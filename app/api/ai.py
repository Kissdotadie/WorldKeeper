"""AI 层接口：服务商配置 / 提示词 / 计量 / 词元监测 / AI 抽取 / 伏笔落盘。

安全边界（写在这里免得后人踩）：
1. **密钥永不回显明文** —— 列表只给 `key_masked`；PUT 回传打码形态 = 不改 key
2. **正文会外发给服务商**（未发表作品）—— 前端必须在界面上告知用户这一点
3. **AI 只读不写** —— 抽取结果是候选，落盘永远走人工确认那一路
4. 计量与缓存不是 md 派生数据，落 `data/ai/`，不进 index.db
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import chapters as ch_mod
from ..ai import batch as batch_mod
from ..ai import catalog as ai_catalog
from ..ai import client as ai_client
from ..ai import config_loader, meter, prompts
from ..ai import extract as ai_extract_mod
from ..logging_setup import get_logger
from ._common import check_book_id as _check_book_id
from . import docs as docs_mod

log = get_logger(__name__)
router = APIRouter(tags=["ai"])


# --------------------------------------------------------------------------
# 服务商配置
# --------------------------------------------------------------------------

@router.get("/ai/config")
def api_ai_config() -> dict:
    """AI 配置总览。密钥只给打码形态。"""
    cfg = config_loader.load_ai_config()
    return {
        "default": cfg.get("default") or "",
        "providers": config_loader.masked_providers(),
        "budget": config_loader.get_budget(),
        "privacy_hint": "正文会发送给所选服务商的 API（这是未发表作品）。介意请改用本地 Ollama。",
    }


@router.get("/ai/catalog")
def api_ai_catalog() -> dict:
    """服务商申请引导（新手向）：科普 + 官方申请直链 + 费用锚点 + 免责与隐私告知。

    内容归后端（`app/ai/catalog.py`），改文案不用重新构建界面 ——
    与识别引擎目录同一套做法。
    """
    return ai_catalog.guide()


class ProviderPatch(BaseModel):
    label: str | None = None
    base_url: str | None = None
    model: str | None = None
    api_key: str | None = None      # 打码形态 = 不改
    enabled: bool | None = None
    price_input: float | None = None
    price_output: float | None = None


@router.put("/ai/providers/{name}")
def api_ai_provider_put(name: str, payload: ProviderPatch) -> dict:
    if not name or len(name) > 40:
        raise HTTPException(status_code=400, detail="服务商名不合法")
    patch = {k: v for k, v in payload.model_dump().items() if v is not None}
    config_loader.update_provider(name, patch)
    return {"saved": True, "providers": config_loader.masked_providers(),
            "default": config_loader.load_ai_config().get("default")}


@router.put("/ai/default")
def api_ai_default(payload: dict) -> dict:
    key = str(payload.get("key") or "")
    try:
        config_loader.set_default(key)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"没有服务商：{key}") from None
    return {"saved": True, "default": key}


@router.post("/ai/providers/{name}/test")
def api_ai_provider_test(name: str) -> dict:
    """连通性测试（会真实调一次，花几个 token 的钱）。"""
    try:
        _, prov = config_loader.get_provider(name)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"没有服务商：{name}") from None
    result = ai_client.test_provider(prov)
    meter.record(book_id="(测试)", provider=name, model=prov.get("model", ""),
                 prompt_tokens=0, completion_tokens=0, cost_cny=0, purpose="test")
    return {"provider": name, **result}


@router.put("/ai/budget")
def api_ai_budget(payload: dict) -> dict:
    try:
        budget = config_loader.set_budget({
            "monthly_limit_cny": float(payload.get("monthly_limit_cny") or 0),
            "warn_at_percent": int(payload.get("warn_at_percent") or 80),
        })
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="预算必须是数字") from None
    return {"saved": True, "budget": budget}


# --------------------------------------------------------------------------
# 提示词
# --------------------------------------------------------------------------

@router.get("/ai/prompts")
def api_prompts_list() -> dict:
    return {"prompts": prompts.list_prompts()}


@router.get("/ai/prompts/{name}")
def api_prompt_get(name: str) -> dict:
    try:
        return prompts.get_prompt(name)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"没有提示词：{name}") from None


@router.put("/ai/prompts/{name}")
def api_prompt_put(name: str, payload: dict) -> dict:
    content = str(payload.get("content") or "")
    try:
        return prompts.save_prompt(name, content)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"没有提示词：{name}") from None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


@router.get("/ai/prompts/{name}/versions")
def api_prompt_versions(name: str) -> dict:
    try:
        return {"name": name, "versions": prompts.list_versions(name)}
    except KeyError:
        raise HTTPException(status_code=404, detail=f"没有提示词：{name}") from None


@router.post("/ai/prompts/{name}/rollback")
def api_prompt_rollback(name: str, payload: dict) -> dict:
    try:
        p = prompts.rollback(name, int(payload.get("version") or 0))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    return {"rolled_back": True, "prompt": p}


# --------------------------------------------------------------------------
# 计量与词元监测
# --------------------------------------------------------------------------

@router.get("/ai/usage")
def api_ai_usage(book_id: str | None = None) -> dict:
    """成本看板：总量 / 本月 / 按书 / 按服务商 / 近期逐章。"""
    stats = meter.usage_stats(book_id or None)
    budget = config_loader.get_budget()
    limit = float(budget.get("monthly_limit_cny") or 0)
    month_cost = stats["month"]["cost_cny"]
    return {
        **stats,
        "budget": budget,
        "month_percent": round(month_cost / limit * 100, 1) if limit > 0 else None,
    }


@router.get("/ai/monitor")
def api_monitor_get() -> dict:
    return meter.monitor_stats()


@router.put("/ai/monitor")
def api_monitor_put(payload: dict) -> dict:
    """开 / 关词元监测。开着时，之后所有调用的 token 都累计进读数。"""
    active = bool(payload.get("active"))
    label = str(payload.get("label") or "")
    state = meter.set_monitor(active, label)
    return {**state, "stats": meter.monitor_stats()}


# --------------------------------------------------------------------------
# AI 抽取
# --------------------------------------------------------------------------

class AiExtractIn(BaseModel):
    """跑哪些章。chapter_nos 空 = 全部。refresh = 无视缓存重跑（钱花得更多）。"""

    chapter_nos: list[int] = Field(default_factory=list)
    provider: str | None = None
    refresh: bool = False


@router.post("/books/{book_id}/chapters/extract/ai")
def api_extract_ai(book_id: str, payload: AiExtractIn) -> dict:
    """AI 抽取（单章粒度，逐章跑）。结果只是**候选**，落盘走人工确认。

    **同步**执行 —— 一本 30 章的书会占住这个请求十几分钟。界面走的是
    异步那一条（`POST /books/{id}/chapters/extract/ai/job`，可看进度、
    可中断、可续跑）；这个入口留给脚本与冒烟测试，契约保持不变。

    真正的活儿在 `app/ai/batch.py` —— 两处各写一遍必然漂移。
    """
    _check_book_id(book_id)
    try:
        return batch_mod.run_ai_extract(
            book_id,
            chapter_nos=payload.chapter_nos,
            provider=payload.provider,
            refresh=payload.refresh,
        )
    except batch_mod.MissingChapters as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    except batch_mod.NoChapters as exc:
        raise HTTPException(status_code=400, detail="还没有导入任何章节") from exc
    except ai_extract_mod.BudgetExceeded as exc:
        raise HTTPException(status_code=402, detail=str(exc)) from None


# --------------------------------------------------------------------------
# 伏笔落盘（AI 候选 → world/foreshadow.md 表格）
# --------------------------------------------------------------------------

class ForeshadowCommitIn(BaseModel):
    items: list[dict] = Field(default_factory=list)  # {content, chapter_no, para?, note?}


def _render_doc(title: str, columns: list[str], rows: list[list[str]]) -> str:
    head = "| " + " | ".join(columns) + " |\n"
    sep = "|" + "|".join(["---"] * len(columns)) + "|\n"
    body = "".join("| " + " | ".join(c.replace("|", "／") for c in r) + " |\n" for r in rows)
    return f"# {title}\n\n{head}{sep}{body}"


@router.post("/books/{book_id}/foreshadow/commit", status_code=201)
def api_foreshadow_commit(book_id: str, payload: ForeshadowCommitIn) -> dict:
    """把确认过的伏笔写进伏笔看板。同「伏笔+章节」去重。"""
    _check_book_id(book_id)
    spec = docs_mod.doc_spec("foreshadow")
    path = docs_mod.doc_path(book_id, "foreshadow")
    columns = spec["columns"]

    rows: list[list[str]] = []
    if path.is_file():
        cols, rows = docs_mod.parse_table(path.read_text(encoding="utf-8"))
        if cols:
            columns = cols

    existing = {(r[0], r[1]) for r in rows if len(r) >= 2}
    added: list[str] = []
    skipped: list[str] = []
    for item in payload.items:
        content = str(item.get("content") or "").strip()
        if not content:
            continue
        no = item.get("chapter_no")
        marker = f"第{no}章" if no else "—"
        if (content, marker) in existing:
            skipped.append(content)
            continue
        note = str(item.get("note") or "").strip()
        para = item.get("para")
        if para and not note:
            note = f"第{para}段"
        rows.append([content, marker, "", "未回收", note])
        existing.add((content, marker))
        added.append(content)

    text = _render_doc(spec["title"], columns, rows)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")
    return {"added": len(added), "skipped": len(skipped),
            "added_items": added, "skipped_items": skipped,
            "total": len(rows), "path": str(path)}
