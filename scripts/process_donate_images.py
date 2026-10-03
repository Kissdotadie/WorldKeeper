"""把三张收款/加群二维码裁成统一规格的「纯码」方块。

    .venv/Scripts/python.exe scripts/process_donate_images.py

为什么裁而不只是遮：
  ①支付宝码下方的姓名行直接被裁掉（用户要求隐去真实姓名）
  ②裁完三张都是干净的方块，并排摆才好看（各自的品牌大字头由界面负责）
裁剪只动像素、不重绘二维码 —— 可扫性不受影响。

产出：data/assets/donate/{alipay,wechat,qqgroup}.png + manifest.json（sha256 清单）
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "assets" / "donate"

SRC = {
    "alipay": Path(r"F:\xwechat_files\wxid_l168fajbus2522_9af8\temp\RWTemp\2026-10\9e20f478899dc29eb19741386f9343c8\38abcdf563d281a3392c3600333a629a.jpg"),
    "wechat": Path(r"F:\xwechat_files\wxid_l168fajbus2522_9af8\temp\RWTemp\2026-10\9e20f478899dc29eb19741386f9343c8\10f59dca0ebce3a14814b11428d77d16.png"),
    "qqgroup": Path(r"F:\xwechat_files\wxid_l168fajbus2522_9af8\temp\RWTemp\2026-10\9e20f478899dc29eb19741386f9343c8\a9af2cf055e5f5b6116bb043131f66c1.jpg"),
}

#: QQ 那张的码点是**淡彩小圆点**，行密度断裂成碎片，自动检测抓不住。
#: 一次性处理，直接按目检坐标定框（原图 1117x1986）—— 比把检测写复杂更可靠。
MANUAL_BOX: dict[str, tuple[int, int, int, int]] = {
    "qqgroup": (200, 676, 916, 1392),
}


def bands(mask_rows: list[int], min_frac: float) -> list[tuple[int, int]]:
    """把「密度达标」的行号聚成连续段，返回 (起,止) 列表。"""
    out: list[tuple[int, int]] = []
    start = None
    for i, v in enumerate(mask_rows):
        if v >= min_frac and start is None:
            start = i
        elif v < min_frac and start is not None:
            out.append((start, i))
            start = None
    if start is not None:
        out.append((start, len(mask_rows)))
    return out


def largest(bnds: list[tuple[int, int]]) -> tuple[int, int]:
    return max(bnds, key=lambda b: b[1] - b[0]) if bnds else (0, 0)


def detect_box(im: Image.Image, mode: str) -> tuple[int, int, int, int]:
    """返回二维码在原图中的 (left, top, right, bottom)。mode: dark=黑码, color=彩码"""
    rgb = im.convert("RGB")
    w, h = rgb.size
    px = rgb.load()

    def dark(x: int, y: int) -> bool:
        r, g, b = px[x, y]
        # 「黑且不彩」：微信那张的绿底平均亮度也低于 110，必须把彩色排除掉
        return (r + g + b) / 3 < 110 and (max(r, g, b) - min(r, g, b)) < 60

    def colored(x: int, y: int) -> bool:
        r, g, b = px[x, y]
        # QQ 那张的码点是**淡彩**（压过 JPEG 后饱和度很低），饱和度判定抓不住，
        # 改判「不是近白/近灰」：码点、企鹅 logo 都算，白卡与灰底不算。
        # 群名/底部的黑色小字也会算，但它们只有几十像素高的小段，
        # 「取最大段」自然落回码本体。
        return min(r, g, b) < 228

    test = dark if mode == "dark" else colored
    # 只看中间 76% 的列 —— 避开左右边缘的装饰与文字
    x0, x1 = int(w * 0.12), int(w * 0.88)
    step = 2
    rows = []
    for y in range(0, h, step):
        n = sum(1 for x in range(x0, x1, 6) if test(x, y))
        rows.append(n / ((x1 - x0) / 6))
    rb = largest(bands(rows, 0.25 if mode == "color" else 0.12))
    if rb[1] - rb[0] < 10:
        raise SystemExit(f"{mode}: 找不到码的行范围")
    top, bot = rb[0] * step, rb[1] * step

    cols = []
    for x in range(0, w, step):
        n = sum(1 for y in range(top, bot, 6) if test(x, y))
        cols.append(n / (max(1, (bot - top) // 6)))
    cb = largest(bands(cols, 0.06 if mode == "color" else 0.12))
    if cb[1] - cb[0] < 10:
        raise SystemExit(f"{mode}: 找不到码的列范围")
    left, right = cb[0] * step, cb[1] * step
    return (left, top, right, bot)


def crop_square(im: Image.Image, box: tuple[int, int, int, int], pad_frac: float = 0.045) -> Image.Image:
    """按 box 裁出正方形（不足补白），四周留 pad 余量。"""
    l, t, r, b = box
    side = max(r - l, b - t)
    cx, cy = (l + r) / 2, (t + b) / 2
    half = side / 2 + side * pad_frac
    x0, y0 = int(cx - half), int(cy - half)
    x1, y1 = int(cx + half), int(cy + half)
    # 越界部分用白底补 —— 码本身不会越界，补的是留白
    out = Image.new("RGB", (x1 - x0, y1 - y0), (255, 255, 255))
    piece = im.convert("RGB").crop((max(0, x0), max(0, y0), min(im.width, x1), min(im.height, y1)))
    out.paste(piece, (max(0, -x0), max(0, -y0)))
    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, dict[str, str]] = {}
    for key, src in SRC.items():
        if not src.is_file():
            print(f"[跳过] {key}: 源图不存在 {src}")
            continue
        im = Image.open(src)
        if key in MANUAL_BOX:
            box = MANUAL_BOX[key]
            print(f"{key}: 人工定框 {box}")
        else:
            mode = "color" if key == "qqgroup" else "dark"
            box = detect_box(im, mode)
            print(f"{key}: 原图 {im.size}  码框 {box}  边长≈{max(box[2]-box[0], box[3]-box[1])}")
        out = crop_square(im, box)
        # 统一导出 720x720，界面里好排
        out = out.resize((720, 720), Image.LANCZOS)
        dst = OUT / f"{key}.png"
        out.save(dst, "PNG")
        digest = hashlib.sha256(dst.read_bytes()).hexdigest()
        manifest[key] = {"file": dst.name, "sha256": digest, "source": src.name}
        print(f"  → {dst}  sha256={digest[:16]}…")
    (OUT / "manifest.json").write_text(
        json.dumps({"schema": 1, "files": manifest}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"manifest → {OUT / 'manifest.json'}")


if __name__ == "__main__":
    main()
