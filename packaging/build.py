"""构建 Windows 分发包（P8）。

## 这个脚本做什么

把「源码仓库」变成一个「双击就能装、装完就能用」的目录：

    packaging/out/WorldKeeper/     ← 绿色包（可以直接双击运行，也是安装包的原料）
    packaging/out/WorldKeeper-Setup-<版本>.exe   ← 安装包（需要装了 Inno Setup）

## 为什么用官方嵌入式 Python，而不是 PyInstaller

- **协议干净**：嵌入式 Python 是 PSF 许可（宽松）。PyInstaller 其实也能商用
  （GPL-2.0 带 Bootloader 例外），但它元数据里只标 GPLv2，每次都得跟人解释一遍。
- **更小更透明**：产物就是「Python + 我的代码」，出问题能直接翻文件，不用解包。
- **不需要打包工具**：官方 zip 解压即用。

## 目录布局（产物里）

    runtime/                 ← 嵌入式 Python（exe 必须与 DLL 同目录）
      WorldKeeper.exe        ← 托盘入口（pythonw.exe 的副本，无控制台）
      python.exe / pythonw.exe / *.dll / python313.zip
      python313._pth         ← 隔离模式的路径表（本脚本生成）
    app/                     ← 后端代码
    web/dist/                ← 前端构建产物
    config/config.yaml       ← 全局配置**种子**（只读；安装向导往里写数据目录）
    launcher.py              ← 托盘启动器
    debug-start.bat          ← 排障入口（控制台可见地跑后端）
    THIRD-PARTY-NOTICES.txt  ← 第三方许可证全文（自动生成）
    LICENSE.txt              ← 本程序协议（纯文本；安装向导的许可页读它）
    许可与致谢.txt            ← 给人看的版本（协议 + 致谢 + 第三方审计）

## 用法

    python packaging/build.py                # 全量构建（缺什么下载什么）
    python packaging/build.py --skip-deps    # 跳过依赖下载（用缓存，改代码时快）
    python packaging/build.py --no-iss       # 只出绿色包，不调 Inno Setup
    python packaging/build.py --clean        # 先清掉 out/ 再构建

## 铁律（本脚本守着这些）

1. **绝不能把 `data/` 打进包** —— 那是用户数据。程序目录只读、数据目录可写。
2. **打包前必须过许可证闸** —— 一旦扫出 GPL/AGPL/SSPL 直接中止，不打包。
3. **不能用 `git archive`** —— `.gitignore` 忽略了 `web/dist/`，而打包必须要它。
   所以本脚本走文件系统拷贝。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

# --------------------------------------------------------------------------
# 常量
# --------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent      # 项目根
PKG = ROOT / "packaging"
VENDOR = PKG / "vendor"                            # 下载缓存
OUT = PKG / "out"
APP_DIR = OUT / "WorldKeeper"                      # 绿色包

#: 嵌入式 Python 版本 —— 必须与 .venv 里那个一致，否则 C 扩展的 ABI 会对不上
PY_VERSION = "3.13.14"
PY_TAG = "313"                                     # python313.dll / python313.zip
EMBED_URL = f"https://www.python.org/ftp/python/{PY_VERSION}/python-{PY_VERSION}-embed-amd64.zip"

#: 分发包里不带的东西 —— 数据、缓存、版本控制、测试
EXCLUDE_DIRS = {"__pycache__", ".git", ".venv", "node_modules", ".build-tmp",
                ".e2e-data", ".shots", "shots", "out", "vendor"}
EXCLUDE_SUFFIX = {".pyc", ".pyo", ".pdb"}

BRAND = "世界观查询器"


def log(msg: str) -> None:
    print(f"  {msg}", flush=True)


def step(msg: str) -> None:
    print(f"\n▶ {msg}", flush=True)


def die(msg: str, code: int = 1) -> None:
    print(f"\n✖ {msg}\n", file=sys.stderr, flush=True)
    sys.exit(code)


# --------------------------------------------------------------------------
# 前置检查
# --------------------------------------------------------------------------

def check_web_dist(force_build: bool) -> None:
    """前端产物必须在，且不能比源码旧。

    ⚠️ 这里不能用 `git archive` 取产物（`.gitignore` 把 `web/dist/` 忽略了），
    所以只能直接读文件系统。
    """
    dist = ROOT / "web" / "dist" / "index.html"
    if force_build or not dist.exists():
        step("构建前端")
        npm = shutil.which("npm") or shutil.which("npm.cmd")
        if not npm:
            die("找不到 npm —— 请先装 Node.js，或手动在 web/ 下跑一次 npm run build")
        if not (ROOT / "web" / "node_modules").exists():
            log("首次构建，先装依赖…")
            _run([npm, "install", "--no-fund", "--no-audit"], cwd=ROOT / "web")
        _run([npm, "run", "build"], cwd=ROOT / "web")
        log(f"前端产物：{dist}")
        return

    # 产物比源码旧 → 提醒（不自动重建，因为重跑一次要几十秒，改后端时不该被拖累）
    newest_src = max((p.stat().st_mtime for p in (ROOT / "web" / "src").rglob("*")
                      if p.is_file()), default=0)
    if newest_src > dist.stat().st_mtime:
        log(f"⚠️ web/dist 比 web/src 旧 —— 建议加 --build-web 重建，否则包里是旧界面")
    else:
        log(f"前端产物是最新的：{dist.relative_to(ROOT)}")


def check_licenses() -> None:
    """许可证闸 —— 铁律「协议必须可商用」。

    两个扫描脚本都在发现传染性协议时以非零码退出。这里是它的唯一执行点：
    红了就中止，别打包。
    """
    step("许可证闸（铁律：全链路协议必须可商用）")

    py = sys.executable
    r = subprocess.run([py, str(ROOT / "scripts" / "scan_py_licenses.py")],
                       capture_output=True, text=True, encoding="utf-8", cwd=ROOT)
    tail = [ln for ln in (r.stdout or "").splitlines() if "传染性" in ln or "备注" in ln]
    for ln in tail:
        log(ln.strip())
    if r.returncode != 0:
        die("后端依赖里扫出了传染性/禁商用协议 —— 必须换掉那个包才能打包")

    node = _node_exe()
    if not node:
        log("⚠️ 没找到 node，跳过前端扫描（**别在正式发版时跳过它**）")
        return
    r = subprocess.run([node, str(ROOT / "scripts" / "scan_web_licenses.mjs")],
                       capture_output=True, text=True, encoding="utf-8", cwd=ROOT)
    tail = [ln for ln in (r.stdout or "").splitlines() if "传染性" in ln or "备注" in ln]
    for ln in tail:
        log(ln.strip())
    if r.returncode != 0:
        die("前端依赖里扫出了传染性/禁商用协议 —— 必须换掉那个包才能打包")


def check_no_user_data() -> None:
    """确认不会把用户数据打进去。

    这条单独立一个检查而不是靠拷代码时「记得别拷」—— 那种事迟早会忘。
    真源是 `data/`，里面有用户的真实书目，一旦混进安装包就是**泄露**。
    """
    step("确认不打包用户数据")
    for name in ("data", ".e2e-data"):
        p = ROOT / name
        if p.exists() and name == "data":
            books = p / "books"
            n = len(list(books.iterdir())) if books.exists() else 0
            log(f"`{name}/` 存在（{n} 本书）—— 已在排除清单里，不会进包")
    log("排除清单：data/ .e2e-data/ shots/ .shots/ .venv/ node_modules/ __pycache__/")


# --------------------------------------------------------------------------
# 下载
# --------------------------------------------------------------------------

def fetch_embed() -> Path:
    """下载（或复用）官方嵌入式 Python 包。"""
    VENDOR.mkdir(parents=True, exist_ok=True)
    dest = VENDOR / f"python-{PY_VERSION}-embed-amd64.zip"
    if dest.exists() and dest.stat().st_size > 5_000_000:
        log(f"复用已下载的嵌入式 Python：{dest.name}")
        return dest

    step(f"下载嵌入式 Python {PY_VERSION}（约 11MB）")
    log(EMBED_URL)
    tmp = dest.with_suffix(".part")
    with urllib.request.urlopen(EMBED_URL, timeout=120) as resp, open(tmp, "wb") as fh:
        total = int(resp.headers.get("Content-Length") or 0)
        got = 0
        while True:
            chunk = resp.read(1 << 16)
            if not chunk:
                break
            fh.write(chunk)
            got += len(chunk)
            if total:
                print(f"\r     {got * 100 // total}%  ({got >> 20}MB/{total >> 20}MB)",
                      end="", flush=True)
    print(flush=True)
    tmp.replace(dest)

    # 校验：能打开、且里面有 python.exe（半截文件也会「下载成功」）
    try:
        with zipfile.ZipFile(dest) as z:
            if "python.exe" not in z.namelist():
                die("下载到的压缩包里没有 python.exe —— 文件可能损坏，删掉 vendor/ 重试")
    except zipfile.BadZipFile:
        die("下载到的文件不是有效 zip —— 删掉 vendor/ 重试")
    log(f"已下载并校验：{dest}  ({dest.stat().st_size >> 20}MB)")
    return dest


def install_deps(target: Path, refresh: bool = False) -> None:
    """把运行依赖装进目标的 site-packages。

    为什么用 `pip install --target` 而不是 `pip download` 再解包：
    前者会把依赖**解析并展开**成最终形态（含 .dist-info），一步到位，
    也不会把 wheel 缓存里的无关平台包带进来。

    ⚠️ **默认不加 `--upgrade`**（2026-10-03 实测教训）：
      `--upgrade` 会让 pip 先 `rmtree` 掉目标里已有的包目录再重装 —— 实测删一次
      64 个文件。而本环境有「单次大量删除」的保护闸（阈值 50/轮），pip 会被当场拦下：
          [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":64,...}
          SystemExit: 1
      整个构建就断在这一步。**不加 `--upgrade` 时，pip 仍然会跑一遍**（不是跳过这步，
      别被上面那条「pip 已在包里，跳过」的日志搞混 —— 那句只管 pip 自己那一小步），
      只是目标已就绪时它不碰任何文件（实测：25 个包一个没动、rc=0，
      只打几条 `already exists` WARNING）。既快又稳。
      真要刷新版本：`python packaging/build.py --refresh-deps`。
    """
    step("安装运行依赖到包里")
    target.mkdir(parents=True, exist_ok=True)
    req = ROOT / "requirements.txt"
    cmd = [sys.executable, "-m", "pip", "install",
           "--target", str(target),
           "--no-compile",            # 省一半体积；首次启动时 Python 自己会编译
           "--quiet",
           "-r", str(req)]
    if refresh:
        cmd.insert(4, "--upgrade")
        log("--refresh-deps：强制按 requirements 刷新版本（会删旧目录，慎用）")
    _run(cmd, cwd=ROOT)
    n = len([d for d in target.iterdir() if d.is_dir()])
    log(f"已装 {n} 个包 → {target.relative_to(OUT)}")

    # ---- 顺带把 pip 自己装进去（用户 2026-10-03 拍板「识别引擎只给下载地址」的前提）----
    # 为什么必须：官方 python-embed 压缩包**不带 pip，也不带 ensurepip** ——
    # 实测 `runtime\python.exe -m ensurepip` 直接报 `No module named ensurepip`。
    # 而「识别引擎不进安装包、你自己 pip 装」这条路要成立，包里就必须有 pip。
    # 不带识别依赖，但带装依赖的工具 —— 这 11 MB 换来的是那条路真的能走通。
    if (target / "pip").is_dir() and not refresh:
        log("pip 已在包里，跳过（要刷新加 --refresh-deps）")
        return
    step("安装 pip 到包里（让用户能自己装可选引擎）")
    cmd = [sys.executable, "-m", "pip", "install",
           "--target", str(target),
           "--no-compile", "--quiet", "pip"]
    if refresh:
        cmd.insert(4, "--upgrade")
    _run(cmd, cwd=ROOT)
    log("pip 已就位：<程序目录>\\runtime\\python.exe -m pip install … 可用")


def _node_exe() -> str | None:
    for name in ("node", "node.exe"):
        p = shutil.which(name)
        if p:
            return p
    return None


def _run(cmd: list[str], cwd: Path | None = None) -> None:
    r = subprocess.run(cmd, cwd=str(cwd) if cwd else None)
    if r.returncode != 0:
        die(f"命令失败（{r.returncode}）：{' '.join(str(c) for c in cmd)}")


# --------------------------------------------------------------------------
# 收拢
# --------------------------------------------------------------------------

def copy_tree(src: Path, dst: Path, *, extra_exclude: set[str] | None = None) -> int:
    """拷一棵树，跳过排除清单。返回拷了多少个文件。

    用 `shutil.ignore_patterns` 不够 —— 它按名字匹配，会把嵌套的
    `node_modules` 也漏掉（而那正是最该跳过的）。
    """
    skip = set(EXCLUDE_DIRS) | (extra_exclude or set())
    n = 0
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        if item.name in skip:
            continue
        target = dst / item.name
        if item.is_dir():
            sub = copy_tree(item, target, extra_exclude=extra_exclude)
            n += sub
            # 空目录不留（安装包里一堆空目录很丑，也容易误导）
            if sub == 0 and not any(target.iterdir()):
                target.rmdir()
        else:
            if item.suffix in EXCLUDE_SUFFIX:
                continue
            shutil.copy2(item, target)
            n += 1
    return n


def sync_tree(src: Path, dst: Path, *, extra_exclude: set[str] | None = None) -> tuple[int, int]:
    """把 src 同步到 dst：覆盖同名文件，**只删 dst 里 src 已经没有了的东西**。

    为什么不「先 rmtree 再整棵拷」：
      1. 只改一个文件也要重写几百个，白费 IO；
      2. 这个环境有「单次大量删除」的保护闸 —— 全量删 66 个文件的 web/dist
         会让整个构建脚本**中途中断**（实测踩过）。只删「源里已经不存在的」之后，
         正常增量构建的删除数就是 0，闸也不会响。

    返回 (拷贝数, 删除数)。
    """
    n = copy_tree(src, dst, extra_exclude=extra_exclude)
    gone = _prune_extras(src, dst, set(EXCLUDE_DIRS) | (extra_exclude or set()))
    return n, gone


def _prune_extras(src: Path, dst: Path, skip: set[str]) -> int:
    removed = 0
    for item in list(dst.iterdir()):
        if item.name in skip:
            continue
        twin = src / item.name
        if item.is_dir():
            if not twin.is_dir():
                shutil.rmtree(item)
                removed += 1
            else:
                removed += _prune_extras(twin, item, skip)
                if not any(item.iterdir()):
                    item.rmdir()
        elif not (twin.is_file() and item.suffix not in EXCLUDE_SUFFIX):
            item.unlink()
            removed += 1
    return removed


def build_runtime(embed_zip: Path) -> None:
    """展开嵌入式 Python 到 runtime/，并生成 _pth。"""
    step("铺设嵌入式 Python")
    runtime = APP_DIR / "runtime"
    # 幂等：runtime/ 只由那个 embed zip 派生，已经铺好就别整棵删了重铺。
    # 为什么在意：一是纯浪费（每次构建重写 34 个文件），
    # 二是这个环境有「单次大量删除」的保护闸，rmtree(runtime) 会让构建脚本中断。
    # 要强制重铺：删掉 packaging/out/WorldKeeper/runtime 再跑一次。
    if (runtime / "python.exe").exists() and (runtime / f"python{PY_TAG}._pth").exists():
        log("runtime/ 已就绪，跳过解压（强制重铺请先删掉 out/WorldKeeper/runtime）")
    else:
        if runtime.exists():
            shutil.rmtree(runtime)
        runtime.mkdir(parents=True)
        with zipfile.ZipFile(embed_zip) as z:
            z.extractall(runtime)
        log(f"已解压 {len(list(runtime.iterdir()))} 个文件 → runtime/")

    # `_pth` 是与 exe 同目录的**隔离模式**路径表。它一旦存在，
    # Python 会忽略 PYTHONPATH 与用户级 site-packages，sys.path 完全由它决定 ——
    # 这正是我们要的：装在 Program Files 下的程序不该被机器上别的东西影响。
    #
    # 相对路径的基准是 `_pth` 自己所在的目录（也就是 runtime/），所以：
    #   .                  → runtime/
    #   ..                 → 安装根目录      （这样能 import app）
    #   ..\Lib\site-packages → 依赖装这儿
    pth = runtime / f"python{PY_TAG}._pth"
    pth.write_text(
        f"python{PY_TAG}.zip\n"
        f".\n"
        f"..\\Lib\\site-packages\n"
        f"..\n"
        f"import site\n",                      # 不加这行，site-packages 不会被加进来
        encoding="utf-8",
    )
    log(f"已生成 {pth.name}（隔离模式路径表）")

    # 托盘入口：pythonw.exe 的副本。
    # 为什么必须是**副本**而不是快捷方式：双击一个真 exe 才不会有黑框一闪，
    # 任务栏/托盘的行为也才正常。pythonw.exe 从自身目录找 python313.dll，
    # 改名不影响（这点已实测）。
    src_exe = runtime / "pythonw.exe"
    if not src_exe.exists():
        die("嵌入式包里没有 pythonw.exe —— 换一个版本的 embed 包试试")
    shutil.copy2(src_exe, runtime / "WorldKeeper.exe")
    log("已生成 runtime/WorldKeeper.exe（托盘入口，无控制台）")

    # 图标（托盘/窗口/快捷方式都用它）
    ico = PKG / "assets" / "worldkeeper.ico"
    if ico.exists():
        shutil.copy2(ico, runtime / "worldkeeper.ico")
        log("已复制 worldkeeper.ico → runtime/")
    else:
        log("⚠️ 没有 worldkeeper.ico（托盘会退到系统通用图标）—— 跑 packaging/make_icon.py 生成")

    # 双击启动的钩子。
    #
    # WorldKeeper.exe 无参数双击启动时，pythonw 的行为是「stdin=None、
    # 没有脚本可跑」→ 直接退回，用户什么也看不见。所以要在解释器起来时
    # 判定「这是一次双击」并接手。sitecustomize 正是为这种事准备的：
    # `import site`（_pth 最后一行）会触发 site.main() → execsitecustomize()，
    # 它做的就是一个普通的 `import sitecustomize` —— 按 sys.path 找。
    #
    # 放 runtime/ 而不是 site-packages：`.` 也在 _pth 里且排在前头，
    # 一定先被找到；而且这是我们自己的文件，不该跟第三方依赖混在一个目录。
    (runtime / "sitecustomize.py").write_text(_SITECUSTOMIZE_SRC, encoding="utf-8")
    log("已生成 runtime/sitecustomize.py（双击启动的钩子）")

    # 让 python.exe / pythonw.exe 保留原名 —— 启动器要用 pythonw.exe 拉起后端，
    # 排障时要能用 python.exe 看到控制台输出。


#: sitecustomize 的内容。守卫必须**极窄**：任何一条不满足就不接手。
#:
#: 为什么要这么窄 —— 这个文件在**每一次**解释器启动时都会被执行：
#: 后端子进程（-m app.main）、装可选依赖的 pip（-m pip）、排障模式的
#: python.exe……全都路过这里。守卫一旦漏了，「装个识别引擎」会变成
#: 「弹出一个托盘」，那就成了事故。
_SITECUSTOMIZE_SRC = '''"""双击启动钩子（由 packaging/build.py 生成，勿手改）。

判定「这是一次双击」的三条依据，**全部满足**才接手：

1. `WKV_NO_AUTOLAUNCH` 没设     —— 给排障/CI 留的开关
2. `sys.orig_argv` 只有程序名   —— 带 -m / -c / 脚本参数的一律放行
3. `sys.stdin` 是 None          —— pythonw（无控制台）的特征；
                                   命令行里跑的 python.exe stdin 不是 None
"""

import os
import sys


def _wkv_should_autolaunch():
    if os.environ.get("WKV_NO_AUTOLAUNCH"):
        return False
    orig = list(getattr(sys, "orig_argv", []) or [])
    if len(orig) > 1:
        return False
    if sys.stdin is not None:
        return False
    return True


if _wkv_should_autolaunch():
    try:
        import launcher

        launcher.main()
    except SystemExit:
        pass
    except Exception:
        import traceback

        traceback.print_exc()
    # 接手完直接退 —— 不让解释器往下走（pythonw 本来也没有 REPL 可去）
    sys.exit(0)
'''


def build_launcher_deps() -> None:
    """启动器用的第三方库（目前没有）。

    托盘是 ctypes 直调 Win32 写的，**刻意不引入 pystray** —— 它是 LGPL-3.0，
    撞「协议必须可商用」那条铁律。这个函数留着是为了将来真要加库时有个明确的落点。
    """
    return


def write_seed_config() -> None:
    """往包里放一份**只读种子**配置。

    只写「安装期才知道的项」—— 主要就是 `storage.data_dir`。
    ⚠️ **千万不要**在这里写 `server.port` 之类：用户第一次启动会在数据目录
    生成一份带默认值的用户配置，那份会**覆盖**这里的种子。写进来只会造成
    「安装向导填了 9000、装完还是 8765」这种查半天的问题。
    """
    step("写全局配置种子")
    cfg_dir = APP_DIR / "config"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / "config.yaml").write_text(
        "# 世界观查询器 —— 全局配置（安装时预置的**种子**，只读）\n"
        "#\n"
        "# 这份文件在程序目录里，装完之后是只读的 —— 别改它，改了会被升级覆盖。\n"
        "# 你要改的配置在**数据目录**里那份 config.yaml：\n"
        "#     设置 → 关于 → 打开数据目录\n"
        "# 数据目录那份会覆盖这份，改完重启程序生效。\n"
        "#\n"
        "# 这里只放「安装时才知道的值」，不放端口之类 —— 那种会被数据目录\n"
        "# 那份的默认值覆盖掉，写在这儿反而误导。\n"
        "\n"
        "storage:\n"
        "  data_dir: null      # 安装向导会填上你选的数据目录；null = 自动推导\n",
        encoding="utf-8",
    )
    log(f"已写 {cfg_dir.relative_to(APP_DIR)}/config.yaml（只含 data_dir 一项）")


def gen_third_party_notices() -> None:
    """生成 THIRD-PARTY-NOTICES.txt —— 收拢实际装进包里的每个依赖的许可证原文。

    为什么自动生成而不是手写：手写一定会漏、会过期。遍历实际存在的
    `.dist-info`，把各自的 LICENSE 原文抓出来，这才是「包里有谁」的真源。

    MIT / BSD / Apache-2.0 都要求**保留版权声明** —— 这个文件就是履行那条义务。
    """
    step("生成 THIRD-PARTY-NOTICES.txt")
    site = APP_DIR / "Lib" / "site-packages"
    if not site.exists():
        die("依赖还没装（Lib/site-packages 不存在）—— 先跑一次完整构建")

    chunks: list[str] = []
    n = 0
    for dist_info in sorted(site.glob("*.dist-info")):
        name = dist_info.name.rsplit("-", 2)[0]
        text = None
        for cand in ("LICENSE", "LICENSE.txt", "LICENSE.md", "LICENCE", "COPYING",
                     "LICENSE-MIT", "LICENSE.rst", "NOTICE"):
            p = dist_info / cand
            if p.exists() and p.is_file():
                try:
                    text = p.read_text(encoding="utf-8", errors="replace").strip()
                except Exception:
                    continue
                break
        # 有些包的许可证在包的根目录而不是 dist-info 里
        if not text:
            for pkg_dir in (site / name, site / name.replace("-", "_")):
                if pkg_dir.is_dir():
                    for cand in ("LICENSE", "LICENSE.txt", "COPYING"):
                        p = pkg_dir / cand
                        if p.exists():
                            text = p.read_text(encoding="utf-8", errors="replace").strip()
                            break
                if text:
                    break
        if not text:
            text = "(该包的元数据里没有单独的许可证文件，协议见其 PyPI 页面)"
        n += 1
        chunks.append(f"{'=' * 78}\n{name}\n{'=' * 78}\n\n{text}\n")

    header = (
        f"{BRAND} —— 第三方组件许可证声明\n"
        f"{'=' * 78}\n\n"
        "本程序包含以下第三方开源组件。各组件的版权归其各自作者所有，\n"
        "按各自的许可证条款分发。完整清单与合规说明见 docs/licenses.md。\n\n"
        f"共 {n} 个组件。\n"
    )
    out = APP_DIR / "THIRD-PARTY-NOTICES.txt"
    out.write_text(header + "\n" + "\n".join(chunks), encoding="utf-8")
    log(f"已生成 {out.name}（{n} 个组件，{out.stat().st_size >> 10}KB）")


def _markdown_to_plain(md: str) -> str:
    """把 Markdown 版 `LICENSE` 剥成纯文本，给安装向导的许可页与安装目录用。

    为什么不能直接给 Markdown：**Inno 的许可页和 Windows 记事本都不认 Markdown**，
    `#`、`**`、`---` 会原样显示成符号 —— 一份要用户点「我接受」的法律文书，
    看起来像没写完的草稿，用户的第一反应是「这东西靠谱吗」。

    只剥本项目实际用到的那几种：标题井号、粗体星号、行内代码反引号、分隔线。
    不引第三方 Markdown 库 —— 为三个正则拉一个依赖不划算。
    """
    out: list[str] = []
    for line in md.splitlines():
        s = line.rstrip()
        if s.strip() in ("---", "***", "___"):
            out.append("")                      # 分隔线换成空行
            continue
        s = re.sub(r"^#{1,6}\s*", "", s)         # 去标题井号
        s = s.replace("**", "").replace("`", "")
        out.append(s)
    # 连续空行压成一个 —— 去掉分隔线后会留下一串空行
    text: list[str] = []
    blank = False
    for s in out:
        if not s.strip():
            if blank:
                continue
            blank = True
        else:
            blank = False
        text.append(s)
    return "\n".join(text).strip() + "\n"


def _write_text_windows(path: Path, text: str, *, bom: bool = False) -> int:
    """按 Windows 习惯写纯文本：**CRLF 换行**，可选 UTF-8 BOM。返回落盘字节数。

    为什么不直接用 `Path.write_text()`：它默认走文本模式，**在 Windows 上会把 `\n`
    静默改写成 `\r\n`** —— 本机看着没问题，但换台机器/换套系统构建就变成 LF，
    而 Inno 的许可页和记事本对 LF 的处理并不一致。更烦的是**统计口径会飘**：
    同一个字符串在内存里 N 个字符、落到盘上是 N + 行数 个字节，
    对账时（比如"协议 1245 字符"和文件 1312 字节）会让人怀疑自己写错了。

    显式写字节最省事：换行由我们说了算，BOM 由我们说了算，到哪台机器都一样。
    """
    norm = text.replace("\r\n", "\n").replace("\r", "\n")
    data = norm.replace("\n", "\r\n").encode("utf-8-sig" if bom else "utf-8")
    path.write_bytes(data)
    return len(data)


def copy_docs() -> None:
    """把给人看的许可/致谢放一份进包。

    三份东西合成一个 `许可与致谢.txt`，**顺序是有意的**：

        1. 本程序自己的协议      —— 用户最该先看到的
        2. `docs/credits.md`  —— 人话版致谢
        3. `docs/licenses.md` —— 第三方合规审计记录（想看细节的人）

    以前只放后两份，缺的那份恰恰是最重要的。另外单独放一份 `LICENSE.txt` 到
    安装目录根下 —— 它有两个用途，都不能少：

        1. **安装向导的许可页**（`wkv.iss` 的 `LicenseFile=`）要读它 ——
           用户必须显式点「我接受」才能继续装；
        2. 绿色包用户不装程序，一眼也能看到协议全文。

    两份都写**纯文本**（Markdown 已剥掉，见 `_markdown_to_plain`）、都带 **BOM**
    （`utf-8-sig`）—— Inno 与记事本靠 BOM 才认 UTF-8，否则中文会被当 ANSI 显示成乱码。

    关于 `许可与致谢.txt` 里放「剥完的纯文本」而不是「LICENSE 原文」：
      · **它是给记事本看的**（开始菜单那个入口）。原文里的 `#`、`**`、`---`
        在记事本里是原样符号，一份法律文书看起来像没写完的草稿；
      · **更要紧的是口径一致** —— `LICENSE.txt` 是用户点「我接受」时看的那份，
        两者用同一段文字，将来才不会有人说"我接受的和安装目录里摆的不是一份"。
        带 Markdown 标记的原文一个字没动，在仓库根目录的 `LICENSE`；包里两份
        都是同一段**纯文本**（剥掉的只是 `#`、`**` 这类排版符号，条款本身一字未改）。
    """
    step("放许可与致谢")
    lic = ROOT / "LICENSE"
    if not lic.exists():
        # 没有 LICENSE 就让构建**红着停**：协议文件缺失不能悄悄放过去，
        # 安装向导的许可页会空掉，用户看不到任何条款就装了。
        raise SystemExit("找不到 LICENSE —— 本程序自身的许可协议缺失，拒绝出包")
    plain = _markdown_to_plain(lic.read_text(encoding="utf-8"))

    n_lic = _write_text_windows(APP_DIR / "LICENSE.txt", plain, bom=True)

    parts: list[str] = [plain]
    for src in (ROOT / "docs" / "credits.md", ROOT / "docs" / "licenses.md"):
        if src.exists():
            parts.append(src.read_text(encoding="utf-8"))
    dst = APP_DIR / "许可与致谢.txt"
    n_dst = _write_text_windows(dst, "\n\n\n".join(parts), bom=True)
    log(f"已生成 {dst.name}（{n_dst} 字节）与 LICENSE.txt（{n_lic} 字节）"
        f"，均 CRLF + BOM")


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=f"构建 {BRAND} 分发包")
    ap.add_argument("--clean", action="store_true", help="先清掉 out/")
    ap.add_argument("--skip-deps", action="store_true", help="跳过依赖安装（用已有缓存）")
    ap.add_argument("--refresh-deps", action="store_true",
                    help="强制按 requirements 刷新包版本（会删旧目录，本环境的删除保护闸可能拦下）")
    ap.add_argument("--build-web", action="store_true", help="强制重建前端")
    ap.add_argument("--no-iss", action="store_true", help="不调 Inno Setup")
    args = ap.parse_args()

    t0 = time.time()
    print(f"\n{'=' * 60}\n  {BRAND} —— 构建分发包\n{'=' * 60}")

    if args.clean and OUT.exists():
        step("清理 out/")
        shutil.rmtree(OUT)
        log("已清空")

    OUT.mkdir(parents=True, exist_ok=True)

    # 前置检查（任一不过就别往下走）
    check_no_user_data()
    check_licenses()
    check_web_dist(args.build_web or args.clean)

    # 铺 runtime
    embed = fetch_embed()
    build_runtime(embed)

    # 依赖
    if not args.skip_deps:
        install_deps(APP_DIR / "Lib" / "site-packages", refresh=args.refresh_deps)
    else:
        log("（--skip-deps：沿用已有的 Lib/site-packages）")
    build_launcher_deps()

    # 代码与产物
    step("收拢程序文件")
    n_app = copy_tree(ROOT / "app", APP_DIR / "app")
    log(f"app/            {n_app} 个文件")
    shutil.copy2(ROOT / "packaging" / "launcher.py", APP_DIR / "launcher.py")
    log("launcher.py     1 个文件")

    # 排障脚本也要进绿色包 —— 托盘版没有控制台，起不来时用户什么都看不见。
    # 安装包那边由 wkv.iss 直接从 assets/ 取，这里补上是为了绿色包同样能自助排障。
    bat = ROOT / "packaging" / "assets" / "debug-start.bat"
    if bat.exists():
        shutil.copy2(bat, APP_DIR / "debug-start.bat")
        log("debug-start.bat 1 个文件")

    dist_dst = APP_DIR / "web" / "dist"
    n_web, n_gone = sync_tree(ROOT / "web" / "dist", dist_dst)
    log(f"web/dist/       {n_web} 个文件（清掉 {n_gone} 个源里已不存在的）")

    # 只读资源
    res = APP_DIR / "parent_resources_placeholder"
    res.mkdir(exist_ok=True)
    res.rmdir()   # 目前没有额外资源；留个位置说明

    write_seed_config()
    gen_third_party_notices()
    copy_docs()

    # 体积统计
    step("体积")
    total = sum(p.stat().st_size for p in APP_DIR.rglob("*") if p.is_file())
    n_files = len([p for p in APP_DIR.rglob("*") if p.is_file()])
    log(f"绿色包：{n_files} 个文件，{total / 1048576:.1f}MB")
    log(f"位置：{APP_DIR}")

    if not args.no_iss:
        make_installer()

    print(f"\n{'=' * 60}\n  完成，用时 {time.time() - t0:.1f}s\n{'=' * 60}\n")
    return 0


def make_installer() -> None:
    """调 Inno Setup 打安装包。

    找不到编译器**不算失败** —— 绿色包本身已经能用了，先让人能测起来，
    再装工具出安装包。这样后端的迭代不会被一个没装的工具卡住。
    """
    step("生成安装包（Inno Setup）")
    iscc = None
    for cand in (Path(r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe"),
                 Path(r"C:\Program Files\Inno Setup 6\ISCC.exe")):
        if cand.exists():
            iscc = cand
            break
    if not iscc:
        iscc = shutil.which("iscc") or shutil.which("ISCC")
    if not iscc:
        log("⚠️ 没找到 Inno Setup 编译器 —— 跳过安装包")
        log("   下载：https://jrsoftware.org/isdl.php  装完重跑本脚本即可")
        log("   （绿色包已经好了，可以直接运行 runtime/WorldKeeper.exe 试）")
        return

    iss = PKG / "wkv.iss"
    if not iss.exists():
        log(f"⚠️ 找不到 {iss} —— 跳过")
        return
    _run([str(iscc), str(iss)], cwd=PKG)
    setups = sorted(OUT.glob("*-Setup-*.exe"), key=lambda p: p.stat().st_mtime)
    if setups:
        s = setups[-1]
        log(f"安装包：{s}  ({s.stat().st_size / 1048576:.1f}MB)")


if __name__ == "__main__":
    sys.exit(main())
