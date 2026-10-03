"""生成四张演示用节点图标（透明底 png），落到 data/assets/icons/。

为什么要有这个脚本：三维图谱的「自定义图片图标」得先有图才能验证。
这四张是程序画的占位图标 —— 你随时可以从关系网右侧上传自己的图替换，
素材目录里放什么就显示什么，工具不挑图。

用法：.venv/Scripts/python.exe scripts/make_demo_icons.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

S = 256
OUT = Path(__file__).resolve().parent.parent / "data" / "assets" / "icons"

DISC_BG = (22, 28, 42, 235)
DISC_RING = (150, 175, 220, 235)
INK = (238, 243, 252, 255)


def base() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((6, 6, S - 6, S - 6), fill=DISC_BG, outline=DISC_RING, width=6)
    return img, d


def person() -> Image.Image:
    img, d = base()
    d.ellipse((S / 2 - 30, 60, S / 2 + 30, 120), fill=INK)
    d.polygon(
        [(S / 2 - 56, 202), (S / 2 - 42, 152), (S / 2, 132), (S / 2 + 42, 152), (S / 2 + 56, 202)],
        fill=INK,
    )
    return img


def shield() -> Image.Image:
    img, d = base()
    d.polygon([(S / 2, 46), (200, 84), (200, 152), (S / 2, 210), (56, 152), (56, 84)], fill=INK)
    d.polygon([(S / 2, 74), (176, 100), (176, 146), (S / 2, 184), (80, 146), (80, 100)], fill=DISC_BG)
    return img


def peak() -> Image.Image:
    img, d = base()
    d.polygon([(40, 198), (108, 88), (140, 136), (170, 82), (216, 198)], fill=INK)
    d.polygon([(108, 88), (140, 136), (124, 118)], fill=DISC_BG)
    d.ellipse((64, 176, 192, 204), fill=DISC_BG)
    return img


def gem() -> Image.Image:
    img, d = base()
    d.polygon([(S / 2, 48), (198, 118), (S / 2, 208), (58, 118)], fill=INK)
    d.polygon([(S / 2, 78), (170, 120), (S / 2, 176), (86, 120)], fill=DISC_BG)
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, maker in (("person.png", person), ("shield.png", shield),
                        ("peak.png", peak), ("gem.png", gem)):
        maker().save(OUT / name)
        print("写出", OUT / name)


if __name__ == "__main__":
    main()
