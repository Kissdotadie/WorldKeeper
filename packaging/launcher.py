"""托盘启动器 —— 用户双击的入口（`runtime/WorldKeeper.exe`）。

## 它干什么

1. **看护后端**：拉起 `pythonw.exe -m app.main` 子进程，盯着它活着；
   挂了弹气泡、菜单里能重启。
2. **托盘**：右键菜单（打开界面 / 打开数据目录 / 查看日志 / 重启服务 / 关于 / 退出）。
3. **优雅退出**：退出时先通知后端，再收尾 —— 不留僵尸进程、不丢日志。

## 为什么是 ctypes 直调 Win32，而不是 pystray

**协议。** 最常用的 `pystray` 是 LGPL-3.0 —— 撞上项目铁律「全链路协议必须可商用」。
ctypes 是标准库，Win32 API 是操作系统接口（不属于任何第三方），
多写一百来行，换来协议上**一点疑问都没有**。代价与收益详见 docs/credits.md。

## 它怎么被启动

- **正常路径**：用户双击 `WorldKeeper.exe`（= pythonw.exe 的副本，无控制台），
  由 `Lib/site-packages/sitecustomize.py` 的守卫判定「这是双击、不是命令行」后 import 本模块。
- **快捷方式**：开始菜单/桌面快捷方式直接指向 `WorldKeeper.exe`，无参数 —— 同一条路。
- **排障**：开始菜单里的「世界观查询器 启动（排障模式）」→ 跑 `{app}\\debug-start.bat`，
  用 `python.exe` 带控制台跑后端，绕开托盘。

  之所以要留这条后路：托盘版没有控制台，后端起不来时**你什么都看不见**。
  排障模式把输出打在屏幕上，一秒定位是哪一步炸了。

## 进程树

    WorldKeeper.exe（托盘，本文件）
      └─ pythonw.exe -m app.main     ← 后端（uvicorn），日志写进数据目录

为什么拆两个进程：托盘和后端的生命周期不同。后端崩了，托盘还在，
能告诉你「服务挂了」并给你一个「重启」按钮；反过来退出托盘时也能把后端带走。
"""

from __future__ import annotations

import ctypes
import os
import subprocess
import sys
import time
import urllib.request
import webbrowser
from ctypes import wintypes
from pathlib import Path

# --------------------------------------------------------------------------
# 路径与导入
# --------------------------------------------------------------------------

#: launcher.py 在**安装根目录**，runtime/ 在它旁边
APP_ROOT = Path(__file__).resolve().parent
RUNTIME = APP_ROOT / "runtime"

# `..` 已在 python313._pth 里，所以这里能 import app ——
# 于是启动器跟后端用**同一套**配置与路径解析，不会出现「两边算出来的端口不一样」
sys.path.insert(0, str(APP_ROOT))          # _pth 已包含 ..，这里兜底（防 _pth 被改动）

from app import config, paths, runtime      # noqa: E402  （sys.path 先就位才能导）

ICON_PATH = RUNTIME / "worldkeeper.ico"
BRAND = "世界观查询器"

log_file = None                              # 延迟初始化（要等数据目录就位）


def log(msg: str) -> None:
    """托盘版没有控制台，输出落文件 —— 排障时唯一的线索。

    位置：数据目录/logs/launcher.log。数据目录没就位时退回 stderr（这时
    多半是命令行/排障模式在跑，看得见）。

    ⚠️ 开文件之前**必须先让 config 把数据目录定下来**（`load_settings`）。
    不这么做的话 `paths.data_dir()` 会走兜底推导（程序目录的 data/，或
    我的文档/WorldKeeper），而那只跟「配置文件里写的」碰巧一致才不出事 ——
    实测就踩到了：`WKV_DATA_DIR` 指到临时目录、后端的数据也落在那里，
    但启动器的日志却写进了 `我的文档\\WorldKeeper\\logs`。
    日志和数据分居两地，排障时等于白排。
    """
    global log_file
    try:
        if log_file is None:
            try:
                config.load_settings()       # 定数据目录（幂等）
            except Exception:
                pass                          # 配置坏了也得能记日志，退回兜底
            paths.ensure_data_dirs()
            log_file = open(paths.logs_dir() / "launcher.log", "a", encoding="utf-8")
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        log_file.write(f"[{stamp}] {msg}\n")
        log_file.flush()
    except Exception:
        print(msg, file=sys.stderr)


