"""P4.5.4.1 实测：走真实 HTTP + 真实磁盘，验证「一图一文件」的落盘布局。

和冒烟测试的区别：冒烟走 TestClient，这个走真 uvicorn + 真网络 + 真文件系统 ——
能抓到 TestClient 掩盖掉的东西（路径拼接、content-length 预检、原子替换）。

用法（先起服务，再跑这个）：
    WKV_DATA_DIR=.e2e-split .venv/Scripts/python.exe scripts/serve_test.py 8799 &
    .venv/Scripts/python.exe scripts/verify_split_store.py http://127.0.0.1:8799 .e2e-split
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8799"
DATA = Path(sys.argv[2] if len(sys.argv) > 2 else ".e2e-split").resolve()

PASS = 0
FAIL = 0


def check(label: str, cond: bool, extra: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [OK]   {label}")
    else:
        FAIL += 1
        print(f"  [FAIL] {label}\n         {extra}")


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=20.0)
    book = "splitdemo"
    view = DATA / "books" / book / "view"
    maps_dir = view / "maps"

    # 干净起步
    shutil.rmtree(DATA / "books" / book, ignore_errors=True)

    r = c.post("/api/books", json={"book_id": book, "title": "拆分实测"})
    check("建书 201", r.status_code == 201, r.text[:200])

    doc = {
        "schema": 1,
        "maps": {
            "world": {"id": "world", "title": "世界图", "image": "maps/w.png",
                      "width": 1600, "height": 1000, "parent": None, "note": "",
                      "pins": [{"id": "p1", "x": 0.2, "y": 0.3},
                               {"id": "p2", "x": 0.5, "y": 0.6, "portal": "north"}],
                      "regions": [{"id": "r1", "name": "北境",
                                   "points": [[0, 0], [1, 0], [0.5, 1]], "opacity": 0.3}]},
            "north": {"id": "north", "title": "北境图", "image": "maps/n.png",
                      "width": 1200, "height": 900, "parent": "world", "note": "",
                      "pins": [{"id": "n1", "x": 0.4, "y": 0.4}], "regions": []},
            "hell": {"id": "hell", "title": "地狱图", "image": "maps/h.png",
                     "width": 1000, "height": 1000, "parent": None, "note": "平级，不是子图",
                     "pins": [], "regions": []},
        },
        "order": ["world", "north", "hell"],
    }

    r = c.put(f"/api/books/{book}/maps", json=doc)
    j = r.json()
    check("首次 PUT 200", r.status_code == 200, r.text[:200])
    check("首次写盘写了 3 张图", j.get("written") == 3, str(j))

    # ---- 磁盘布局 ----
    check("目录叫 view/maps/", maps_dir.is_dir(), str(maps_dir))
    check("index.json 在", (maps_dir / "index.json").is_file(), str(maps_dir))
    check("三张图各自一个文件",
          all((maps_dir / f"{m}.json").is_file() for m in ("world", "north", "hell")),
          str(sorted(p.name for p in maps_dir.iterdir())))
    check("没有留下 .tmp 半截文件",
          not list(maps_dir.glob("*.tmp")), str(list(maps_dir.glob("*.tmp"))))

    idx = json.loads((maps_dir / "index.json").read_text(encoding="utf-8"))
    check("目录里 order 齐全", idx["order"] == ["world", "north", "hell"], str(idx["order"]))
    check("目录不含点位（点位在单图文件里）",
          "pins" not in idx["maps"]["world"] and "regions" not in idx["maps"]["world"],
          str(idx["maps"]["world"]))
    check("目录里带 rev 指纹", len(idx["maps"]["world"].get("rev", "")) == 16, str(idx["maps"]["world"]))

    world_content = json.loads((maps_dir / "world.json").read_text(encoding="utf-8"))
    check("单图文件里是点位与区域",
          len(world_content["pins"]) == 2 and len(world_content["regions"]) == 1,
          str(world_content)[:200])

    # ---- 增量落盘 ----
    r = c.put(f"/api/books/{book}/maps", json=doc)
    check("一个字段都没改 → written=0", r.json()["written"] == 0, r.text[:200])

    doc["maps"]["north"]["pins"][0]["x"] = 0.9
    r = c.put(f"/api/books/{book}/maps", json=doc)
    check("只挪北境图的一个点 → written=1", r.json()["written"] == 1, r.text[:200])

    # ---- 删图 → 孤儿文件清掉 ----
    doc["maps"].pop("hell")
    doc["order"].remove("hell")
    r = c.put(f"/api/books/{book}/maps", json=doc)
    check("删掉一张图 → removed=1", r.json()["removed"] == 1, r.text[:200])
    check("孤儿内容文件真被删了", not (maps_dir / "hell.json").is_file(), str(maps_dir))
    check("目录里也没了",
          "hell" not in json.loads((maps_dir / "index.json").read_text(encoding="utf-8"))["maps"], "")

    # ---- 删索引重建：地图还在 ----
    r = c.post("/api/admin/rebuild-index")
    check("重建索引 200", r.status_code == 200, r.text[:200])
    d = c.get(f"/api/books/{book}/maps").json()
    check("重建索引后地图与点位原样", len(d["maps"]) == 2 and len(d["maps"]["world"]["pins"]) == 2,
          str(list(d["maps"])))

    # ---- 迁移：手写一份老的单文件 maps.json ----
    shutil.rmtree(maps_dir)
    (view / "maps.json").write_text(json.dumps({
        "schema": 1,
        "maps": {"legacyworld": {"id": "legacyworld", "title": "旧世界", "image": "",
                                 "width": 800, "height": 600, "parent": None, "note": "",
                                 "pins": [{"id": "lp", "x": 0.11, "y": 0.22}], "regions": []}},
        "order": ["legacyworld"],
    }, ensure_ascii=False), encoding="utf-8")

    d = c.get(f"/api/books/{book}/maps").json()
    check("旧文件读得出来", list(d["maps"]) == ["legacyworld"], str(list(d["maps"])))
    check("迁移后生成 index.json", (maps_dir / "index.json").is_file(), str(maps_dir))
    check("迁移后生成单图文件", (maps_dir / "legacyworld.json").is_file(), str(maps_dir))
    check("旧文件改名留档", (view / "maps.json.migrated").is_file(), str(view))
    check("老的 maps.json 已不在", not (view / "maps.json").is_file(), str(view))

    # ---- 目录里被拿掉的图：内容文件也该清掉 ----
    stray = maps_dir / "stray.json"
    stray.write_text('{"schema":2,"id":"stray","pins":[],"regions":[]}', encoding="utf-8")
    idx = json.loads((maps_dir / "index.json").read_text(encoding="utf-8"))
    idx["maps"]["stray"] = {"title": "多出来的", "image": "", "width": 0, "height": 0,
                            "parent": None, "note": "", "rev": "deadbeef"}
    (maps_dir / "index.json").write_text(json.dumps(idx, ensure_ascii=False), encoding="utf-8")
    c.put(f"/api/books/{book}/maps", json={
        "maps": {"legacyworld": {"id": "legacyworld", "title": "旧世界", "pins": [], "regions": []}},
        "order": ["legacyworld"]})
    check("目录里没有的图，内容文件一并清掉", not stray.is_file(), str(stray))

    # ---- 非法 id（路径穿越）----
    r = c.put(f"/api/books/{book}/maps", json={
        "maps": {"../../pwned": {"id": "../../pwned", "title": "x", "pins": [], "regions": []}},
        "order": ["../../pwned"]})
    check("带 ../ 的 id 不炸（200 收下但丢弃）", r.status_code == 200, r.text[:200])
    check("view/ 之外没被写出文件", not (DATA / "pwned.json").is_file(), str(DATA))

    print(f"\n{'=' * 48}")
    print(f"  通过 {PASS} 项，失败 {FAIL} 项")
    print(f"{'=' * 48}")
    c.close()
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
