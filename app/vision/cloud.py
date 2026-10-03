"""云端识别引擎：把底图发给视觉大模型（VL），要它回结构化候选。

**和本地引擎的分工**：本地只认「线条围出来的形状」，认不出语义 ——
它不知道哪块是海、哪块是「北境」。VL 模型能把图上的字一起读进去，
所以「这块是北境，那块是神界」这种判断只有它能给。

**隐私**：底图是用户自己画的设定稿，多半没公开过。
`sends_image_offsite = True`，界面必须据此提示；而且这条只能由**人显式选择**
引擎才走，`auto` 永远优先本地。

**走了 AI 层的三条老规矩**：
1. 密钥只在 `data/ai/ai.yaml`，这里只记服务商名字，日志/异常都不碰 key
2. 计量进 `metering.jsonl`（`purpose="vision"`），预算超限直接刹车
3. 只读不写：产出是候选，落盘要人点
"""

from __future__ import annotations

import base64
import json
import re
import time

import httpx

from ..ai import config_loader, meter
from ..ai.extract import BudgetExceeded, check_budget
from ..logging_setup import get_logger
from .base import (
    MAX_POINTS,
    RegionCandidate,
    TextCandidate,
    VisionError,
    VisionOptions,
    VisionResult,
    clamp01,
)

log = get_logger(__name__)

#: 单条文字/标签的长度上限，防模型话痨
_LABEL_MAX = 60

DEFAULT_PROMPT = """你在读一张小说设定用的地图（手绘、扫描或网图）。请只输出 JSON，不要任何解释。

要做的两件事：
1. regions：把图上**有明确边界、且构成一个地理/政治单元**的区块圈出来（国、州、山脉、海域、大陆、区域）。
2. texts：把图上的**文字标注**抄下来，给出它的中心位置（地名的位置就是这个地名所指的地方）。

严格按这个结构输出：
{"regions":[{"label":"北境","points":[[0.12,0.30],[0.44,0.28],[0.46,0.61],[0.13,0.62]]}],
 "texts":[{"text":"灰堡城","x":0.31,"y":0.44}]}

规矩：
- 所有坐标都是**归一化 0~1**（x 除以图宽、y 除以图高），左上角是 (0,0)。
- points 是沿边界顺时针的多边形顶点，**最多 40 个**，直线段尽量少（能 6 个点描出就不要 20 个）。
- 看不清、拿不准的**宁可不报**，不要凑数。一张图上没有明确边界就返回空数组。
- label 用图上的原文；图上没有名字就写一个你能看出来的类别（如「山脉」）。
- 每张图 regions 不超过 __MAX_REGIONS__ 个，texts 不超过 __MAX_TEXTS__ 个。"""


class CloudEngine:
    id = "cloud"
    label = "云端视觉模型（把图发出去）"
    sends_image_offsite = True

    def __init__(self, provider_key: str = ""):
        self.provider_key = (provider_key or "").strip()

    # ---- 可用性 --------------------------------------------------------

    def availability(self) -> tuple[bool, str]:
        cfg = config_loader.load_ai_config()
        name = self.provider_key or cfg.get("default") or ""
        if not name:
            return False, "还没配任何 AI 服务商 —— 去「设置 → AI」加一家支持看图（VL）的模型"
        prov = (cfg.get("providers") or {}).get(name)
        if not prov:
            return False, f"识别配置里指定的服务商「{name}」在 AI 配置里不存在"
        if not prov.get("api_key") or not prov.get("base_url") or not prov.get("model"):
            return False, f"服务商「{name}」的 base_url / api_key / model 没配全"
        if not prov.get("enabled", True):
            return False, f"服务商「{name}」被停用了"
        return True, ""

    # ---- 主流程 --------------------------------------------------------

    def analyze(self, image: bytes, opts: VisionOptions, *, book_id: str = "") -> VisionResult:
        ok, why = self.availability()
        if not ok:
            raise VisionError("unavailable", why)

        try:
            check_budget()
        except BudgetExceeded as exc:
            raise VisionError("rate_limit", str(exc)) from exc

        name, prov = config_loader.get_provider(self.provider_key or None)
        prompt = (opts.prompt or "").strip() or DEFAULT_PROMPT
        prompt = (
            prompt.replace("__MAX_REGIONS__", str(opts.max_regions))
            .replace("__MAX_TEXTS__", str(opts.max_texts))
        )
        if not opts.detect_regions:
            prompt += "\n\n注意：这次**不要**输出 regions，只输出 texts（regions 给空数组）。"
        if not opts.detect_text:
            prompt += "\n\n注意：这次**不要**输出 texts，只输出 regions（texts 给空数组）。"

        mime = _guess_mime(image)
        data_url = f"data:{mime};base64,{base64.b64encode(image).decode('ascii')}"
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ]

        started = time.monotonic()
        data = self._post(prov, messages)
        elapsed = int((time.monotonic() - started) * 1000)

        content, usage = _unpack(data)
        parsed = _parse_json(content)

        notes: list[str] = [
            f"这次的图已经发给了「{name}」—— 底图是你的设定稿，注意这一点",
        ]
        regions = _clean_regions(parsed.get("regions"), opts.max_regions, self.id)
        texts = _clean_texts(parsed.get("texts"), opts.max_texts, self.id)
        if opts.detect_regions and not regions:
            notes.append("模型没报任何区域 —— 它可能觉得这张图没有可圈的地理单元")
        if opts.detect_text and not texts:
            notes.append("模型没报任何文字 —— 字太糊或太小的话很正常")
        if parsed.get("_parse_note"):
            notes.append(str(parsed["_parse_note"]))

        cost = config_loader.estimate_cost(
            prov, usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0)
        )
        meter.record(
            book_id=book_id or "(未知)",
            provider=name,
            model=usage.get("model") or prov.get("model", ""),
            prompt_tokens=usage.get("prompt_tokens", 0),
            completion_tokens=usage.get("completion_tokens", 0),
            cost_cny=cost,
            purpose="vision",
        )

        return VisionResult(
            engine=self.id,
            regions=regions,
            texts=texts,
            width=0,
            height=0,
            elapsed_ms=elapsed,
            notes=notes,
            usage={
                "provider": name,
                "model": usage.get("model") or prov.get("model", ""),
                "prompt_tokens": usage.get("prompt_tokens", 0),
                "completion_tokens": usage.get("completion_tokens", 0),
                "total_tokens": usage.get("total_tokens", 0),
                "cost_cny": cost,
            },
        )

    # ---- 调用 ----------------------------------------------------------

    def _post(self, prov: dict, messages: list[dict]) -> dict:
        base = (prov.get("base_url") or "").rstrip("/")
        key = prov.get("api_key") or ""
        model = prov.get("model") or ""
        payload = {
            "model": model,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": 4096,
            "stream": False,
        }
        headers = {
            "Authorization": f"Bearer {key}",
            "api-key": key,  # 小米 MiMo 一类的头，两个都给，兼容优先
            "Content-Type": "application/json",
        }
        try:
            resp = httpx.post(
                f"{base}/chat/completions", headers=headers, json=payload,
                timeout=240.0, trust_env=False,
            )
        except httpx.HTTPError as exc:
            raise VisionError("network", f"连不上服务商：{exc.__class__.__name__}") from exc

        if resp.status_code in (401, 403):
            raise VisionError("auth", f"密钥被拒（{resp.status_code}）—— 去 AI 配置里检查 key")
        if resp.status_code == 429:
            raise VisionError("rate_limit", "触发限流（429），稍后再试")
        if resp.status_code >= 500:
            raise VisionError("server", f"服务商那边出错了（{resp.status_code}）")
        if resp.status_code != 200:
            raise VisionError("bad_response", f"返回 {resp.status_code}：{resp.text[:200]}")
        try:
            return resp.json()
        except Exception as exc:
            raise VisionError("bad_response", f"响应不是 JSON：{exc}") from exc