# --------------------------------------------------------------------------
# Win32 常量与结构
# --------------------------------------------------------------------------

user32 = ctypes.WinDLL("user32", use_last_error=True)
shell32 = ctypes.WinDLL("shell32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

# -- 返回值宽度（这是 64 位下的真坑，不是洁癖） ----------------------------
#
# ctypes 对没显式设 restype 的函数默认按 **c_int（32 位）** 收返回值。
# 而 Windows 64 位上 HANDLE / HICON / HWND / LRESULT 都是 **64 位**的。
# 后果不是崩溃，而是更阴的：句柄**高位被悄悄砍掉**，往下传一个错的值，
# 于是「图标加载失败」「窗口句柄无效」这类鬼问题，而且复现不稳定。
#
# wintypes.WNDPROC / LRESULT 在 Python 3.13 里**不存在**（老版本有），
# 所以这两个也得自己补 —— 这是实测出来的，不是从文档抄的。
LRESULT = ctypes.c_ssize_t                                   # 指针宽度
WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT,
                             wintypes.WPARAM, wintypes.LPARAM)

user32.DefWindowProcW.restype = LRESULT
user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT,
                                  wintypes.WPARAM, wintypes.LPARAM]
user32.LoadImageW.restype = wintypes.HANDLE
user32.LoadImageW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT,
                              ctypes.c_int, ctypes.c_int, wintypes.UINT]
user32.LoadIconW.restype = wintypes.HANDLE
user32.LoadIconW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR]
user32.CreateWindowExW.restype = wintypes.HWND
# argtypes 必须显式声明 —— 否则 ctypes 把每个参数默认按 32 位 c_int 转换，
# 64 位句柄（hInstance/hwnd/menu 都是 0x7FF6… 这种）直接 OverflowError。
# VM 首次双击炸的就是这里：argument 11 = hInstance。
user32.CreateWindowExW.argtypes = [
    wintypes.DWORD,      # dwExStyle
    wintypes.LPCWSTR,    # lpClassName
    wintypes.LPCWSTR,    # lpWindowName
    wintypes.DWORD,      # dwStyle
    ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    wintypes.HWND,       # hWndParent
    wintypes.HMENU,      # hMenu
    wintypes.HINSTANCE,  # hInstance ← 64 位，就是它炸的
    wintypes.LPVOID,     # lpParam
]
# 同族地雷一次清完 —— 这些调用全都收 64 位句柄：
# 注意：wintypes 没有 UINT_PTR（实测 False），用 ctypes.c_size_t 等价替换
user32.AppendMenuW.argtypes = [wintypes.HMENU, wintypes.UINT,
                               ctypes.c_size_t, wintypes.LPCWSTR]
user32.TrackPopupMenu.argtypes = [wintypes.HMENU, wintypes.UINT, ctypes.c_int,
                                  ctypes.c_int, ctypes.c_int,
                                  wintypes.HWND, ctypes.c_void_p]
user32.DestroyMenu.argtypes = [wintypes.HMENU]
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT,
                                wintypes.WPARAM, wintypes.LPARAM]
user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT,
                                  wintypes.WPARAM, wintypes.LPARAM]
user32.CreatePopupMenu.restype = wintypes.HANDLE
kernel32.GetModuleHandleW.restype = wintypes.HMODULE
kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
shell32.Shell_NotifyIconW.restype = wintypes.BOOL
shell32.Shell_NotifyIconW.argtypes = [wintypes.DWORD, ctypes.c_void_p]
kernel32.CreateMutexW.restype = wintypes.HANDLE
kernel32.CreateMutexW.argtypes = [wintypes.LPCVOID, wintypes.BOOL, wintypes.LPCWSTR]

