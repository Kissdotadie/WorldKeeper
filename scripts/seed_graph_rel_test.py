"""给「图上删关系」验收造两条关联（只写临时数据目录）。

    .venv/Scripts/python.exe scripts/seed_graph_rel_test.py 8799

把「灰堡城」的关联段写成两条 [[双链]]，然后在关系网里双击它、
点 ✕ 删掉一条，比对档案是否真的少了那一行。
"""

from __future__ import annotations

import sys

import httpx

BASE = f"http://127.0.0.1:{sys.argv[1] if len(sys.argv) > 1 else 8799}"
BOOK = "地图验收"

RELS = ["坐落于：[[灰烬之地]]", "毗邻：[[白鸦渡]]"]


def main() -> None:
    c = httpx.Client(timeout=20, trust_env=False)

    r = c.get(f"{BASE}/api/books/{BOOK}/entities")
    r.raise_for_status()
    items = r.json()["items"]
    by_name = {e["name"]: e for e in items}
    print("实体：", list(by_name))

    src = by_name["灰堡城"]
    r = c.put(
        f"{BASE}/api/books/{BOOK}/entities/{src['id']}",
        json={"type": src["type"], "name": src["name"], "summary": src.get("summary") or "验收用",
              "body": {"关联": RELS}},
    )
    print("写关联:", r.status_code, r.text[:120])

    r = c.get(f"{BASE}/api/books/{BOOK}/entities/{src['id']}")
    print("回读关联:", r.json().get("body", {}).get("关联"))
    print("SRC_ID", src["id"])
    print("done")


if __name__ == "__main__":
    main()
