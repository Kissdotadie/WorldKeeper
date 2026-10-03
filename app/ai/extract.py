"""AI 抽取编排：正文 + 名录 + 提示词 → 结构化候选。

工程要点（全部来自既定决策）：
- 提示词里附**已有实体名录**，AI 只报新增与变更（既准又省钱）
- 强制结构化 JSON；解析失败自动重试一次（把坏输出退回去让它修）
- 响应缓存：键 = 正文 hash + 提示词版本 + 模型 + 服务商，命中零花费
- 每条结论必须带原文依据（出处永不丢失）
- 计量：每一次真实调用都记 token 与估算花费；预算超限直接刹车
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from .. import custom_types, paths, store
from ..logging_setup import get_logger
from . import client, config_loader, meter, prompts

log = get_logger(__name__)

MAX_ROSTER_CHARS = 6000   # 名录太长会烧钱，超出就截断（角色优先）
RETRY_HINT = (
    "你上次的输出不是合法 JSON。请只输出一个 JSON 对象本身，"
    "不要 markdown 代码围栏、不要任何解释文字。结构要求不变。"
)


class BudgetExceeded(Exception):
    pass


# --------------------------------------------------------------------------
# 名录
# --------------------------------------------------------------------------

def _roster(book_id: str) -> tuple[str, dict[str, str], dict[str, str]]:
    """实体名录文本 + 两张判定表（name→id, name→type）。"""
    with store.connect() as conn:
        rows = list(conn.execute(
            "SELECT id, name, type FROM entities WHERE book_id=? ORDER BY type, name",
            (book_id,)))
    name_to_id = {r["name"]: r["id"] for r in rows}
    type_of = {r["name"]: r["type"] for r in rows}

    # 角色排前面 —— 截断时保最重要的
    rows.sort(key=lambda r: (r["type"] != "character", r["type"], r["name"]))
    lines = []
    total = 0
    for r in rows:
        line = f"{r['name']}（{r['type']}）"
        if total + len(line) > MAX_ROSTER_CHARS:
            lines.append(f"…（其余 {len(rows) - len(lines)} 条从略，变化上报时按名字核对即可）")
            break
        lines.append(line)
        total += len(line)
    return "、".join(lines) if lines else "（知识库还是空的，全部按新实体上报）", name_to_id, type_of


def _methodology_roster(book_id: str) -> str:
    items = store.methodology_overview(book_id)["items"]
    return "、".join(it["name"] for it in items) if items else "（暂无）"


# --------------------------------------------------------------------------
# 提示词渲染与缓存
# --------------------------------------------------------------------------

def render_prompt(template: str, mapping: dict[str, str]) -> str:
    """占位符替换。不用 str.format —— 用户模板里的 JSON 花括号会把它弄炸。"""
    out = template
    for key, value in mapping.items():
        out = out.replace("{" + key + "}", value)
    return out


def _cache_key(provider_key: str, provider: dict, prompt: dict, chapter_text: str) -> str:
    h = hashlib.sha256()
    h.update(provider_key.encode())
    h.update((provider.get("model") or "").encode())
    h.update(str(prompt.get("version") or 0).encode())
    h.update(prompt.get("sha1", "").encode())
    h.update(chapter_text.encode("utf-8"))
    return h.hexdigest()[:32]


def _cache_get(key: str) -> dict | None:
    p = paths.ai_cache_dir() / f"{key}.json"
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _cache_put(key: str, payload: dict) -> None:
    d = paths.ai_cache_dir()
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{key}.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")


# --------------------------------------------------------------------------
# JSON 解析（容错）
# --------------------------------------------------------------------------

def _parse_json(text: str) -> dict:
    """从模型输出里挖出一个 JSON 对象。"""
    raw = (text or "").strip()
    # 剥 markdown 围栏
    m = re.search(r"```(?:json)?\s*(.*?)```", raw, re.DOTALL)
    if m:
        raw = m.group(1).strip()
    # 找第一个 { 到最后一个 }
    start, end = raw.find("{"), raw.rfind("}")
    if start >= 0 and end > start:
        raw = raw[start:end + 1]
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("顶层不是对象")
    return data


# --------------------------------------------------------------------------
# 结果整形
# --------------------------------------------------------------------------

def _locate_para(paras: list[str], evidence: str) -> int | None:
    """证据句子在第几段（段号是出处定位的锚点）。"""
    probe = (evidence or "").strip()[:14]
    if not probe:
        return None
    for i, p in enumerate(paras, start=1):
        if probe in p:
            return i
    return None


def _to_candidates(
    data: dict, *, chapter_no: int, paras: list[str],
    name_to_id: dict[str, str], type_of: dict[str, str],
    valid_types: set[str],
) -> tuple[list[dict], list[dict], list[dict]]:
    """模型输出 → （新实体候选 / 变更 / 伏笔）。候选结构与规则层同构。"""
    candidates: list[dict] = []
    for item in data.get("entities") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name or len(name) > 40:
            continue
        etype = str(item.get("type") or "concept").strip()
        if etype not in valid_types:
            etype = "concept"
        evidence = str(item.get("evidence") or "").strip()
        summary = str(item.get("summary") or "").strip()[:80]
        meths = [str(m).strip() for m in (item.get("methodologies") or []) if str(m).strip()]
        para = _locate_para(paras, evidence)
        exists = name in name_to_id
        candidates.append({
            "name": name,
            "type": type_of.get(name, etype) if exists else etype,
            "count": 1,
            "confidence": 0.75,  # AI 档：比规则 C 档高，但仍需人工确认
            "reasons": (["AI 抽取", f"摘要：{summary}"] if summary else ["AI 抽取"]),
            "chapters": [chapter_no],
            "samples": [evidence] if evidence else [],
            "first_at": {"chapter_no": chapter_no, "para": para} if para else {"chapter_no": chapter_no},
            "exists": exists,
            "entity_id": name_to_id.get(name),
            "methodologies": meths,
            "methodology_evidence": {},
            "summary": summary,
            "source": "ai",
        })

    changes: list[dict] = []
    for item in data.get("changes") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        changes.append({
            "name": name,
            "exists": name in name_to_id,
            "entity_id": name_to_id.get(name),
            "field": str(item.get("field") or "").strip()[:40],
            "detail": str(item.get("detail") or "").strip()[:200],
            "evidence": str(item.get("evidence") or "").strip()[:300],
            "para": _locate_para(paras, str(item.get("evidence") or "")),
            "chapter_no": chapter_no,
        })

    foreshadow: list[dict] = []
    for item in data.get("foreshadow") or []:
        if not isinstance(item, dict):
            continue
        content = str(item.get("content") or "").strip()
        if not content:
            continue
        evidence = str(item.get("evidence") or "").strip()
        foreshadow.append({
            "content": content[:120],
            "evidence": evidence[:300],
            "chapter_no": chapter_no,
            "para": _locate_para(paras, evidence),
        })
    return candidates, changes, foreshadow


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------

def check_budget() -> None:
    """月度花费超限直接刹车（0 = 不设限）。"""
    budget = config_loader.get_budget()
    limit = float(budget.get("monthly_limit_cny") or 0)
    if limit <= 0:
        return
    spent = meter.usage_stats()["month"]["cost_cny"]
    if spent >= limit:
        raise BudgetExceeded(
            f"本月已花费约 ¥{spent:.2f}，达到上限 ¥{limit:.2f}。去 AI 配置里调高预算再继续。")


def ai_extract_chapter(
    book_id: str,
    *,
    chapter_no: int,
    title: str,
    text: str,
    provider_key: str | None = None,
    refresh: bool = False,
) -> dict:
    """对一章跑 AI 抽取。单章为粒度 —— 哪章不满意就单独重跑哪章。"""
    check_budget()
    pkey, provider = config_loader.get_provider(provider_key)
    if not provider.get("enabled", True):
        raise client.AIError("bad_response", f"服务商 {pkey} 已被停用")
    prompt = prompts.get_prompt("extraction")
    roster_text, name_to_id, type_of = _roster(book_id)
    valid_types = set(custom_types.list_types(book_id))

    # 类型清单附在名录后 —— 模型才知道本书允许哪些 type（含自定义类型），
    # 不改提示词模板本身（占位符校验会挡新占位符）。
    type_line = "；".join(
        f"{key}={info['label']}" for key, info in custom_types.list_types(book_id).items())
    roster_text = (
        roster_text
        + f"\n\n（本书可选的实体类型 key：{type_line}。"
          "拿不准归哪类就用 concept；类型必须从上面这些 key 里选）")
    paras = [p.strip() for p in text.split("\n\n") if p.strip()]

    key = _cache_key(pkey, provider, prompt, text)
    if not refresh:
        hit = _cache_get(key)
        if hit is not None:
            meter.record(book_id=book_id, provider=pkey,
                         model=provider.get("model", ""), chapter_no=chapter_no,
                         purpose="extract", cache_hit=True)
            return {**hit, "cache_hit": True, "provider": pkey,
                    "tokens": {"prompt": 0, "completion": 0}, "cost_cny": 0.0}

    user_msg = render_prompt(prompt["content"], {
        "entity_roster": roster_text,
        "methodology_roster": _methodology_roster(book_id),
        "chapter_no": str(chapter_no),
        "title": title or "",
        "chapter_text": text,
    })
    messages = [{"role": "user", "content": user_msg}]

    data: dict | None = None
    total_prompt = total_completion = 0
    for attempt in (1, 2):
        # max_tokens 给足 —— 输出被截断的 JSON 解析必然失败，而失败的表现
        # 是「两次都不是合法 JSON」这种让人摸不着头脑的报错。
        # 实测 1.2 万字的长章一次能吐 5~6k token，4096 会拦腰截断。
        # 多给的额度**不等于多花钱**：按实际用量计费，吐不完就不收。
        r = client.chat(provider, messages, max_tokens=8192)
        total_prompt += r["prompt_tokens"]
        total_completion += r["completion_tokens"]
        try:
            data = _parse_json(r["content"])
            break
        except Exception as exc:
            log.info("第 %s 章 AI 输出解析失败（第 %s 次）：%s", chapter_no, attempt, exc)
            if attempt == 1:
                # 把对话续上，让它自己修 —— 比重发整章便宜
                messages = [
                    {"role": "user", "content": user_msg},
                    {"role": "assistant", "content": r["content"][:2000]},
                    {"role": "user", "content": RETRY_HINT},
                ]
    if data is None:
        cost = config_loader.estimate_cost(provider, total_prompt, total_completion)
        meter.record(book_id=book_id, provider=pkey, model=provider.get("model", ""),
                     prompt_tokens=total_prompt, completion_tokens=total_completion,
                     cost_cny=cost, chapter_no=chapter_no, purpose="extract")
        raise client.AIError("bad_response", "两次输出都不是合法 JSON，这章跳过（钱已记账）")

    candidates, changes, foreshadow = _to_candidates(
        data, chapter_no=chapter_no, paras=paras,
        name_to_id=name_to_id, type_of=type_of,
        valid_types=valid_types)

    payload = {
        "chapter_no": chapter_no,
        "candidates": candidates,
        "changes": changes,
        "foreshadow": foreshadow,
        "prompt_version": prompt["version"],
        "model": provider.get("model", ""),
    }
    _cache_put(key, payload)

    cost = config_loader.estimate_cost(provider, total_prompt, total_completion)
    meter.record(book_id=book_id, provider=pkey, model=provider.get("model", ""),
                 prompt_tokens=total_prompt, completion_tokens=total_completion,
                 cost_cny=cost, chapter_no=chapter_no, purpose="extract")
    return {**payload, "cache_hit": False, "provider": pkey,
            "tokens": {"prompt": total_prompt, "completion": total_completion},
            "cost_cny": cost}