#: 收 / 传 64 位句柄的 Win32 调用清单 —— 这些**必须**显式声明 argtypes。
#: 漏一个的后果不是报错，是 `pythonw.exe` **静默死亡**：没有控制台、没有日志，
#: 用户看到的就是「双击图标没反应」。这不是假设，VM 首次安装炸的正是
#: `CreateWindowExW` 少了 argtypes（argument 11 = hInstance → OverflowError）。
#:
#: 新增任何 Win32 调用时，照着这张表加一行 —— 加漏了启动自检会当场拦下来。
_ARGTYPE_REQUIRED = [
    (user32, "CreateWindowExW"), (user32, "AppendMenuW"), (user32, "TrackPopupMenu"),
    (user32, "DestroyMenu"), (user32, "SetForegroundWindow"), (user32, "PostMessageW"),
    (user32, "DefWindowProcW"), (user32, "LoadImageW"), (user32, "LoadIconW"),
    (kernel32, "GetModuleHandleW"), (kernel32, "CreateMutexW"),
    (shell32, "Shell_NotifyIconW"),
]


def _selftest_win32() -> list[str]:
    """启动自检：64 位句柄相关的 Win32 函数有没有漏声明 argtypes。

    为什么必须在**启动时**跑：这类 bug 死得太安静 —— 静默死亡、无日志，
    排障只能靠猜。宁可在这里返回一个能写进 launcher.log 的错误码，
    也不要让进程不明不白地消失。
    """
    return [name for lib, name in _ARGTYPE_REQUIRED if getattr(lib, name).argtypes is None]


WM_APP_TRAY = 0x8000 + 100                   # 托盘回调消息（自定义，避开系统用的区间）
WM_APP_QUIT = 0x8000 + 101                   # 跨线程的退出请求

WM_DESTROY = 0x0002
WM_CLOSE = 0x0010
WM_COMMAND = 0x0111
WM_NULL = 0x0000
WM_LBUTTONUP = 0x0202
WM_RBUTTONUP = 0x0205
WM_CONTEXTMENU = 0x007B                     # Win7+ 的右键消息（托盘 v3 回调里也可能收到）
WM_USER = 0x0400

NIM_ADD, NIM_MODIFY, NIM_DELETE, NIM_SETFOCUS, NIM_SETVERSION = 0, 1, 2, 3, 4
NIF_MESSAGE, NIF_ICON, NIF_TIP = 0x01, 0x02, 0x04
NIF_INFO, NIF_SHOWTIP = 0x10, 0x80
NOTIFYICON_VERSION = 3                       # 回调里 lParam 直接就是鼠标消息，好处理

NIIF_INFO, NIIF_WARNING, NIIF_ERROR = 0x1, 0x2, 0x3

TPM_RIGHTBUTTON, TPM_BOTTOMALIGN, TPM_RETURNCMD = 0x0000, 0x0020, 0x0100
IMAGE_ICON, LR_LOADFROMFILE, LR_DEFAULTSIZE = 1, 0x0010, 0x0040
CW_USEDEFAULT = 0x80000000
CS_VREDRAW, CS_HREDRAW = 0x0001, 0x0002
IDI_APPLICATION = 32512
ERROR_ALREADY_EXISTS = 183
SW_HIDE = 0
INFINITE = 0xFFFFFFFF
WAIT_OBJECT_0 = 0
QS_ALLINPUT = 0x04FF
MWMO_INPUTAVAILABLE = 0x0004

# 菜单项 ID（WM_COMMAND 的 wParam 低字）
M_OPEN_UI, M_OPEN_DATA, M_OPEN_LOGS, M_RESTART, M_ABOUT, M_QUIT = 100, 101, 102, 103, 104, 105


class GUID(ctypes.Structure):
    _fields_ = [("Data1", ctypes.c_ulong), ("Data2", ctypes.c_ushort),
                ("Data3", ctypes.c_ushort), ("Data4", ctypes.c_ubyte * 8)]


class NOTIFYICONDATAW(ctypes.Structure):
    # 结构要给全 —— cbSize 填 sizeof(整个结构)，Win10/11 认
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("hWnd", wintypes.HWND),
        ("uID", wintypes.UINT),
        ("uFlags", wintypes.UINT),
        ("uCallbackMessage", wintypes.UINT),
        ("hIcon", wintypes.HANDLE),
        ("szTip", wintypes.WCHAR * 128),
        ("dwState", wintypes.DWORD),
        ("dwStateMask", wintypes.DWORD),
        ("szInfo", wintypes.WCHAR * 256),
        ("unionVersion", wintypes.UINT),       # uVersion / uTimeout 共用
        ("szInfoTitle", wintypes.WCHAR * 64),
        ("dwInfoFlags", wintypes.DWORD),
        ("guidItem", GUID),
        ("hBalloonIcon", wintypes.HANDLE),
    ]


class WNDCLASSEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.UINT),
        ("style", wintypes.UINT),
        ("lpfnWndProc", WNDPROC),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", wintypes.HINSTANCE),
        ("hIcon", wintypes.HANDLE),
        ("hCursor", wintypes.HANDLE),
        ("hbrBackground", wintypes.HANDLE),
        ("lpszMenuName", wintypes.LPCWSTR),
        ("lpszClassName", wintypes.LPCWSTR),
        ("hIconSm", wintypes.HANDLE),
    ]


class MSG(ctypes.Structure):
    _fields_ = [
        ("hwnd", wintypes.HWND), ("message", wintypes.UINT),
        ("wParam", wintypes.WPARAM), ("lParam", wintypes.LPARAM),
        ("time", wintypes.DWORD), ("pt", wintypes.POINT),
    ]


# --------------------------------------------------------------------------
# 托盘
# --------------------------------------------------------------------------

class Tray:
    """隐藏窗口 + Shell_NotifyIcon，就这两样。

    Windows 托盘没有「回调函数」这种东西 —— 你必须有个窗口来收消息。
    所以这里造一个**不显示**的窗口，把托盘事件路由到它身上。
    """

    def __init__(self, app: "App") -> None:
        self.app = app
        self.hwnd = None
        self._tid = kernel32.GetCurrentThreadId()
        self._proc = WNDPROC(self._on_msg)   # 持引用防 GC —— 不然回调就飞了

    # -- 窗口 ---------------------------------------------------------

    def create_window(self) -> None:
        hinst = kernel32.GetModuleHandleW(None)
        cls = "WorldKeeperTrayWnd"
        wc = WNDCLASSEXW()
        wc.cbSize = ctypes.sizeof(WNDCLASSEXW)
        wc.lpfnWndProc = self._proc
        wc.hInstance = hinst
        wc.lpszClassName = cls
        wc.hIcon = self._load_icon()
        wc.hIconSm = wc.hIcon
        if not user32.RegisterClassExW(ctypes.byref(wc)) and ctypes.get_last_error() not in (0, 1410):
            # 1410 = ERROR_CLASS_ALREADY_EXISTS，重复启动时正常
            raise ctypes.WinError(ctypes.get_last_error())

        self.hwnd = user32.CreateWindowExW(
            0, cls, BRAND, 0, 0, 0, 0, 0, None, None, hinst, None)
        if not self.hwnd:
            raise ctypes.WinError(ctypes.get_last_error())

    def _load_icon(self) -> int:
        """优先用我们自己的 .ico；加载失败退到系统通用图标（别让启动挂在这）。"""
        if ICON_PATH.exists():
            h = user32.LoadImageW(None, str(ICON_PATH), IMAGE_ICON,
                                  0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE)
            if h:
                return h
        return user32.LoadIconW(None, IDI_APPLICATION)

    # -- 托盘图标 -----------------------------------------------------

    def add_icon(self) -> None:
        nid = NOTIFYICONDATAW()
        nid.cbSize = ctypes.sizeof(NOTIFYICONDATAW)
        nid.hWnd = self.hwnd
        nid.uID = 1
        nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP
        nid.uCallbackMessage = WM_APP_TRAY
        nid.hIcon = self._load_icon()
        nid.szTip = f"{BRAND}（右键打开菜单）"
        nid.unionVersion = NOTIFYICON_VERSION
        shell32.Shell_NotifyIconW(NIM_ADD, ctypes.byref(nid))
        shell32.Shell_NotifyIconW(NIM_SETVERSION, ctypes.byref(nid))

    def remove_icon(self) -> None:
        nid = NOTIFYICONDATAW()
        nid.cbSize = ctypes.sizeof(NOTIFYICONDATAW)
        nid.hWnd = self.hwnd
        nid.uID = 1
        shell32.Shell_NotifyIconW(NIM_DELETE, ctypes.byref(nid))

    def balloon(self, title: str, text: str, level: int = NIIF_INFO) -> None:
        nid = NOTIFYICONDATAW()
        nid.cbSize = ctypes.sizeof(NOTIFYICONDATAW)
        nid.hWnd = self.hwnd
        nid.uID = 1
        nid.uFlags = NIF_INFO | NIF_SHOWTIP
        nid.szInfo = text[:255]
        nid.szInfoTitle = title[:63]
        nid.dwInfoFlags = level
        nid.unionVersion = 0
        shell32.Shell_NotifyIconW(NIM_MODIFY, ctypes.byref(nid))

    # -- 菜单 ---------------------------------------------------------

    def show_menu(self) -> None:
        menu = user32.CreatePopupMenu()
        items = [
            (M_OPEN_UI, "打开界面"),
            0,   # 分隔线
            (M_OPEN_DATA, "打开数据目录"),
            (M_OPEN_LOGS, "查看日志"),
            0,
            (M_RESTART, "重启服务"),
            0,
            (M_ABOUT, "关于"),
            (M_QUIT, "退出"),
        ]
        for it in items:
            if it == 0:
                user32.AppendMenuW(menu, 0x0800, 0, None)     # MF_SEPARATOR
            else:
                mid, label = it
                user32.AppendMenuW(menu, 0x0000, mid, label)  # MF_STRING

        # 经典 Win32 坑：TrackPopupMenu 之前必须 SetForegroundWindow，
        # 否则菜单弹出来但点击外面不消失（微软自己的文档都写了 workaround）
        user32.SetForegroundWindow(self.hwnd)
        pt = wintypes.POINT()
        user32.GetCursorPos(ctypes.byref(pt))
        chosen = user32.TrackPopupMenu(menu, TPM_RIGHTBUTTON | TPM_BOTTOMALIGN | TPM_RETURNCMD,
                                       pt.x, pt.y, 0, self.hwnd, None)
        user32.DestroyMenu(menu)
        user32.PostMessageW(self.hwnd, WM_NULL, 0, 0)   # 收掉前台状态

        if chosen:
            self.app.on_menu(chosen)

    # -- 消息循环 -----------------------------------------------------

    def _on_msg(self, hwnd, msg, wparam, lparam):
        if msg == WM_APP_TRAY:
            ev = lparam & 0xFFFF
            if ev in (WM_RBUTTONUP, WM_CONTEXTMENU):
                self.show_menu()
            elif ev == WM_LBUTTONUP:
                self.app.open_ui()
            return 0
        if msg == WM_COMMAND:
            self.app.on_menu(wparam & 0xFFFF)
            return 0
        if msg == WM_DESTROY:
            self.remove_icon()
            user32.PostQuitMessage(0)
            return 0
        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

    def pump(self, timeout_ms: int) -> bool:
        """跑 timeout_ms 的消息循环；返回 False 表示收到退出。

        为什么不用 GetMessageW（阻塞）：退出请求可能来自**别的线程**
        （看护线程发现子进程死了想退出/弹提示），阻塞在 GetMessage 上
        就只能等下一次鼠标事件才醒。PeekMessage + 超时让两条路都通。
        """
        end = time.time() + timeout_ms / 1000
        msg = MSG()
        while True:
            while user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 1):   # PM_REMOVE
                if msg.message == 0x0012:                                   # WM_QUIT
                    return False
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
            if time.time() >= end:
                return True
            # Win32 的 MsgWaitForMultipleObjects：有消息/超时/句柄事件都会醒
            idx = user32.MsgWaitForMultipleObjects(0, None, 0,
                                                   max(1, int((end - time.time()) * 1000)),
                                                   QS_ALLINPUT)
            if idx == WAIT_OBJECT_0:      # 消息到了，立刻去取
                continue


