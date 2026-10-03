"""运维接口：索引重建、日志、环境信息、实体体检。"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .. import audit, consistency, paths, snapshot, store
from ..logging_setup import get_logger
from ._common import check_book_id as _check_book_id

log = get_logger(__name__)
router = APIRouter(tags=["admin"])


@router.post("/admin/rebuild-index")
def api_rebuild_index(book_id: str | None = Query(default=None, description="不传则重建全部")) -> dict:
    """索引重建 —— 故障自愈的第一手段（铁律：索引可抛弃）。"""
    if book_id:
        return store.rebuild_book(book_id)
    return store.rebuild_all()


@router.get("/admin/info")
def api_info() -> dict:
    return {
        "data_dir": str(paths.data_dir()),
        "program_dir": str(paths.program_dir()),
        "index_file": str(paths.index_file()),
        "logs_dir": str(paths.logs_dir()),
        "frozen": paths.is_frozen(),
        "index_ready": store.is_initialized(),
    }


# --------------------------------------------------------------------------
# 实体体检（勘误清理）
# --------------------------------------------------------------------------

class LintDeleteIn(BaseModel):
    book_id: str
    ids: list[str] = Field(..., min_length=1, max_length=2000)


@router.get("/admin/lint")
def api_lint(book_id: str = Query(..., description="要体检的书目")) -> dict:
    """扫一遍实体名，挑出「不像专名」的。**只读**，不动任何文件。"""
    _check_book_id(book_id)
    return audit.scan(book_id)


# --------------------------------------------------------------------------
# 不一致体检（时间线 / 伏笔 / 称谓 / 地理 / 出处）
# --------------------------------------------------------------------------

@router.get("/admin/consistency")
def api_consistency(
    book_id: str = Query(..., description="要体检的书目"),
    deep: bool = Query(default=True, description="是否连出处一起查（要读一遍档案，大书约 1~3 秒）"),
) -> dict:
    """五类一致性检查。**只读**，不动任何文件，也不碰正文。"""
    _check_book_id(book_id)
    return consistency.scan(book_id, deep=deep)


@router.post("/admin/lint/delete")
def api_lint_delete(payload: LintDeleteIn) -> dict:
    """批量删除体检清单里勾中的实体。

    **先快照、再删除**：把要删的文件整批备份到同一份快照目录，备份不成功
    就整批中止 —— 「以为有备份、其实没有」比这次不删危险得多。
    只删档案文件，绝不动章节正文。
    """
    book_id = payload.book_id
    _check_book_id(book_id)

    metas: list[dict] = []
    files: list[Path] = []
    for eid in payload.ids:
        meta = store.get_entity(book_id, eid)
        if not meta:
            continue
        p = meta.get("file_path")
        if p:
            # 路径安全闸：路径不在本书目录内（副本/迁移残留的绝对路径）就整批拒删
            try:
                target = paths.ensure_inside_book(book_id, p)
            except ValueError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            meta["_target"] = target  # 校验过的真实路径，下面删除时只用它
            files.append(target)
        metas.append(meta)
    if not metas:
        raise HTTPException(status_code=404, detail="这些实体都不存在（可能已经被删过了）")

    snap = None
    if files:
        try:
            snap = snapshot.snapshot_files(book_id, files, reason="lint-delete")
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"删除前快照失败，已中止：{exc}") from exc

    removed: list[str] = []
    failed: list[str] = []
    # 索引一次事务全删（逐条提交会慢到像卡死），文件逐个删并统计失败
    store.delete_entities_bulk(book_id, [m["id"] for m in metas])
    for meta in metas:
        target: Path | None = meta.get("_target")
        if target and target.exists():
            try:
                target.unlink()
            except OSError as exc:
                log.warning("删除实体文件失败 %s：%s", target, exc)
                failed.append(meta["id"])
                continue
        removed.append(meta["id"])

    store.rebuild_book_relations(book_id)
    log.info("实体体检清理：删除 %d 条，快照 %s", len(removed), snap["dir"] if snap else "无")
    return {
        "deleted": len(removed),
        "ids": removed,
        "failed": failed,
        "snapshot": snap,
    }


@router.get("/admin/logs")
def api_logs(lines: int = Query(default=200, ge=1, le=5000)) -> dict:
    """读最近的日志尾部 —— 安装后用户看不到控制台，界面里要能查（口子 A6）。"""
    path = paths.logs_dir() / "app.log"
    if not path.exists():
        return {"lines": [], "path": str(path)}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = f.readlines()
    except OSError as exc:
        return {"lines": [f"读取日志失败：{exc}"], "path": str(path)}
    return {"lines": [ln.rstrip("\n") for ln in content[-lines:]], "path": str(path)}


# --------------------------------------------------------------------------
# 快照与保留策略（P11-A6）
#
# 沿用「删除前快照」那一套落盘逻辑，只是把触发时机从「动手之前」扩成
# 「按时间」。索引不进快照 —— 它是可抛弃的派生数据（铁律）。
# --------------------------------------------------------------------------

class SnapshotIn(BaseModel):
    book_id: str | None = Field(default=None, description="不传则对每本书各存一份")
    reason: str = Field(default="manual", max_length=24)


class PruneIn(BaseModel):
    dry_run: bool = Field(default=False, description="只算不删，用来先看一眼会清掉哪些")


@router.get("/admin/snapshots")
def api_snapshots() -> dict:
    """快照清单 + 当前策略 + 上次自动快照时间。**只读**。"""
    items = snapshot.list_snapshots()
    return {
        "snapshots": items,
        "count": len(items),
        "total_bytes": sum(i["bytes"] for i in items),
        "policy": snapshot.auto_policy(),
        "last_auto": snapshot.last_auto_info(),
    }


@router.post("/admin/snapshots")
def api_snapshot_now(payload: SnapshotIn) -> dict:
    """手动「立即快照」。走与自动快照同一条路 —— 不做第二套实现。

    `book_id` 给了就只存那一本；不给则每本各存一份（与自动快照一致）。
    """
    reason = payload.reason or "manual"
    if payload.book_id:
        book_id = _check_book_id(payload.book_id)
        try:
            r = snapshot.snapshot_book(book_id, reason=reason)
        except (OSError, FileNotFoundError) as exc:
            raise HTTPException(status_code=500, detail=f"快照失败：{exc}") from exc
        taken = [{"book_id": book_id, "dir": r["dir"], "count": r["count"]}]
        failed: list[dict] = []
    else:
        res = snapshot.maybe_auto_snapshot(reason=reason, force=True)
        taken = res.get("taken") or []
        failed = res.get("failed") or []
        if not taken:
            raise HTTPException(
                status_code=404,
                detail="没有可快照的书目（数据目录下还没有任何一本书）",
            )
    items = snapshot.list_snapshots()
    return {
        "taken": taken,
        "failed": failed,
        "total_bytes": sum(i["bytes"] for i in items),
        "count": len(items),
    }


@router.post("/admin/snapshots/prune")
def api_snapshot_prune(payload: PruneIn) -> dict:
    """按策略清理旧快照。先 `dry_run` 看一眼会删哪些，再真删 —— 界面照这个顺序引导。"""
    pol = snapshot.auto_policy()
    return snapshot.prune_snapshots(
        keep_count=pol["keep_count"],
        max_total_mb=pol["max_total_mb"],
        dry_run=payload.dry_run,
    )
