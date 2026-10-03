"""给「区域整体拖动」验收造一张带区域的地图（只写临时数据目录）。

    .venv/Scripts/python.exe scripts/seed_region_drag_test.py 8799

前提：先跑过 seed_region_test.py（书目与地点实体已就位）。
这里只补一份 maps 文档：1 张图 + 2 个点位 + 1 个四边形区域。
"""

from __future__ import annotations

import sys

import httpx

BASE = f"http://127.0.0.1:{sys.argv[1] if len(sys.argv) > 1 else 8799}"
BOOK = "地图验收"


def main() -> None:
    c = httpx.Client(timeout=20, trust_env=False)

    # 地点实体 id：点位与区域都要挂到已有的地点上
    r = c.get(f"{BASE}/api/books/{BOOK}/entities")
    r.raise_for_status()
    rows = r.json().get("entities", r.json() if isinstance(r.json(), list) else [])
    by_name = {e["name"]: e["id"] for e in rows}
    print("地点：", list(by_name))

    doc = {
        "schema": 2,
        "order": ["map-demo"],
        "maps": {
            "map-demo": {
                "id": "map-demo",
                "title": "灰烬之地全图",
                "image": "maps/demo-world.png",
                "width": 1600,
                "height": 1000,
                "parent": None,
                "level": "世界",
                "note": "验收用",
                "pins": [
                    {
                        "id": "pin-a",
                        "entity_id": by_name.get("灰堡城"),
                        "label": "",
                        "x": 0.25,
                        "y": 0.3,
                        "portal": None,
                        "kind": None,
                        "color": None,
                        "note": "",
                    },
                    {
                        "id": "pin-b",
                        "entity_id": by_name.get("白鸦渡"),
                        "label": "",
                        "x": 0.72,
                        "y": 0.62,
                        "portal": None,
                        "kind": None,
                        "color": None,
                        "note": "",
                    },
                ],
                "regions": [
                    {
                        "id": "rgn-a",
                        "name": "灰烬之地",
                        "entity_id": by_name.get("灰烬之地"),
                        "points": [[0.40, 0.35], [0.60, 0.35], [0.60, 0.55], [0.40, 0.55]],
                        "fill": None,
                        "opacity": 0.28,
                    }
                ],
            }
        },
    }

    r = c.put(f"{BASE}/api/books/{BOOK}/maps", json={"maps_doc": doc})
    print("put maps:", r.status_code, r.text[:160])

    r = c.get(f"{BASE}/api/books/{BOOK}/maps")
    got = r.json()["maps"]["map-demo"]
    print("回读区域：", got["regions"][0]["points"])
    print("done")


if __name__ == "__main__":
    main()
