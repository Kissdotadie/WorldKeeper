"""导入检查：验证 launcher.py 能不能在打包形态下干净导入。

跑这个而不是直接 import，是因为 launcher 在模块顶层就干了三件事：
建 WinDLL、设 restype/argtypes、from app import … —— 任何一处
名字拼错 / API 挂错 DLL，都要在**这里**炸出来，而不是等用户双击时。

用法：.venv/Scripts/python.exe packaging/import_check.py
退出码 0 = 干净；非 0 = 有问题（把输出贴给我就行）。
"""
import ctypes
import importlib.util as _iu
import io
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))              # 让 `import app` 可用
sys.path.insert(0, str(ROOT / "packaging"))

buf = io.StringIO()


def check(label, fn):
    try:
        val = fn()
        buf.write(f"OK   {label}: {val}\n")
    except Exception as exc:
        buf.write(f"FAIL {label}: {type(exc).__name__}: {exc}\n")
        raise


def main() -> int:
    spec = _iu.spec_from_file_location("launcher_under_test",
                                       ROOT / "packaging" / "launcher.py")
    mod = _iu.module_from_spec(spec)
    check("模块导入", lambda: (spec.loader.exec_module(mod), "通过")[1])
    check("WNDPROC 已自定义（wintypes 里没有）", lambda: mod.WNDPROC.__name__)
    check("LRESULT 宽度（位）", lambda: ctypes.sizeof(mod.LRESULT) * 8)
    check("DefWindowProcW 返回值宽度（位）",
          lambda: ctypes.sizeof(mod.user32.DefWindowProcW.restype) * 8)
    check("LoadImageW 返回值宽度（位）",
          lambda: ctypes.sizeof(mod.user32.LoadImageW.restype) * 8)
    check("GetModuleHandleW 挂在 kernel32",
          lambda: ctypes.sizeof(mod.kernel32.GetModuleHandleW.restype) * 8)
    check("App 类", lambda: mod.App.__name__)
    check("Tray 类", lambda: mod.Tray.__name__)
    print(buf.getvalue())
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print(buf.getvalue())
        import traceback
        traceback.print_exc()
        sys.exit(1)
