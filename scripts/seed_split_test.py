"""给浏览器实测造点数据：一张底图 + 三张互连的地图（世界/北境/地狱）。

纯标准库生成 PNG，不依赖 Pillow。
"""

from __future__ import annotations

import json
import struct
import sys
import zlib
from pathlib import Path

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8799"
BOOK = "splitdemo"
W, H = 960, 600


def png_bytes(w: int, h: int) -> bytes:
    """一张带网格的世界地图底图（浅底 + 深色经纬线）。"""
    rows = []
    for y in range(h):
        row = bytearray([0])  # filter type 0
        for x in range(w):
            r, g, b = 232, 226, 210
            if x % 120 == 0 or y % 120 == 0:
                r, g, b = 205, 196, 176
            if abs(x - w // 2) < 2 or abs(y - h // 2) < 2:
                r, g, b = 150, 140, 120
            row += bytes((r, g, b))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6))
            + chunk(b"IEND", b""))


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=30.0)
    img = png_bytes(W, H)
    r = c.post("/api/assets/maps", files={"file": ("world.png", img, "image/png")})
    r.raise_for_status()
    name = r.json()["name"]
    print("底图已上传：", name)

    doc = {
        "schema": 2,
        "maps": {
            "world": {"id": "world", "title": "世界图", "image": f"maps/{name}",
                      "width": W, "height": H, "parent": None, "note": "三层世界观的顶层",
                      "pins": [
                          {"id": "pw1", "x": 0.28, "y": 0.34, "label": "灰烬之地", "kind": None, "color": None},
                          {"id": "pw2", "x": 0.62, "y": 0.55, "label": "灰堡城", "portal": "north",
                           "kind": None, "color": None},
                          {"id": "pw3", "x": 0.80, "y": 0.22, "label": "地狱入口", "portal": "hell",
                           "kind": None, "color": None},
                      ],
                      "regions": [
                          {"id": "rg1", "name": "北境", "points": [[0.34, 0.2], [0.62, 0.2],
                                                                   [0.66, 0.62], [0.36, 0.66]],
                           "fill": "#3f8f4f", "opacity": 0.25},
                      ]},
            "north": {"id": "north", "title": "北境详图", "image": f"maps/{name}",
                      "width": W, "height": H, "parent": "world", "note": "世界图的子图",
                      "pins": [{"id": "pn1", "x": 0.45, "y": 0.5, "label": "灰堡城",
                                "kind": None, "color": None}], "regions": []},
            "hell": {"id": "hell", "title": "地狱图", "image": f"maps/{name}",
                     "width": W, "height": H, "parent": None,
                     "note": "和凡界平级，靠门户相连 —— 不是凡界的子图",
                     "pins": [], "regions": []},
        },
        "order": ["world", "north", "hell"],
    }
    r = c.put(f"/api/books/{BOOK}/maps", json=doc)
    r.raise_for_status()
    print("地图已落盘：", r.json())

    print("\n磁盘：")
    for p in sorted((Path(".e2e-split") / "books" / BOOK / "view" / "maps").iterdir()):
        print("  ", p.name, p.stat().st_size, "B" if p.is_file() else "")
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
