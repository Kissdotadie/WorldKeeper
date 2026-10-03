"""docx 解析 —— 零依赖实现。

为什么不用 python-docx？因为它会把整套 OOXML 抽象搬进来，而这里只需要两件事：
1. 按顺序拿到段落文字
2. 拿到段落的**列表层级**（ilvl）与是否加粗

`.docx` 本质是个 zip，里面 `word/document.xml` 就是正文。
用标准库 zipfile + xml.etree 足够，也符合「架构必须轻」这条铁律。

层级信息很关键：作者的设定稿常常是「种族 / 人族 / 精灵」这样的多级大纲，
丢了 ilvl 就只剩一坨平铺的名词，没法还原成树。
"""

from __future__ import annotations

import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from xml.etree import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

#: 文本类扩展名（章节导入允许上传的）
TEXT_EXTS = (".txt", ".md", ".markdown")
DOCX_EXTS = (".docx",)
ALLOWED_EXTS = DOCX_EXTS + TEXT_EXTS


class DocxError(Exception):
    """docx 读不动（不是 zip / 缺 document.xml / XML 坏了）。"""


@dataclass
class Paragraph:
    """一个段落。`level` 是多级列表层级：0 为顶层；None 表示不在列表里。"""

    text: str
    level: int | None = None
    bold: bool = False
    style: str = ""

    @property
    def is_heading(self) -> bool:
        return bool(self.style and re.search(r"heading|标题|Title", self.style, re.I))


@dataclass
class Doc:
    paragraphs: list[Paragraph] = field(default_factory=list)
    tables: list[list[list[str]]] = field(default_factory=list)

    @property
    def text(self) -> str:
        return "\n\n".join(p.text for p in self.paragraphs if p.text.strip())

    @property
    def char_count(self) -> int:
        return sum(len(p.text) for p in self.paragraphs)


def _para_text(p: ET.Element) -> str:
    """段落文字。tab 转成制表符，br 转成换行。"""
    buf: list[str] = []
    for node in p.iter():
        tag = node.tag
        if tag == W + "t":
            buf.append(node.text or "")
        elif tag == W + "tab":
            buf.append("\t")
        elif tag == W + "br":
            buf.append("\n")
    return "".join(buf).strip()


