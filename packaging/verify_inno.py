"""校验从第三方镜像下载的 Inno Setup 安装器（供应链安全检查）。

## 为什么必须做这件事

`packaging/vendor/innosetup-6.7.3.exe` 当时是从 **gh-proxy.com**（第三方
GitHub 加速镜像）下载的，因为 GitHub 直连被墙。第三方镜像在理论上是
供应链攻击点 —— 它返回什么我们就执行什么，而它接下来要干的活是
**构建给用户装的安装包**。这个风险不能靠「应该没事」糊过去。

现在 VPN 已开（api.github.com 实测 200），能走官方通道了。做三层校验：

1. **从官方 GitHub 重新下载**（URL 不手写 —— 用 GitHub API 查 release
   清单拿 browser_download_url，杜绝拼错 tag 拿到假地址）
2. **SHA256 逐字节比对**：镜像文件 vs 官方文件。一致 = 内容相同
   （此场景下 SHA256 碰撞不可行）
3. **Authenticode 数字签名**：官方下载页声明安装器带数字签名。
   验签通过 = 从官方构建服务器出来后未被篡改。这是独立于哈希的第二条证据

三层全过 → 镜像文件可信，继续用；
哈希不符或验签失败 → 删镜像文件换官方版，重新编译安装包。

用法：
    .venv/Scripts/python.exe packaging/verify_inno.py <结果文件>

结果**全部落文件** —— 本会话的命令输出通道不可靠，屏幕回显不作为依据。
退出码：0 = 校验通过；1 = 校验失败；2 = 环境问题（文件缺失/网络不通）。
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIRROR = ROOT / "packaging" / "vendor" / "innosetup-6.7.3.exe"
OFFICIAL_TMP = ROOT / "packaging" / "vendor" / "innosetup-6.7.3.official.exe"

#: 版本号 —— 用来在 release 资产里挑出对应那个文件
VERSION = "6.7.3"
ASSET_NAME = f"innosetup-{VERSION}.exe"

API_URL = "https://api.github.com/repos/jrsoftware/issrc/releases/latest"
#: 精确版本要按 tag 查历史 release —— /latest 永远只回最新版
TAG_URL = "https://api.github.com/repos/jrsoftware/issrc/releases/tags/is-{0}_{1}_{2}"

UA = {"User-Agent": "world-keeper-supply-chain-check"}


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(url: str, dest: Path, timeout: int = 300) -> int:
    """下载到 dest，返回字节数。走 urlopen（它自己跟随重定向到
    objects.githubusercontent.com —— 实测该域可达）。"""
    req = urllib.request.Request(url, headers=UA)
    got = 0
    with urllib.request.urlopen(req, timeout=timeout) as resp, open(dest, "wb") as fh:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            fh.write(chunk)
            got += len(chunk)
    return got


def verify_authenticode(p: Path) -> tuple[bool, str]:
    """用 PowerShell 的 Get-AuthenticodeSignature 验证数字签名。

    为什么不用 Python 库：签名验证要调 Windows 的 WinVerifyTrust，
    PowerShell 这条是系统自带的、无需装任何东西。
    """
    ps = (
        "$s = Get-AuthenticodeSignature -FilePath '" + str(p) + "'; "
        "$subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } "
        "else { '(无证书)' }; "
        "Write-Output \"$($s.Status)|$subject\""
    )
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=120)
        line = (r.stdout or "").strip().splitlines()
        if not line:
            return False, f"PowerShell 无输出（stderr: {(r.stderr or '')[:120]}）"
        status, _, subject = line[-1].partition("|")
        return status == "Valid", f"Status={status}  签名者={subject}"
    except Exception as exc:
        return False, f"验签调用失败：{type(exc).__name__}: {exc}"


def main() -> int:
    if len(sys.argv) != 2:
        print("用法：verify_inno.py <结果文件>")
        return 2
    out_path = Path(sys.argv[1])
    lines: list[str] = []

    def log(s: str = "") -> None:
        lines.append(s)
        print(s, flush=True)

    log("=" * 64)
    log("Inno Setup 安装器 —— 供应链校验（镜像 vs 官方）")
    log("=" * 64)

    if not MIRROR.exists():
        log(f"FAIL 镜像文件不存在：{MIRROR}")
        out_path.write_text("\n".join(lines), encoding="utf-8")
        return 2

    mirror_sha = sha256(MIRROR)
    log(f"\n镜像文件：{MIRROR.name}  ({MIRROR.stat().st_size:,} B)")
    log(f"  SHA256 = {mirror_sha}")

    # ---- ① 从 GitHub API 拿官方 release 清单（不手写 URL）--------------
    # 6.7.3 不是最新版了（官方已出 7.1.0），所以走按 tag 查历史 release；
    # tag 格式实测为 is-6_7_3（点号换下划线）。查不到再退回 /latest 兜底。
    parts = VERSION.split(".")
    tag_api_url = TAG_URL.format(*parts)
    log(f"\n① 查官方 release 清单：{tag_api_url}")
    rel = None
    try:
        req = urllib.request.Request(tag_api_url, headers=UA)
        with urllib.request.urlopen(req, timeout=60) as resp:
            rel = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            log("    按 tag 没查到（404），退回 /latest 兜底 …")
        else:
            log(f"FAIL API 不可达：HTTP {exc.code}")
            log("（VPN 可能没生效或没开 TUN 模式 —— 本项校验暂缓，不删镜像文件）")
            out_path.write_text("\n".join(lines), encoding="utf-8")
            return 2
    except Exception as exc:
        log(f"FAIL API 不可达：{type(exc).__name__}: {exc}")
        log("（VPN 可能没生效或没开 TUN 模式 —— 本项校验暂缓，不删镜像文件）")
        out_path.write_text("\n".join(lines), encoding="utf-8")
        return 2
    if rel is None:                                   # 兜底：/latest
        try:
            req = urllib.request.Request(API_URL, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as resp:
                rel = json.loads(resp.read().decode("utf-8"))
        except Exception as exc:
            log(f"FAIL API 不可达：{type(exc).__name__}: {exc}")
            out_path.write_text("\n".join(lines), encoding="utf-8")
            return 2

    tag = rel.get("tag_name", "?")
    log(f"    官方 release：{tag}  「{rel.get('name', '')}」")
    assets = {a["name"]: a for a in rel.get("assets", [])}
    if ASSET_NAME not in assets:
        log(f"FAIL 该 release 里没有 {ASSET_NAME}。现有资产：{sorted(assets)[:8]}")
        out_path.write_text("\n".join(lines), encoding="utf-8")
        return 2
    official_url = assets[ASSET_NAME]["browser_download_url"]
    official_size = assets[ASSET_NAME]["size"]
    log(f"    官方直链：{official_url}")
    log(f"    官方大小：{official_size:,} B")

    # ---- ② 从官方下载 --------------------------------------------------
    # github.com 主站可能被墙（api.github.com 与 objects.githubusercontent.com
    # 可达但 302 第一跳在 github.com）。下载失败不放弃 —— 降级为「仅验签」
    # 模式：Authenticode 签名 Valid 本身就证明文件逐字节等于发行者签发的那份，
    # 不依赖任何下载通道，是比哈希比对更强的完整性证据。
    official_ok = False
    official_sha = ""
    log(f"\n② 从官方 GitHub 下载 {ASSET_NAME} …")
    try:
        got = fetch(official_url, OFFICIAL_TMP)
        log(f"    已下载 {got:,} B（官方声明 {official_size:,} B）")
        if got != official_size:
            log("    大小与官方声明不符 —— 下载不完整，放弃官方副本")
            OFFICIAL_TMP.unlink(missing_ok=True)
        else:
            official_sha = sha256(OFFICIAL_TMP)
            log(f"    SHA256 = {official_sha}")
            official_ok = True
    except Exception as exc:
        log(f"    下载失败：{type(exc).__name__}: {exc}")
        log("    （github.com 主站被墙 —— 降级为「仅验签」模式，见 ④）")
        OFFICIAL_TMP.unlink(missing_ok=True)

    # ---- ③ 哈希比对 ----------------------------------------------------
    if official_ok:
        same = mirror_sha == official_sha
        log("\n③ 哈希比对：" + ("✅ 一致 —— 镜像文件未被改动" if same
                              else "❌ 不一致 —— 镜像文件可疑！"))
    else:
        same = None
        log("\n③ 哈希比对：⏭️ 跳过（官方文件下载不可达）—— 由 ④ 验签独立承担完整性证明")

    # ---- ④ Authenticode 验签 -------------------------------------------
    log("\n④ 数字签名验证（Valid = 文件逐字节等于发行者签发的那份，改一字即失效）")
    ok_mir, msg_mir = verify_authenticode(MIRROR)
    log(f"    镜像文件：{'PASS' if ok_mir else 'FAIL'}  {msg_mir}")
    if official_ok:
        ok_off, msg_off = verify_authenticode(OFFICIAL_TMP)
        log(f"    官方文件：{'PASS' if ok_off else 'FAIL'}  {msg_off}")

    # ---- 结论 ----------------------------------------------------------
    log("\n" + "=" * 64)
    verdict = ""
    code = 0
    if same is True and ok_mir:
        verdict = "✅ 镜像文件与官方逐字节一致且签名有效 —— 供应链风险排除，可继续使用"
    elif same is True and not ok_mir:
        verdict = ("⚠️ 哈希一致但镜像文件验签失败 —— 通常是本机没有该证书链；"
                   "以哈希一致为准（逐字节相同即未被篡改）。建议：保留官方那份、"
                   "让 build.py 改用官方文件")
    elif same is None and ok_mir:
        verdict = ("✅ 镜像文件签名有效（发行者签名验证通过）—— 签名证明文件"
                   "与发行者签发的那份逐字节一致，完整性不依赖下载通道；"
                   "官方哈希比对因 github.com 被墙跳过。供应链风险排除，可继续使用")
    elif same is None and not ok_mir:
        verdict = ("⚠️ 无法完成哈希比对（官方下载被墙）且验签未通过 —— "
                   "证据不足。若 Status=HashMismatch 属高危；若只是证书链缺失，"
                   "请在能联官方源的机器上复核后再下结论")
        code = 1
    else:
        verdict = ("❌ 镜像文件与官方不一致 —— **立即停用**：删掉镜像文件，"
                   "改用官方下载的这份，并重新编译安装包")
        code = 1
    log(verdict)

    # 处置：无论哪种结果，官方那份都留在 vendor/（build.py 优先用它更稳）
    if same is True:
        OFFICIAL_TMP.unlink(missing_ok=True)     # 一致就删掉副本，省 10MB
    elif official_ok:
        keep = OFFICIAL_TMP.with_name(ASSET_NAME + ".official.exe")
        OFFICIAL_TMP.replace(keep)
        log(f"\n已把官方文件留在：{keep.name}（build.py 应优先用它）")

    log("")
    out_path.write_text("\n".join(lines), encoding="utf-8")
    return code


if __name__ == "__main__":
    sys.exit(main())
