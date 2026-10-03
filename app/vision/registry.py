"""引擎登记处：谁可用、默认用谁、为什么不可用。

**`auto` 的含义**：能用本地就用本地。
理由不是本地更准（大模型通常更准），而是底图是用户自己的手稿与设定，
能不发到外网就不发。本地那次跑砸了，用户还能手动切云端重跑一次。
云端要把未公开的设定发出去、还要花钱，**必须由人显式选择**。

**显式选择不做回退**（这条是刻意的）：
- 指定 `local` 而本地不可用 → **直接报错**，绝不悄悄改用云端。
  悄悄换的话，用户以为图没出门，实际已经发出去了 —— 这是最不能犯的错。
- 指定 `cloud` 而云端不可用 → 也直接报错，但错误里告诉用户本地能不能用。
  静默换引擎会让「这个结果是哪来的」变得说不清。

**可用性原因要能直接读给人看**，含「怎么装」。不许吞 —— 用户看到
「识别不了」但没有任何下一步，等于没有这个功能。
"""

from __future__ import annotations

from . import config
from .base import VisionEngine, VisionError, VisionOptions, VisionResult
from .cloud import CloudEngine
from .local import LocalEngine

#: 界面上能直接改的参数（临时覆盖用，不落盘）。
#: 落盘的是 `data/vision/config.json`，这里只覆盖「这一次」。
OVERRIDE_KEYS = (
    "detect_regions",
    "detect_text",
    "min_region_area",
    "simplify",
    "max_regions",
    "max_texts",
    "ocr",
    "blur",
    "prompt",
)


# --------------------------------------------------------------------------
# 造引擎
# --------------------------------------------------------------------------


def build_engine(engine_id: str, cfg: dict | None = None) -> VisionEngine:
    """按 id 造一个引擎实例。未知 id 一律当本地 —— 手改坏的配置不该让功能打不开。"""
    cfg = cfg if isinstance(cfg, dict) else config.load_config()
    if engine_id == "cloud":
        section = cfg.get("cloud") if isinstance(cfg.get("cloud"), dict) else {}
        return CloudEngine(provider_key=str(section.get("provider") or ""))
    return LocalEngine()


def _cloud_provider_name(cfg: dict) -> str:
    section = cfg.get("cloud") if isinstance(cfg.get("cloud"), dict) else {}
    return str(section.get("provider") or "")


# --------------------------------------------------------------------------
# 可用性
# --------------------------------------------------------------------------


def available_engines(cfg: dict | None = None) -> list[dict]:
    """三个选项各自的可用性。第一个是 `auto`（默认选它）。

    `auto` 这一项**必须给出 `sends_image_offsite`** —— 它不是一个固定值：
    本地能用的时候它是 False（图不出门），本地用不了、只能走云端的时候它就是
    True。让用户选了一个写着「不外发」的选项、结果图被发出去了，
    比没这个功能糟糕得多。
    """
    cfg = cfg if isinstance(cfg, dict) else config.load_config()

    local = build_engine("local", cfg)
    local_ok, local_why = local.availability()

    cloud = build_engine("cloud", cfg)
    cloud_ok, cloud_why = cloud.availability()

    if local_ok:
        auto = {
            "id": "auto",
            "label": "自动（优先本地）",
            "available": True,
            "reason": "",
            "will_use": "local",
            "will_use_label": local.label,
            "sends_image_offsite": False,
            "hint": "现在会走本地识别，图不出这台机器。",
        }
    elif cloud_ok:
        auto = {
            "id": "auto",
            "label": "自动（本地不可用，会走云端）",
            "available": True,
            "reason": "",
            "will_use": "cloud",
            "will_use_label": cloud.label,
            "sends_image_offsite": True,
            "hint": f"本地用不了（{local_why}），所以自动模式会把图发给「"
                    f"{_cloud_provider_name(cfg) or '默认服务商'}」。",
        }
    else:
        auto = {
            "id": "auto",
            "label": "自动（两个引擎都用不了）",
            "available": False,
            "reason": f"本地：{local_why}；云端：{cloud_why}",
            "will_use": "",
            "will_use_label": "",
            "sends_image_offsite": False,
            "hint": "两个都不可用，先修好一个。",
        }

    return [
        auto,
        {
            "id": "local",
            "label": local.label,
            "available": local_ok,
            "reason": local_why,
            "will_use": "local" if local_ok else "",
            "will_use_label": local.label if local_ok else "",
            "sends_image_offsite": False,
            "hint": "图不出发送，适合未公开的设定稿。认得出线条围出的形状，认不出语义。",
        },
        {
            "id": "cloud",
            "label": cloud.label,
            "available": cloud_ok,
            "reason": cloud_why,
            "will_use": "cloud" if cloud_ok else "",
            "will_use_label": cloud.label if cloud_ok else "",
            "sends_image_offsite": True,
            "hint": "能把图上的字读进去，所以能判断「这块是北境」；代价是底图会发给服务商。",
        },
    ]


