"""给识别引擎造一套演示数据：一张手绘风底图 + 一本挂着它的书。

用法：
    .venv/Scripts/python.exe scripts/seed_vision_test.py

写的是 `.e2e-data`（隔离目录），不碰用户真实数据。
脚本可重复跑：底图同名覆盖，地图按 id 幂等更新。

为什么要造这张图：识别引擎的价值全在「线条乱七八糟的手绘图」上。
拿一张规规矩矩的矩形网格去测，测的只是 OpenCV 会不会找轮廓，
测不出「手抖的线、断口、重叠的地名」这些真问题。
"""

from __future__ import annotations

import math
import os
import random
import sys
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("WKV_DATA_DIR", str(ROOT / ".e2e-data"))

BOOK_ID = "验收书"
MAP_ID = "vision-demo"
W, H = 1600, 1000


def _hand_drawn_poly(pts, jitter: float = 3.0, seed: int = 0, seg: int = 10):
    """把一条折线画成「手抖过的」样子：每段之间插点并加抖动。"""
    rnd = random.Random(seed)
    out = []
    for i in range(len(pts)):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % len(pts)]
        for s in range(seg):
            t = s / seg
            out.append(
                (
                    x0 + (x1 - x0) * t + rnd.uniform(-jitter, jitter),
                    y0 + (y1 - y0) * t + rnd.uniform(-jitter, jitter),
                )
            )
    out.append(out[0])
    return out


def make_map_png() -> bytes:
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (W, H), (250, 246, 236))  # 泛黄的纸
    d = ImageDraw.Draw(img)

    # 纸纹：撒一点浅色噪点，模拟扫描件（也顺带验证引擎不会被噪点带偏）
    rnd = random.Random(7)
    for _ in range(9000):
        x, y = rnd.randrange(W), rnd.randrange(H)
        v = rnd.randrange(232, 250)
        d.point((x, y), fill=(v, v - 4, v - 12))

    def font(size: int):
        for name in ("msyh.ttc", "simhei.ttf", "msyhbd.ttc", "simsun.ttc"):
            p = Path("C:/Windows/Fonts") / name
            if p.is_file():
                try:
                    return ImageFont.truetype(str(p), size)
                except Exception:
                    continue
        return ImageFont.load_default()

    big, mid = font(38), font(30)

    # 五个区域：形状故意不规则，边界故意挨着（真实地图就是这样）
    regions = [
        {
            "name": "北境",
            "poly": [(120, 90), (560, 60), (640, 300), (430, 400), (150, 340)],
            "label": (250, 200),
        },
        {
            "name": "西荒",
            "poly": [(150, 360), (430, 415), (470, 700), (200, 830), (90, 610)],
            "label": (240, 560),
        },
        {
            "name": "中原",
            "poly": [(645, 305), (1080, 250), (1160, 560), (880, 690), (470, 700), (435, 415),
                     (560, 400)],
            "label": (740, 470),
        },
        {
            "name": "东海诸岛",
            "poly": [(1200, 300), (1460, 380), (1500, 620), (1290, 700), (1150, 520)],
            "label": (1250, 480),
        },
        {
            "name": "南岭",
            "poly": [(480, 715), (900, 705), (1000, 880), (620, 930), (420, 860)],
            "label": (660, 810),
        },
    ]

    for i, r in enumerate(regions):
        line = _hand_drawn_poly(r["poly"], jitter=4.0, seed=i * 13 + 1)
        d.line(line, fill=(40, 36, 32), width=5, joint="curve")

    # 地名：**压在区域里**，顺带验证「文字不会把空白块切碎」这件事
    for i, r in enumerate(regions):
        d.text(r["label"], r["name"], font=big, fill=(28, 24, 20))
        # 每个区域再撒一个小地名
        lx, ly = r["label"]
        d.text((lx + 20, ly + 52), f"{r['name']}城", font=mid, fill=(60, 54, 48))

    # 图外一圈装饰框（不闭合，免得被当成区域边界）
    d.line([(40, 20), (W - 60, 34), (W - 40, H - 30)], fill=(120, 110, 100), width=3)

    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def main() -> int:
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app()) as client:
        r = client.post("/api/books", json={"book_id": BOOK_ID, "title": "验收书"})
        print(f"书目：{r.status_code}（已在就 409/200 都正常）")

        png = make_map_png()
        r = client.post(
            "/api/assets/maps", files={"file": ("vision-demo.png", png, "image/png")}
        )
        if r.status_code != 201:
            print("上传底图失败：", r.status_code, r.text[:300])
            return 1
        image_ref = f"maps/{r.json()['name']}"
        print(f"底图：{image_ref}（{len(png) / 1024:.0f} KB）")

        d = client.get(f"/api/books/{BOOK_ID}/maps").json()
        doc = {"schema": d["schema"], "maps": d["maps"], "order": list(d["order"])}
        doc["maps"][MAP_ID] = {
            "id": MAP_ID,
            "title": "北境全图（识别演示）",
            "image": image_ref,
            "width": W,
            "height": H,
            "parent": None,
            "level": "区域",
            "note": "拿它试「识别」：先只带底图，区域和地名都让引擎去出候选。",
            "pins": [],
            "regions": [],
        }
        if MAP_ID not in doc["order"]:
            doc["order"].append(MAP_ID)
        r = client.put(f"/api/books/{BOOK_ID}/maps", json=doc)
        print("地图：", r.status_code, r.text[:200])

        # 顺带跑一次，确认链路是通的（真正的确认还是要在界面上点）
        r = client.post(
            f"/api/books/{BOOK_ID}/vision/analyze",
            json={"map_id": MAP_ID, "engine": "local"},
        )
        if r.status_code == 200:
            res = r.json()["result"]
            print(f"试跑：{len(res['regions'])} 块区域、{len(res['texts'])} 个地名，"
                  f"{res['elapsed_ms']}ms")
            for t in res["texts"]:
                print("   ", t["text"])
        else:
            print("试跑没成功：", r.status_code, r.text[:300])

    print(f"\n数据目录：{os.environ['WKV_DATA_DIR']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
