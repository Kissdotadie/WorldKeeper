"""给测试实例灌一份「地图层级与规模」验收用的假数据（只写临时数据目录）。

    先起服务：  WKV_DATA_DIR=.e2e-nav .venv/Scripts/python.exe scripts/serve_test.py 8799
    再灌数据：  .venv/Scripts/python.exe scripts/seed_map_tree_test.py 8799

造的是 **P4.5.4 那 4 项**要看的东西：

1. **一棵 8 层的树**（宇宙 › 凡界 › 大陆 › 帝国 › 行省 › 城市 › 城区 › 建筑）
   —— 用来验「缩进封顶后第 5 层起不再往右挪」和「面包屑超过 4 层折叠」。
2. **一份平级的兄弟图**（神界，和凡界同挂在宇宙下）
   —— 三界平级不是父子，这是世界观模型里最容易写错的地方。
3. **一张图上凑齐三种门户**（凡界图上放三个点）：
   - 通到自己的子孙 → ▼ 钻进去
   - 通到自己的上一层 → ▲ 回外层
   - 通到兄弟图（无直系关系）→ ⇄ 跨空间
4. **两套层级标签**（宇宙/位面/大陆/帝国/行省/城市/城区/建筑），
   用来验左栏按标签筛选与配色。

底图是现画的（不是小说素材），测完连目录一起删掉。
"""

from __future__ import annotations

import io
import sys

import httpx
from PIL import Image, ImageDraw

BASE = f"http://127.0.0.1:{sys.argv[1] if len(sys.argv) > 1 else 8799}"
BOOK = "地图层级验收"

# (id, 标题, 层级标签, 父图 id)
TREE: list[tuple[str, str, str, str | None]] = [
    ("m1", "宇宙总图", "宇宙", None),
    ("m2", "凡界·世界图", "位面", "m1"),
    ("m3", "太古大陆", "大陆", "m2"),
    ("m4", "晨曦帝国", "帝国", "m3"),
    ("m5", "北境行省", "行省", "m4"),
    ("m6", "灰堡城", "城市", "m5"),
    ("m7", "内城区", "城区", "m6"),
    ("m8", "灰堡主堡", "建筑", "m7"),
    # 兄弟图：和凡界同挂宇宙下，但两张图之间没有父子关系
    ("m9", "神界图", "位面", "m1"),
]

LOCS = ["灰烬之地", "灰堡城", "白鸦渡", "铁砧岭", "寒鸦港", "青石关"]


def make_image() -> bytes:
    """一张 1600x1000 的「手绘地图」：米色纸 + 网格 + 几块色斑。"""
    img = Image.new("RGB", (1600, 1000), (243, 235, 216))
    d = ImageDraw.Draw(img)
    for x in range(0, 1600, 100):
        d.line([(x, 0), (x, 1000)], fill=(226, 216, 194), width=1)
    for y in range(0, 1000, 100):
        d.line([(0, y), (1600, y)], fill=(226, 216, 194), width=1)
    d.ellipse([180, 180, 700, 560], fill=(214, 224, 206), outline=(160, 178, 150), width=3)
    d.polygon(
        [(900, 200), (1300, 300), (1400, 640), (1000, 700)],
        fill=(230, 214, 196),
        outline=(186, 160, 132),
    )
    d.rectangle([300, 660, 800, 900], fill=(206, 216, 228), outline=(150, 168, 190), width=3)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def main() -> None:
    c = httpx.Client(timeout=30, trust_env=False)
    r = c.post(f"{BASE}/api/books", json={"book_id": BOOK, "title": BOOK})
    print("book:", r.status_code, r.text[:140])

    r = c.post(
        f"{BASE}/api/assets/maps",
        files={"file": ("demo-level.png", make_image(), "image/png")},
    )
    print("asset:", r.status_code, r.text[:140])
    name = r.json().get("name") or "demo-level.png"
    image = f"maps/{name}"

    # 地点按名字补齐（重跑时不重复建）
    have = {e["name"] for e in c.get(f"{BASE}/api/books/{BOOK}/entities").json()["items"]}
    for nm in LOCS:
        if nm in have:
            print(f"  {nm}: 已有，跳过")
            continue
        r = c.post(
            f"{BASE}/api/books/{BOOK}/entities",
            json={"type": "location", "name": nm, "summary": f"层级验收用地点 · {nm}"},
        )
        print(f"  {nm}:", r.status_code)

    ents = {
        e["name"]: e["id"]
        for e in c.get(f"{BASE}/api/books/{BOOK}/entities").json()["items"]
    }
    print("entities:", len(ents))

    def pin(pid: str, name: str, x: float, y: float, portal: str | None = None) -> dict:
        return {
            "id": pid,
            "entity_id": ents.get(name),
            "label": "",
            "x": x,
            "y": y,
            "portal": portal,
            "kind": None,
            "color": None,
            "note": "",
        }

    maps: dict[str, dict] = {}
    for mid, title, level, parent in TREE:
        maps[mid] = {
            "id": mid,
            "title": title,
            "image": image,
            "width": 1600,
            "height": 1000,
            "parent": parent,
            "level": level,
            "note": "",
            "pins": [],
            "regions": [],
        }

    # 凡界图上凑齐三种门户
    maps["m2"]["pins"] = [
        pin("p_down", "铁砧岭", 0.30, 0.34, "m3"),   # 子孙 → ▼
        pin("p_up", "灰烬之地", 0.68, 0.30, "m1"),   # 祖先 → ▲
        pin("p_side", "寒鸦港", 0.50, 0.72, "m9"),   # 兄弟 → ⇄
        pin("p_plain", "白鸦渡", 0.20, 0.70),        # 无门户，对照组
    ]
    maps["m3"]["pins"] = [pin("p_city", "灰堡城", 0.55, 0.46, "m6")]
    maps["m1"]["pins"] = [pin("p_blue", "青石关", 0.40, 0.50, "m2")]

    doc = {"maps": maps, "order": [mid for mid, *_ in TREE]}
    r = c.put(f"{BASE}/api/books/{BOOK}/maps", json=doc)
    print("maps:", r.status_code, r.text[:200])

    got = c.get(f"{BASE}/api/books/{BOOK}/maps").json()
    for mid, title, level, parent in TREE:
        m = got["maps"][mid]
        print(f"  {title:<12} level={m['level']:<4} parent={m['parent']} pins={len(m['pins'])}")
    print("done →", f"{BASE}/ 的「地理观 → 地图」")


if __name__ == "__main__":
    main()
