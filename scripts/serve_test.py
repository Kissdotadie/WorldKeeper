"""起一个临时的测试实例（换个端口，不动用户正在用的那个）。

用法：
    .venv/Scripts/python.exe scripts/serve_test.py [port]

为什么要单起一个：用户可能正开着 8765 / 8020 在用，改了后端路由之后
那两个实例不会自动加载新代码（启动没带 --reload）。要实测新东西就得
另开一个，测完直接关掉，不打扰正在用的那个。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import uvicorn  # noqa: E402

from app.main import create_app  # noqa: E402

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
    uvicorn.run(create_app(), host="127.0.0.1", port=port, log_level="warning")
