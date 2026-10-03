"""运行时保障：端口探测、单实例、局域网地址、优雅退出。

对应口子 A4 / A5 / A7 与「移动端局域网访问」的前置条件。
"""

from __future__ import annotations

import atexit
import json
import os
import socket
import sys
import urllib.error
import urllib.request

from .logging_setup import get_logger

log = get_logger(__name__)


# --------------------------------------------------------------------------
# 自动开浏览器
# --------------------------------------------------------------------------

def browser_allowed(settings) -> bool:
    """要不要自动打开浏览器。

    判据：环境变量 `WKV_OPEN_BROWSER` **优先**（给了就听它的，可开可关），
    没给才看配置里的 `server.open_browser`。`0`/`false`/`no`/空串算关。

    **为什么放进 runtime 而不是各写一份**：托盘启动器（`packaging/launcher.py`）
    和后端（`app/main.py`）都要用它，两边各写一份的下场是「一半的开关」——
    启动器认 `WKV_OPEN_BROWSER=0`、后端不认，于是包级冒烟每跑一次
    （`pythonw -m app.main`，无控制台）都弹一个莫名其妙的浏览器窗口。
    实测就是这样发现的。
    """
    env = os.environ.get("WKV_OPEN_BROWSER")
    if env is not None:
        return env not in ("", "0", "false", "False", "no", "NO", "No")
    return bool(settings.server.get("open_browser", True))


# --------------------------------------------------------------------------
# 端口
# --------------------------------------------------------------------------

def is_port_free(port: int, host: str = "0.0.0.0") -> bool:
    """端口是否可用。

    **Windows 上的坑**：SO_REUSEADDR 在 Windows 的语义与 Linux 不同 ——
    它允许两个 socket 绑同一个端口，于是被占用的端口也会「绑得上」，
    探测结果永远说空闲。整个端口顺延（A4）与单实例探测（A5）都会失效。
    所以 Windows 必须改用 SO_EXCLUSIVEADDRUSE 做独占绑定。
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):  # Windows
            s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:  # POSIX：容忍 TIME_WAIT，但不会误判活跃监听
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def find_free_port(preferred: int, scan: int = 20, host: str = "0.0.0.0") -> int:
    """从 preferred 起向后找可用端口（口子 A4）。

    全被占用时抛错，由调用方决定是提示用户还是放弃。
    """
    for port in range(preferred, preferred + max(1, scan)):
        if is_port_free(port, host):
            if port != preferred:
                log.warning("端口 %s 被占用，改用 %s", preferred, port)
            return port
    # 提示要指对文件：程序目录里的 `config/config.yaml` 是**只读种子**，
    # 装进 Program Files 后既改不动、改了也会被数据目录那份盖掉（本机实测踩过）。
    # 真正能改的是数据目录里那份，路径在「设置 → 关于 → 打开数据目录」。
    raise RuntimeError(
        f"端口 {preferred}~{preferred + scan - 1} 都被占用了。"
        "改端口请编辑**数据目录**里的 config.yaml（设置 → 关于 → 打开数据目录），"
        "程序目录里的 config/config.yaml 只是只读种子，改它不生效。"
    )


# --------------------------------------------------------------------------
# 局域网地址
# --------------------------------------------------------------------------

def lan_ip() -> str | None:
    """本机在局域网中的地址。用于启动时打印，方便手机访问。

    技巧：向一个外部地址发 UDP「连接」不会真的发包，但能让内核选出出口网卡。
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("223.5.5.5", 80))
        return s.getsockname()[0]
    except Exception:
        return None
    finally:
        s.close()


def print_access_addresses(port: int, lan_enabled: bool) -> None:
    """启动时打印可访问地址（移动端访问的前置条件之一）。"""
    lines = [
        "",
        "  世界观查询器已启动",
        f"    本机： http://127.0.0.1:{port}",
    ]
    if lan_enabled:
        ip = lan_ip()
        if ip:
            lines.append(f"    局域网： http://{ip}:{port}   （手机连同一 WiFi 可访问）")
        else:
            lines.append("    局域网： 未检测到可用地址")
    else:
        lines.append("    局域网： 未开启（需要手机访问请在 config/config.yaml 中开启 lan_access）")
    lines.append("    按 Ctrl+C 停止服务")
    lines.append("")
    print("\n".join(lines), flush=True)


# --------------------------------------------------------------------------
# 单实例（口子 A5）
# --------------------------------------------------------------------------

def probe_existing_instance(port: int, scan: int = 20, host: str = "127.0.0.1") -> int | None:
    """检测是否已有实例在跑。

    比起文件锁，直接探健康检查端点更准确：第二次双击图标时，
    正确行为是「唤起已有实例」而不是报错或抢占文件。
    """
    for p in range(port, port + max(1, scan)):
        if is_port_free(p):
            # 端口空着，说明这个端口没有实例
            continue
        try:
            url = f"http://{host}:{p}/api/health"
            with urllib.request.urlopen(url, timeout=0.6) as resp:
                if resp.status == 200:
                    payload = json.loads(resp.read().decode("utf-8"))
                    if payload.get("app") == "world-keeper":
                        return p
        except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
            continue
    return None


# --------------------------------------------------------------------------
# 优雅退出（口子 A7）
# --------------------------------------------------------------------------

_shutdown_hooks: list = []


def on_shutdown(fn) -> None:
    _shutdown_hooks.append(fn)


def _run_shutdown_hooks() -> None:
    for fn in _shutdown_hooks:
        try:
            fn()
        except Exception as exc:  # pragma: no cover
            log.warning("退出钩子执行失败：%s", exc)


def install_shutdown_hooks() -> None:
    atexit.register(_run_shutdown_hooks)

    def _signal_handler(signum, frame):  # pragma: no cover
        log.info("收到退出信号 %s，正在安全关闭…", signum)
        _run_shutdown_hooks()
        sys.exit(0)

    try:
        import signal

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                signal.signal(sig, _signal_handler)
            except (ValueError, OSError):
                pass
    except Exception:
        pass
