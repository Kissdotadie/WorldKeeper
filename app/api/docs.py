"""`world/` 目录下的**整册档案**。

为什么要有这个通道？
「一实体一文件」适合人物、地点这类可以被双链引用的东西；
但纪年表、剧情线、伏笔看板天然是**一张表、一条线**，硬拆成几百个实体文件反而不可读。

所以给 `world/` 开一路：**Markdown 表格就是真源**，工具只读它、只按用户输入写它，
不引入第二种格式（导出、Git diff、手改都还是纯文本）。
和 `chapters/` 的区别很重要：那是正文只读区，这里是可以写的档案区。
"""

from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

from .. import paths
from ._common import check_book_id

router = APIRouter(tags=["docs"])

#: 只允许朴素的小写名，防止 `../` 之类的东西混进路径
_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,24}$")


def _tpl(title: str, columns: list[str], samples: list[list[str]]) -> str:
    head = "| " + " | ".join(columns) + " |\n"
    sep = "|" + "|".join(["---"] * len(columns)) + "|\n"
    body = "".join("| " + " | ".join(r) + " |\n" for r in samples)
    return f"# {title}\n\n{head}{sep}{body}"


#: 预置档案。不在表里的名字也能用，只是没有现成模板。
DOC_KINDS: dict[str, dict] = {
    "worldview": {
        "title": "世界观总纲",
        "hint": "世界的底色：时代、制度、力量体系、常识。写成条文，别写成小说。",
        "columns": [],
        "template": (
            "# 世界观总纲\n\n"
            "## 时代与地理\n\n"
            "## 力量体系\n\n"
            "## 社会制度\n\n"
            "## 常识与禁忌\n"
        ),
    },
    "chronology": {
        "title": "纪年表",
        "hint": "故事内时间的编年。有了它，时间线才能从「第几章」升到「哪一年」。",
        "columns": ["时间", "事件", "关联", "备注"],
        "template": _tpl(
            "纪年表",
            ["时间", "事件", "关联", "备注"],
            [
                ["明显帝 138 年", "北境初定", "[[裴渊]]", "背景交代"],
                ["明显帝 143 年 秋", "裴渊入京", "[[裴渊]]、[[韦忠]]", ""],
            ],
        ),
    },
    "plot": {
        "title": "剧情线",
        "hint": "按卷 / 章节记事件与状态。章节正文导入后（P2/P3）会自动补进来，现在可以手填大纲。",
        "columns": ["卷", "章节", "事件", "状态", "备注"],
        "template": _tpl(
            "剧情线",
            ["卷", "章节", "事件", "状态", "备注"],
            [
                ["卷一", "第1章", "裴渊入京应试", "已写", "开头三章定基调"],
                ["卷一", "第2章", "科场舞弊案发", "待写", ""],
            ],
        ),
    },
    "foreshadow": {
        "title": "伏笔看板",
        "hint": "埋下去就要记得收。状态一列填「已回收」它就从待办里消失。",
        "columns": ["伏笔", "埋设章节", "预计回收", "状态", "备注"],
        "template": _tpl(
            "伏笔看板",
            ["伏笔", "埋设章节", "预计回收", "状态", "备注"],
            [["裴渊的旧伤", "第3章", "第一卷末", "未回收", ""]],
        ),
    },
    "geography": {
        "title": "地理志",
        "hint": "地点的从属与距离。要画真地图需要坐标体系，那是后面的事；这里先记住「谁归谁管」。",
        "columns": ["地名", "所属", "类型", "备注"],
        "template": _tpl(
            "地理志",
            ["地名", "所属", "类型", "备注"],
            [
                ["大明显朝", "—", "王朝", ""],
                ["京城", "大明显朝", "都城", ""],
                ["北境", "大明显朝", "边地", "常年驻军"],
            ],
        ),
    },
    "rules": {
        "title": "规则与边界",
        "hint": "修炼 / 科技 / 魔法系统的硬规矩。写清楚「不能做什么」比写「能做什么」重要。",
        "columns": ["规则", "内容", "边界条件", "出处"],
        "template": _tpl(
            "规则与边界",
            ["规则", "内容", "边界条件", "出处"],
            [["境界不可越阶", "低阶无法伤到高阶", "绝境 / 秘宝例外", ""]],
        ),
    },
}

