"""打赏码「一键换码 / 重新登记」。

为什么要有这个脚本
------------------
打赏码的真源**编在程序包里**（`app/assets/donate/*.png`），哈希**写在代码里**
（`app/donate_manifest.py`）。这样别人改数据目录里的图没用 —— 后端每次自检会
拿代码里的哈希比对，不一致就从包内原图覆盖回去，并把这件事记成一条**不会自己
消失的告警**。

代价是：作者自己换码时不能只丢一张图进 data 目录（那会被当成篡改恢复掉），
必须同时更新「包内图片 + 代码内哈希」这两样。这正是本脚本要干的活。

四种用法
--------
1) 换码（给原始截图，脚本自动找码、裁成正方形）::

       .venv/Scripts/python.exe scripts/donate_rebuild.py \\
           --src alipay=支付宝截图.jpg \\
           --src wechat=微信.png \\
           --src qqgroup=QQ群.jpg

2) 只用自己裁好的方形码图（不裁，只缩放到统一边长）::

       .venv/Scripts/python.exe scripts/donate_rebuild.py --set alipay=a.png

3) 自动检测抓不住时人工定框（原图像素坐标，`左,上,右,下`）::

       ... --src qqgroup=群.jpg --box qqgroup=200,676,916,1392

4) 采纳现状：包内已有图，只想重建清单 / 换随机 token / 修复数据目录镜像::

       .venv/Scripts/python.exe scripts/donate_rebuild.py --adopt

说明
----
- 只改一张时，另外两张保持原样（不用一次给齐三张）。
- 数据目录（默认按 `WKV_DATA_DIR` 或程序目录旁的 data/ 推导）里的副本会被
  同步成新图，并把历史篡改事件清空 —— 换码是作者本人的正当操作，不该留告警。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# 复用「把截图裁成纯码方块」那套逻辑：同一套阈值，不会两处跑偏
sys.path.insert(0, str(Path(__file__).resolve().parent))
from process_donate_images import crop_square, detect_box  # noqa: E402

BUNDLE = ROOT / "app" / "assets" / "donate"
MANIFEST_PY = ROOT / "app" / "donate_manifest.py"

KEYS = ("alipay", "wechat", "qqgroup")
DEFAULT_LABELS = {"alipay": "支付宝", "wechat": "微信支付", "qqgroup": "QQ 群"}

#: 自动检测用的判定模式：黑码走 dark，彩码走 color
AUTO_MODE = {"alipay": "dark", "wechat": "dark", "qqgroup": "color"}


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------

def sha256_of(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def parse_kv(items: list[str] | None, what: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in items or []:
        if "=" not in raw:
            raise SystemExit(f"{what} 需要写成 key=值 的形式，收到：{raw}")
        k, v = raw.split("=", 1)
        k = k.strip()
        if k not in KEYS:
            raise SystemExit(f"{what} 的键只能是 {KEYS}，收到：{k}")
        out[k] = v.strip()
    return out


def parse_box(raw: str) -> tuple[int, int, int, int]:
    parts = [int(x) for x in raw.replace("，", ",").split(",")]
    if len(parts) != 4:
        raise SystemExit(f"--box 需要 左,上,右,下 四个整数，收到：{raw}")
    return parts[0], parts[1], parts[2], parts[3]


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# 出图
# ---------------------------------------------------------------------------

def build_from_source(key: str, src: Path, box: tuple[int, int, int, int] | None,
                      size: int, dst: Path) -> None:
    """从原始截图裁出码本体，导出为 size×size 的 PNG。"""
    from PIL import Image

    im = Image.open(src)
    if box is None:
        box = detect_box(im, AUTO_MODE.get(key, "dark"))
        print(f"  {key}: 自动定框 {box}（原图 {im.size}）")
    else:
        print(f"  {key}: 人工定框 {box}（原图 {im.size}）")
    out = crop_square(im, box).resize((size, size), Image.LANCZOS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    out.save(dst, "PNG")


def build_from_square(key: str, src: Path, size: int, dst: Path) -> None:
    """已是方形码图：只统一边长，不裁。"""
    from PIL import Image

    im = Image.open(src)
    print(f"  {key}: 直接采用 {src.name}（{im.size}）")
    if im.size != (size, size):
        # 非等比拉伸会把二维码拉歪导致扫不出 —— 先补成正方形再缩放
        side = max(im.size)
        canvas = Image.new("RGB", (side, side), (255, 255, 255))
        canvas.paste(im.convert("RGB"), ((side - im.width) // 2, (side - im.height) // 2))
        im = canvas
    out = im.convert("RGB").resize((size, size), Image.LANCZOS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    out.save(dst, "PNG")


# ---------------------------------------------------------------------------
# 清单 / 镜像
# ---------------------------------------------------------------------------

def write_manifest(entries: dict[str, dict], token: str) -> None:
    """把哈希与随机 token 写进**代码**（`app/donate_manifest.py`）。

    为什么不写 JSON：JSON 和图片一起放在包目录里，改图的人顺手也能改 JSON，
    校验就形同虚设。写进 Python 源码后，要伪造得同时改 .py —— 门槛高一档。
    """
    lines = [
        '"""打赏码图清单 —— 由 scripts/donate_rebuild.py 生成，请勿手改。',
        "",
        "这里存的是**程序包内**那三张原图的 sha256。后端每次自检都拿它跟",
        "`app/assets/donate/*.png` 比对：对不上说明程序文件被动过，界面会给一条",
        "**清不掉**的告警（代码与资源同时被改就防不住了 —— 那已经是另一个程序）。",
        "",
        f"token 用于图片 URL 的随机后缀，重建一次变一次。",
        '"""',
        "",
        "from __future__ import annotations",
        "",
        "SCHEMA = 1",
        "",
        f'TOKEN = "{token}"',
        "",
        "LABELS: dict[str, str] = {",
    ]
    for k in KEYS:
        lines.append(f'    "{k}": "{DEFAULT_LABELS[k]}",')
    lines += ["}", "", "ITEMS: dict[str, dict[str, object]] = {"]
    for k in KEYS:
        e = entries.get(k)
        if not e:
            lines.append(f'    # "{k}": 尚未提供（界面显示占位）')
            continue
        lines += [
            f'    "{k}": {{',
            f'        "file": "{k}.png",',
            f'        "sha256": "{e["sha256"]}",',
            f'        "bytes": {e["bytes"]},',
            f'        "w": {e["w"]},',
            f'        "h": {e["h"]},',
            "    },",
        ]
    lines += ["}", ""]
    MANIFEST_PY.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n清单 → {MANIFEST_PY}  (token={token[:12]}…)")