# --------------------------------------------------------------------------
# 应用（进程看护）
# --------------------------------------------------------------------------

#: 启动器自己的单实例互斥量。带环境变量覆盖是为了**冒烟测试**能用自己
#: 的名字跑一遍完整托盘路径 —— 否则用户正开着程序时，测试一进去就被
#: 「已有启动器在跑」挡回来，托盘创建那段永远测不到（P0 就是这么漏掉的）。
MUTEX_NAME = os.environ.get("WKV_TRAY_MUTEX", "Global\\WorldKeeperTrayMutex")


def _pid_listening_on(port: int) -> int | None:
    """反查监听该端口的进程 PID（`netstat -ano`）。

    只服务于「接管来的后端能不能干净收尾」这一件事，查不到就算了。
    为什么不上 psutil：为一个收尾动作加一个第三方依赖不划算，
    netstat 是系统自带的，解析也只认「本地地址以 :端口 结尾」这一个特征 ——
    **不解析 State 那一列**，免得撞上中文/本地化输出。
    """
    if not port:
        return None
    try:
        out = subprocess.run(["netstat", "-ano", "-p", "TCP"],
                             capture_output=True, text=True, timeout=10,
                             creationflags=subprocess.CREATE_NO_WINDOW).stdout
    except Exception:
        return None
    suffix = f":{port}"
    for line in out.splitlines():
        f = line.split()
        if len(f) < 4 or not f[-1].isdigit():
            continue
        if f[1].endswith(suffix):
            return int(f[-1])
    return None