_SEP_CELL = re.compile(r"^:?-{2,}:?$")


def doc_spec(name: str) -> dict:
    """取档案规格；未预置的名字给一份通用规格。"""
    spec = DOC_KINDS.get(name)
    if spec:
        return {"name": name, **spec}
    title = name.replace("_", " ").strip() or name
    return {
        "name": name,
        "title": title,
        "hint": "自定义档案。写 Markdown 表格就会有视图，写别的内容就是纯文本。",
        "columns": [],
        "template": f"# {title}\n\n",
    }


def doc_path(book_id: str, name: str) -> Path:
    """解析成绝对路径，并确认它确实落在本册的 world/ 里。"""
    if not _NAME_RE.match(name or ""):
        raise HTTPException(status_code=400, detail=f"档案名不合法：{name!r}")
    root = paths.world_dir(book_id).resolve()
    target = (root / f"{name}.md").resolve()
    if target.parent != root:
        raise HTTPException(status_code=400, detail="路径越界")
    return target


def parse_table(text: str) -> tuple[list[str], list[list[str]]]:
    """把 Markdown 里的**第一张**表格抠出来。没有表格就返回空。"""
    rows: list[list[str]] = []
    for line in (text or "").splitlines():
        s = line.strip()
        if not s.startswith("|"):
            if rows:
                break  # 表格结束
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if cells and all(not c or _SEP_CELL.match(c) for c in cells):
            continue  # `|---|---|` 分隔行
        rows.append(cells)
    if not rows:
        return [], []
    return rows[0], rows[1:]


# --------------------------------------------------------------------------
# 接口
# --------------------------------------------------------------------------


@router.get("/books/{book_id}/docs")
def api_docs_list(book_id: str) -> dict:
    """列出所有档案，并标出哪些已经建了。"""
    check_book_id(book_id)
    root = paths.world_dir(book_id)
    out = []
    for name in DOC_KINDS:
        f = root / f"{name}.md"
        out.append({"name": name, **{k: v for k, v in doc_spec(name).items() if k != "name"},
                    "exists": f.is_file()})
    # world/ 下用户自己加的文件也一并列出
    if root.is_dir():
        for f in sorted(root.glob("*.md")):
            if f.stem in DOC_KINDS:
                continue
            out.append({**doc_spec(f.stem), "exists": True})
    return {"book_id": book_id, "docs": out, "count": len(out)}


@router.get("/books/{book_id}/docs/{name}")
def api_docs_get(book_id: str, name: str) -> dict:
    """读一份档案。文件不存在时返回 `exists=false` 与模板正文，前端据此给「一键建模板」。"""
    check_book_id(book_id)
    path = doc_path(book_id, name)
    spec = doc_spec(name)

    exists = path.is_file()
    text = path.read_text(encoding="utf-8") if exists else ""
    columns, rows = parse_table(text)

    return {
        "book_id": book_id,
        "name": name,
        "title": spec["title"],
        "hint": spec["hint"],
        "exists": exists,
        "path": str(path),
        "text": text,
        "columns": columns,
        "rows": rows,
        "template": spec["template"],
    }


@router.put("/books/{book_id}/docs/{name}")
def api_docs_put(book_id: str, name: str, payload: dict = Body(...)) -> dict:
    """整份覆盖写。文件名固定、内容固定，所以没有并发合并的问题。

    注意这是 `world/` 档案区，不是 `chapters/` 正文区 —— 正文永不写入这条规矩不受影响。
    """
    check_book_id(book_id)
    text = payload.get("text")
    if not isinstance(text, str):
        raise HTTPException(status_code=400, detail="缺少 text 字段")

    path = doc_path(book_id, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")

    columns, rows = parse_table(text)
    return {
        "book_id": book_id,
        "name": name,
        "exists": True,
        "path": str(path),
        "columns": columns,
        "rows": rows,
        "saved": True,
    }
