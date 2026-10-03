"""批量粘贴解析：把一段 Markdown 表格或列表拆成多个实体草稿。

这是「空库自录」下的主力录入路径 —— 用户把设定表整段贴进来，
工具自动切成一个个实体，而不是一个个手敲。

支持三种形态：
1. 表格    | 名称 | 修为 | 身份 |
           | 裴渊 | 三花聚顶 | 卧底 |
2. 列表    - 裴渊：21岁，潜伏隐龙院的假太监
3. 纯行    裴渊
           韦忠
"""

from __future__ import annotations

import re

# 表头里哪些列名算作「实体主名」
_NAME_HEADERS = {"名称", "名字", "姓名", "名", "name", "标题", "词条"}

# 表头里哪些列名算作「摘要」
_SUMMARY_HEADERS = {"摘要", "简介", "描述", "说明", "备注", "summary"}

# 表头里哪些列名算作「别名」
_ALIAS_HEADERS = {"别名", "又称", "别称", "曾用名", "alias", "aliases"}

# 表头里哪些列名算作「标签」
_TAG_HEADERS = {"标签", "分类", "类别", "tag", "tags"}

_TABLE_ROW = re.compile(r"^\s*\|(.+)\|\s*$")
_LIST_ITEM = re.compile(r"^\s*(?:[-*+]|\d+[.、)])\s+(.+?)\s*$")
_SEPARATOR_CELLS = re.compile(r"^\s*:?-{2,}:?\s*$")

# 所有「认识」的表头词，用来判断首行到底是表头还是数据
_KNOWN_HEADERS = _NAME_HEADERS | _SUMMARY_HEADERS | _ALIAS_HEADERS | _TAG_HEADERS


def _split_row(line: str) -> tuple[list[str], str]:
    """把一行拆成单元格。返回 (cells, kind)，kind ∈ {'pipe','tsv','none'}。

    真实录入场景有两种来源，都得认：
    - 从 Markdown / 网页表格复制 → 带前导竖线 `| 裴渊 | 21岁 |`
    - 从 Excel / WPS 复制    → 制表符分隔 `裴渊\\t21岁`
    """
    raw = line.strip()
    if not raw:
        return [], "none"

    m = _TABLE_ROW.match(line)
    if m:
        return [c.strip() for c in m.group(1).split("|")], "pipe"

    if "\t" in raw:
        return [c.strip() for c in raw.split("\t")], "tsv"

    # 没有前导竖线但内部有至少两个竖线，也当作表格（用户手写的宽松写法）
    if raw.count("|") >= 2:
        return [c.strip() for c in raw.strip("|").split("|")], "pipe"

    return [], "none"


def _is_separator(cells: list[str]) -> bool:
    return bool(cells) and all(_SEPARATOR_CELLS.match(c) for c in cells)


def _split_multi(value: str) -> list[str]:
    """把「裴渊、小裴子」或「主角,隐龙院」拆成列表。"""
    if not value:
        return []
    parts = re.split(r"[、,，;；/|]", value)
    return [p.strip() for p in parts if p.strip()]


