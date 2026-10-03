"""AI 服务商配置（`data/ai/ai.yaml`）。

表驱动：providers 是 dict，新买一家 API 就加一段，代码不动。
密钥处理规矩：
- 列表/详情接口一律打码（`mask_key`）
- 保存时若回传的 key 是打码形态（含 …），视为「没改」，保留原值
"""

from __future__ import annotations

from typing import Any

import yaml

from .. import paths

DEFAULT_CONFIG: dict[str, Any] = {
    "default": "",
    "providers": {},
    "budget": {"monthly_limit_cny": 0, "warn_at_percent": 80},
}

_HEADER = (
    "# AI 服务商配置 —— 机密文件：不进版本控制、不写日志、界面不回显明文\n"
    "# 表驱动：新买 API 照抄一段 provider 填上即可，不用改代码\n"
)


def load_ai_config() -> dict:
    p = paths.ai_config_file()
    raw: dict = {}
    if p.exists():
        try:
            data = yaml.safe_load(p.read_text(encoding="utf-8"))
            raw = data if isinstance(data, dict) else {}
        except Exception:
            raw = {}
    cfg = {**DEFAULT_CONFIG, **raw}
    cfg["providers"] = dict(raw.get("providers") or {})
    cfg["budget"] = {**DEFAULT_CONFIG["budget"], **(raw.get("budget") or {})}
    return cfg


def save_ai_config(cfg: dict) -> None:
    p = paths.ai_config_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    body = yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False)
    p.write_text(_HEADER + body, encoding="utf-8")


def mask_key(key: str) -> str:
    """打码：只露头 6 尾 4。短 key 全糊掉。"""
    k = (key or "").strip()
    if len(k) <= 12:
        return "…" * 6 if k else ""
    return f"{k[:6]}…{k[-4:]}"


def get_provider(key: str | None = None) -> tuple[str, dict]:
    """取一家服务商。key 为 None 时取默认。找不到抛 KeyError。"""
    cfg = load_ai_config()
    name = key or cfg.get("default") or ""
    if not name and cfg["providers"]:
        name = next(iter(cfg["providers"]))
    prov = cfg["providers"].get(name)
    if not prov:
        raise KeyError(name or "(未配置)")
    merged = {
        "label": name, "base_url": "", "api_key": "", "model": "",
        "enabled": True, "price_input": 0, "price_output": 0,
        **prov,
    }
    return name, merged


def masked_providers() -> list[dict]:
    """给界面用的列表：key 打码，绝不回显明文。"""
    cfg = load_ai_config()
    default = cfg.get("default") or ""
    out = []
    for name, prov in cfg["providers"].items():
        p = {"label": name, "base_url": "", "api_key": "", "model": "",
             "enabled": True, "price_input": 0, "price_output": 0, **prov}
        out.append({
            "key": name,
            "label": p.get("label") or name,
            "base_url": p["base_url"],
            "model": p["model"],
            "enabled": bool(p.get("enabled", True)),
            "is_default": name == default,
            "has_key": bool(p.get("api_key")),
            "key_masked": mask_key(p.get("api_key", "")),
            "price_input": float(p.get("price_input") or 0),
            "price_output": float(p.get("price_output") or 0),
        })
    return out


def update_provider(name: str, patch: dict) -> dict:
    """改一家服务商。api_key 传打码形态 = 不动原 key。"""
    cfg = load_ai_config()
    prov = dict(cfg["providers"].get(name) or {})
    for field in ("label", "base_url", "model", "enabled", "price_input", "price_output"):
        if field in patch and patch[field] is not None:
            prov[field] = patch[field]
    new_key = (patch.get("api_key") or "").strip()
    if new_key and "…" not in new_key:
        prov["api_key"] = new_key
    cfg["providers"][name] = prov
    if not cfg.get("default"):
        cfg["default"] = name
    save_ai_config(cfg)
    return prov


def set_default(name: str) -> None:
    cfg = load_ai_config()
    if name not in cfg["providers"]:
        raise KeyError(name)
    cfg["default"] = name
    save_ai_config(cfg)


def get_budget() -> dict:
    return load_ai_config()["budget"]


def set_budget(patch: dict) -> dict:
    cfg = load_ai_config()
    for f in ("monthly_limit_cny", "warn_at_percent"):
        if f in patch and patch[f] is not None:
            cfg["budget"][f] = patch[f]
    save_ai_config(cfg)
    return cfg["budget"]


def estimate_cost(provider: dict, prompt_tokens: int, completion_tokens: int) -> float:
    """按 provider 单价估算花费（元）。单价为 0 时返回 0 —— 界面只显示 token。"""
    pin = float(provider.get("price_input") or 0)
    pout = float(provider.get("price_output") or 0)
    return round((prompt_tokens * pin + completion_tokens * pout) / 1_000_000, 6)