def _para_level(p: ET.Element) -> int | None:
    """取多级列表层级；不是列表项则返回 None。"""
    pr = p.find(W + "pPr")
    if pr is None:
        return None
    ilvl = pr.find(W + "numPr/" + W + "ilvl")
    if ilvl is None:
        # 有些稿子只标了缩进没标编号，退而求其次用缩进推断
        ind = pr.find(W + "ind")
        if ind is not None:
            left = ind.get(W + "left") or ind.get(W + "start")
            if left and str(left).isdigit():
                return max(0, int(left) // 420)  # 420 twips ≈ 一级缩进
        return None
    val = ilvl.get(W + "val")
    try:
        return int(val) if val is not None else 0
    except ValueError:
        return 0


def _para_bold(p: ET.Element) -> bool:
    pr = p.find(W + "pPr")
    if pr is not None:
        rpr = pr.find(W + "rPr")
        if rpr is not None and rpr.find(W + "b") is not None:
            return True
    for r in p.iter(W + "r"):
        rpr = r.find(W + "rPr")
        if rpr is not None and rpr.find(W + "b") is not None:
            return True
    return False


def _para_style(p: ET.Element) -> str:
    pr = p.find(W + "pPr")
    if pr is None:
        return ""
    st = pr.find(W + "pStyle")
    return st.get(W + "val", "") if st is not None else ""


def _read_table(tbl: ET.Element) -> list[list[str]]:
    rows: list[list[str]] = []
    for tr in tbl.findall(W + "tr"):
        cells = [_para_text(tc).replace("\n", " ").strip() for tc in tr.findall(W + "tc")]
        if any(cells):
            rows.append(cells)
    return rows


def _collect(body: ET.Element, doc: Doc) -> None:
    """按文档顺序遍历 body，段落与表格分别归位。"""
    for child in body:
        if child.tag == W + "p":
            text = _para_text(child)
            if not text:
                continue
            doc.paragraphs.append(
                Paragraph(
                    text=text,
                    level=_para_level(child),
                    bold=_para_bold(child),
                    style=_para_style(child),
                )
            )
        elif child.tag == W + "tbl":
            rows = _read_table(child)
            if rows:
                doc.tables.append(rows)
        elif child.tag == W + "sdt":  # 内容控件里也可能藏正文
            inner = child.find(W + "sdtContent")
            if inner is not None:
                _collect(inner, doc)


def read_docx(path: str | Path) -> Doc:
    """读 .docx，返回段落（含层级）与表格。"""
    p = Path(path)
    try:
        with zipfile.ZipFile(p) as z:
            try:
                xml = z.read("word/document.xml")
            except KeyError as exc:
                raise DocxError(f"{p.name} 里没有 word/document.xml，可能不是有效的 docx") from exc
    except zipfile.BadZipFile as exc:
        raise DocxError(f"{p.name} 不是有效的 docx（zip 读取失败）") from exc

    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise DocxError(f"{p.name} 的 XML 解析失败：{exc}") from exc

    body = root.find(W + "body")
    if body is None:
        raise DocxError(f"{p.name} 缺少 body")

    doc = Doc()
    _collect(body, doc)
    return doc


def read_text_file(path: str | Path) -> Doc:
    """读 .txt / .md：按空行切段，`#` 开头的行视为标题。"""
    p = Path(path)
    raw = p.read_text(encoding="utf-8", errors="replace")
    doc = Doc()
    for block in re.split(r"\n\s*\n", raw):
        block = block.strip()
        if not block:
            continue
        heading = re.match(r"^(#{1,4})\s+(.*)$", block)
        if heading:
            doc.paragraphs.append(Paragraph(text=heading.group(2).strip(),
                                            style="Heading", bold=True))
            continue
        # 段内换行保留但不是空行
        doc.paragraphs.append(Paragraph(text=re.sub(r"\n+", "\n", block)))
    return doc


def read_any(path: str | Path) -> Doc:
    """按扩展名分派。"""
    suffix = Path(path).suffix.lower()
    if suffix in DOCX_EXTS:
        return read_docx(path)
    if suffix in TEXT_EXTS:
        return read_text_file(path)
    raise DocxError(f"不支持的格式：{suffix or '(无扩展名)'}")


# --------------------------------------------------------------------------
# 大纲树还原（给世界观设定稿用）
# --------------------------------------------------------------------------

@dataclass
class OutlineNode:
    text: str
    level: int
    children: list["OutlineNode"] = field(default_factory=list)
    depth: int = 0


def to_outline(paragraphs: list[Paragraph], base_level: int = 0) -> list[OutlineNode]:
    """把带 ilvl 的段落还原成树。

    只有出现在多级列表里的段落参与建树；不在列表里的段落
    挂到当前节点的「无归属」位置会被丢弃 —— 调用方通常分两步走：
    先用 `split_sections()` 切出「种族 / 地理 / 职业」这些大块，再对每块建树。
    """
    roots: list[OutlineNode] = []
    stack: list[OutlineNode] = []
    for para in paragraphs:
        if para.level is None:
            continue
        level = max(0, para.level - base_level)
        node = OutlineNode(text=para.text, level=level)
        while stack and stack[-1].level >= level:
            stack.pop()
        if stack:
            node.depth = stack[-1].depth + 1
            stack[-1].children.append(node)
        else:
            node.depth = 0
            roots.append(node)
        stack.append(node)
    return roots


def flatten_outline(nodes: list[OutlineNode]) -> list[OutlineNode]:
    """深度优先拉平（带 depth），方便逐条建实体。"""
    out: list[OutlineNode] = []

    def walk(ns: list[OutlineNode]) -> None:
        for n in ns:
            out.append(n)
            walk(n.children)

    walk(nodes)
    return out


def find_roots(paragraphs: list[Paragraph], level: int = 0) -> list[str]:
    """取出某一层级的所有标题文字（常用来找「一级分类」）。"""
    return [p.text for p in paragraphs if p.level == level and p.text.strip()]
