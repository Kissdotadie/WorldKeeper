"""异步任务接口（P11-A3）。

设计取舍
--------
1. **轮询，不用 SSE / WebSocket。**
   任务状态本来就是「一秒一变」的粒度，轮询足够；而且它有两个实打实的好处：
   - **刷新页面 / 关掉浏览器再回来，进度还在**（SSE 一断就得重连重放）
   - 打包进桌面程序后不新增长连接、不占额外端口、不跟杀软/代理打架
   代价只是每秒一次几十字节的 GET。为了省这点流量换上面两条，不值当。
   增量靠 `?after=<上次最大 event_seq>`：只回新日志，轮询体量恒定。

2. **任务 id 允许调用方指定**（只给导入这条路用）。
   导入需要先按 id 建暂存目录把上传的文件落进去，目录名必须跟任务 id 一致，
   否则重启后对不上。id 只收 8~32 位十六进制（`jobs._resolve_job_id`）。

3. **同一本书的同类任务不并跑**（`BusyError` → 409）。
   这是**防重复扣费**的闸：批量 AI 抽取双击两下就是两倍的钱。
   顺带也落实了「档案与索引只能串行写」。

4. 本模块一被 import，`app.tasks` 就把三类任务登记好了 —— 续跑靠 kind
   从注册表取执行体，所以跨重启也续得上。
"""

from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from .. import jobs, paths
from .. import tasks as tasks_mod  # noqa: F401 —— 只为触发三类任务的登记
from ..logging_setup import get_logger
from ._common import check_book_id as _check_book_id

log = get_logger(__name__)
router = APIRouter(tags=["jobs"])

#: 导入任务一次最多收多少个文件（防一次拖一个目录进来把内存与磁盘塞满）
MAX_JOB_FILES = 300


def _busy_detail(exc: jobs.BusyError) -> dict:
    j = exc.job or {}
    return {
        "message": f"「{j.get('title') or j.get('kind_label')}」已经在跑了，等它跑完或先停掉",
        "job_id": j.get("id"),
    }


# --------------------------------------------------------------------------
# 读
# --------------------------------------------------------------------------

@router.get("/jobs/kinds")
def api_job_kinds() -> dict:
    """有哪些任务类型（任务中心用来渲染说明）。"""
    return {"kinds": jobs.kinds()}


@router.get("/jobs/active")
def api_jobs_active() -> dict:
    """当前正在跑的那个 + 排队情况。界面上的常驻小条用它，所以做得很便宜。"""
    return jobs.active()


@router.get("/jobs")
def api_jobs_list(
    book_id: str | None = Query(default=None),
    status: str | None = Query(default=None, description="逗号分隔，如 running,queued"),
    limit: int = Query(default=30, ge=1, le=200),
) -> dict:
    """任务清单。默认**不带日志正文**（清单不需要），单个任务详情才带。"""
    items = jobs.list_jobs(book_id=book_id, status=status, limit=limit)
    return {"jobs": items, "count": len(items)}


@router.get("/jobs/{job_id}")
def api_job_get(
    job_id: str,
    after: int = Query(default=0, ge=0, description="上次拿到的最大 event_seq，只回之后的日志"),
) -> dict:
    snap = jobs.get(job_id, after)
    if snap is None:
        raise HTTPException(status_code=404, detail="没有这个任务（可能已被清理）")
    return snap


# --------------------------------------------------------------------------
# 停 / 续 / 删
# --------------------------------------------------------------------------

@router.post("/jobs/{job_id}/cancel")
def api_job_cancel(job_id: str) -> dict:
    """请求停止。

    排队中的立刻变终态；正在跑的只是置了标志，等它跑到**子项之间**收尾。
    所以返回里可能是 `running` + `message=正在收尾` —— 这是实情，不美化。
    """
    try:
        return jobs.cancel(job_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="没有这个任务") from None


@router.post("/jobs/{job_id}/resume")
def api_job_resume(job_id: str) -> dict:
    """续跑：拿同一份参数再排一个任务，跳过上次已完成的子项。

    会**真的再花一次钱**跑剩下的章，所以界面必须写清「只跑没跑完的部分」。
    """
    try:
        return jobs.resume(job_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="没有这个任务") from None
    except jobs.ResumeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except jobs.BusyError as exc:
        raise HTTPException(status_code=409, detail=_busy_detail(exc)) from None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


@router.delete("/jobs/{job_id}")
def api_job_delete(job_id: str) -> dict:
    """删掉一条历史记录（连同它的暂存目录）。只允许删终态任务。"""
    try:
        ok = jobs.delete(job_id)
    except jobs.ResumeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    if not ok:
        raise HTTPException(status_code=404, detail="没有这个任务")
    return {"deleted": job_id}


# --------------------------------------------------------------------------
# 起：三类长任务的异步入口
# --------------------------------------------------------------------------

class RebuildJobIn(BaseModel):
    book_id: str | None = Field(default=None, description="不传则重建全部")


@router.post("/admin/rebuild-index/job", status_code=202)
def api_rebuild_job(payload: RebuildJobIn) -> dict:
    """把「重建索引」排成后台任务（同步那个入口照旧在，供脚本用）。"""
    book_id = None
    if payload.book_id:
        book_id = _check_book_id(payload.book_id)
    try:
        return jobs.submit(
            tasks_mod.KIND_REBUILD,
            book_id=book_id,
            title=f"重建索引：{book_id}" if book_id else "重建全部书目索引",
            args={"book_id": book_id},
        )
    except jobs.BusyError as exc:
        raise HTTPException(status_code=409, detail=_busy_detail(exc)) from None


