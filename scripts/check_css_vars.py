"""检查 CSS：所有 `var(--x)` 引用的变量都必须真的被定义过。

为什么要有这个脚本（P11-1️⃣② 的教训）：
P7~P10 的一批样式写了 `var(--border)` / `var(--radius)` / `var(--text)`，
这组变量**从未在 tokens.css 里定义过**。CSS 自定义属性未定义又没写 fallback
时，**整条声明在计算期作废** —— 于是边框、圆角、字色、背景悄悄全部消失，
界面上却看不出任何报错。用户反馈「工具箱卡片没边框」，根因就是这个。

用法（在本项目根目录）：
    .venv/Scripts/python.exe scripts/check_css_vars.py
    退出码 0 = 干净；1 = 有缺失（并打印每处缺失所在的文件与行号）。

注意：
- 只扫 `web/src/styles/*.css`（tokens/base/app/mobile）。
- JS 里 `style.setProperty('--x', ...)` 动态设置的变量认不出来，
  所以脚本同时列出「被引用但定义处不在 CSS 里」的变量供人工核对 ——
  目前的已知白名单：--type-color / --font-ui / --font-mono /
  --app-bg-size / --app-bg-repeat（都由 `lib/appearance.ts`、`TypeColorStyle.tsx` 注入）。
"""

from __future__ import annotations

import collections
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
STYLES = ROOT / "web" / "src" / "styles"

# JS 动态注入、CSS 里永远查不到定义的变量（与上面的说明对应）
KNOWN_DYNAMIC = {
    "--type-color",       # TypeColorStyle.tsx 按 data-entity-type 注入
    "--font-ui",          # lib/appearance.ts（外观设置）
    "--font-mono",        # lib/appearance.ts
    "--app-bg-size",      # lib/appearance.ts（背景图）
    "--app-bg-repeat",    # lib/appearance.ts
}

VAR_USE = re.compile(r"var\(\s*(--[A-Za-z0-9_-]+)")
# 定义处：`--x:` 且前面不是 `var(`。不能要求行首 —— 常有 `:root { --rail-w: 64px }`
# 这种一行写完的；也不能把 `var(--x)` 当成定义。
VAR_DEF = re.compile(r"(?<!var\()(--[A-Za-z0-9_-]+)\s*:")


def main() -> int:
    used: dict[str, list[tuple[str, int]]] = collections.defaultdict(list)
    defined: set[str] = set()

    for f in sorted(STYLES.glob("*.css")):
        text = f.read_text(encoding="utf-8")
        for i, line in enumerate(text.splitlines(), start=1):
            for m in VAR_USE.finditer(line):
                used[m.group(1)].append((f.name, i))
            for m in VAR_DEF.finditer(line):
                defined.add(m.group(1))

    # tokens.css 的兼容别名层里，别名自己引用的变量也算已定义 ——
    # 上面 VAR_DEF 已经按「行首 --x:」收进去了，无需特判。

    missing = {
        name: locs
        for name, locs in used.items()
        if name not in defined and name not in KNOWN_DYNAMIC
    }

    if not missing:
        print(f"OK —— {len(defined)} 个变量已定义，{len(used)} 个被引用，无缺失。")
        return 0

    print("缺失的 CSS 变量（被引用但从未定义，整条声明会在计算期作废）：\n")
    for name, locs in sorted(missing.items(), key=lambda kv: -len(kv[1])):
        print(f"  {name}  ×{len(locs)}")
        for f, line in locs[:6]:
            print(f"      {STYLES / f}:{line}")
        if len(locs) > 6:
            print(f"      … 还有 {len(locs) - 6} 处")
    print("\n修法：要么在 tokens.css 的语义层/兼容别名层补定义，要么改用已有变量。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
