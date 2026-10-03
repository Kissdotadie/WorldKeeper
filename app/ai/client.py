"""OpenAI 兼容的 chat 客户端。

日志与异常的规矩：
- **永不记录/抛出 api_key**
- 正文是未发表作品，日志只写长度与 token 数，不写正文内容
"""

from __future__ import annotations

import time

import httpx

from ..logging_setup import get_logger

log = get_logger(__name__)


class AIError(Exception):
    """kind: network / auth / rate_limit / server / bad_response"""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


def chat(
    provider: dict,
    messages: list[dict],
    *,
    max_tokens: int = 4096,
    temperature: float = 0.2,
    timeout: float = 180.0,
) -> dict:
    """调一次 /chat/completions。

    返回 {content, model, prompt_tokens, completion_tokens, total_tokens, latency_ms}
    """
    base = (provider.get("base_url") or "").rstrip("/")
    key = provider.get("api_key") or ""
    model = provider.get("model") or ""
    if not base or not key or not model:
        raise AIError("bad_response", "服务商配置不完整（base_url / api_key / model 缺一不可）")

    url = f"{base}/chat/completions"
    # 小米 MiMo 用 api-key 头，OpenAI 系用 Authorization Bearer —— 两个都给，兼容优先
    headers = {
        "Authorization": f"Bearer {key}",
        "api-key": key,
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }

    started = time.monotonic()
    try:
        resp = httpx.post(url, headers=headers, json=payload, timeout=timeout, trust_env=False)
    except httpx.HTTPError as exc:
        raise AIError("network", f"连不上服务商：{exc.__class__.__name__}") from exc
    latency = int((time.monotonic() - started) * 1000)

    if resp.status_code in (401, 403):
        raise AIError("auth", f"密钥被拒（{resp.status_code}）—— 去 AI 配置里检查 key")
    if resp.status_code == 429:
        raise AIError("rate_limit", "触发限流（429），稍后再试")
    if resp.status_code >= 500:
        raise AIError("server", f"服务商那边出错了（{resp.status_code}），稍后再试")
    if resp.status_code != 200:
        raise AIError("bad_response", f"返回 {resp.status_code}：{resp.text[:200]}")

    try:
        data = resp.json()
        choice = (data.get("choices") or [{}])[0]
        content = (choice.get("message") or {}).get("content") or ""
        usage = data.get("usage") or {}
    except Exception as exc:
        raise AIError("bad_response", f"响应不是预期的结构：{exc}") from exc

    result = {
        "content": content,
        "model": data.get("model") or model,
        "prompt_tokens": int(usage.get("prompt_tokens") or 0),
        "completion_tokens": int(usage.get("completion_tokens") or 0),
        "total_tokens": int(usage.get("total_tokens") or 0),
        "latency_ms": latency,
    }
    log.info(
        "AI 调用完成：provider=%s model=%s tokens=%s+%s 耗时 %sms",
        provider.get("label"), model,
        result["prompt_tokens"], result["completion_tokens"], latency,
    )
    return result


def test_provider(provider: dict) -> dict:
    """连通性测试：发一条最便宜的消息。返回 {ok, latency_ms, model, error}。"""
    try:
        r = chat(
            provider,
            [{"role": "user", "content": "只回复两个字：正常"}],
            max_tokens=16,
            timeout=45.0,
        )
        return {"ok": True, "latency_ms": r["latency_ms"], "model": r["model"],
                "reply": (r["content"] or "")[:50], "error": ""}
    except AIError as exc:
        return {"ok": False, "latency_ms": 0, "model": provider.get("model", ""),
                "reply": "", "error": str(exc)}
