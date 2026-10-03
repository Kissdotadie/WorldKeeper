"""书目接口。"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import config, custom_types, entities, fingerprint, jobs, paths, snapshot, store
from ..logging_setup import get_logger
from ..models import ENTITY_TYPES
from ._common import check_book_id, clean_type_labels, type_labels_for

log = get_logger(__name__)

router = APIRouter(tags=["books"])


class BookIn(BaseModel):
    book_id: str = Field(..., min_length=1, max_length=64, description="书目标识，同时作为目录名")
    title: str = ""
    author: str = ""
    #: 题材（玄幻/科幻/…）—— 决定录入界面的示例与占位文案，随书可改
    genre: str = ""
    #: 封面，素材库相对路径（covers/xxx.jpg）
    cover: str = ""


class BookUpdateIn(BaseModel):
    """改书目元数据。只给了的字段才会动。"""
    title: str | None = None
    author: str | None = None
    genre: str | None = None
    cover: str | None = None


class TypeLabelsIn(BaseModel):
    """类型显示名的覆盖表。key 必须是内置 8 种之一，空值 = 恢复内置名。"""
    labels: dict[str, str]


class DeleteBookIn(BaseModel):
    """删整本书。**必须把书名原样回填一遍** —— 防手滑。"""
    confirm: str
    book_id: str


class CustomTypeIn(BaseModel):
    """新建自定义类型。key 必给（要当目录名），prefix/color 可留空自动定。"""
    label: str
    key: str
    prefix: str | None = None
    color: str | None = None


@router.get("/books")
def api_list_books() -> dict:
    items = entities.list_books()
    return {"books": items, "count": len(items)}


@router.post("/books", status_code=201)
def api_create_book(payload: BookIn) -> dict:
    try:
        book = entities.create_book(payload.book_id, payload.title, payload.author,
                                    genre=payload.genre, cover=payload.cover)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return book


@router.put("/books/{book_id}")
def api_update_book(book_id: str, payload: BookUpdateIn) -> dict:
    """改书名/作者/题材/封面。只动 book.yaml —— 实体与正文一个字不碰。

    exclude_none：没提交的字段不许「顺手」写进 patch —— 否则一个只改题材的
    请求会把 title=None 一起送下去，下游 str(None) 就成了字符串 "None"。
    """
    check_book_id(book_id)
    patch = payload.model_dump(exclude_none=True)
    if not patch:
        raise HTTPException(status_code=400, detail="没有给出任何要改的字段")
    return entities.update_book(book_id, patch)


@router.get("/books/{book_id}")
def api_get_book(book_id: str) -> dict:
    check_book_id(book_id)
    cfg = config.load_book_config(book_id)
    if not cfg.get("book_id"):
        cfg["book_id"] = book_id
    cfg["entity_count"] = len(entities.load_all_entities(book_id))
    # 界面要的是「现在显示成什么」，不是「覆盖表里写了什么」 ——
    # 所以这里合并完再给，前端不用自己兜底。
    cfg["type_labels"] = type_labels_for(book_id)
    return cfg


@router.delete("/books/{book_id}")
def api_delete_book(book_id: str, payload: DeleteBookIn) -> dict:
    """**整本书删掉**（含档案、正文、世界观文档、地图、视图摆位）。

    这是全项目最不可逆的一个动作，所以上了三道闸：

    1. **必须回填书名**。`confirm` 要与书名（或书目 ID）逐字一致 ——
       下拉菜单里点错一行的成本是整本书，这个门槛值。
    2. **先整本快照再动手**。快照落到 `data/snapshots/`，**在书目录之外**，
       所以它自己不会被这次删除带走；返回里把快照路径给出来，
       后悔了按原路径拷回 `books/` 就能整体复原。
    3. **路径闸**。`paths.ensure_book_root()` 要求解析结果必须是 `books/` 的
       直接子目录 —— `..` 之类的东西漏进来就会删到数据目录外面去。

    删完顺手把索引里这本书的行清掉，不留幽灵条目。
    """
    check_book_id(book_id)
    root = None
    try:
        root = paths.ensure_book_root(book_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not root.is_dir():
        raise HTTPException(status_code=404, detail=f"书目「{book_id}」不存在")

    cfg = config.load_book_config(book_id)
    title = str(cfg.get("title") or book_id)
    given = (payload.confirm or "").strip()
    if given not in (title, book_id):
        raise HTTPException(
            status_code=400,
            detail=f"确认名不匹配：请输入书名「{title}」或书目 ID「{book_id}」",
        )

    # 有活儿在跑就先别删。任务还在往书目录里写，一边删一边写，
    # Windows 上 rmtree 会中途报「目录不是空的」停下 —— 书没删干净、
    # 索引却已经清空，是最坏的一种状态。让用户先去任务中心把活儿停掉。
    pending = jobs.pending_for_book(book_id)
    if pending:
        names = "、".join(f"{p.get('title') or p['kind']}（{p['status']}）" for p in pending[:3])
        raise HTTPException(
            status_code=409,
            detail=(
                f"这本书还有 {len(pending)} 个任务没跑完：{names}。"
                "先去「任务中心」把它们停掉（或等它们跑完）再删 —— "
                "否则删到一半任务还在往目录里写，会删不干净。"
            ),
        )

    # 先快照。备份没成就整批中止 —— 「以为有备份、其实没有」比这次不删危险得多。
    try:
        snap = snapshot.snapshot_book(book_id, reason="book-delete")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"删除前快照失败，已中止：{exc}") from exc

    shutil.rmtree(root)
    store.forget_book(book_id)
    log.info("已删除书目「%s」，快照在 %s", book_id, snap.get("dir"))
    return {"deleted": True, "book_id": book_id, "title": title, "snapshot": snap}


@router.put("/books/{book_id}/type-labels")
def api_set_type_labels(book_id: str, payload: TypeLabelsIn) -> dict:
    """改类型的**显示名**。底层 key、目录、ID 前缀一个字都不动 ——
    只改「界面上的字」，所以随时可改、随时可改回，不存在迁移问题。"""
    check_book_id(book_id)
    labels = clean_type_labels(payload.labels)

    cfg = config.load_book_config(book_id)
    # 先整段拿掉再写回：这次没提交的 key 视为「恢复内置名」，
    # 否则改过一次的名字会赖在覆盖表里退不回去。
    cfg.pop("type_labels", None)
    if labels:
        cfg["type_labels"] = labels
    config.save_book_config(book_id, cfg)

    return {
        "book_id": book_id,
        "type_labels": type_labels_for(book_id),
        "builtin": {k: v[0] for k, v in ENTITY_TYPES.items()},
        "config_file": str(paths.book_config_file(book_id)),
    }


# --------------------------------------------------------------------------
# 自定义实体类型（P7.6）
# --------------------------------------------------------------------------

@router.get("/books/{book_id}/types")
def api_list_types(book_id: str) -> dict:
    """本书完整类型注册表：内置 8 + 自定义，各带实体计数与可用性标记。

    count 以文件系统为准；builtin=False 才可删除。
    """
    check_book_id(book_id)
    registry = custom_types.list_types(book_id)
    by_dir = custom_types.count_all(book_id)
    items = []
    for key, t in registry.items():
        items.append({
            "key": key,
            **t,
            "count": by_dir.get(t["subdir"], 0),
            "removable": not t["builtin"],
        })
    return {"book_id": book_id, "types": items, "max_custom": custom_types.MAX_CUSTOM}


@router.post("/books/{book_id}/types", status_code=201)
def api_add_type(book_id: str, payload: CustomTypeIn) -> dict:
    """注册自定义类型（开新部门）。校验全在 custom_types.add_custom。"""
    check_book_id(book_id)
    try:
        t = custom_types.add_custom(
            book_id, payload.label, key=payload.key,
            prefix=payload.prefix, color=payload.color)
    except custom_types.TypeError_ as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {**t, "count": 0}


@router.delete("/books/{book_id}/types/{type_key}")
def api_remove_type(book_id: str, type_key: str) -> dict:
    """注销自定义类型。名下还有实体 → 409（先移走或删光）。"""
    check_book_id(book_id)
    try:
        return custom_types.remove_custom(book_id, type_key)
    except custom_types.TypeError_ as exc:
        msg = str(exc)
        # 名下有实体是「状态冲突」（先处理实体再来），其余是「请求本身不合法」
        code = 409 if "名下还有" in msg else 422
        raise HTTPException(status_code=code, detail=msg) from exc


# --------------------------------------------------------------------------
# 整书导出（P7 数据导出）
# --------------------------------------------------------------------------

@router.get("/books/{book_id}/export")
def api_export_book(book_id: str):
    """整书打包下载（zip）：实体档案、章节正文、世界观文档、时间线/伏笔、
    配置、视图装饰 —— 全部内容一个不落，拿到哪台机器都能解压接着用。

    打包的是数据目录里的书目文件夹本身，不做任何格式转换 ——
    Markdown 是真源，备份也必须是原样的 Markdown。
    """
    import io
    import zipfile
    from datetime import datetime

    from fastapi import Response

    check_book_id(book_id)
    src = paths.book_dir(book_id)
    if not src.exists():
        raise HTTPException(status_code=404, detail="书目目录不存在")

    entity_count = sum(1 for _ in entities.iter_entity_files(book_id))
    manifest = {
        "book_id": book_id,
        "exported_at": datetime.now().isoformat(timespec="seconds"),
        "schema_version": "P7",
        "entity_count": entity_count,
        "note": "整书导出：解压到数据目录的 books/ 下即可恢复（目录名 = book_id）",
    }

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(src.rglob("*")):
            if p.is_file() and "__pycache__" not in p.parts:
                zf.write(p, Path(book_id) / p.relative_to(src))
        zf.writestr(f"{book_id}/manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    filename = f"{book_id}-export-{stamp}.zip"
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --------------------------------------------------------------------------
# 数据指纹（P11-A5）：发现「你在外部编辑器改过 md」
# --------------------------------------------------------------------------

@router.get("/books/{book_id}/fingerprint")
def api_fingerprint(book_id: str) -> dict:
    """比一遍「上次记下的样子」和「磁盘现在的样子」。**只读**，不改任何文件。

    没有基线时会顺手建一份，并如实回 `baseline_just_created=True` ——
    不然第一次进书会把全书每个文件都报成「新增」，那是纯噪音。
    """
    check_book_id(book_id)
    return fingerprint.status(book_id)


@router.post("/books/{book_id}/fingerprint/refresh")
def api_fingerprint_refresh(book_id: str) -> dict:
    """「我确实在外面改过，按现状接受」—— 重建基线。

    注意这里**只重建指纹，不碰索引**。想让索引也跟着磁盘更新，
    用「重建索引」；两件事分开做，是因为「以磁盘为准」和「以索引为准」
    是两个不同的决定，不该被一个按钮糊在一起。
    """
    check_book_id(book_id)
    try:
        r = fingerprint.refresh(book_id)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"重建指纹失败：{exc}") from exc
    out = fingerprint.diff(book_id)
    out["refreshed"] = r
    return out
