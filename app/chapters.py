"""章节（正文）通道。

**关于「正文只读」这条规矩的精确含义**：
工具**导入**正文时会写 `chapters/`，导入完成后正文内容就是只读的 ——
抽取、索引、关系推导都只读不写，绝不改写正文任何一个字。
换句话说：写只发生在「导入」这一下，导入之后它跟印刷稿一样是死的。

文件：`chapters/0001-第一章 黎明苏醒号.md`
    ---
    chapter_no: 1
    title: 第一章 黎明苏醒号
    volume: 序卷《帝国佚事》
    source_file: 序卷001船，陨石，芭芭菈.docx
    imported_at: 2026-09-30T22:00:00+08:00
    word_count: 10734
    ---

    段落一……

    段落二……
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from . import paths
from .logging_setup import get_logger
from .models import now_iso, safe_filename
from .parsers import docx as docx_parser

log = get_logger(__name__)

MAX_CHAPTER_CHARS = 400_000  # 单章上限，防误传整本书

_CN_NUM = {"零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6,
           "七": 7, "八": 8, "九": 9, "十": 10}


def cn_to_int(s: str) -> int | None:
    """把「一」「十二」「二十一」转成整数。识别不了返回 None。"""
    s = (s or "").strip()
    if not s:
        return None
    if s.isdigit():
        return int(s)
    if "十" not in s:
        if all(c in _CN_NUM for c in s):
            return int("".join(str(_CN_NUM[c]) for c in s)) if len(s) == 1 else None
        return None
    head, _, tail = s.partition("十")
    tens = _CN_NUM.get(head, 1) if head else 1
    ones = _CN_NUM.get(tail, 0) if tail else 0
    if (head and head not in _CN_NUM) or (tail and tail not in _CN_NUM):
        return None
    return tens * 10 + ones


#: 卷标题：序卷 / 第一卷 《xxx》
_VOLUME_RE = re.compile(r"^(序卷|楔子|尾声|第[一二三四五六七八九十百零\d]+卷)\s*《?(.*?)》?\s*$")
#: 章标题：第一章 xxx
_TITLE_RE = re.compile(r"^(第[一二三四五六七八九十百零\d]+章)\s*(.*)$")


@dataclass
class Chapter:
    chapter_no: int
    title: str = ""
    volume: str = ""
    source_file: str = ""
    imported_at: str = ""
    word_count: int = 0
    text: str = ""
    file_path: str | None = None

    def to_frontmatter(self) -> dict:
        return {
            "chapter_no": self.chapter_no,
            "title": self.title,
            "volume": self.volume,
            "source_file": self.source_file,
            "imported_at": self.imported_at or now_iso(),
            "word_count": self.word_count or count_words(self.text),
        }

    @staticmethod
    def from_parts(fm: dict, text: str, file_path: str | None = None) -> "Chapter":
        return Chapter(
            chapter_no=int(fm.get("chapter_no") or 0),
            title=str(fm.get("title") or ""),
            volume=str(fm.get("volume") or ""),
            source_file=str(fm.get("source_file") or ""),
            imported_at=str(fm.get("imported_at") or ""),
            word_count=int(fm.get("word_count") or 0),
            text=text,
            file_path=file_path,
        )


def count_words(text: str) -> int:
    """中文按字算，忽略空白。"""
    return len(re.sub(r"\s", "", text or ""))


# --------------------------------------------------------------------------
# 文件名 / 标题解析
# --------------------------------------------------------------------------

def parse_filename(stem: str) -> tuple[str, int | None, str]:
    """从文件名猜 (卷名, 章序, 摘要)。

    例：`序卷001船，陨石，芭芭菈` → ("序卷", 1, "船，陨石，芭芭菈")
        `第一章 黎明苏醒号`       → ("", 1, "黎明苏醒号")
    """
    s = (stem or "").strip()
    volume = ""
    m = re.match(r"^(序卷|序章|楔子|尾声|第[一二三四五六七八九十百零\d]+卷)", s)
    if m:
        volume = m.group(1)
        s = s[len(volume):]
    seq: int | None = None
    m = re.match(r"^[\s_\-]*(\d{2,4})[\s_\-]*(.*)$", s)
    if m:
        seq = int(m.group(1))
        s = m.group(2)
    else:
        m = re.match(r"^(第[一二三四五六七八九十百零\d]+章)[\s_\-]*(.*)$", s)
        if m:
            seq = cn_to_int(re.sub(r"[第章]", "", m.group(1)))
            s = m.group(2)
    return volume, seq, s.strip(" ，,、_—-") or stem


def split_volume_and_title(paragraphs: list[docx_parser.Paragraph]) -> tuple[str, int, str, int]:
    """从 docx 段落里切出（卷名, 章序, 章名, 正文起始下标）。

    设定稿与正文常常是：
        序卷《帝国佚事》          ← 卷
        第一章 黎明苏醒号          ← 章
        万里晴空，一望无际……      ← 正文
    """
    volume = ""
    chapter_no = 0
    title = ""
    start = 0

    for i, p in enumerate(paragraphs[:6]):  # 只在开头几段里找，避免误吃正文
        t = p.text.strip()
        if not t:
            continue
        if not volume:
            m = _VOLUME_RE.match(t)
            if m and not _TITLE_RE.match(t):
                volume = t
                start = i + 1
                continue
        if not title:
            m = _TITLE_RE.match(t)
            if m:
                chapter_no = cn_to_int(re.sub(r"[第章]", "", m.group(1))) or 0
                # 「第一章 黎明苏醒号」→ 主名只留「黎明苏醒号」。
                # 章序已经单独存了，标题里再带一遍「第一章」，
                # 界面就会显示成「第 1 章 · 第一章 黎明苏醒号」。
                title = re.sub(r"^第\s*[0-9一二三四五六七八九十百零两]+\s*[章回节]\s*[、.．:：\-—]?\s*",
                               "", t).strip() or t
                start = i + 1
                break
    return volume, chapter_no, title, start


# --------------------------------------------------------------------------
# 从上传的文件构建 Chapter
# --------------------------------------------------------------------------

def build_from_file(path: Path, *, fallback_no: int = 0) -> Chapter:
    """把上传的 docx/txt/md 变成一个章节对象（不落盘）。"""
    doc = docx_parser.read_any(path)
    paras = doc.paragraphs

    fname_volume, fname_seq, fname_summary = parse_filename(path.stem)
    doc_volume, doc_no, doc_title, start = split_volume_and_title(paras)

    body_paras = [p.text for p in paras[start:]]
    # 表格内容也并入正文（有些稿子把设定放在表里）
    for tbl in doc.tables:
        for row in tbl:
            body_paras.append(" | ".join(row))

    text = "\n\n".join(t.strip() for t in body_paras if t.strip())
    if len(text) > MAX_CHAPTER_CHARS:
        text = text[:MAX_CHAPTER_CHARS]

    # 章序优先级：正文里的「第X章」> 文件名里的数字 > 调用方给的兜底序号
    chapter_no = doc_no or fname_seq or fallback_no
    title = doc_title or fname_summary or path.stem
    volume = doc_volume or fname_volume

    return Chapter(
        chapter_no=int(chapter_no or 0),
        title=title,
        volume=volume,
        source_file=path.name,
        imported_at=now_iso(),
        word_count=count_words(text),
        text=text,
    )


# --------------------------------------------------------------------------
# 落盘 / 读取
# --------------------------------------------------------------------------

def chapter_file_name(chapter_no: int, title: str) -> str:
    safe = safe_filename(title or f"第{chapter_no}章")[:60]
    return f"{int(chapter_no):04d}-{safe}.md"


def chapter_file_path(book_id: str, chapter_no: int, title: str = "") -> Path:
    d = paths.chapters_dir(book_id)
    # 已有同名章号的文件就复用，避免导入两次产生两份
    existing = find_chapter_file(book_id, chapter_no)
    if existing is not None:
        return existing
    return d / chapter_file_name(chapter_no, title)


def find_chapter_file(book_id: str, chapter_no: int) -> Path | None:
    d = paths.chapters_dir(book_id)
    if not d.exists():
        return None
    prefix = f"{int(chapter_no):04d}-"
    for f in sorted(d.glob("*.md")):
        if f.name.startswith(prefix):
            return f
    return None


def _render(chapter: Chapter) -> str:
    fm = yaml.safe_dump(chapter.to_frontmatter(), allow_unicode=True,
                        sort_keys=False, default_flow_style=False).strip()
    return f"---\n{fm}\n---\n\n{chapter.text.strip()}\n"


def save_chapter(book_id: str, chapter: Chapter) -> Path:
    """写入章节文件。正文原样落盘，不做任何加工。"""
    d = paths.chapters_dir(book_id)
    d.mkdir(parents=True, exist_ok=True)
    target = chapter_file_path(book_id, chapter.chapter_no, chapter.title)
    target.write_text(_render(chapter), encoding="utf-8")
    chapter.file_path = str(target)
    return target


def _load_file(path: Path) -> Chapter | None:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    fm: dict = {}
    text = raw
    if raw.startswith("---"):
        parts = raw.split("---", 2)
        if len(parts) >= 3:
            try:
                fm = yaml.safe_load(parts[1]) or {}
            except yaml.YAMLError:
                fm = {}
            text = parts[2].lstrip("\n")
    if not fm:
        # 没 frontmatter 的文件名兜底：0003-某标题.md
        m = re.match(r"^(\d+)-(.*)$", path.stem)
        if m:
            fm = {"chapter_no": int(m.group(1)), "title": m.group(2)}
    ch = Chapter.from_parts(fm, text.strip(), str(path))
    if not ch.word_count:
        ch.word_count = count_words(ch.text)
    return ch


def list_chapters(book_id: str) -> list[Chapter]:
    d = paths.chapters_dir(book_id)
    if not d.exists():
        return []
    out: list[Chapter] = []
    for f in sorted(d.glob("*.md")):
        if f.name.startswith("."):
            continue
        ch = _load_file(f)
        if ch is not None:
            out.append(ch)
    out.sort(key=lambda c: (c.chapter_no or 10**6, c.title))
    return out


def read_chapter(book_id: str, chapter_no: int) -> Chapter | None:
    f = find_chapter_file(book_id, chapter_no)
    return _load_file(f) if f else None


def delete_chapter(book_id: str, chapter_no: int) -> bool:
    f = find_chapter_file(book_id, chapter_no)
    if not f:
        return False
    f.unlink()
    return True


def next_chapter_no(book_id: str) -> int:
    items = list_chapters(book_id)
    return (max((c.chapter_no for c in items), default=0)) + 1


def overall_stats(book_id: str) -> dict:
    items = list_chapters(book_id)
    return {
        "chapters": len(items),
        "words": sum(c.word_count for c in items),
        "volumes": sorted({c.volume for c in items if c.volume}),
    }
