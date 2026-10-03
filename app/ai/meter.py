"""token 计量 + 词元监测。

落 `data/ai/metering.jsonl`（追加写）—— 不是 md 派生数据，
按「索引零独占状态」铁律不能进 index.db。

词元监测（monitor）：一个可开关的全局监视会话。
开着的时候，所有计量都累计进监视读数；读数 = started_at 之后的全部记录。
"""

from __future__ import annotations

import json
import time
from datetime import datetime
from pathlib import Path
from typing import Iterable

from .. import paths


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def record(
    *,
    book_id: str,
    provider: str,
    model: str,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    cost_cny: float = 0.0,
    chapter_no: int | None = None,
    purpose: str = "extract",
    cache_hit: bool = False,
) -> dict:
    """追加一条计量流水。cache_hit 的记录 token 为 0（没花钱）。"""
    entry = {
        "ts": _now(),
        "book_id": book_id,
        "chapter_no": chapter_no,
        "provider": provider,
        "model": model,
        "prompt_tokens": int(prompt_tokens),
        "completion_tokens": int(completion_tokens),
        "cost_cny": round(float(cost_cny), 6),
        "purpose": purpose,
        "cache_hit": bool(cache_hit),
    }
    p = paths.ai_metering_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry


def iter_records() -> Iterable[dict]:
    p = paths.ai_metering_file()
    if not p.exists():
        return
    with p.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except Exception:
                continue  # 坏行不拖垮统计


def _sum(rows: Iterable[dict]) -> dict:
    rows = list(rows)
    return {
        "calls": len(rows),
        "prompt_tokens": sum(r.get("prompt_tokens", 0) for r in rows),
        "completion_tokens": sum(r.get("completion_tokens", 0) for r in rows),
        "cost_cny": round(sum(r.get("cost_cny", 0.0) for r in rows), 4),
        "cache_hits": sum(1 for r in rows if r.get("cache_hit")),
    }


def usage_stats(book_id: str | None = None) -> dict:
    """成本看板：总量 / 本月 / 按书 / 按服务商 / 按章（最近 50 条）。"""
    all_rows = list(iter_records())
    if book_id:
        all_rows = [r for r in all_rows if r.get("book_id") == book_id]

    month_prefix = _now()[:7]  # YYYY-MM
    month_rows = [r for r in all_rows if str(r.get("ts", "")).startswith(month_prefix)]

    by_book: dict[str, list] = {}
    by_provider: dict[str, list] = {}
    for r in all_rows:
        by_book.setdefault(r.get("book_id") or "?", []).append(r)
        by_provider.setdefault(r.get("provider") or "?", []).append(r)

    chapters = sorted(
        (r for r in all_rows if r.get("chapter_no") is not None),
        key=lambda r: r.get("ts", ""), reverse=True,
    )[:50]

    return {
        "total": _sum(all_rows),
        "month": {**_sum(month_rows), "month": month_prefix},
        "by_book": {k: _sum(v) for k, v in by_book.items()},
        "by_provider": {k: _sum(v) for k, v in by_provider.items()},
        "recent_chapters": chapters,
    }


# --------------------------------------------------------------------------
# 词元监测（可开关的监视会话）
# --------------------------------------------------------------------------

def get_monitor() -> dict:
    p = paths.ai_monitor_file()
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return {"active": False, "started_at": "", "label": "", **data}
        except Exception:
            pass
    return {"active": False, "started_at": "", "label": ""}


def _line_count() -> int:
    p = paths.ai_metering_file()
    if not p.exists():
        return 0
    with p.open("r", encoding="utf-8") as f:
        return sum(1 for line in f if line.strip())


def set_monitor(active: bool, label: str = "") -> dict:
    # 记下开启时流水已有的行数 —— 读数只算这之后追加的记录。
    # （不能按时间戳比：同一秒内的记录会误伤）
    state = {
        "active": bool(active),
        "started_at": _now() if active else "",
        "label": label or ("词元监测 " + time.strftime("%H:%M")) if active else "",
        "offset": _line_count() if active else 0,
    }
    p = paths.ai_monitor_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    return state


def monitor_stats() -> dict:
    """监视读数：开启时刻之后追加的全部消耗。"""
    state = get_monitor()
    out = {**state, "tokens": 0, "prompt_tokens": 0, "completion_tokens": 0,
           "cost_cny": 0.0, "calls": 0}
    if not state.get("active"):
        return out
    offset = int(state.get("offset") or 0)
    rows = list(iter_records())
    if offset:
        rows = rows[offset:] if len(rows) > offset else []
    elif state.get("started_at"):
        # 兼容旧格式（没有 offset 字段）：退回时间戳比较
        started = state["started_at"]
        rows = [r for r in rows if str(r.get("ts", "")) > started]
    s = _sum(rows)
    out.update({
        "calls": s["calls"],
        "prompt_tokens": s["prompt_tokens"],
        "completion_tokens": s["completion_tokens"],
        "tokens": s["prompt_tokens"] + s["completion_tokens"],
        "cost_cny": s["cost_cny"],
    })
    return out