def _is_our_backend(pid: int) -> bool:
    """确认这个 PID 确实是我们的解释器进程再动手 —— PID 会被系统复用，
    光凭一个数字去杀进程是危险的。

    两种都认：托盘拉起来的是 **pythonw.exe**（无控制台），
    用户用排障脚本手工起来的是 **python.exe**（有控制台）。
    前提是这台进程的端口已经被 `probe_existing_instance` 验过
    —— 它回的是本程序的健康检查（`app == "world-keeper"`），不是随便一个 HTTP 服务。
    """
    try:
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                             capture_output=True, text=True, timeout=10,
                             creationflags=subprocess.CREATE_NO_WINDOW).stdout
    except Exception:
        return False
    first = out.strip().split(",")[0].strip().strip('"').lower()
    return first in ("pythonw.exe", "python.exe")


class App:
    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.port: int | None = None
        self.quitting = False
        self.stopping = False          # True = 我们主动在停，别把「正常退出」当「挂了」
        #: True = 后端不是本启动器拉起的（上一轮托盘崩了、或用排障脚本手工起的），
        #: 我们只是「接管」了它 —— 退出时的收尾方式不一样，见 stop_backend。
        self.adopted = False

    # -- 后端 ---------------------------------------------------------

    def start_backend(self) -> bool:
        """拉起后端子进程。成功与否看**健康检查**，不是看进程还活着 ——
        起来又立刻退出（比如端口被占还配了零次重扫）这种事，进程表看不出来。

        **或者接管一个已经在跑的后端。** 这一条是补的：以前发现后端在跑就直接
        打开浏览器退出，于是「有后端、没托盘」这个状态永远修不回来 ——
        用户上次托盘崩了之后，双击图标只会开个网页，托盘再也回不来。
        """
        if self.proc and self.proc.poll() is None:
            return True

        settings = config.load_settings(reload=True)
        self.port = settings.port
        self.adopted = False

        #: `WKV_FORCE_START=1` 强制自己重新起一个（测试 / 排障用）。
        #: 默认「能接就接」—— 多起来一个后端只会抢端口，没有半点好处。
        if not os.environ.get("WKV_FORCE_START"):
            found = runtime.probe_existing_instance(settings.port, settings.port_scan)
            if found:
                self.adopted = True
                self.port = found
                log(f"接管已在运行的后端：http://127.0.0.1:{found}（不是本启动器拉起的）")
                return True

        pythonw = RUNTIME / "pythonw.exe"
        if not pythonw.exists():
            pythonw = Path(sys.executable)          # 兜底：就用自己这个解释器

        log_path = paths.logs_dir() / "service-stdout.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)

        log(f"启动后端：{pythonw.name} -m app.main（cwd={APP_ROOT}）")
        fh = open(log_path, "ab")                    # 追加 —— 崩溃现场要留底
        try:
            self.proc = subprocess.Popen(
                [str(pythonw), "-m", "app.main"],
                cwd=str(APP_ROOT),
                stdin=subprocess.DEVNULL,
                stdout=fh, stderr=fh,               # 后端自己也会写日志；这里兜住没被日志接住的输出
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        finally:
            fh.close()
        log(f"后端 pid={self.proc.pid}")

        ok = self.wait_healthy(20)
        if ok:
            log(f"后端就绪：http://127.0.0.1:{self.port}")
        else:
            log("⚠️ 后端 20s 内没通过健康检查（详情见 service-stdout.log 与 logs/）")
        return ok

    def wait_healthy(self, seconds: float) -> bool:
        """等健康检查通过；顺带把**真实端口**摸出来（配置的端口可能被占而顺延）。"""
        settings = config.load_settings()
        deadline = time.time() + seconds
        while time.time() < deadline:
            if self.proc and self.proc.poll() is not None:
                return False                          # 已经退了，别再等
            found = runtime.probe_existing_instance(settings.port, settings.port_scan)
            if found:
                self.port = found
                return True
            time.sleep(0.5)
        return False

    def stop_backend(self, wait: float = 8.0) -> None:
        if self.adopted:
            self._stop_adopted()
            return
        if not (self.proc and self.proc.poll() is None):
            return
        self.stopping = True
        try:
            # 先走后端自己的关闭路径（优雅）：敲 /api/… 没有专门的关闭端点，
            # 就直接 terminate —— uvicorn 对 SIGTERM 的处理就是跑优雅关闭钩子
            self.proc.terminate()
            try:
                self.proc.wait(wait)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(5)
        finally:
            self.stopping = False

    def _stop_adopted(self) -> None:
        """收尾一个「接管来的」后端。

        我们手里没有它的 Popen，只能靠端口反查 PID，**并且必须确认那个 PID
        真的是我们的 pythonw.exe 再动手** —— PID 会被系统复用，
        光凭一个数字去杀进程是危险的（可能杀掉别人刚启动的东西）。

        查不到就老老实实留着它跑，并在日志里写明：宁可留一个后台进程，
        也不能冒杀错进程的风险。
        """
        self.stopping = True
        try:
            pid = _pid_listening_on(self.port or 0) if self.port else None
            if not pid or not _is_our_backend(pid):
                log("接管的后端定位不到（端口/PID 查不到），保留它继续运行")
                return
            log(f"结束接管的后端 pid={pid}")
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                           capture_output=True, timeout=15,
                           creationflags=subprocess.CREATE_NO_WINDOW)
        finally:
            self.stopping = False

    def restart_backend(self) -> None:
        log("重启服务…")
        self.stop_backend()
        if self.start_backend():
            self.balloon_ok("服务已重启", f"界面地址 http://127.0.0.1:{self.port}")
        else:
            self.balloon_err("服务重启失败", "详见数据目录里的日志")

    # -- 菜单动作 -----------------------------------------------------

    def _should_open_browser(self) -> bool:
        """要不要自动开浏览器。

        判据在 `runtime.browser_allowed` —— 与后端**共用同一份**，别在这里
        再写一遍：两边各写一份的话，启动器认 `WKV_OPEN_BROWSER=0` 而后端不认，
        包级冒烟（`pythonw -m app.main`）就会每跑一次弹一个浏览器窗口。
        """
        return runtime.browser_allowed(config.load_settings())

    def open_ui(self) -> None:
        port = self.port or config.load_settings().port
        url = f"http://127.0.0.1:{port}"
        webbrowser.open(url)
        log(f"打开界面 {url}")

    def open_data_dir(self) -> None:
        d = paths.data_dir()
        os.makedirs(d, exist_ok=True)
        os.startfile(str(d))                            # noqa: S606 —— 只开目录，无害
        log(f"打开数据目录 {d}")

    def open_logs(self) -> None:
        d = paths.logs_dir()
        os.makedirs(d, exist_ok=True)
        os.startfile(str(d))                            # noqa: S606
        log(f"打开日志目录 {d}")

    def about(self) -> None:
        import app as app_pkg
        self.balloon_ok(
            f"{BRAND} {getattr(app_pkg, '__version__', '')}",
            f"数据目录：{paths.data_dir()}\n界面：http://127.0.0.1:{self.port}",
        )

    def on_menu(self, mid: int) -> None:
        if mid == M_OPEN_UI:
            self.open_ui()
        elif mid == M_OPEN_DATA:
            self.open_data_dir()
        elif mid == M_OPEN_LOGS:
            self.open_logs()
        elif mid == M_RESTART:
            self.restart_backend()
        elif mid == M_ABOUT:
            self.about()
        elif mid == M_QUIT:
            self.quitting = True
            user32.PostMessageW(self.tray.hwnd, WM_CLOSE, 0, 0)

    # -- 看护线程 -----------------------------------------------------

    def watch(self) -> None:
        """后台线程：盯着后端。挂了（且不是我们在停）就弹气泡提示。

        为什么单独一个线程：主线程在跑 Windows 消息循环，不能被轮询卡住。
        线程里**不能直接碰窗口**（Win32 窗口归属创建它的线程），所以
        只用 user32.PostMessageW 投消息回去，UI 动作全在主线程做。
        """
        log("看护线程启动")
        while not self.quitting:
            time.sleep(3)
            if self.quitting or self.stopping:
                continue
            if self.proc and self.proc.poll() is not None:
                code = self.proc.returncode
                log(f"后端进程退出，returncode={code}")
                if code == 0:
                    continue                            # 正常退出（用户在配置里关了？）
                # 投一个「重启」请求回主线程 —— 菜单动作那里已经会处理
                try:
                    hwnd = self.tray.hwnd
                    if hwnd:
                        user32.PostMessageW(hwnd, WM_COMMAND, M_RESTART, 0)
                        self.balloon_err("服务停止了", "正在尝试自动重启…")
                except Exception:
                    pass

    # -- 生命周期 -----------------------------------------------------

    def run(self) -> int:
        # ① 启动器自身的单实例：互斥量。**必须是第一步。**
        #
        # 原来的顺序相反：先探后端，发现后端在跑就直接打开浏览器退出。
        # 那个顺序害了两件事：
        #   1. 「有后端、没托盘」这个状态永远修不回来 —— 上次托盘崩了之后，
        #      双击图标只会开个网页，托盘再也回不来；
        #   2. 它把 P0 那个「双击图标静默死亡」彻底藏住了 ——
        #      开发机上一直有个 8765 的残留后端，冒烟测试每次都从这条短路出去，
        #      托盘创建那段代码**一次都没真正执行过**，直到 VM 干净机器上才炸。
        # 现在改成：先占互斥量 → 建托盘 → 再决定后端是自己起还是接管。
        mutex = kernel32.CreateMutexW(None, False, MUTEX_NAME)
        if mutex and kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
            # 已经有托盘在跑了 —— 这才是「点一下图标只想要界面」的场景
            running = runtime.probe_existing_instance(config.load_settings().port,
                                                      config.load_settings().port_scan)
            log(f"已有启动器在跑（端口 {running or '未知'}），只打开界面")
            if running:
                webbrowser.open(f"http://127.0.0.1:{running}")
            return 0

        self.tray = Tray(self)
        self.tray.create_window()
        self.tray.add_icon()
        # 这一行是冒烟测试的抓手：日志里出现它 = 托盘创建这条完整路径真的跑通了
        log("托盘已就绪")

        if not self.start_backend():
            self.balloon_err("服务启动失败",
                             f"开始菜单里运行「{BRAND} 启动（排障模式）」看详细输出")
        elif self.adopted:
            # 接管的情况要说清楚：这个后端的生死不归我们管，退出时按 _stop_adopted 处理
            self.balloon_ok(f"{BRAND} 已接管运行中的服务",
                            f"http://127.0.0.1:{self.port}")
        else:
            self.balloon_ok(f"{BRAND} 已启动", f"http://127.0.0.1:{self.port}")

        if self.port and self._should_open_browser():
            self.open_ui()

        import threading
        threading.Thread(target=self.watch, daemon=True).start()

        # ③ 消息循环
        while self.tray.pump(250):
            if self.quitting:
                break

        log("开始退出")
        self.stop_backend()
        self.tray.remove_icon()
        log("已退出")
        return 0

    # 气泡的便捷包装
    def balloon_ok(self, title: str, text: str) -> None:
        try:
            self.tray.balloon(title, text, NIIF_INFO)
        except Exception:
            pass

    def balloon_err(self, title: str, text: str) -> None:
        try:
            self.tray.balloon(title, text, NIIF_ERROR)
        except Exception:
            pass


def main() -> int:
    # 先自检再干活。顺序不能反：漏声明 argtypes 的后果是静默死亡，
    # 所以必须赶在任何 Win32 调用之前把问题变成一条**能读到的日志**。
    missing = _selftest_win32()
    if missing:
        log("启动器自检失败：以下 Win32 调用缺 argtypes，64 位下会静默崩溃 —— "
            + "、".join(missing))
        return 3
    app = App()
    try:
        return app.run()
    except Exception:
        import traceback
        log("启动器异常：\n" + traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.exit(main())