# --------------------------------------------------------------------------
# 解析
# --------------------------------------------------------------------------

_MIME = {
    b"\x89PNG": "image/png",
    b"\xff\xd8\xff": "image/jpeg",
}


def _guess_mime(image: bytes) -> str:
    for sig, mime in _MIME.items():
        if image.startswith(sig):
            return mime
    if image[:4] == b"RIFF" and image[8:12] == b"WEBP":
        return "image/webp"
    return "image/png"


def _unpack(data: dict) -> tuple[str, dict]:
    try:
        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        content = msg.get("content") or ""
        # 有些 VL 服务商把内容切成数组（text + image），拼回文本
        if isinstance(content, list):
            content = "".join(
                part.get("text", "") for part in content if isinstance(part, dict)
            )
        usage = data.get("usage") or {}
    except Exception as exc:
        raise VisionError("bad_response", f"响应结构不对：{exc}") from exc
    return str(content), {
        "prompt_tokens": int(usage.get("prompt_tokens") or 0),
        "completion_tokens": int(usage.get("completion_tokens") or 0),
        "total_tokens": int(usage.get("total_tokens") or 0),
        "model": data.get("model") or "",
    }


def _parse_json(text: str) -> dict:
    """从模型输出里挖 JSON。挖不出来不抛错 —— 返回空 + 一条说明，界面照常显示。"""
    raw = (text or "").strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", raw, re.DOTALL)
    if m:
        raw = m.group(1).strip()
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        return {"regions": [], "texts": [],
                "_parse_note": "模型没按要求回 JSON，这次什么都没拿到 —— 换个模型或重跑一次"}
    try:
        data = json.loads(raw[start:end + 1])
    except Exception:
        return {"regions": [], "texts": [],
                "_parse_note": "模型回的 JSON 解析不了，这次什么都没拿到"}
    return data if isinstance(data, dict) else {"regions": [], "texts": []}


def _clean_regions(raw, limit: int, source: str) -> list[RegionCandidate]:
    """模型给的坐标一律当不可信输入：夹回 0~1、顶点不足三点丢弃、超量截断。"""
    out: list[RegionCandidate] = []
    if not isinstance(raw, list):
        return out
    for item in raw[:limit]:
        if not isinstance(item, dict):
            continue
        pts_raw = item.get("points")
        if not isinstance(pts_raw, list):
            continue
        pts: list[tuple[float, float]] = []
        for p in pts_raw[:MAX_POINTS]:
            if isinstance(p, (list, tuple)) and len(p) >= 2:
                try:
                    pts.append((clamp01(float(p[0])), clamp01(float(p[1]))))
                except (TypeError, ValueError):
                    continue
        if len(pts) < 3:
            continue
        label = item.get("label")
        out.append(
            RegionCandidate(
                points=pts,
                label=str(label)[:_LABEL_MAX] if label else "",
                confidence=0.0,  # VL 报的信心没有校准意义，不编数字
                source=source,
            )
        )
    return out


def _clean_texts(raw, limit: int, source: str) -> list[TextCandidate]:
    out: list[TextCandidate] = []
    if not isinstance(raw, list):
        return out
    for item in raw[:limit]:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        try:
            x = clamp01(float(item.get("x")))
            y = clamp01(float(item.get("y")))
        except (TypeError, ValueError):
            continue
        out.append(
            TextCandidate(
                text=text[:_LABEL_MAX], x=x, y=y, confidence=0.0, source=source, box=None
            )
        )
    return out
