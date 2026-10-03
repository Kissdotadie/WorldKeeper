"""章节（正文）接口。

导入是唯一会写 `chapters/` 的操作；导入之后正文即只读。
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from .. import chapters as ch_mod
from .. import entities as entities_mod
from .. import paths
from .. import store
from ..logging_setup import get_logger
from .. import custom_types
from ..models import Entity, empty_body, now_iso
from ..parsers import contract as extractor_contract
from ..parsers import docx as docx_parser
from ..parsers.lint import judge_name
from ._common import check_book_id as _check_book_id
from ._common import type_options as _type_options

log = get_logger(__name__)
router = APIRouter(tags=["chapters"])

MAX_UPLOAD = 20 * 1024 * 1024  # 单个文件 20MB


class ChapterPatch(BaseModel):
    """手工调整章节元信息（不动正文）。"""

    title: str | None = None
    volume: str | None = None
    chapter_no: int | None = None


def _brief(ch: ch_mod.Chapter) -> dict:
    return {
        "chapter_no": ch.chapter_no,
        "title": ch.title,
        "volume": ch.volume,
        "source_file": ch.source_file,
        "imported_at": ch.imported_at,
        "word_count": ch.word_count,
        "file_path": ch.file_path,
    }


@router.get("/books/{book_id}/chapters")
def api_list_chapters(book_id: str) -> dict:
    _check_book_id(book_id)
    items = ch_mod.list_chapters(book_id)
    return {
        "book_id": book_id,
        "count": len(items),
        "items": [_brief(c) for c in items],
        "stats": ch_mod.overall_stats(book_id),
        "dir": str(paths.chapters_dir(book_id)),
    }


@router.get("/books/{book_id}/chapters/{chapter_no}")
def api_read_chapter(book_id: str, chapter_no: int) -> dict:
    _check_book_id(book_id)
    ch = ch_mod.read_chapter(book_id, chapter_no)
    if ch is None:
        raise HTTPException(status_code=404, detail=f"没有第 {chapter_no} 章")
    return {**_brief(ch), "text": ch.text, "book_id": book_id}


@router.get("/books/{book_id}/chapters/{chapter_no}/paragraphs")
def api_chapter_paragraphs(book_id: str, chapter_no: int,
                           limit: int = Query(default=0, ge=0, le=2000)) -> dict:
    """按段落返回（抽取候选时要定位到「第几段」，所以单独给一个口子）。"""
    _check_book_id(book_id)
    ch = ch_mod.read_chapter(book_id, chapter_no)
    if ch is None:
        raise HTTPException(status_code=404, detail=f"没有第 {chapter_no} 章")
    paras = [p.strip() for p in ch.text.split("\n\n") if p.strip()]
    if limit:
        paras = paras[:limit]
    return {"chapter_no": chapter_no, "count": len(paras), "paragraphs": paras}


async def _stage_upload(upload: UploadFile, tmpdir: Path) -> tuple[str, Path | None, str | None]:
    """把一个上传文件落到临时目录。返回 (文件名, 落盘路径, 错误)。

    只做「收下来」这件事：格式与大小在这一步就挡掉，别让它进到解析环节
    （解析一个 200MB 的假 docx 会先卡住再说）。
    """
    name = Path(upload.filename or "未命名").name
    suffix = Path(name).suffix.lower()
    if suffix not in docx_parser.ALLOWED_EXTS:
        return name, None, f"不支持的格式 {suffix or '(无扩展名)'}；只收 docx / txt / md"
    data = await upload.read()
    if len(data) > MAX_UPLOAD:
        return name, None, f"文件过大（{len(data)//1024//1024}MB，上限 20MB）"
    staged = tmpdir / name
    staged.write_bytes(data)
    return name, staged, None


def _parse_one(
    book_id: str, name: str, path: Path,
) -> tuple[str, ch_mod.Chapter | None, str | None]:
    """把一个**已经落在磁盘上**的文件解析成章节对象（章节本身不落盘）。

    返回 (文件名, 章节对象, 错误信息)。error 非 None 时 chapter 为 None。
    单个文件坏掉不能拖垮整批 —— 错误都在这里消化掉。
    """
    name = Path(name).name
    suffix = Path(name).suffix.lower()
    if suffix not in docx_parser.ALLOWED_EXTS:
        return name, None, f"不支持的格式 {suffix or '(无扩展名)'}；只收 docx / txt / md"
    try:
        chapter = ch_mod.build_from_file(path, fallback_no=ch_mod.next_chapter_no(book_id))
    except docx_parser.DocxError as exc:
        return name, None, str(exc)
    except Exception as exc:
        log.warning("解析 %s 失败：%s", name, exc)
        return name, None, f"解析失败：{exc}"
    if not chapter.text.strip():
        return name, None, "正文是空的，没提取到任何段落"
    return name, chapter, None


def run_import(
    book_id: str,
    entries: list[tuple[str, Path]],
    *,
    overwrite: bool = False,
    task=None,
    preset_errors: list[dict] | None = None,
) -> dict:
    """批量导入正文的真源实现。**同步接口与异步任务都调这一份。**

    一个文件 = 一章。章序优先取正文里的「第X章」，其次文件名里的数字。
    章号已存在且未勾覆盖时跳过 —— 因此**中断后重传同一批文件即可续跑**，
    已导入的章会自动跳过，只补没进去的那些（异步任务那条路还多一层
    「上次跑过哪些文件」的跳过，省掉重复解析）。

    `entries` 是 (显示用文件名, 磁盘上真实路径) —— 同步入口先把上传落到临时
    目录，异步入口的文件是先落到任务暂存目录的（要活过重启）。
    """
    _check_book_id(book_id)
    ch_dir = paths.chapters_dir(book_id)
    ch_dir.mkdir(parents=True, exist_ok=True)

    imported: list[dict] = []
    skipped: list[dict] = []
    errors: list[dict] = list(preset_errors or [])

    skip = task.skip if task is not None else set()
    todo = [(n, p) for (n, p) in entries if n not in skip]
    skipped_n = len(entries) - len(todo)
    if task is not None:
        task.set_total(len(entries), unit="个文件")
        if skipped_n:
            task.log(f"续跑：跳过上次已处理的 {skipped_n} 个文件")
            task.advance(skipped_n)

    for name, path in todo:
        if task is not None:
            task.check()
            task.detail(file=name)
        _n, chapter, error = _parse_one(book_id, name, path)
        if error:
            errors.append({"file": name, "error": error})
            if task is not None:
                task.advance(key=name, level="warn", text=f"{name}：{error}")
            continue

        assert chapter is not None
        exists = ch_mod.find_chapter_file(book_id, chapter.chapter_no) is not None
        if exists and not overwrite:
            reason = f"第 {chapter.chapter_no} 章已存在（勾选覆盖可替换）"
            skipped.append({"file": name, "chapter_no": chapter.chapter_no, "reason": reason})
            if task is not None:
                task.advance(key=name, text=f"{name}：{reason}")
            continue

        saved = ch_mod.save_chapter(book_id, chapter)
        imported.append({**_brief(chapter), "file": str(saved)})
        if task is not None:
            task.advance(key=name, text=f"第 {chapter.chapter_no} 章「{chapter.title}」"
                                        f"入册（{chapter.word_count} 字）")

    return {
        "book_id": book_id,
        "imported": len(imported),
        "skipped": len(skipped),
        "failed": len(errors),
        "items": imported,
        "skipped_items": skipped,
        "errors": errors,
        "stats": ch_mod.overall_stats(book_id),
    }


@router.post("/books/{book_id}/chapters/import/preview")
async def api_import_preview(
    book_id: str,
    files: list[UploadFile] = File(..., description="docx / txt / md，可多选"),
) -> dict:
    """批量导入**预检**：只解析，绝不落盘。

    返回每个文件解析出的章号/标题/卷/字数，以及三类标记：
    - `exists`：章号已在库里（增量导入时默认跳过，除非勾选覆盖）
    - `dup_in_batch`：同一批里有多个文件解析出同一章号（只会有一个被采用）
    - `error`：格式 / 解析问题

    前端据此在导入前把冲突标红，让用户决定要不要覆盖。
    """
    _check_book_id(book_id)
    items: list[dict] = []
    seen: dict[int, str] = {}  # chapter_no -> 第一个占用它的文件名

    with tempfile.TemporaryDirectory(prefix="wkv-ch-prev-") as tmp:
        tmpdir = Path(tmp)
        for upload in files:
            name, staged, error = await _stage_upload(upload, tmpdir)
            if error or staged is None:
                items.append({"file": name, "ok": False, "error": error})
                continue
            _n, chapter, error = _parse_one(book_id, name, staged)
            if error:
                items.append({"file": name, "ok": False, "error": error})
                continue
            assert chapter is not None
            exists = ch_mod.find_chapter_file(book_id, chapter.chapter_no) is not None
            dup_with = seen.get(chapter.chapter_no)
            if dup_with is None:
                seen[chapter.chapter_no] = name
            items.append({
                "file": name,
                "ok": True,
                "chapter_no": chapter.chapter_no,
                "title": chapter.title,
                "volume": chapter.volume,
                "word_count": chapter.word_count,
                "exists": exists,
                "dup_in_batch": dup_with,  # None 或撞章号的那个文件名
            })

    return {
        "book_id": book_id,
        "total": len(items),
        "new": sum(1 for it in items if it.get("ok") and not it.get("exists") and not it.get("dup_in_batch")),
        "conflicts": sum(1 for it in items if it.get("ok") and (it.get("exists") or it.get("dup_in_batch"))),
        "failed": sum(1 for it in items if not it.get("ok")),
        "items": items,
    }


@router.post("/books/{book_id}/chapters/import", status_code=201)
async def api_import_chapters(
    book_id: str,
    files: list[UploadFile] = File(..., description="docx / txt / md，可多选"),
    overwrite: bool = Query(default=False, description="章号已存在时是否覆盖"),
) -> dict:
    """批量导入正文。

    一个文件 = 一章。章序优先取正文里的「第X章」，其次文件名里的数字。
    章号已存在且未勾覆盖时跳过 —— 因此**中断后重传同一批文件即可续跑**，
    已导入的章会自动跳过，只补没进去的那些。

    **同步**执行。界面走异步那一条（`.../import/job`，文件先落任务暂存目录，
    可看进度、可中断、可续跑）；这个入口留给脚本与冒烟测试，契约不变。
    真源实现在 `run_import()` —— 两个入口共用，不写第二遍。
    """
    _check_book_id(book_id)
    entries: list[tuple[str, Path]] = []
    early: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="wkv-ch-") as tmp:
        tmpdir = Path(tmp)
        for upload in files:
            name, staged, error = await _stage_upload(upload, tmpdir)
            if error or staged is None:
                early.append({"file": name, "error": error or "落盘失败"})
                continue
            entries.append((name, staged))
        return run_import(book_id, entries, overwrite=overwrite, preset_errors=early)


@router.patch("/books/{book_id}/chapters/{chapter_no}")
def api_patch_chapter(book_id: str, chapter_no: int, payload: ChapterPatch) -> dict:
    """改章节元信息（标题/卷/章号），**不动正文**。"""
    _check_book_id(book_id)
    ch = ch_mod.read_chapter(book_id, chapter_no)
    if ch is None:
        raise HTTPException(status_code=404, detail=f"没有第 {chapter_no} 章")
    old = Path(ch.file_path) if ch.file_path else None
    if payload.title is not None:
        ch.title = payload.title.strip() or ch.title
    if payload.volume is not None:
        ch.volume = payload.volume.strip()
    if payload.chapter_no is not None and payload.chapter_no != chapter_no:
        if ch_mod.find_chapter_file(book_id, payload.chapter_no) is not None:
            raise HTTPException(status_code=409, detail=f"第 {payload.chapter_no} 章已存在")
        ch.chapter_no = payload.chapter_no
    target = ch_mod.save_chapter(book_id, ch)
    # 章号变了，旧文件名要清掉，否则会留下孤儿文件
    if old and old.exists() and old.resolve() != target.resolve():
        old.unlink()
    return _brief(ch)


@router.delete("/books/{book_id}/chapters/{chapter_no}")
def api_delete_chapter(book_id: str, chapter_no: int) -> dict:
    _check_book_id(book_id)
    if not ch_mod.delete_chapter(book_id, chapter_no):
        raise HTTPException(status_code=404, detail=f"没有第 {chapter_no} 章")
    return {"deleted": True, "chapter_no": chapter_no, "stats": ch_mod.overall_stats(book_id)}


class BatchDeleteIn(BaseModel):
    chapter_nos: list[int] = Field(default_factory=list)


@router.post("/books/{book_id}/chapters/batch-delete")
def api_batch_delete(book_id: str, payload: BatchDeleteIn) -> dict:
    _check_book_id(book_id)
    done = [n for n in payload.chapter_nos if ch_mod.delete_chapter(book_id, n)]
    return {"deleted": done, "count": len(done), "stats": ch_mod.overall_stats(book_id)}


# --------------------------------------------------------------------------
# 规则抽取（C 档：只出候选，绝不落盘）
# --------------------------------------------------------------------------

class ExtractIn(BaseModel):
    """要抽哪些章。不传 = 全部。"""

    chapter_nos: list[int] = Field(default_factory=list)
    min_score: float = 0.20


class ExtractItemIn(BaseModel):
    """人工核对过的一条候选。"""

    name: str = Field(..., min_length=1, max_length=120)
    type: str = "character"
    summary: str = ""
    methodologies: list[str] = Field(default_factory=list)
    chapters: list[int] = Field(default_factory=list)
    #: 出处：{"chapter_no": 1, "para": 12}
    first_at: dict | None = None
    aliases: list[str] = Field(default_factory=list)


class ExtractCommitIn(BaseModel):
    items: list[ExtractItemIn]
    update_existing: bool = False
    on_duplicate: Literal["skip", "merge"] = "skip"


def _known_maps(book_id: str) -> tuple[dict[str, str], dict[str, str], dict[str, str]]:
    """取（名字→ID、别名→ID、名字→类型）三张表，供抽取时判定「这条是不是已经有了」。"""
    with store.connect() as conn:
        name_to_id = {r["name"]: r["id"] for r in conn.execute(
            "SELECT id, name FROM entities WHERE book_id=?", (book_id,))}
        type_of = {r["name"]: r["type"] for r in conn.execute(
            "SELECT name, type FROM entities WHERE book_id=?", (book_id,))}
        alias_to_id = {r["alias"]: r["entity_id"] for r in conn.execute(
            "SELECT entity_id, alias FROM entity_aliases WHERE book_id=?", (book_id,))}
    return name_to_id, alias_to_id, type_of


@router.get("/extractors")
def api_extractors() -> dict:
    """已注册的抽取器花名册（P11-C3 契约）。新增抽取器注册即入列，端点不用改。"""
    return {"items": extractor_contract.registered()}


@router.post("/books/{book_id}/chapters/extract")
def api_extract(book_id: str, payload: ExtractIn) -> dict:
    """跑一遍规则抽取，返回**待确认变更清单**。

    这一步只读正文、不动任何文件 —— 落盘要等人工在清单里勾完。
    """
    _check_book_id(book_id)
    all_ch = ch_mod.list_chapters(book_id)
    if payload.chapter_nos:
        wanted = set(payload.chapter_nos)
        picked = [c for c in all_ch if c.chapter_no in wanted]
        missing = sorted(wanted - {c.chapter_no for c in picked})
        if missing:
            raise HTTPException(status_code=404, detail=f"这些章不存在：{missing}")
    else:
        picked = all_ch

    if not picked:
        raise HTTPException(status_code=400, detail="还没有导入任何章节，先去导入正文")

    name_to_id, alias_to_id, type_of = _known_maps(book_id)
    # 库里已有的方法论名 —— 抽取时用它给候选挂「信奉什么」的标签
    known_methods = [it["name"] for it in store.methodology_overview(book_id)["items"]]
    # 走**抽取器契约**（P11-C3）：核心只认 key，不认具体实现。
    # 今天 key='rule'，明天插一种新抽取器，这里一个字不用改。
    out = extractor_contract.run_extractor("rule", extractor_contract.ExtractRequest(
        book_id=book_id,
        chapters=[{"chapter_no": c.chapter_no, "title": c.title, "text": c.text} for c in picked],
        known=name_to_id,
        alias_map=alias_to_id,
        methodologies=known_methods,
        options={"min_score": payload.min_score},
    ))
    result = {
        "candidates": out.candidates,
        "appearances": out.extras["appearances"],
        "stats": out.extras["stats"],
    }
    # 已在库里的候选，把库里记的类型带上（避免用猜测的类型覆盖）
    for c in result["candidates"]:
        if c["exists"] and c["name"] in type_of:
            c["type"] = type_of[c["name"]]
    # 每条候选附上体检判定 —— 前端据此把「疑似垃圾」默认不勾、标红，
    # 这样即使有人不逐条看、直接点全选，垃圾也不会跟着落盘（P10 反馈）。
    for c in result["candidates"]:
        verdict = judge_name(c.get("name", ""), type_key=c.get("type"))
        c["lint"] = {
            "ok": verdict["ok"],
            "severity": verdict["severity"],
            "kind": verdict["kind"],
            "reason": verdict["reason"],
        }
    result["suspect"] = sum(1 for c in result["candidates"] if not c["lint"]["ok"])
    result["book_id"] = book_id
    result["picked_chapters"] = [c.chapter_no for c in picked]
    # 自定义类型也要出现在候选清单的类型下拉里 —— 按书查注册表
    result["type_options"] = _type_options(book_id)
    return result


@router.post("/books/{book_id}/chapters/extract/commit", status_code=201)
def api_extract_commit(book_id: str, payload: ExtractCommitIn) -> dict:
    """把清单里勾选的条目落盘成实体。出处随实体一起写进去，不丢。"""
    _check_book_id(book_id)
    name_to_id, _alias_to_id, _type_of = _known_maps(book_id)

    created: list[dict] = []
    skipped: list[dict] = []
    chapters: dict[int, str] = {c.chapter_no: c.title for c in ch_mod.list_chapters(book_id)}

    for item in payload.items:
        name = item.name.strip()
        if not name:
            continue
        existing_id = name_to_id.get(name)
        if existing_id and not payload.update_existing:
            skipped.append({"name": name, "reason": "同名实体已存在", "entity_id": existing_id})
            continue

        sources: list[dict] = []
        if item.first_at:
            no = int(item.first_at.get("chapter_no") or 0)
            sources.append({
                "chapter_no": no,
                "chapter_title": chapters.get(no, ""),
                "para": item.first_at.get("para"),
            })
        for no in item.chapters:
            if not any(s["chapter_no"] == no for s in sources):
                sources.append({"chapter_no": no, "chapter_title": chapters.get(no, "")})

        if existing_id:
            # 只补出处与出场记录，不覆盖用户已写的摘要
            entity = _load_entity(book_id, existing_id)
            if entity is None:
                skipped.append({"name": name, "reason": "实体文件缺失", "entity_id": existing_id})
                continue
        else:
            if item.type not in custom_types.list_types(book_id):
                skipped.append({"name": name, "reason": f"未知类型 {item.type}"})
                continue
            seq = entities_mod.next_sequence(book_id, item.type)
            entity = Entity(
                id=custom_types.make_id(book_id, item.type, seq),
                book_id=book_id,
                type=item.type,
                name=name,
                aliases=[a.strip() for a in item.aliases if a.strip()],
                methodologies=[m.strip() for m in item.methodologies if m.strip()],
                first_appear=(item.first_at or {}).get("chapter_no") and str(
                    (item.first_at or {}).get("chapter_no")),
                body=empty_body(),
            )
            if item.summary.strip():
                entity.body["摘要"] = item.summary.strip()

        # 出场记录：哪几章出现过
        existing_appear = {str(r[0]) for r in entity.body.get("出场记录", [])}
        for no in item.chapters:
            key = str(no)
            if key not in existing_appear:
                note = (item.summary or "").strip()[:40] or "本章出现"
                entity.body.setdefault("出场记录", []).append([key, note])

        entity.provenance = {
            "method": "extract",
            "sources": sources + list(entity.provenance.get("sources", [])),
        }
        entity.updated_at = now_iso()
        entities_mod.save_entity_file(entity)
        store.upsert_entity_single(entity)
        created.append({"id": entity.id, "name": entity.name, "type": entity.type,
                        "file": entity.file_path})

    if created:
        store.rebuild_book_relations(book_id)
    return {
        "book_id": book_id,
        "created": len(created),
        "skipped": len(skipped),
        "items": created,
        "skipped_items": skipped,
    }


def _load_entity(book_id: str, entity_id: str) -> Entity | None:
    meta = store.get_entity(book_id, entity_id)
    if not meta or not meta.get("file_path"):
        return None
    p = Path(meta["file_path"])
    if not p.exists():
        return None
    try:
        return entities_mod.load_entity_file(p)
    except Exception:
        return None

