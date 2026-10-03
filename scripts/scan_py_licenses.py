"""后端依赖的许可证扫描（P8 分发合规）。

为什么要有这个脚本，而不是「装完看一眼 pip list」：
分发前要能**随时重跑**并给出可存档的结论。依赖会升级，协议会变；
今天扫过不等于下个版本还干净。构建脚本每次打包前调一次，红了就停。

只扫**运行必需**的依赖（requirements.txt 的直接依赖 + 它们的传递依赖）——
`requirements-vision.txt` 是可选的（不装也能跑），单独标注。开发依赖
（pytest 等）不进分发包，不计。

用法：
    python scripts/scan_py_licenses.py             # 打印清单
    python scripts/scan_py_licenses.py --json      # 输出 JSON
    python scripts/scan_py_licenses.py --md        # 输出 Markdown 表格（写进 docs/licenses.md）

退出码：发现传染性或禁商用协议 → 1，否则 0。
"""

from __future__ import annotations

import argparse
import importlib.metadata as md
import json
import sys

#: 传染性或禁商用 —— 一旦命中必须换掉那个包，不能只是记一笔
FORBIDDEN = ("AGPL", "GPL", "SSPL", "EUPL", "CPAL", "OSL-3", "RPL", "COMMONS CLAUSE")

#: 需要挂备注的（弱著佐权 / 非标准）—— 可商用，但要在声明页说明来龙去脉
FOOTNOTE = ("MPL", "MOZILLA", "EPL", "CDDL", "PSF", "HPND", "MIT-CMU")

#: 直接依赖 → 是不是运行必需。用来把「可选识别引擎」单独归类
REQUIRED_ROOTS = {
    "fastapi", "uvicorn", "pyyaml", "python-frontmatter",
    "python-multipart", "httpx",
}
#: 这些是 requirements-vision.txt 拉的（可选，不装也能跑）
VISION_ROOTS = {
    "opencv-python", "opencv-python-headless", "rapidocr", "onnxruntime",
    "shapely", "pyclipper", "omegaconf", "antlr4-python3-runtime",
    "flatbuffers", "pillow", "numpy", "tqdm", "opentelemetry-api",
    "protobuf", "colorlog", "requests", "six",
}
#: 只用于开发/测试，不进分发包
DEV_ONLY = {"pytest", "pluggy", "iniconfig", "pip", "packaging", "pygments"}


def _declared(dist: md.Distribution) -> str:
    """把三方元数据字段归一成一句人话。

    为什么不只看 `License`：新包按 PEP 639 只写 `License-Expression`，
    老的写 `License`，更老的只挂 classifier —— 三个都得看，否则会把
    一批 MIT/Apache 的包报成「未声明」，白白吓自己一跳。
    """
    expr = (dist.metadata.get("License-Expression") or "").strip()
    if expr:
        return expr
    cls = next((c for c in (dist.metadata.get_all("Classifier") or [])
                if c.startswith("License ::")), "")
    if cls:
        return (cls.replace("License :: OSI Approved :: ", "")
                   .replace("License :: ", "").strip())
    lic = (dist.metadata.get("License") or "").strip().splitlines()
    if lic and lic[0].strip():
        return lic[0].strip()[:60]
    return "（未声明）"


def collect() -> list[dict]:
    rows = []
    for dist in md.distributions():
        name = (dist.metadata["Name"] or "").strip()
        if not name:
            continue
        low = name.lower()
        if low in DEV_ONLY:
            continue
        kind = ("vision" if low in VISION_ROOTS
                else "required" if low in REQUIRED_ROOTS else "transitive")
        rows.append({
            "name": name,
            "version": dist.version,
            "license": _declared(dist),
            "kind": kind,
        })
    return sorted(rows, key=lambda r: r["name"].lower())


def classify(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    def hit(row, words):
        text = row["license"].upper().replace("NOT ", "").replace("NO ", "")
        return any(w in text for w in words)

    return ([r for r in rows if hit(r, FORBIDDEN)],
            [r for r in rows if hit(r, FOOTNOTE) and not hit(r, FORBIDDEN)])


def main() -> int:
    ap = argparse.ArgumentParser(description="扫描后端依赖的许可证")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--md", action="store_true", help="输出 Markdown 表格")
    args = ap.parse_args()

    rows = collect()
    forbidden, notes = classify(rows)

    if args.json:
        print(json.dumps({"count": len(rows), "rows": rows,
                          "forbidden": forbidden, "notes": notes},
                         ensure_ascii=False, indent=2))
    elif args.md:
        print("| 包 | 版本 | 协议 | 归类 |")
        print("|---|---|---|---|")
        label = {"required": "运行必需", "vision": "可选·识别引擎", "transitive": "传递依赖"}
        for r in rows:
            print(f"| `{r['name']}` | {r['version']} | {r['license']} | {label[r['kind']]} |")
    else:
        label = {"required": "运行必需", "vision": "可选·识别引擎", "transitive": "传递依赖"}
        print(f"后端依赖：{len(rows)} 个\n")
        for r in rows:
            print(f"  {r['name']:<26} {r['version']:<11} {r['license']:<44} {label[r['kind']]}")
        bad = ", ".join(f"{r['name']}({r['license']})" for r in forbidden)
        note = ", ".join(f"{r['name']}({r['license']})" for r in notes)
        print(f"\n传染性/禁商用：{bad or '无'}")
        print(f"需挂备注：{note or '无'}")

    return 1 if forbidden else 0


if __name__ == "__main__":
    sys.exit(main())
