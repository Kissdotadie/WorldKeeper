"""给 8799 测试实例灌一份地图验收用的假数据（只写临时数据目录）。

    先起服务：  WKV_DATA_DIR=.e2e-region .venv/Scripts/python.exe scripts/serve_test.py 8799
    再灌数据：  .venv/Scripts/python.exe scripts/seed_region_test.py 8799

做三件事：建一册书、生成一张带网格的演示底图并上传、建几个地点实体。
底图是现画的（不是小说素材），测完连目录一起删掉。
"""

from __future__ import annotations

import io
import sys

import httpx
from PIL import Image, ImageDraw

BASE = f"http://127.0.0.1:{sys.argv[1] if len(sys.argv) > 1 else 8799}"
BOOK = "地图验收"
LOCS = ["灰烬之地", "灰堡城", "白鸦渡", "铁砧岭", "寒鸦港", "青石关"]

#: 地点之间的 [[双链]]。
#:
#: ⚠️ **必须补上**：关系图默认**不显示孤立节点**（`include_isolated` 默认关），
#: 一册全是孤立实体的书，在关系网/世界观里就是**一张空图** —— 画布上一个点都没有。
#: 依赖「点中一个节点，再按 Esc」的验收会整段失效，且报出来的失败像是 UI 坏了
#: （2026-10-03 就是这样被误导了一轮）。灌数据时顺手连起来，别让后来人再踩。
LINKS: dict[str, list[str]] = {
    "灰堡城": ["灰烬之地"],
    "白鸦渡": ["灰烬之地"],
    "铁砧岭": ["灰堡城"],
    "寒鸦港": ["白鸦渡"],
    "青石关": ["铁砧岭"],
    "内城": ["灰堡城"],
}


def main() -> None:
    c = httpx.Client(timeout=20)
    r = c.post(f"{BASE}/api/books", json={"book_id": BOOK, "title": BOOK})
    print("book:", r.status_code, r.text[:120])

    # 一张 1600x1000 的"手绘地图"：米色纸 + 网格 + 几块色斑
    img = Image.new("RGB", (1600, 1000), (243, 235, 216))
    d = ImageDraw.Draw(img)
    for x in range(0, 1600, 100):
        d.line([(x, 0), (x, 1000)], fill=(226, 216, 194), width=1)
    for y in range(0, 1000, 100):
        d.line([(0, y), (1600, y)], fill=(226, 216, 194), width=1)
    d.ellipse([180, 180, 700, 560], fill=(214, 224, 206), outline=(160, 178, 150), width=3)
    d.polygon([(900, 200), (1300, 300), (1400, 640), (1000, 700)], fill=(230, 214, 196), outline=(186, 160, 132))
    d.rectangle([300, 660, 800, 900], fill=(206, 216, 228), outline=(150, 168, 190), width=3)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    r = c.post(f"{BASE}/api/assets/maps", files={"file": ("demo-world.png", buf.getvalue(), "image/png")})
    print("asset:", r.status_code, r.text[:120])

    for i, name in enumerate(LOCS):
        r = c.post(
            f"{BASE}/api/books/{BOOK}/entities",
            json={"type": "location", "name": name, "summary": f"验收用地点 {i + 1}"},
        )
        print(f"  {name}:", r.status_code)

    # 一张子图，用来验证下钻入口 + 多层
    r = c.post(f"{BASE}/api/books/{BOOK}/entities",
               json={"type": "location", "name": "内城", "summary": "灰堡城的里层"})
    print("  内城:", r.status_code)

    # ---- 补关联（见文件顶部 LINKS 的说明：不补就是一张空图）----
    # 用 PUT 补，所以**重复跑本脚本也安全**（不会重复建实体，只把关联写齐）。
    items = c.get(f"{BASE}/api/books/{BOOK}/entities", params={"limit": 200}).json()["items"]
    ids = {e["name"]: e["id"] for e in items}
    for name, targets in LINKS.items():
        if name not in ids:
            continue
        body = {"关联": [f"[[{t}]]" for t in targets if t in ids]}
        r = c.put(f"{BASE}/api/books/{BOOK}/entities/{ids[name]}",
                  json={"type": "location", "name": name, "body": body})
        print(f"  关联 {name} → {'、'.join(targets)}:", r.status_code)
    print("done")


if __name__ == "__main__":
    main()
