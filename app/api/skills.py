"""技能中心的 HTTP 接口。

- 卡片管理：列表 / 详情 / 新建 / 改 / 删 / 把内置卡复制成自定义
- 运行：选一批章节 → 渲染模板 → 调 AI → 返回**分析结果**（只读，不落盘、不改正文）

运行结果**不落任何文件**：技能卡是"看一下"的东西，结论要不要进知识库由作者
自己决定（走录入或 AI 抽取那条带人工确认的路）。花的钱照记进计量流水。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import chapters as ch_mod
from .. import skills
from .. import store
from ..ai import client as ai_client
from ..ai import config_loader, extract as ai_extract_mod, meter
from ..logging_setup import get_logger
from ._common import check_book_id as _check_book_id

log = get_logger(__name__)
router = APIRouter(tags=["skills"])


def _wrap(fn, *args, **kwargs):
    """把模块层抛的异常翻成人话的 HTTP 错误。"""
    try:
        return fn(*args, **kwargs)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"没有这张技能卡：{exc.args[0]}") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# --------------------------------------------------------------------------
# 卡片管理
# --------------------------------------------------------------------------

class SkillIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    template: str = Field(min_length=1)
    scene: str = ""
    skill_id: str | None = None
    placeholders: list[str] | None = None


class SkillPatch(BaseModel):
    name: str | None = None
    scene: str | None = None
    template: str | None = None


class CloneIn(BaseModel):
    name: str | None = None


class SkillRunIn(BaseModel):
    book_id: str
    chapter_nos: list[int] = Field(default_factory=list)
    focus: str = ""
    provider: str | None = None


@router.get("/skills")
def api_list_skills() -> dict:
    return skills.list_skills()


@router.post("/skills", status_code=201)
def api_create_skill(payload: SkillIn) -> dict:
    return _wrap(skills.create_skill, payload.name, payload.template,
                 scene=payload.scene, skill_id=payload.skill_id,
                 placeholders=payload.placeholders)


@router.get("/skills/{skill_id}")
def api_get_skill(skill_id: str) -> dict:
    return _wrap(skills.get_skill, skill_id)


@router.put("/skills/{skill_id}")
def api_update_skill(skill_id: str, payload: SkillPatch) -> dict:
    return _wrap(skills.update_skill, skill_id,
                 {"name": payload.name, "scene": payload.scene, "template": payload.template})


@router.delete("/skills/{skill_id}")
def api_delete_skill(skill_id: str) -> dict:
    return _wrap(skills.delete_skill, skill_id)


@router.post("/skills/{skill_id}/clone", status_code=201)
def api_clone_skill(skill_id: str, payload: CloneIn) -> dict:
    return _wrap(skills.clone_skill, skill_id, payload.name)


# --------------------------------------------------------------------------
# 运行
# --------------------------------------------------------------------------

_BUILTIN_ROSTER_LIMIT = 6000


def _roster_text(book_id: str) -> str:
    rows = store.list_entities(book_id)
    rows.sort(key=lambda r: (r.get("type") != "character", r.get("type") or "", r.get("name") or ""))
    lines: list[str] = []
    total = 0
    for r in rows:
        line = f"{r['name']}（{r['type']}）"
        if total + len(line) > _BUILTIN_ROSTER_LIMIT:
            lines.append(f"…（其余 {len(rows) - len(lines)} 条从略）")
            break
        lines.append(line)
        total += len(line)
    return "、".join(lines) if lines else "（知识库还是空的）"


@router.post("/skills/{skill_id}/run")
def api_run_skill(skill_id: str, payload: SkillRunIn) -> dict:
    """跑一张技能卡。**只读**：读章节正文 → AI 分析 → 返回结果，什么都不落盘。"""
    _check_book_id(payload.book_id)
    card = _wrap(skills.get_skill, skill_id)

    all_ch = ch_mod.list_chapters(payload.book_id)
    if payload.chapter_nos:
        wanted = set(payload.chapter_nos)
        picked = [c for c in all_ch if c.chapter_no in wanted]
        missing = sorted(wanted - {c.chapter_no for c in picked})
        if missing:
            raise HTTPException(status_code=404, detail=f"这些章不存在：{missing}")
    else:
        picked = all_ch
    if not picked:
        raise HTTPException(status_code=400, detail="这本书还没有章节，先去「正文」导入")

    try:
        ai_extract_mod.check_budget()
        provider_name, provider = config_loader.get_provider(payload.provider)
    except KeyError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"还没配置 AI 服务商（{exc.args[0] if exc.args else ''}）—— 去 设置 → 后台 → AI 配置",
        ) from exc
    except ai_extract_mod.BudgetExceeded as exc:
        raise HTTPException(status_code=402, detail=str(exc)) from exc

    chapter_text, titles, truncated = skills.assemble_chapters(
        [{"chapter_no": c.chapter_no, "title": c.title, "text": c.text} for c in picked])
    prompt = skills.render_prompt(
        card, chapter_text=chapter_text, chapter_titles=titles,
        entity_roster=_roster_text(payload.book_id), focus=payload.focus)

    try:
        r = ai_client.chat(provider, [{"role": "user", "content": prompt}],
                           max_tokens=4096, temperature=0.3, timeout=300.0)
    except ai_client.AIError as exc:
        raise HTTPException(status_code=502, detail=f"AI 调用失败（{exc.kind}）：{exc}") from None

    cost = config_loader.estimate_cost(provider, r["prompt_tokens"], r["completion_tokens"])
    meter.record(
        book_id=payload.book_id, provider=provider_name, model=r["model"],
        prompt_tokens=r["prompt_tokens"], completion_tokens=r["completion_tokens"],
        cost_cny=cost, purpose=f"skill:{skill_id}")

    return {
        "skill_id": skill_id,
        "skill_name": card["name"],
        "book_id": payload.book_id,
        "chapters": [c.chapter_no for c in picked],
        "content": r["content"],
        "truncated": truncated,
        "prompt_chars": len(prompt),
        "provider": provider_name,
        "model": r["model"],
        "tokens": {
            "prompt": r["prompt_tokens"],
            "completion": r["completion_tokens"],
            "total": r["total_tokens"],
        },
        "cost_cny": round(cost, 6),
        "latency_ms": r.get("latency_ms", 0),
        "privacy_hint": "本次把选中章节的正文发给了 AI 服务商。正文是未发表作品，介意见此改用本地模型。",
        "readonly_notice": "结果只是分析参考，没有写进知识库，也没有改动正文一个字。",
    }