def sync_mirror(data_dir: Path, entries: dict[str, dict], token: str) -> None:
    """把包内图同步到数据目录，并清空历史事件。

    数据目录这份副本**不参与对外服务**（接口永远从包内读），留着是为了：
    作者能直接看到码长什么样；以及「被改过」这件事有迹可查。
    """
    mirror = data_dir / "assets" / "donate"
    mirror.mkdir(parents=True, exist_ok=True)
    for k, e in entries.items():
        dst = mirror / f"{k}.png"
        dst.write_bytes((BUNDLE / f"{k}.png").read_bytes())
        print(f"  镜像 {dst}")
    # 旧清单文件（第一版的 manifest.json）已废弃，留着会误导
    legacy = mirror / "manifest.json"
    if legacy.is_file():
        legacy.unlink()
        print(f"  已清理废弃文件 {legacy}")
    state = {
        "schema": 2,
        "token": token,
        "synced_at": now_iso(),
        "files": {k: {"sha256": e["sha256"], "bytes": e["bytes"]} for k, e in entries.items()},
        # 换码是作者本人的正当操作 → 历史篡改记录一并清空
        "events": [],
        "acknowledged_at": now_iso(),
    }
    (mirror / "current.json").write_text(
        json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"  状态 → {mirror / 'current.json'}")


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="打赏码换码 / 重新登记", add_help=True)
    ap.add_argument("--src", action="append", metavar="KEY=PATH",
                    help="原始截图（脚本自动找码并裁成正方形）")
    ap.add_argument("--set", action="append", metavar="KEY=PATH", dest="set_",
                    help="已裁好的方形码图（只统一边长）")
    ap.add_argument("--box", action="append", metavar="KEY=L,T,R,B",
                    help="人工定框（原图像素坐标）")
    ap.add_argument("--label", action="append", metavar="KEY=文字",
                    help="界面上的标签文字（默认 支付宝 / 微信支付 / QQ 群）")
    ap.add_argument("--adopt", action="store_true",
                    help="不换图，只按包内现有图重建清单（并换新 token、清空告警）")
    ap.add_argument("--size", type=int, default=720, help="统一边长，默认 720")
    ap.add_argument("--data-dir", default=None, help="数据目录（默认自动推导）")
    args = ap.parse_args()

    srcs = parse_kv(args.src, "--src")
    sets = parse_kv(args.set_, "--set")
    boxes = {k: parse_box(v) for k, v in parse_kv(args.box, "--box").items()}
    labels = parse_kv(args.label, "--label")

    overlap = set(srcs) & set(sets)
    if overlap:
        raise SystemExit(f"同一张码不能既 --src 又 --set：{sorted(overlap)}")
    if not (args.adopt or srcs or sets):
        raise SystemExit("什么都没做。给 --src / --set 换码，或用 --adopt 重建清单。")

    BUNDLE.mkdir(parents=True, exist_ok=True)

    if args.adopt:
        print("采纳包内现有图片，重建清单：")
    else:
        for k, p in srcs.items():
            f = Path(p).expanduser()
            if not f.is_file():
                raise SystemExit(f"{k} 的源图不存在：{f}")
            build_from_source(k, f, boxes.get(k), args.size, BUNDLE / f"{k}.png")
        for k, p in sets.items():
            f = Path(p).expanduser()
            if not f.is_file():
                raise SystemExit(f"{k} 的码图不存在：{f}")
            build_from_square(k, f, args.size, BUNDLE / f"{k}.png")
        if boxes:
            unused = set(boxes) - set(srcs)
            if unused:
                print(f"  [提示] --box 没用上（只在 --src 时生效）：{sorted(unused)}")

    # 登记：读包内每一张（缺的就留空，界面会显示占位）
    from PIL import Image

    entries: dict[str, dict] = {}
    for k in KEYS:
        f = BUNDLE / f"{k}.png"
        if not f.is_file():
            print(f"  [跳过] {k}：包内没有 {f.name}，界面会显示占位")
            continue
        im = Image.open(f)
        entries[k] = {
            "sha256": sha256_of(f),
            "bytes": f.stat().st_size,
            "w": im.width,
            "h": im.height,
        }

    token = secrets.token_hex(16)
    write_manifest(entries, token)

    if labels:
        # 标签在清单里是常量字典，这里顺手提示一句就够，不搞成可配置项
        print(f"  [提示] 标签目前写在 app/donate_manifest.py 的 LABELS 里，"
              f"想改成 {labels} 直接编辑该文件即可")

    # 数据目录
    if args.data_dir:
        data_dir = Path(args.data_dir).expanduser().resolve()
    else:
        from app import paths  # 延迟导入：确保 WKV_DATA_DIR 已生效

        data_dir = paths.data_dir()
    print(f"\n数据目录：{data_dir}")
    sync_mirror(data_dir, entries, token)

    print("\n完成。重启后端（或刷新界面）即可生效。")
    print("提示：包内图片与代码哈希是配套的 —— 只改一边会让界面报「程序文件被改动」。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
