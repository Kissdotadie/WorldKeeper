"""批量 AI 抽取（逐章跑）—— 一处实现，两个入口。

为什么单独抽一个模块
--------------------
同一段逻辑有两个调用方：
1. **同步接口** `POST /books/{id}/chapters/extract/ai`（脚本、冒烟测试用，契约稳定）
2. **异步任务** kind=`ai-extract`（界面上点的那条路，可看进度 / 可中断 / 可续跑）

两处各写一遍必然漂移（改了一边忘了另一边，结果「界面跑出来的」和
「接口跑出来的」不是一回事）。所以真源只有这里一份，两个入口都调它。

进度回调是**可选**的：同步入口不传 `task`，一次不落的跑完；
异步入口传进来的那个 `Task` 会在每个子项之间被问一次「停了吗」。
"""

from __future__ import annotations

from typing import Any

from .. import chapters as ch_mod
from ..logging_setup import get_logger
from ..parsers import contract as extractor_contract
from ..parsers.lint import judge_name
from . import client as ai_client
from . import extract as ai_extract_mod  # 只用 check_budget / BudgetExceeded（基建，非抽取本身）

log = get_logger(__name__)


class NoChapters(Exception):
    """这本书还没有任何章节。"""


class MissingChapters(Exception):
    """指定了要跑的章号，但其中一些不存在。"""

    def __init__(self, missing: list[int]):
        super().__init__(f"这些章不存在：{missing}")
        self.missing = missing


def pick_chapters(book_id: str, chapter_nos: list[int] | None) -> list[ch_mod.Chapter]:
    """挑出这次要跑的章。章号列表为空 = 全书。

    章号不存在时报错而不是静默忽略 —— 静默忽略会让人以为「跑过了」，
    其实是章号写错了。这类错觉一次都不能有。
    """
    all_ch = ch_mod.list_chapters(book_id)
    if chapter_nos:
        wanted = set(chapter_nos)
        picked = [c for c in all_ch if c.chapter_no in wanted]
        missing = sorted(wanted - {c.chapter_no for c in picked})
        if missing:
            raise MissingChapters(missing)
    else:
        picked = all_ch
    if not picked:
        raise NoChapters()
    return picked


def run_ai_extract(
    book_id: str,
    *,
    chapter_nos: list[int] | None = None,
    provider: str | None = None,
    refresh: bool = False,
    task: Any = None,
) -> dict:
    """逐章跑 AI 抽取，返回与同步接口**完全同形**的结果字典。

    `task` 是 `app.jobs.Task`（或任何有 check/log/advance/detail/result/skip
    这几个方法的对象）。为 None 就是「没人看进度」的同步模式。
    """
    picked = pick_chapters(book_id, chapter_nos)
    ai_extract_mod.check_budget()  # 超预算抛 BudgetExceeded，由调用方转成 402

    skip = task.skip if task is not None else set()
    todo = [c for c in picked if str(c.chapter_no) not in skip]
    skipped_n = len(picked) - len(todo)

    if task is not None:
        task.set_total(len(picked), unit="章")
        if skipped_n:
            task.log(f"续跑：跳过上次已完成的 {skipped_n} 章", level="info")
            task.advance(skipped_n)
        if not todo:
            task.log("没有需要新跑的章（上次已经全部完成）")

    all_candidates: list[dict] = []
    all_changes: list[dict] = []
    all_foreshadow: list[dict] = []
    per_chapter: list[dict] = []
    total_cost = 0.0
    total_tokens = 0

    for ch in todo:
        if task is not None:
            task.check()  # 协作式中断的安全点：上一个已落盘、下一个还没开始
            task.detail(chapter_no=ch.chapter_no, title=ch.title)
        try:
            # 走**抽取器契约**（P11-C3）：batch 是「编排层」，只管逐章循环、
            # 进度与续跑；抽取本身交给注册表里 key='ai' 的那只。
            out = extractor_contract.run_extractor("ai", extractor_contract.ExtractRequest(
                book_id=book_id,
                chapters=[{"chapter_no": ch.chapter_no, "title": ch.title, "text": ch.text}],
                options={"provider_key": provider, "refresh": refresh},
            ))
            r = {
                "candidates": out.candidates,
                "changes": out.extras["changes"],
                "foreshadow": out.extras["foreshadow"],
                **out.extras["meta"],
            }
        except ai_client.AIError as exc:
            log.warning("第 %s 章 AI 抽取失败：%s", ch.chapter_no, exc)
            per_chapter.append({"chapter_no": ch.chapter_no, "status": "error",
                                "error": str(exc), "kind": exc.kind})
            if task is not None:
                # ⚠️ 失败**不带 key**：进度照走，但这一章不算「做过了」，
                # 续跑时会被重试。带上 key 就等于把失败冒充成完成，
                # 而续跑本来就是为了补这些没成的章。
                task.advance(level="warn", text=f"第 {ch.chapter_no} 章失败：{exc}")
            continue
        except ai_extract_mod.BudgetExceeded as exc:
            per_chapter.append({"chapter_no": ch.chapter_no, "status": "budget_stop",
                                "error": str(exc), "kind": "budget"})
            if task is not None:
                task.log(f"预算到顶，停在「{ch.title}」前面：{exc}", level="warn")
            break

        all_candidates.extend(r["candidates"])
        all_changes.extend(r["changes"])
        all_foreshadow.extend(r["foreshadow"])
        tokens = r["tokens"]["prompt"] + r["tokens"]["completion"]
        total_tokens += tokens
        total_cost += r["cost_cny"]
        per_chapter.append({
            "chapter_no": ch.chapter_no,
            "status": "cache" if r["cache_hit"] else "ok",
            "provider": r["provider"],
            "model": r["model"],
            "prompt_version": r["prompt_version"],
            "tokens": tokens,
            "cost_cny": r["cost_cny"],
            "candidates": len(r["candidates"]),
            "changes": len(r["changes"]),
            "foreshadow": len(r["foreshadow"]),
        })
        if task is not None:
            task.advance(key=str(ch.chapter_no),
                         text=f"第 {ch.chapter_no} 章 {ch.title}：候选 {len(r['candidates'])}、"
                              f"变更 {len(r['changes'])}、伏笔 {len(r['foreshadow'])}"
                              f"（{tokens} 词元{'，命中缓存' if r['cache_hit'] else ''}）")

    # 候选名的「像不像专名」体检。放在这里而不是各入口各做一遍 ——
    # 两处判定不一致的话，界面上的黄标就和冒烟测的不是一回事了。
    for c in all_candidates:
        verdict = judge_name(c.get("name", ""), type_key=c.get("type"))
        c["lint"] = {
            "ok": verdict["ok"],
            "severity": verdict["severity"],
            "kind": verdict["kind"],
            "reason": verdict["reason"],
        }

    result = {
        "book_id": book_id,
        "candidates": all_candidates,
        "changes": all_changes,
        "foreshadow": all_foreshadow,
        "per_chapter": per_chapter,
        "suspect": sum(1 for c in all_candidates if not c["lint"]["ok"]),
        "totals": {
            "chapters_run": sum(1 for p in per_chapter if p["status"] in ("ok", "cache")),
            "chapters_failed": sum(1 for p in per_chapter if p["status"] == "error"),
            "tokens": total_tokens,
            "cost_cny": round(total_cost, 4),
        },
        "privacy_hint": "本章正文已发送给 AI 服务商。介意见 AI 配置里的本地模型方案。",
    }
    if task is not None:
        task.result(**result)
    return result
