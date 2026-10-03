"""实体接口：增删改查、批量粘贴导入、搜索。

所有路由第一参数是 book_id（口子 4）。
创建实体走「先生成稳定 ID → 写 Markdown → 更新索引」的顺序，
Markdown 始终是真源。
"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .. import config, custom_types, entities, paths, snapshot, store
from ..logging_setup import get_logger
from ..models import Entity, empty_body, now_iso
from ..parsers import contract as extractor_contract
from ._common import check_book_id as _check_book_id
from ._common import check_type as _check_type
from ._common import type_labels_for as _type_labels_for
from ._common import type_options as _type_options

log = get_logger(__name__)
router = APIRouter(tags=["entities"])


# --------------------------------------------------------------------------
# 请求体
# --------------------------------------------------------------------------

class EntityIn(BaseModel):
    type: str
    name: str = Field(..., min_length=1, max_length=120)
    aliases: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    #: 方法论引用（名字数组）。角色信奉哪套哲学观就填在这里。
    methodologies: list[str] = Field(default_factory=list)
    first_appear: str | None = None
    status: str | None = None
    #: 自定义图标，素材库相对路径（如 `icons/knight.png`）
    icon: str | None = None
    # 摘要既可以用扁平字段（和列表接口返回的 summary 对称），
    # 也可以放进 body["摘要"]，两者同时给以 body 为准。
    summary: str | None = None
    body: dict | None = None

    def merged_body(self, base: dict | None = None) -> dict | None:
        """把扁平字段并进结构化 body。两者都没给则返回 None（表示不改动）。"""
        if self.body is None and self.summary is None:
            return None
        body = {**empty_body(), **(base or {}), **(self.body or {})}
        if self.summary is not None:
            body["摘要"] = self.summary
        return body


class PasteIn(BaseModel):
    text: str = ""
    mode: str | None = None
    type: str = "concept"
    tags: list[str] = Field(default_factory=list)
    summary_column: str | None = None


class DraftIn(BaseModel):
    """用户在待确认清单里核对过、准备落盘的一条。"""

    name: str = Field(..., min_length=1, max_length=200)
    summary: str = ""
    aliases: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    attributes: list[list[str]] = Field(default_factory=list)


class PasteCommitIn(PasteIn):
    """提交落盘。

    两条路径：
    - 传 drafts：只落盘清单里保留下来的条目（人工确认后的路径，界面上走这条）
    - 不传 drafts：拿 text 重新解析一遍全量落盘（脚本/命令行走的捷径）
    """

    drafts: list[DraftIn] | None = None
    on_duplicate: Literal["skip", "create"] = "skip"


# --------------------------------------------------------------------------
# 查询
# --------------------------------------------------------------------------

@router.get("/books/{book_id}/entities")
def api_list_entities(
    book_id: str,
    type: str | None = Query(default=None),
    tag: str | None = Query(default=None),
    sort: str = Query(default="name"),
) -> dict:
    _check_book_id(book_id)
    items = store.list_entities(book_id, type, tag, sort)
    return {"book_id": book_id, "count": len(items), "items": items, "types": _type_options(book_id)}


@router.get("/books/{book_id}/stats")
def api_stats(book_id: str) -> dict:
    _check_book_id(book_id)
    data = store.stats(book_id)
    data["types"] = _type_options(book_id)
    return data


def _index_health(book_id: str, index_total: int) -> dict:
    """索引 vs 磁盘的对照快照 —— 汇总页「什么都画不出来」时，靠它定位断在哪一环。

    故意破一次「汇总接口不扫文件」的例：一片空白最需要的恰恰是「到底哪一层空」。
    但只在**索引里一条实体都没有**时才去数磁盘文件（那正是空白页的典型症状），
    索引里有数就直接跳过，保持毫秒级。

    返回里那几个路径是关键：`data_dir` 能一眼看出是不是程序切到了另一个数据目录，
    `index_total` / `disk_total` 的落差则说明索引过期了，重建一下就行。
    """
    bdir = paths.book_dir(book_id)
    edir = paths.entities_dir(book_id)
    idx = paths.index_file()

    disk_total: int | None = None
    if index_total == 0:
        n = 0
        if edir.is_dir():
            for p in edir.rglob("*.md"):
                if not p.name.startswith("_"):  # 目录说明之类的下划线文件不算实体
                    n += 1
        disk_total = n

    idx_mtime = None
    if idx.exists():
        idx_mtime = datetime.fromtimestamp(idx.stat().st_mtime).isoformat(timespec="seconds")

    return {
        "data_dir": str(paths.data_dir()),
        "book_dir": str(bdir),
        "book_dir_exists": bdir.is_dir(),
        "entities_dir_exists": edir.is_dir(),
        "index_file": str(idx),
        "index_file_exists": idx.exists(),
        "index_file_mtime": idx_mtime,
        "index_total": index_total,
        "disk_total": disk_total,
        # 磁盘上有 md、索引里却没有 —— 索引过期，页面上直接提示「重建索引」
        "index_stale": bool(disk_total is not None and disk_total > index_total),
    }


@router.get("/books/{book_id}/overview")
def api_overview(book_id: str) -> dict:
    """汇总页数据看板要的全部数字，一次往返拿完（详见 store.dashboard_overview）。

    `types` 一并带上：页面上每处图例都要把类型 key 翻成显示名，缺了它前端还得
    再请求一次 —— 那正好是「打开首页白一下」的原因。
    `health` 是索引健康快照，让「页面是空的」这件事自己带上原因。
    """
    _check_book_id(book_id)
    data = store.dashboard_overview(book_id)
    data["types"] = _type_options(book_id)
    data["health"] = _index_health(book_id, data["entities"]["total"])
    return data


@router.get("/books/{book_id}/tags")
def api_tags(book_id: str) -> dict:
    _check_book_id(book_id)
    return {"book_id": book_id, "tags": store.all_tags(book_id)}


@router.get("/books/{book_id}/search")
def api_search(book_id: str, q: str = Query(default=""), limit: int = Query(default=50, ge=1, le=200)) -> dict:
    _check_book_id(book_id)
    results = store.search(book_id, q, limit)
    return {"book_id": book_id, "query": q, "count": len(results), "items": results}


@router.get("/books/{book_id}/changed-files")
def api_changed_files(book_id: str) -> dict:
    """检测被外部编辑器改动过的文件（数据指纹）。"""
    _check_book_id(book_id)
    files = store.changed_files(book_id)
    return {"book_id": book_id, "count": len(files), "files": files}


# --------------------------------------------------------------------------
# 批量粘贴导入（主力录入路径）
# --------------------------------------------------------------------------

@router.post("/books/{book_id}/bulk-paste/preview")
def api_paste_preview(book_id: str, payload: PasteIn) -> dict:
    """解析粘贴内容，返回草稿供确认 —— 不落盘。"""
    _check_book_id(book_id)
    _check_type(payload.type, book_id)
    # 解析走**抽取器契约**（P11-C3）：raw.drafts 原样透传，响应形状不变。
    # exists 的「按所选类型查重」留在这一层 —— 那是「和库里哪个类型撞名」，
    # 不是「抽没抽到」，归 API 口径管。
    result = extractor_contract.run_extractor("paste", extractor_contract.ExtractRequest(
        book_id=book_id, material=payload.text,
        options={"mode": payload.mode, "tags": payload.tags},
    )).extras["raw"]

    existing = {e["name"] for e in store.list_entities(book_id, payload.type)}
    for draft in result["drafts"]:
        draft["exists"] = draft["name"] in existing
    if existing:
        hit = [d["name"] for d in result["drafts"] if d.get("exists")]
        if hit:
            result["warnings"].append("以下条目已存在同名实体：" + "、".join(hit))

    result["book_id"] = book_id
    result["type"] = payload.type
    return result


@router.post("/books/{book_id}/bulk-paste/commit", status_code=201)
def api_paste_commit(book_id: str, payload: PasteCommitIn) -> dict:
    """确认导入。**只落盘用户在清单里保留下来的条目**，不做静默全量写。"""
    _check_book_id(book_id)
    _check_type(payload.type, book_id)

    if payload.drafts is not None:
        drafts = [d.model_dump() for d in payload.drafts]
    else:
        drafts = extractor_contract.run_extractor("paste", extractor_contract.ExtractRequest(
            book_id=book_id, material=payload.text,
            options={"mode": payload.mode, "tags": payload.tags},
        )).extras["raw"]["drafts"]
    if not drafts:
        raise HTTPException(status_code=400, detail="没有可导入的条目")

    existing = {e["name"] for e in store.list_entities(book_id, payload.type)}
    conflict = sorted({d["name"] for d in drafts} & existing)

    seq = entities.next_sequence(book_id, payload.type)
    created: list[dict] = []
    skipped: list[str] = []

    for draft in drafts:
        name = str(draft.get("name") or "").strip()
        if not name:
            continue
        if name in existing and payload.on_duplicate == "skip":
            skipped.append(name)
            continue
        entity = _draft_to_entity(book_id, payload.type, draft, seq=seq)
        seq += 1
        entities.save_entity_file(entity)
        store.upsert_entity_single(entity)
        created.append({"id": entity.id, "name": entity.name, "file": entity.file_path})

    store.rebuild_book_relations(book_id)

    log.info("批量导入：%s / %s，新增 %d 条，跳过 %d 条", book_id, payload.type, len(created), len(skipped))
    return {
        "book_id": book_id,
        "type": payload.type,
        "created": len(created),
        "skipped": skipped,
        "conflicts": conflict,
        "items": created,
    }


def _draft_to_entity(book_id: str, type_key: str, draft: dict, seq: int) -> Entity:
    body = empty_body()
    body["摘要"] = draft.get("summary", "") or ""
    attrs = draft.get("attributes") or []
    body["属性"] = [[str(r[0]), str(r[1])] for r in attrs if len(r) >= 2 and str(r[0]).strip()]
    return Entity(
        id=custom_types.make_id(book_id, type_key, seq),
        book_id=book_id,
        type=type_key,
        name=str(draft["name"]).strip(),
        aliases=[str(a).strip() for a in (draft.get("aliases") or []) if str(a).strip()],
        tags=[str(t).strip() for t in (draft.get("tags") or []) if str(t).strip()],
        body=body,
        # 出处（口子 2）：这条是从粘贴来的，不是手敲的
        provenance={"method": "paste", "sources": []},
    )


# --------------------------------------------------------------------------
# 单条增删改查
# --------------------------------------------------------------------------

@router.get("/books/{book_id}/entities/{entity_id}")
def api_get_entity(book_id: str, entity_id: str) -> dict:
    _check_book_id(book_id)
    meta = store.get_entity(book_id, entity_id)
    if not meta:
        raise HTTPException(status_code=404, detail="实体不存在")
    entity = None
    if meta.get("file_path") and Path(meta["file_path"]).exists():
        try:
            entity = entities.load_entity_file(Path(meta["file_path"]))
        except Exception as exc:
            log.warning("读取实体文件失败 %s：%s", meta["file_path"], exc)
    if entity:
        meta["body"] = entity.body
        meta["created_at"] = entity.created_at
        meta["provenance"] = entity.provenance
    else:
        meta.setdefault("body", empty_body())
    labels = _type_labels_for(book_id)
    meta["type_label"] = labels.get(meta.get("type", ""), "")
    return meta


@router.post("/books/{book_id}/entities", status_code=201)
def api_create_entity(book_id: str, payload: EntityIn) -> dict:
    _check_book_id(book_id)
    _check_type(payload.type, book_id)

    seq = entities.next_sequence(book_id, payload.type)
    entity = Entity(
        id=custom_types.make_id(book_id, payload.type, seq),
        book_id=book_id,
        type=payload.type,
        name=payload.name.strip(),
        aliases=[a.strip() for a in payload.aliases if a.strip()],
        tags=[t.strip() for t in payload.tags if t.strip()],
        methodologies=[m.strip() for m in payload.methodologies if m.strip()],
        first_appear=payload.first_appear,
        status=payload.status,
        icon=(payload.icon or '').strip() or None,
        body=payload.merged_body() or empty_body(),
        provenance={"method": "manual", "sources": []},
    )
    path = entities.save_entity_file(entity)
    store.upsert_entity_single(entity)
    return {"id": entity.id, "name": entity.name, "file": str(path)}


@router.put("/books/{book_id}/entities/{entity_id}")
def api_update_entity(book_id: str, entity_id: str, payload: EntityIn) -> dict:
    _check_book_id(book_id)
    meta = store.get_entity(book_id, entity_id)
    if not meta:
        raise HTTPException(status_code=404, detail="实体不存在")

    path = Path(meta["file_path"]) if meta.get("file_path") else None
    if not path or not path.exists():
        raise HTTPException(status_code=409, detail="实体文件缺失，请重建索引后重试")

    entity = entities.load_entity_file(path)
    # 类型改成注册表里有的都行（内置 + 本书自定义）；没给/不认识的保持原样
    entity.type = payload.type if payload.type in custom_types.list_types(book_id) else entity.type
    entity.name = payload.name.strip() or entity.name
    entity.aliases = [a.strip() for a in payload.aliases if a.strip()]
    entity.tags = [t.strip() for t in payload.tags if t.strip()]
    entity.methodologies = [m.strip() for m in payload.methodologies if m.strip()]
    entity.first_appear = payload.first_appear
    entity.status = payload.status
    entity.icon = (payload.icon or '').strip() or None
    merged = payload.merged_body(entity.body)
    if merged is not None:
        entity.body = merged
    entity.updated_at = now_iso()
    entity.file_path = str(path)

    new_path = entities.save_entity_file(entity)
    store.upsert_entity_single(entity)
    store.rebuild_book_relations(book_id)
    return {"id": entity.id, "name": entity.name, "file": str(new_path)}


@router.delete("/books/{book_id}/entities/{entity_id}")
def api_delete_entity(book_id: str, entity_id: str) -> dict:
    _check_book_id(book_id)
    meta = store.get_entity(book_id, entity_id)
    if not meta:
        raise HTTPException(status_code=404, detail="实体不存在")

    path = meta.get("file_path")
    target: Path | None = None
    if path:
        # 路径安全闸：索引里的绝对路径万一指向别处（副本/迁移残留），
        # 这里必须拦下 —— 删除不可逆，宁可拒删让用户重建索引。
        try:
            target = paths.ensure_inside_book(book_id, path)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    # 删之前先备份：删除是唯一不可逆的动作，删错一个人会连带丢掉他的关系与出场记录。
    # 快照失败就中止 —— 宁可不删，也不能让人以为「有备份」。
    if target and target.exists():
        try:
            snapshot.snapshot_files(book_id, [target], reason=f"del-{entity_id}")
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"删除前快照失败，已中止：{exc}") from exc

    store.delete_entity_single(book_id, entity_id)
    if target and target.exists():
        try:
            target.unlink()
        except OSError as exc:
            log.warning("删除实体文件失败 %s：%s", target, exc)
    return {"id": entity_id, "deleted": True}


# --------------------------------------------------------------------------
# 别名总表 + 实体合并（P7）
# --------------------------------------------------------------------------

@router.get("/books/{book_id}/aliases")
def api_list_aliases(book_id: str) -> dict:
    """全局名字视角：别名表（含实体主名）+ 谁的名字被多个实体占用（冲突）。

    主名也放进表里，是因为「黎明觉醒号 / 黎明苏醒号」这类同物异名
    （名字零重叠）不会触发冲突检测 —— 只有把主名摊进同一张表，
    搜索框才找得到它们，合并才有入口。
    """
    _check_book_id(book_id)
    with store.connect() as conn:
        rows = conn.execute(
            """SELECT a.alias, a.entity_id,
                      COALESCE(e.name, '') AS name, COALESCE(e.type, '') AS type
                 FROM entity_aliases a
                 LEFT JOIN entities e
                   ON e.book_id = a.book_id AND e.id = a.entity_id
                WHERE a.book_id = ?
                ORDER BY a.alias COLLATE NOCASE""",
            (book_id,),
        ).fetchall()
        names = conn.execute(
            "SELECT id, name, type FROM entities WHERE book_id = ?", (book_id,)
        ).fetchall()

    owners: dict[str, list[dict]] = {}
    for r in rows:
        owners.setdefault(r["alias"], []).append(
            {"entity_id": r["entity_id"], "name": r["name"], "type": r["type"], "via": "alias"}
        )
    for n in names:
        owners.setdefault(n["name"], []).append(
            {"entity_id": n["id"], "name": n["name"], "type": n["type"], "via": "name"}
        )
    conflicts = {
        alias: entries
        for alias, entries in owners.items()
        if len({e["entity_id"] for e in entries}) > 1
    }
    # 主名行混进同一张表（via=name），前端标灰区分 —— 名字视角才是完整的
    items = [
        {"alias": r["alias"], "entity_id": r["entity_id"],
         "entity_name": r["name"], "type": r["type"], "via": "alias"}
        for r in rows
    ] + [
        {"alias": n["name"], "entity_id": n["id"],
         "entity_name": n["name"], "type": n["type"], "via": "name"}
        for n in names
    ]
    return {"aliases": items, "count": len(items), "conflicts": conflicts}


class MergeIn(BaseModel):
    source_id: str


@router.post("/books/{book_id}/entities/{entity_id}/merge")
def api_merge_entity(book_id: str, entity_id: str, payload: MergeIn) -> dict:
    """把 source 并入 entity_id（后者为主）。关系真源是 [[双链]]，
    合并只改实体档案 + 重建关系解析，**章节正文一个字不动**。"""
    _check_book_id(book_id)
    if payload.source_id == entity_id:
        raise HTTPException(status_code=400, detail="不能把实体合并到它自己")
    with store.connect() as conn:
        exists = lambda eid: conn.execute(
            "SELECT 1 FROM entities WHERE book_id=? AND id=?", (book_id, eid)
        ).fetchone()
        if not exists(entity_id) or not exists(payload.source_id):
            raise HTTPException(status_code=404, detail="实体不存在")
        # 名字 → 实体 ID 的全局归属（主名 + 别名），合并时只改写无歧义的名字
        owner: dict[str, str] = {}
        for eid, nm in conn.execute(
            "SELECT id, name FROM entities WHERE book_id=?", (book_id,)
        ).fetchall():
            owner.setdefault(str(nm).strip(), eid)
        for eid, al in conn.execute(
            "SELECT entity_id, alias FROM entity_aliases WHERE book_id=?", (book_id,)
        ).fetchall():
            owner.setdefault(str(al).strip(), eid)

    try:
        result = entities.merge_entity_files(book_id, entity_id, payload.source_id, name_owner=owner)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    # 索引同步：source 删掉、target 重读、关系全量重解析
    store.delete_entity_single(book_id, payload.source_id)
    meta = store.get_entity(book_id, entity_id)
    if meta and meta.get("file_path") and Path(meta["file_path"]).exists():
        fresh = entities.load_entity_file(Path(meta["file_path"]))
        store.upsert_entity_single(fresh)
    store.rebuild_book_relations(book_id)
    log.info("实体合并：%s ← %s（吸收名字 %s，改写双链 %s 处）",
             result["target"], result["source"], result["absorbed_names"], result["moved_links"])
    return result