class AiExtractJobIn(BaseModel):
    """跑哪些章。chapter_nos 空 = 全部。refresh = 无视缓存重跑（钱花得更多）。"""

    chapter_nos: list[int] = Field(default_factory=list)
    provider: str | None = None
    refresh: bool = False


@router.post("/books/{book_id}/chapters/extract/ai/job", status_code=202)
def api_extract_ai_job(book_id: str, payload: AiExtractJobIn) -> dict:
    """把「批量 AI 抽取」排成后台任务 —— 界面走这条，能看进度、能停、能续。"""
    _check_book_id(book_id)
    n = len(payload.chapter_nos)
    try:
        return jobs.submit(
            tasks_mod.KIND_AI_EXTRACT,
            book_id=book_id,
            title=f"AI 抽取：{book_id}（{n} 章）" if n else f"AI 抽取：{book_id}（全书）",
            args={
                "book_id": book_id,
                "chapter_nos": list(payload.chapter_nos),
                "provider": payload.provider,
                "refresh": bool(payload.refresh),
            },
        )
    except jobs.BusyError as exc:
        raise HTTPException(status_code=409, detail=_busy_detail(exc)) from None


@router.post("/books/{book_id}/chapters/import/job", status_code=202)
async def api_import_job(
    book_id: str,
    files: list[UploadFile] = File(..., description="docx / txt / md，可多选"),
    overwrite: bool = Query(default=False, description="章号已存在时是否覆盖"),
) -> dict:
    """批量导入排成后台任务。

    **先把文件落到任务暂存目录**（`<数据目录>/jobs/<任务id>/stage/`），再入队。
    放数据目录而不是系统临时目录，是因为它要**活过重启**：重启后要么续跑、
    要么记录被删掉时一起清干净 —— 总之不会悄悄丢掉一半。
    暂存目录整块都在 jobs 目录内，路径归属在这里再校验一次（删除类纪律）。
    """
    _check_book_id(book_id)
    if not files:
        raise HTTPException(status_code=400, detail="没有收到任何文件")
    if len(files) > MAX_JOB_FILES:
        raise HTTPException(status_code=400,
                            detail=f"一次最多 {MAX_JOB_FILES} 个文件（这次收到 {len(files)} 个）")

    # ⚠️ 顺序要紧：先把任务历史读进来，**再**往暂存目录落文件。
    #    反过来的话，随后 submit 触发的首次加载会把「刚建出来还没登记」的
    #    暂存目录当成孤立垃圾清掉 —— 于是全新进程里的第一个导入任务，
    #    文件刚落地就没了，只能报「暂存目录里一个文件都没找到」。
    jobs.ensure_loaded()

    # 先自己占一个 id，才能按它建暂存目录
    try:
        job_id = jobs.new_job_id()
    except ValueError as exc:  # pragma: no cover - 不可能触发，留着防御
        raise HTTPException(status_code=500, detail=str(exc)) from None

    stage = paths.jobs_dir() / job_id / "stage"
    root = paths.jobs_dir().resolve()
    if stage.resolve().parent.parent != root:
        raise HTTPException(status_code=500, detail="暂存目录不在数据目录内，拒绝写入")

    names: list[str] = []
    empty: list[str] = []
    try:
        stage.mkdir(parents=True, exist_ok=True)
        for upload in files:
            name = Path(upload.filename or "未命名").name
            data = await upload.read()
            if not data:
                empty.append(name)
                continue
            # 同名文件不会互相覆盖：重名前面加序号（一份原稿发两遍是常事）
            target = stage / name
            if target.exists():
                stem, suffix = target.stem, target.suffix
                i = 2
                while target.exists():
                    target = stage / f"{stem}({i}){suffix}"
                    i += 1
            target.write_bytes(data)
            names.append(target.name)
    except OSError as exc:
        shutil.rmtree(stage.parent, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"暂存上传文件失败：{exc}") from exc

    if not names:
        shutil.rmtree(stage.parent, ignore_errors=True)
        raise HTTPException(status_code=400, detail="上传的文件都是空的")

    try:
        job = jobs.submit(
            tasks_mod.KIND_IMPORT,
            book_id=book_id,
            title=f"导入章节：{len(names)} 个文件",
            # stage_id 指回**发起这次任务的那个 id** —— 续跑时会照抄这份 args，
            # 于是新任务仍然读得到同一批暂存文件（不必重新上传）。
            args={"book_id": book_id, "files": names, "overwrite": bool(overwrite),
                  "stage_id": job_id},
            job_id=job_id,
        )
    except jobs.BusyError as exc:
        shutil.rmtree(stage.parent, ignore_errors=True)  # 排队失败就别留下垃圾
        raise HTTPException(status_code=409, detail=_busy_detail(exc)) from None
    except ValueError as exc:
        shutil.rmtree(stage.parent, ignore_errors=True)
        raise HTTPException(status_code=400, detail=str(exc)) from None

    job["staged"] = names
    if empty:
        job["empty_files"] = empty
    return job