def engines_report() -> dict:
    """给界面的一份总览：现在的选择、三个选项、隐私提示。"""
    cfg = config.load_config()
    engines = available_engines(cfg)
    chosen = cfg.get("engine", "auto")
    entry = next((e for e in engines if e["id"] == chosen), engines[0])
    return {
        "engine": chosen,
        "engines": engines,
        "current": entry,
        "cloud_provider": _cloud_provider_name(cfg),
        "privacy": (
            "底图是你自己画的设定稿，多半没公开过。"
            "本地识别在这台机器上跑，图不出去；云端识别会把图发给 AI 服务商。"
        ),
    }


# --------------------------------------------------------------------------
# 选引擎
# --------------------------------------------------------------------------


def resolve_engine(want: str = "auto", cfg: dict | None = None) -> tuple[VisionEngine, list[str]]:
    """挑一个能用的引擎。返回 (引擎, 降级说明)。

    降级说明会原样出现在结果里 —— 「这次为什么走了云端」必须写在界面上，
    不能只写进日志。
    """
    cfg = cfg if isinstance(cfg, dict) else config.load_config()
    if want not in config.ENGINE_IDS:
        want = "auto"
    notes: list[str] = []

    if want in ("auto", "local"):
        local = build_engine("local", cfg)
        ok, why = local.availability()
        if ok:
            if want == "auto":
                notes.append("自动模式：本地识别可用，图没有离开这台机器")
            return local, notes
        if want == "local":
            cloud_ok, cloud_why = build_engine("cloud", cfg).availability()
            extra = "云端现在可用，但那是把图发出去，得你自己点。" if cloud_ok \
                else f"云端也不可用：{cloud_why}"
            raise VisionError(
                "unavailable",
                f"你指定了本地识别，但它现在用不了：{why}。{extra}"
                "（指定了本地就不会自动改走云端 —— 那会把你的设定发出去。）",
            )
        notes.append(f"本地识别用不了，这次改走云端：{why}")

    cloud = build_engine("cloud", cfg)
    ok, why = cloud.availability()
    if ok:
        return cloud, notes

    if want == "cloud":
        local_ok, local_why = build_engine("local", cfg).availability()
        extra = "本地识别现在可用，切过去就不用花钱、也不外发。" if local_ok \
            else f"本地也不可用：{local_why}"
        raise VisionError("unavailable", f"云端识别用不了：{why}。{extra}")

    raise VisionError(
        "unavailable",
        f"没有可用的识别引擎。本地：{build_engine('local', cfg).availability()[1]}；"
        f"云端：{why}",
    )


# --------------------------------------------------------------------------
# 跑一次
# --------------------------------------------------------------------------


def options_for(engine_id: str, cfg: dict, overrides: dict | None = None) -> VisionOptions:
    """取该引擎那节的参数，套上这次的临时覆盖。

    `auto` 解析出来是哪个引擎，就用哪个引擎那节的参数 —— 界面上改的是
    「本地参数」「云端参数」，不是「auto 参数」。
    """
    section = cfg.get(engine_id) if isinstance(cfg.get(engine_id), dict) else {}
    merged = dict(section or {})
    if isinstance(overrides, dict):
        for k in OVERRIDE_KEYS:
            if overrides.get(k) is not None:
                merged[k] = overrides[k]
    return VisionOptions.from_config({engine_id: merged}, engine_id=engine_id)


def analyze_image(
    book_id: str,
    image: bytes,
    *,
    engine_id: str | None = None,
    overrides: dict | None = None,
) -> VisionResult:
    """跑一次识别。**只出候选，不落任何盘。**

    `engine_id` 留空 = 用 `data/vision/config.json` 里选的那个。
    """
    cfg = config.load_config()
    want = engine_id or cfg.get("engine") or "auto"
    engine, notes = resolve_engine(want, cfg)
    opts = options_for(engine.id, cfg, overrides)

    result = engine.analyze(image, opts, book_id=book_id)
    # 这两条是「这次实际发生了什么都」的事实，由登记处统一盖上，
    # 免得每个引擎各填各的、漏一个就误导人。
    result.engine = engine.id
    result.engine_label = engine.label
    result.sends_image_offsite = bool(engine.sends_image_offsite)
    result.notes = notes + list(result.notes)
    return result
