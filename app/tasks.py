"""三类长任务的具体执行体（P11-A3）。

在 `app.jobs` 那套通用运行时之上，把「重建索引 / 批量 AI 抽取 / 批量导入章节」
登记成可排队、可中断、可续跑的任务。

为什么执行体放这里而不是塞进 `app/jobs.py`
-------------------------------------------
`app/jobs.py` 只管「排队、进度、中断、落盘」这些与业务无关的事，不 import
任何业务模块。业务执行体集中放这里，登记表一读就明白系统里有哪些长任务。
两边分开还有个实际好处：`jobs.py` 能被单独测（不拖起 store / AI / chapters）。

**登记顺序即依赖顺序**：`app/api/jobs.py` 一 import 本模块，三类任务就挂好了；
`resume()` 靠 kind 从注册表取执行体，所以续跑能跨重启。
"""

from __future__ import annotations

from pathlib import Path

from . import entities as entity_repo
from . import jobs, store
from .ai import batch as batch_mod
from .ai import extract as ai_extract_mod
from .logging_setup import get_logger

log = get_logger(__name__)

KIND_REBUILD = "rebuild"
KIND_AI_EXTRACT = "ai-extract"
KIND_IMPORT = "import"


# --------------------------------------------------------------------------
# 重建索引
# --------------------------------------------------------------------------

def _run_rebuild(task: jobs.Task, args: dict) -> None:
    """重建索引。单本或全部。索引可抛弃 —— 这一步永远安全。"""
    book_id = (args.get("book_id") or task.book_id or "").strip() or None

    if book_id:
        task.set_total(1, unit="本")
        task.detail(book_id=book_id)
        task.log(f"重建《{book_id}》的索引…")
        r = store.rebuild_book(book_id)
        task.advance(1, key=book_id,
                     text=f"《{book_id}》：{r['entities']} 条实体（{r['elapsed_seconds']} 秒）")
        task.result(books=[r], total_entities=r["entities"])
        return

    books = entity_repo.list_books()
    task.set_total(len(books), unit="本")
    task.log(f"重建全部书目，共 {len(books)} 本")

    acc: list[dict] = []

    def _on_book(r: dict) -> None:
        # 每重建完一本就是一个安全点：上一本已经整体落库，中断在这里最干净
        task.check()
        acc.append(r)
        task.advance(1, key=r["book_id"],
                     text=f"《{r['book_id']}》：{r['entities']} 条实体（{r['elapsed_seconds']} 秒）")
        task.result(books=list(acc), total_entities=sum(x["entities"] for x in acc))

    res = store.rebuild_all(on_book=_on_book)
    task.result(books=res["books"], total_entities=res["total_entities"])


# --------------------------------------------------------------------------
# 批量 AI 抽取
# --------------------------------------------------------------------------

def _run_ai_extract(task: jobs.Task, args: dict) -> None:
    """逐章跑 AI 抽取。**每章都是真金白银**，所以这个任务必须能停、能续。"""
    book_id = (args.get("book_id") or task.book_id or "").strip()
    if not book_id:
        raise ValueError("没有指定书目")

    task.detail(book_id=book_id)
    task.log("正文会逐章发送给 AI 服务商（未发表作品）。介意见 AI 配置里的本地模型方案。",
             level="warn")
    try:
        batch_mod.run_ai_extract(
            book_id,
            chapter_nos=args.get("chapter_nos") or None,
            provider=args.get("provider") or None,
            refresh=bool(args.get("refresh")),
            task=task,
        )
    except batch_mod.MissingChapters as exc:
        raise ValueError(f"这些章不存在：{exc.missing}") from None
    except batch_mod.NoChapters:
        raise ValueError("这本书还没有导入任何章节") from None
    except ai_extract_mod.BudgetExceeded as exc:
        # 预算超限发生在**动手之前**（check_budget 在最前面），所以没有白花钱。
        raise RuntimeError(f"预算到顶，一个字都没跑：{exc}") from None


# --------------------------------------------------------------------------
# 批量导入章节
# --------------------------------------------------------------------------

def _run_import(task: jobs.Task, args: dict) -> None:
    """批量导入 docx / txt / md。

    待导入的文件在**入队时就落到了任务暂存目录**（`<jobs>/<id>/stage/`），
    不是系统临时目录 —— 因为它要活过重启：重启后既能续跑，也不会悄悄
    丢掉一半文件。暂存目录在记录被删时一起清掉。
    """
    from .api import chapters as chapters_api  # 延迟导入：避免与 API 包形成循环

    book_id = (args.get("book_id") or task.book_id or "").strip()
    if not book_id:
        raise ValueError("没有指定书目")

    names: list[str] = list(args.get("files") or [])
    if not names:
        raise ValueError("这一批没有文件（暂存目录可能是空的）")

    # 暂存目录跟着**入队时那个任务 id** 走（`stage_id`），不是跟着当前任务 id：
    # 续跑是「拿同一份参数再排一个新任务」，新任务 id 不一样，文件却还在原来
    # 那个目录里。用 stage_id 指过去，续跑就不用再上传一遍（也绝不会误读
    # 到别的任务的文件）。stage_id 存在 args 里，所以重启后照样对得上。
    stage_id = str(args.get("stage_id") or task.id)
    stage = jobs.stage_dir(stage_id)
    entries: list[tuple[str, Path]] = []
    missing: list[str] = []
    for n in names:
        p = stage / Path(str(n)).name
        if p.is_file():
            entries.append((p.name, p))
        else:
            missing.append(str(n))
    if missing:
        task.log(f"有 {len(missing)} 个暂存文件不在了（{missing[:3]}），这些跳过", level="warn")
    if not entries:
        raise RuntimeError(
            f"暂存目录里一个文件都没找到（{stage}），无法导入。"
            "如果这条记录是续跑来的，可能是原始任务记录已经被删掉了 —— 重新上传这批文件即可。"
        )

    task.detail(book_id=book_id)
    r = chapters_api.run_import(
        book_id, entries, overwrite=bool(args.get("overwrite")), task=task,
    )
    task.result(
        imported=r["imported"], skipped=r["skipped"], failed=r["failed"],
        stats=r["stats"],
        items=r["items"][:100],
        skipped_items=r["skipped_items"][:100],
        errors=r["errors"][:50],
        missing=missing,
    )


# --------------------------------------------------------------------------
# 登记
# --------------------------------------------------------------------------

def register_all() -> None:
    jobs.register(
        KIND_REBUILD,
        label="重建索引",
        runner=_run_rebuild,
        resumable=False,  # 重建是幂等的：重跑一遍最干净，续跑没有意义
        hint="从 Markdown 全量重灌索引。索引可以随时抛弃重建，这一步永远安全。",
    )
    jobs.register(
        KIND_AI_EXTRACT,
        label="批量 AI 抽取",
        runner=_run_ai_extract,
        resumable=True,
        hint="逐章抽取实体 / 关系 / 伏笔候选，结果只进待确认清单，不会自己落盘。",
    )
    jobs.register(
        KIND_IMPORT,
        label="批量导入章节",
        runner=_run_import,
        resumable=True,
        hint="一个文件 = 一章。章号已存在的会跳过，所以重跑同一批也不会重复入库。",
    )


register_all()
