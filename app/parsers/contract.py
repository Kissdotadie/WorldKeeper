"""抽取器插件契约（P11-C3）——「正文/原料 → 候选变更」的一条统一管道。

第二梯队 #7 一直空着：`app/parsers/` 里几种解析器各说各话，调用方各接各的，
将来想插一种新抽取器就得改核心。本模块把口子收成一份契约：

**输入** `ExtractRequest` —— 章节正文（rule/ai）或原料（paste/docx）+ 已有实体名录 + 上下文选项
**输出** `ExtractOutput` —— `candidates`（统一候选结构）+ `extras`（各家专属产物原样带出）

候选的**必有键**（冒烟按这套不变量逐家验）：
    name        名字
    source      谁抽的：rule / ai / paste / docx
    confidence  置信度 0~1（AI 档 0.75、规则档按锚点算、粘贴 0.9 —— 数字是诚实分，不是装饰）
    reasons     为什么报它（人类可读）
    exists      库里是否已有同名实体
    where       出处 —— **每家自己的坐标系**：rule/ai 是 {chapter_no, para}，
                paste 是 {material}，docx 是 {doc_level, doc_index}。出处永不丢失。

两条规矩：
1. 适配器是**薄**的 —— 只做形状归一，不复制任何解析逻辑；
   真正的活儿仍由 parsers/extract、ai/extract、paste、docx 各自干。
2. AI 适配器**惰性导入** —— app.ai 拖着配置/计量一串依赖，
   不能让「只想用规则抽取」的路径连坐加载。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

# --------------------------------------------------------------------------
# 契约的数据形状
# --------------------------------------------------------------------------


@dataclass
class ExtractRequest:
    """一次抽取的全部输入。字段按需填，各家只读自己关心的。"""

    book_id: str = ""
    #: [{chapter_no, title, text}] —— rule / ai 吃这个
    chapters: list[dict] = field(default_factory=list)
    #: 原料文本 —— paste 吃这个（Markdown 表格 / 列表 / 纯行）
    material: str = ""
    #: 设定稿文件路径 —— docx 吃这个（含 .txt/.md，read_any 统一入口）
    doc_path: str | None = None
    #: 已有实体名录 {实体名: id} —— 用于给候选标 exists / entity_id
    known: dict[str, str] = field(default_factory=dict)
    #: {别名: id} —— 同样只影响 exists 判定
    alias_map: dict[str, str] = field(default_factory=dict)
    #: 库里已知的方法论名（rule 用它给候选挂「信奉什么」）
    methodologies: list[str] = field(default_factory=list)
    #: 各家自己的旋钮：min_score / min_count / provider_key / refresh / mode / tags …
    options: dict[str, Any] = field(default_factory=dict)


@dataclass
class ExtractOutput:
    """一次抽取的统一输出。extras 装各家专属产物（appearances/changes/…），原样透传。"""

    source: str
    candidates: list[dict] = field(default_factory=list)
    extras: dict[str, Any] = field(default_factory=dict)


class Extractor(Protocol):
    """抽取器契约。实现这三个属性 + run，再 register 一下就算入伙。"""

    key: str
    label: str
    input_kind: str  # 'chapters' | 'material' | 'doc' —— 调用方据此知道该喂什么

    def run(self, req: ExtractRequest) -> ExtractOutput: ...


# --------------------------------------------------------------------------
# 注册表
# --------------------------------------------------------------------------

_REGISTRY: dict[str, Extractor] = {}


def register(extractor: Extractor) -> None:
    """登记一个抽取器。同 key 覆盖（测试里换桩用）。"""
    _REGISTRY[extractor.key] = extractor


def get_extractor(key: str) -> Extractor:
    if key not in _REGISTRY:
        raise KeyError(f"没有叫「{key}」的抽取器；已注册：{sorted(_REGISTRY)}")
    return _REGISTRY[key]


def run_extractor(key: str, req: ExtractRequest) -> ExtractOutput:
    """走契约跑一次抽取 —— 调用方只认 key，不认具体实现。"""
    return get_extractor(key).run(req)


def registered() -> list[dict]:
    """已入伙的抽取器清单（给后台/冒烟看的花名册）。"""
    return [
        {"key": ex.key, "label": ex.label, "input_kind": ex.input_kind}
        for ex in _REGISTRY.values()
    ]


# --------------------------------------------------------------------------
# 四个内置适配器
# --------------------------------------------------------------------------


class RuleExtractor:
    """规则抽取 —— 说话人锚定 / 引语上下文 / 高频专名，零 AI 零词典。"""

    key = "rule"
    label = "规则抽取"
    input_kind = "chapters"

    def run(self, req: ExtractRequest) -> ExtractOutput:
        from . import extract as mod  # 本模块内的老朋友，直接导

        result = mod.extract(
            req.chapters,
            known=req.known,
            alias_map=req.alias_map,
            min_score=req.options.get("min_score", 0.20),
            min_count=req.options.get("min_count", 2),
            methodologies=req.methodologies,
        )
        for c in result["candidates"]:
            c["source"] = "rule"
            # 出处：首次出现在哪章哪段（extract 已保证 first_at 的形状）
            c["where"] = dict(c.get("first_at") or {})
        return ExtractOutput(
            source="rule",
            candidates=result["candidates"],
            extras={"appearances": result["appearances"], "stats": result["stats"]},
        )


class AiExtractor:
    """AI 抽取 —— 单章为粒度（缓存 / 计量 / 重试都按章算），多章请循环调用。"""

    key = "ai"
    label = "AI 抽取"
    input_kind = "chapters"

    def run(self, req: ExtractRequest) -> ExtractOutput:
        from ..ai import extract as mod  # 惰性：不拖累纯规则路径的加载

        if not req.chapters:
            raise ValueError("AI 抽取一次吃一章：req.chapters 里放一章的 {chapter_no,title,text}")
        ch = req.chapters[0]
        r = mod.ai_extract_chapter(
            req.book_id,
            chapter_no=ch.get("chapter_no") or 0,
            title=ch.get("title") or "",
            text=ch.get("text") or "",
            provider_key=req.options.get("provider_key"),
            refresh=req.options.get("refresh", False),
        )
        for c in r["candidates"]:
            c["source"] = "ai"  # _to_candidates 已给，setdefault 兜底防漂
            # 出处：_to_candidates 把章节/段号收在 first_at 里，收拢成 where
            c.setdefault("where", dict(c.get("first_at") or {}))
        return ExtractOutput(
            source="ai",
            candidates=r["candidates"],
            extras={
                "changes": r["changes"],
                "foreshadow": r["foreshadow"],
                "meta": {
                    "chapter_no": r.get("chapter_no"),
                    "model": r.get("model"),
                    "prompt_version": r.get("prompt_version"),
                    "cache_hit": r.get("cache_hit", False),
                    "provider": r.get("provider"),
                    "tokens": r.get("tokens"),
                    "cost_cny": r.get("cost_cny"),
                },
            },
        )


class PasteExtractor:
    """批量粘贴 —— 设定表整段贴进来，切成实体草稿。出处是「用户亲手给的」。"""

    key = "paste"
    label = "批量粘贴"
    input_kind = "material"

    def run(self, req: ExtractRequest) -> ExtractOutput:
        from .paste import parse_paste

        raw = parse_paste(req.material, req.options.get("mode"), req.options.get("tags"))
        lookup = {**req.alias_map, **req.known}
        candidates: list[dict] = []
        for d in raw.get("drafts", []):
            name = str(d.get("name") or "").strip()
            if not name:
                continue
            eid = lookup.get(name)
            candidates.append({
                "name": name,
                "type": None,  # 粘贴不猜类型 —— 由用户在确认清单里挑
                "count": 1,
                "confidence": 0.9,
                "reasons": [f"粘贴导入（{raw.get('mode')} 模式）"],
                "samples": [d["summary"]] if d.get("summary") else [],
                "exists": eid is not None,
                "entity_id": eid,
                "source": "paste",
                "where": {"material": "粘贴原料"},
            })
        return ExtractOutput(
            source="paste",
            candidates=candidates,
            extras={"raw": raw},  # bulk-paste 接口吃的还是原始 drafts，原样带出
        )


class DocxExtractor:
    """docx 设定稿 —— 多级列表还原成大纲，节点就是候选实体。

    出处坐标系是文档自己的：第几层、第几个节点 —— 正文还没有章节号，
    硬造一个「第 1 章」才是撒谎。
    """

    key = "docx"
    label = "docx 设定稿"
    input_kind = "doc"

    def run(self, req: ExtractRequest) -> ExtractOutput:
        from . import docx as mod

        if not req.doc_path:
            raise ValueError("docx 抽取需要 req.doc_path（.docx/.txt/.md 文件路径）")
        doc = mod.read_any(req.doc_path)
        nodes = mod.flatten_outline(mod.to_outline(doc.paragraphs))
        lookup = {**req.alias_map, **req.known}
        candidates: list[dict] = []
        for i, n in enumerate(nodes):
            name = n.text.strip()
            if not name:
                continue
            eid = lookup.get(name)
            candidates.append({
                "name": name,
                "type": None,  # 大纲节点不猜类型 —— 种族/势力/地点由人工定
                "count": 1,
                "confidence": 0.8 if n.depth == 0 else 0.6,
                "reasons": [f"docx 大纲（第 {n.level} 级）"],
                "samples": [],
                "exists": eid is not None,
                "entity_id": eid,
                "source": "docx",
                "where": {"doc_level": n.level, "doc_index": i},
            })
        return ExtractOutput(
            source="docx",
            candidates=candidates,
            extras={"roots": mod.find_roots(doc.paragraphs), "node_count": len(nodes)},
        )


register(RuleExtractor())
register(AiExtractor())
register(PasteExtractor())
register(DocxExtractor())
