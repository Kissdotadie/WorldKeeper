"""绿色包冒烟验收 —— 所有结论落文件，绝不信屏幕输出。

为什么单独写一个文件而不是敲命令行：会话的命令输出通道在这段时间里
反复错乱（回显的命令跟发出去的不一致）。落文件 + 用 Read 读，
是当前唯一可信的验证通道。

验七件事，按「坏了有多严重」排：

  [1] 嵌入式解释器能不能自己起来        （_pth 错 → 全盘皆输）
  [2] `import app` 走不走得通           （路径表漏了安装根 → 后端起不来）
  [3] 第三方依赖在不在                  （site-packages 没进 sys.path → 后端起不来）
  [4] sitecustomize 守卫对不对          （写宽了 → 敲 pip 也弹托盘 = 事故）
  [5] 后端能不能真正起来并响应          （最接近用户双击后的真实体验）
  [6] /m/ 重定向、打赏码完整性          （前置审计修的两处，装完也得在）
  [7] **托盘完整路径**                  （P0 生死线，见下）

[7] 为什么必须有：VM 干净机器上「双击图标静默死亡」，而这一套冒烟 12/12 全绿 ——
根因是开发机上一直挂着一个 8765 的残留后端，启动器每次都从「已有实例就退出」
那条短路出去，**托盘创建那段代码一次都没真正执行过**。
现在启动器改成「先占互斥量 → 建托盘 → 再决定后端自己起还是接管」，
并且日志里会写下「托盘已就绪」，于是这条路径第一次变得可测。

注意：[7] 会在当前桌面**真的建一个托盘图标**，跑完自动清掉。

用法：
    .venv/Scripts/python.exe packaging/smoke_green.py <绿色包目录> <输出文件>
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PASS: list[str] = []
FAIL: list[str] = []


def _free_port() -> int:
    """让系统给一个当前空闲的端口 —— 硬编码端口会跟用户正在跑的程序撞车。"""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def check(label: str, ok: bool, detail: str = "") -> None:
    line = f"{'OK  ' if ok else 'FAIL'}  {label}" + (f"   —— {detail}" if detail else "")
    (PASS if ok else FAIL).append(line)
    print(line, flush=True)


def main() -> int:
    if len(sys.argv) != 3:
        print("用法：smoke_green.py <绿色包目录> <输出文件>")
        return 2
    app_dir = Path(sys.argv[1]).resolve()
    out_path = Path(sys.argv[2])

    py = app_dir / "runtime" / "python.exe"
    check("[0] 嵌入式 python.exe 存在", py.exists(), str(py))
    if not py.exists():
        _write(out_path)
        return 1

    def run_py(args: list[str], env_extra: dict | None = None,
               timeout: float = 60) -> subprocess.CompletedProcess:
        env = dict(os.environ)
        if env_extra:
            env.update(env_extra)
        return subprocess.run([str(py), *args], capture_output=True, text=True,
                              encoding="utf-8", errors="replace",
                              cwd=str(app_dir), env=env, timeout=timeout)

    # ---- [1] 解释器自己 ------------------------------------------------
    r = run_py(["-c", "import sys; print(sys.version.split()[0])"])
    check("[1] 嵌入式解释器能启动", r.returncode == 0,
          (r.stdout + r.stderr).strip()[:120])
    if r.returncode == 0:
        ver = r.stdout.strip()
        check("[1] 版本 3.13.x", ver.startswith("3.13"), ver)

    # ---- [2] import app（_pth 的 `..` 那行）----------------------------
    r = run_py(["-c", "import app; print(app.__version__)"])
    check("[2] import app 成功", r.returncode == 0,
          (r.stdout + r.stderr).strip()[:160])
    ver = r.stdout.strip() if r.returncode == 0 else ""
    # 期望值从**源码**读，不写死 —— 写死的那版会在每次发版时假失败
    # （0.1.0 → 0.2.0 就撞过一次：包是好的，断言是旧的）
    want = ""
    try:
        for line in (ROOT / "app" / "__init__.py").read_text(encoding="utf-8").splitlines():
            if line.startswith("__version__"):
                want = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
    except Exception:
        pass
    check("[2] 版本号读得到", bool(ver) and (not want or ver == want),
          f"包内 {ver or '(空)'} / 源码 {want or '(读不到)'}")

    # ---- [3] 第三方依赖（..\Lib\site-packages 那行）--------------------
    r = run_py(["-c",
                "import fastapi, uvicorn, yaml, frontmatter, multipart, httpx; "
                "print('deps-ok')"])
    check("[3] 第三方依赖能导入", r.returncode == 0 and "deps-ok" in r.stdout,
          (r.stdout + r.stderr).strip()[:200])

    # ---- [4] sitecustomize 守卫（这条最容易写宽 = 事故）----------------
    # a) 带参数（-c）→ 必须不接手。sys.stdin 也不是 None（有控制台）→ 双保险
    r = run_py(["-c", "print('no-autolaunch')"])
    check("[4] 命令行带参不触发托盘", r.returncode == 0 and "no-autolaunch" in r.stdout,
          (r.stdout + r.stderr).strip()[:120])
    # b) 显式开关 → 必须不接手
    r = run_py(["-c", "print('env-guard-ok')"],
               env_extra={"WKV_NO_AUTOLAUNCH": "1"})
    check("[4] WKV_NO_AUTOLAUNCH 开关生效",
          r.returncode == 0 and "env-guard-ok" in r.stdout,
          (r.stdout + r.stderr).strip()[:120])

    # ---- [5] 后端真正起来（最接近双击后的体验）--------------------------
    tmp = Path(tempfile.mkdtemp(prefix="wkv-green-smoke-"))
    env = dict(os.environ)
    env["WKV_DATA_DIR"] = str(tmp)
    env["WKV_PORT"] = "8799"
    env["WKV_NO_AUTOLAUNCH"] = "1"           # 测的是后端，别把托盘也拉起来
    env["WKV_OPEN_BROWSER"] = "0"            # 别每跑一次冒烟就弹一个浏览器
    proc = subprocess.Popen(
        [str(app_dir / "runtime" / "pythonw.exe"), "-m", "app.main"],
        cwd=str(app_dir), env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    base = "http://127.0.0.1:8799"
    url = ""
    deadline = time.time() + 25
    try:
        while time.time() < deadline:
            if proc.poll() is not None:
                out = (proc.stdout.read() if proc.stdout else b"").decode("utf-8", "replace")
                check("[5] 后端进程保持存活", False, f"提前退出 rc={proc.returncode}：{out[-300:]}")
                break
            try:
                with urllib.request.urlopen(f"{base}/api/health", timeout=1.5) as resp:
                    if resp.status == 200:
                        url = base
                        break
            except Exception:
                time.sleep(0.4)
        check("[5] 后端通过健康检查", bool(url), url or "25s 内没起来")

        if url:
            # /m/ 必须重定向 —— 前置审计修的那个白屏 bug，装到包里也得在
            req = urllib.request.Request(f"{url}/m/", method="GET")

            class _NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *a, **k):
                    return None

            opener = urllib.request.build_opener(_NoRedirect)
            try:
                resp = opener.open(req, timeout=5)
                check("[6] /m/ 返回 302（不白屏）", False,
                      f"竟返回 {resp.status} —— 重定向丢了")
            except urllib.error.HTTPError as e:
                loc = e.headers.get("Location", "")
                check("[6] /m/ 返回 302 回 /m（不白屏）",
                      e.code in (301, 302, 303, 307) and loc.rstrip("/").endswith("/m"),
                      f"{e.code} → {loc}")

            # 打赏码完整性 —— 打包清单里最容易漏的就是它
            with urllib.request.urlopen(f"{url}/api/donate", timeout=5) as resp:
                d = json.loads(resp.read().decode("utf-8"))
                check("[6] 打赏码 integrity=ok（donate 目录没漏）",
                      d.get("integrity") == "ok",
                      json.dumps(d, ensure_ascii=False)[:160])

            # 数据目录必须落在临时目录（不是程序目录）
            with urllib.request.urlopen(f"{url}/api/admin/info", timeout=5) as resp:
                info = json.loads(resp.read().decode("utf-8"))
                dd = str(info.get("data_dir", ""))
                check("[6] 数据目录落在数据区（不在程序目录）",
                      dd.startswith(str(tmp)),
                      dd or "(空)")
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)

    # ---- [7] 托盘完整路径（P0 生死线）---------------------------------
    _tray_gate(app_dir)

    _write(out_path)
    return 1 if FAIL else 0


def _tray_gate(app_dir: Path) -> None:
    """跑一遍**完整的双击路径**：自检 → 建托盘窗口与图标 → 拉后端 → 消息循环。

    判据全部来自 `launcher.log`，不看进程表 —— 这个项目的教训是
    「进程活着」什么都证明不了（后端起不来时进程也可能还挂着）。
    """
    pyw = app_dir / "runtime" / "pythonw.exe"
    if not pyw.exists():
        check("[7] pythonw.exe 存在（托盘路径前置）", False, str(pyw))
        return

    tmp = Path(tempfile.mkdtemp(prefix="wkv-tray-smoke-"))
    port = _free_port()
    env = dict(os.environ)
    env.update({
        "WKV_DATA_DIR": str(tmp),
        "WKV_PORT": str(port),
        "WKV_NO_AUTOLAUNCH": "1",       # 我们显式调 main()，不需要 sitecustomize 帮手
        "WKV_OPEN_BROWSER": "0",        # 别每跑一次冒烟就弹一个浏览器
        "WKV_TRAY_MUTEX": f"Global\\WKVTraySmoke{os.getpid()}",
    })
    code = (f"import sys; sys.path.insert(0, r'{app_dir}');"
            "import launcher; sys.exit(launcher.main())")

    print("[7] 正在跑托盘完整路径（桌面上会短暂出现一个托盘图标）…", flush=True)
    tray = subprocess.Popen([str(pyw), "-c", code], cwd=str(app_dir), env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    log_path = tmp / "logs" / "launcher.log"
    text = ""
    try:
        deadline = time.time() + 45
        while time.time() < deadline:
            if log_path.exists():
                text = log_path.read_text(encoding="utf-8", errors="replace")
                if "托盘已就绪" in text:
                    break
            time.sleep(0.5)
        if log_path.exists():
            text = log_path.read_text(encoding="utf-8", errors="replace")

        check("[7] 启动器自检通过（没有缺 argtypes 的 Win32 调用）",
              bool(text) and "自检失败" not in text,
              "自检失败 —— 见 launcher.log" if "自检失败" in text
              else "OK" if text else "没有 launcher.log（进程可能启动即死）")
        check("[7] 托盘窗口 + 图标创建成功（日志出现「托盘已就绪」）",
              "托盘已就绪" in text,
              "OK" if "托盘已就绪" in text
              else (text.splitlines()[-1][:140] if text else "没有日志"))
        check("[7] 启动器没有抛异常",
              bool(text) and "启动器异常" not in text,
              "见 launcher.log" if "启动器异常" in text
              else "OK" if text else "没有日志，判不了")

        healthy = False
        deadline2 = time.time() + 30
        while time.time() < deadline2:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health",
                                            timeout=1.5) as r:
                    if r.status == 200:
                        healthy = True
                        break
            except Exception:
                time.sleep(0.4)
        check("[7] 托盘把后端拉起来并通过健康检查", healthy, f"http://127.0.0.1:{port}")
    finally:
        # 托盘是被 TerminateProcess 杀的，它拉起的后端不会跟着走 —— /T 连树一起收
        subprocess.run(["taskkill", "/PID", str(tray.pid), "/T", "/F"],
                       capture_output=True, timeout=20)
        try:
            tray.wait(10)
        except subprocess.TimeoutExpired:
            tray.kill()
        shutil.rmtree(tmp, ignore_errors=True)


def _write(out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    body = ["=" * 60,
            f"  通过 {len(PASS)} 项，失败 {len(FAIL)} 项",
            "=" * 60, *PASS, "", *FAIL, ""]
    out_path.write_text("\n".join(body), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
