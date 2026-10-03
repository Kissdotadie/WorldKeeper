"""生成程序图标（多尺寸 .ico）。

图标画什么：一枚深色圆盘 + 淡色圆环 + 三个相连的节点。
对应这个工具在做的事 —— 「把散落的点连成一张网」。

为什么不找一个现成的图标：许可不明的图标是最不该塞进分发包的
（没人会去查一个 .ico 的出处，但它是**明确的版权作品**）。程序画的
几何图形没有任何第三方权利。风格也与内置演示图标一致（同一套配色）。

用法：
    .venv/Scripts/python.exe packaging/make_icon.py
产出：
    packaging/assets/worldkeeper.ico
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent / "assets" / "worldkeeper.ico"

# 与 scripts/make_demo_icons.py 同一套配色，视觉上是一家
DISC_BG = (22, 28, 42, 255)
DISC_RING = (150, 175, 220, 255)
NODE = (198, 214, 240, 255)
EDGE = (110, 135, 175, 255)

#: Windows 图标要这几个尺寸：16 是托盘/任务栏，32/48 是资源管理器，256 是大图标
SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)


def draw(size: int) -> Image.Image:
    """按目标尺寸画一张（不是缩放出来的 —— 小尺寸下缩放会糊成一团）。

    边长统一用相对值，这样 16px 与 256px 的构图比例一致。
    """
    # 4 倍超采样再缩回去，边缘才不锯齿（PIL 没有原生抗锯齿绘图）
    S = size * 4
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    u = S / 100.0                       # 1 单位 = 1% 边长

    # 圆盘
    pad = 3 * u
    d.ellipse([pad, pad, S - pad, S - pad], fill=DISC_BG)

    # 外环
    ring = 4.5 * u
    d.ellipse([pad + ring / 2, pad + ring / 2, S - pad - ring / 2, S - pad - ring / 2],
              outline=DISC_RING, width=max(1, round(ring)))

    # 三个节点（三角形排布）+ 连线
    nodes = {
        "a": (50, 26),
        "b": (24, 72),
        "c": (76, 72),
    }
    r = 8.5 * u
    lw = max(1, round(4 * u))
    pts = {k: (x * u, y * u) for k, (x, y) in nodes.items()}
    for a, b in (("a", "b"), ("b", "c"), ("c", "a")):
        d.line([pts[a], pts[b]], fill=EDGE, width=lw)
    for p in pts.values():
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=NODE)

    return img.resize((size, size), Image.LANCZOS)


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    frames = [draw(s) for s in SIZES]
    # PIL 写 ico 时用 sizes 参数控制包含哪些尺寸
    frames[-1].save(OUT, format="ICO", sizes=[(s, s) for s in SIZES])
    print(f"已生成 {OUT}（{OUT.stat().st_size / 1024:.1f}KB，{len(SIZES)} 个尺寸）")

    # 顺手存一张 256 的 png 给「关于」页/文档用
    png = OUT.with_suffix(".png")
    frames[-1].save(png)
    print(f"已生成 {png}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
