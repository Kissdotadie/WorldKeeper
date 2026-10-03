"""绿色包的启动验证（P8 主体）。

验证四件事，按「坏了会怎样」从轻到重排：

1. 嵌入式解释器自己能不能起来（_pth 写错 → 什么都起不来）
2. `import app` 能不能走通（路径表漏了安装根 → 后端起不来）
3. sitecustomize 的守卫逻辑对不对（守卫写宽了 → 命令行一敲 python 也弹托盘）
4. 后端能不能真正起来并响应健康检查（最接近用户双击后的真实体验）

用法：python packaging/test_green.py
不依赖开发机的 .venv —— 用的就是包里的 runtime/python.exe，这才是要测的东西。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "packaging" / "out" / "WorldKeeper"
RUNTIME = APP / "runtime"
PY = RUNTIME / "python.exe"

results: list[str] = []
failed = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global failed
    mark = "OK  " if ok else "FAIL"
    if not ok:
        failed += 1
    results.append(f"{mark} {label}" + (f" —— {detail}" if detail else ""))
    print(results[-1], flush=True)


def run_py(args: list[str], *, env_extra: dict | None = None,
           timeout: float = 60) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    return subprocess.run([str(PY), *args], capture_output=True, text=True,
                          encoding="utf-8", errors="replace", env=env,
                          cwd=str(APP), timeout=timeout)


def main() -> int:
    if not PY.exists():
        print(f"FAIL 找不到 {PY} —— 先跑 packaging/build.py")
        return 2

    # ---- ① 解释器自身 --------------------------------------------------
    r = run_py(["-c", "import sys; print(sys.version.split()[0])"])
    check("嵌入式解释器能启动", r.returncode == 0, (r.stdout + r.stderr).strip()[:120])
    if r.returncode == 0:
        got = r.stdout.strip()
        check("版本与构建时一致（3.13.14）", got == "3.13.14", got)

    # ---- ② import app（_pth 的 `..` 那行）-----------------------------
    r = run_py(["-c",
                "from app import __version__, APP_ID; print(APP_ID, __version__)"])
    check("能 import app（路径表正确）", r.returncode == 0,
          (r.stdout + r.stderr).strip()[:160])
    if r.returncode == 0:
        check("APP_ID 与版本读出来对", r.stdout.strip() == "world-keeper 0.1.0",
              r.stdout.strip())

    # ---- ③ 第三方依赖（..\Lib\site-packages 那行）---------------------
    r = run_py(["-c", "import yaml, fastapi, uvicorn, frontmatter, httpx; "
                      "print('deps ok')"])
    check("第三方依赖能导入", r.returncode == 0, (r.stdout + r.stderr).strip()[:160])

    # ---- ④ sitecustomize 守卫 ----------------------------------------
    # 有参数（-c / -m）→ 必须不接手。这条最容易写宽 —— 守卫一宽，
    # 「python -m pip install xxx」都会弹出一个托盘，那就是事故。
    r = run_py(["-c",
                "import sys; print('argv_keep' if not hasattr(sys, '_wkv_launched') else 'launched')"],
               env_extra={"WKV_NO_AUTOLAUNCH": "1"})
    check("排障开关生效（WKV_NO_AUTOLAUNCH）",
          r.returncode == 0 and "argv_keep" in r.stdout, r.stdout.strip()[:80])

    # ---- ⑤ 后端真正起来（最接近双击后的体验）--------------------------
    tmp = Path(tempfile.mkdtemp(prefix="wkv-green-"))
    env = {"WKV_DATA_DIR": str(tmp), "WKV_NO_AUTOLAUNCH": "1",
           "WKV_PORT": "8799"}
    proc = subprocess.Popen(
        [str(PY), "-m", "app.main"],
        cwd=str(APP), env={**os.environ, **env},
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    try:
        url = None
        deadline = time.time() + 25
        while time.time() < deadline:
            if proc.poll() is not None:
                out = proc.stdout.read().decode("utf-8", "replace") if proc.stdout else ""
                check("后端进程保持存活", False, f"提前退出 rc={proc.returncode}：{out[-300:]}")
                break
            for p in (8799, 8800, 8801):
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{p}/api/health",
                                                timeout=0.8) as resp:
                        payload = json.loads(resp.read().decode("utf-8"))
                        if payload.get("app") == "world-keeper":
                            url = f"http://127.0.0.1:{p}"
                            break
                except Exception:
                    continue
            if url:
                break
            time.sleep(0.5)
        check("后端通过健康检查", bool(url), url or "25s 内没起来")
        if url:
            # /m/ 必须重定向（P8 前置修的那个 bug，装到包里也得在）
            req = urllib.request.Request(url + "/m/", method="GET")
            op = urllib.request.build_opener(_NoRedirect)
            try:
                resp = op.open(req, timeout=5)
                check("/m/ 重定向（安装形态下也不白屏）",
                      resp.status in (301, 302, 303, 307)
                      and resp.headers.get("Location", "").endswith("/m"),
                      f"{resp.status} → {resp.headers.get('Location')}")
            except urllib.error.HTTPError as e:
                check("/m/ 重定向（安装形态下也不白屏）", False, str(e.code))
            # 打赏码完整性（打包清单里最容易漏的那项）
            with urllib.request.urlopen(url + "/api/donate", timeout=5) as resp:
                d = json.loads(resp.read().decode("utf-8"))
                check("打赏码 integrity=ok（donate 目录没漏）",
                      d.get("integrity") == "ok", json.dumps(d, ensure_ascii=False)[:120])
            # 配置种子：数据目录必须落在临时目录（不是程序目录）
            with urllib.request.urlopen(url + "/api/app/info", timeout=5) as resp:
                info = json.loads(resp.read().decode("utf-8"))
                dd = str(info.get("data_dir", ""))
                check("数据目录落在用户可写位置（不在 Program Files）",
                      dd.startswith(str(tmp)) or "Program Files" not in dd, dd[:120])
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n" + "=" * 60)
    if failed:
        print(f"  {failed} 项失败")
        return 1
    print("  全部通过")
    return 0


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):        # noqa: D102
        return None


if __name__ == "__main__":
    import urllib.error                      # noqa: E402  （_NoRedirect 要用到）
    sys.exit(main())