def _parse_table(lines: list[str]) -> list[dict]:
    """解析表格（Markdown 竖线表或 Excel 制表符表），每行一个实体。"""
    rows: list[list[str]] = []
    for line in lines:
        cells, kind = _split_row(line)
        if not cells:
            continue
        if _is_separator(cells):
            continue
        rows.append(cells)

    if len(rows) < 2:
        return []

    first = rows[0]
    if _looks_like_header(first) or len(rows) > 2:
        headers, body = first, rows[1:]
    else:
        # 两行且首行不像表头 —— 当成两行数据，列名退化为「列N」
        headers = [f"列{i + 1}" for i in range(len(first))]
        body = rows

    # 找到主名列
    name_idx = None
    for i, h in enumerate(headers):
        key = h.strip().lower()
        if key in _NAME_HEADERS or "名" in h:
            name_idx = i
            break
    if name_idx is None:
        name_idx = 0  # 没有明确表头就默认第一列

    out: list[dict] = []
    for row in body:
        if name_idx >= len(row):
            continue
        name = row[name_idx].strip()
        if not name or _is_separator([name]):
            continue

        draft: dict = {"name": name, "attributes": [], "aliases": [], "tags": [], "summary": ""}

        for i, h in enumerate(headers):
            if i == name_idx or i >= len(row):
                continue
            value = row[i].strip()
            if not value:
                continue
            key = h.strip()
            low = key.lower()
            if low in _SUMMARY_HEADERS:
                draft["summary"] = value
            elif low in _ALIAS_HEADERS or key in _ALIAS_HEADERS:
                draft["aliases"].extend(_split_multi(value))
            elif low in _TAG_HEADERS or key in _TAG_HEADERS:
                draft["tags"].extend(_split_multi(value))
            else:
                draft["attributes"].append([key, value])

        out.append(draft)
    return out


def _looks_like_header(cells: list[str]) -> bool:
    return any(c.strip().lower() in _KNOWN_HEADERS for c in cells)


def _parse_list(lines: list[str]) -> list[dict]:
    """解析列表，每项一个实体。支持「名字：描述」写法。"""
    out: list[dict] = []
    for line in lines:
        m = _LIST_ITEM.match(line)
        if not m:
            continue
        item = m.group(1).strip()
        if not item:
            continue
        item = re.sub(r"^\*\*(.+?)\*\*", r"\1", item)  # 去掉加粗

        name, summary = item, ""
        for sep in ("：", ":", "——", " -- ", "—"):
            if sep in item:
                head, _, tail = item.partition(sep)
                if head.strip() and len(head.strip()) <= 24:
                    name, summary = head.strip(), tail.strip()
                break

        out.append({
            "name": name,
            "attributes": [],
            "aliases": [],
            "tags": [],
            "summary": summary,
        })
    return out


def _parse_plain(lines: list[str]) -> list[dict]:
    """纯文本行，每行一个实体（跳过明显的标题行）。"""
    out: list[dict] = []
    for line in lines:
        text = line.strip().lstrip("#").strip()
        if not text or len(text) > 60:
            continue
        out.append({"name": text, "attributes": [], "aliases": [], "tags": [], "summary": ""})
    return out


def detect_mode(text: str) -> str:
    lines = [ln for ln in (text or "").splitlines() if ln.strip()]
    table_rows = sum(1 for ln in lines if _split_row(ln)[0])
    if table_rows >= 2:
        return "table"
    if any(_LIST_ITEM.match(ln) for ln in lines):
        return "list"
    return "plain"


def parse_paste(text: str, mode: str | None = None, default_tags: list[str] | None = None) -> dict:
    """把粘贴内容解析成实体草稿列表（不落盘，先给用户预览）。"""
    lines = [ln for ln in (text or "").splitlines() if ln.strip()]
    if not lines:
        return {"mode": "empty", "count": 0, "drafts": [], "warnings": ["没有可解析的内容"]}

    mode = mode if mode in ("table", "list", "plain") else detect_mode(text)

    if mode == "table":
        drafts = _parse_table(lines)
    elif mode == "list":
        drafts = _parse_list(lines)
    else:
        drafts = _parse_plain(lines)

    extra_tags = [t for t in (default_tags or []) if str(t).strip()]
    for d in drafts:
        d["tags"] = list(dict.fromkeys(d["tags"] + extra_tags))

    warnings: list[str] = []
    if not drafts:
        warnings.append("没能识别出任何条目，请检查格式")
    counts: dict[str, int] = {}
    for d in drafts:
        counts[d["name"]] = counts.get(d["name"], 0) + 1
    dupes = sorted(n for n, c in counts.items() if c > 1)
    if dupes:
        warnings.append("本次粘贴内存在重复名称：" + "、".join(dupes))

    return {"mode": mode, "count": len(drafts), "drafts": drafts, "warnings": warnings}
