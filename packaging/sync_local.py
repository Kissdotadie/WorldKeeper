"""把当前源码同步到本机的两份已装副本（不重新打包）。

用法：.venv/Scripts/python.exe packaging/sync_local.py

同步什么：
    app/            → 两份的 app/          （后端代码，含新接口 outline.py）
    web/dist/       → 两份的 web/dist/     （前端产物，含五视图结构 + 导入面板）
    launcher.py     → 两份根目录
    debug-start.bat → 两份根目录

刻意**不**碰的东西：
    config/config.yaml  —— 安装版的这份是安装向导填的（指向真实数据目录），
                           覆盖它等于把人的数据目录改没了。
    data/               —— 安装版程序目录里那份 data/ 不动（来路存疑，但不是今天的事）。
    Lib/ runtime/       —— 依赖与解释器没变，动了纯属浪费时间。
    许可与致谢.txt 等   —— 本轮没有依赖变化，文档原样。

为什么用 sync_tree 而不是整棵删了重拷：
    1. 增量拷贝只写变了的文件；
    2. 本环境有「单次大量删除」保护闸，全量删会中途断掉。
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packaging"))

import build  # noqa: E402  （只借它的 sync_tree / copy_tree / EXCLUDE_*，不跑 main）

TARGETS = [
    build.APP_DIR,                                # 绿色包 packaging/out/WorldKeeper
    Path(r"D:\Program Files\WorldKeeper"),        # 安装版
]


def main() -> int:
    src_app = ROOT / "app"
    src_web = ROOT / "web" / "dist"
    problems: list[str] = []

    for target in TARGETS:
        print(f"\n=== {target} ===")
        if not target.is_dir():
            problems.append(f"{target} 不存在，跳过")
            print("  ⚠ 目录不存在，跳过")
            continue

        # 后端代码
        n_app = build.copy_tree(src_app, target / "app")
        print(f"  app/          覆盖 {n_app} 个文件")

        # 前端产物
        n_web, n_gone = build.sync_tree(src_web, target / "web" / "dist")
        print(f"  web/dist/     覆盖 {n_web} 个文件（清掉 {n_gone} 个源里已没有的）")

        # 启动器与排障脚本
        for name in ("launcher.py", "debug-start.bat"):
            src = ROOT / "packaging" / ("launcher.py" if name == "launcher.py" else "assets/debug-start.bat")
            if src.exists():
                shutil.copy2(src, target / name)
                print(f"  {name:15s} 覆盖 1 个文件")

        # 版本号落位确认
        marker = target / "app" / "__init__.py"
        got = ""
        for line in marker.read_text(encoding="utf-8").splitlines():
            if line.startswith("__version__"):
                got = line.split("=", 1)[1].strip().strip('"')
                break
        print(f"  版本号 → {got}")

    print("\n" + "=" * 52)
    if problems:
        print("  有跳过的目标：")
        for p in problems:
            print(f"   - {p}")
    print("  完成。改了后端代码，**正在跑的实例要重启才生效**。")
    print("=" * 52)
    return 0


if __name__ == "__main__":
    sys.exit(main())
