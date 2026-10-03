"""识别引擎配置（`data/vision/config.json`）。

**全局一份，不分书** —— 跟 `ai.yaml` 一个待遇。「这台机器有没有 OCR、
默认走本地还是云端」是机器级事实，不该每本书问一遍。

**为什么不塞进 ai.yaml**：那边存的是密钥，这边存的是算法参数。
混在一起之后，任何一次「把配置发给别人帮看」都会顺手带走一堆无关信息；
分开存，`config.json` 可以随便截图给人看，`ai.yaml` 永远不出门。
云端那一节只记**服务商名字**，真钥匙还在 ai.yaml 里 —— 密钥只有一个地方。
"""

from __future__ import annotations

import json
from typing import Any

from .. import paths
from ..logging_setup import get_logger

log = get_logger(__name__)

SCHEMA_VERSION = 1

#: 引擎 id 白名单。写错的名字当 auto 处理，不报错 —— 手改坏配置不该让功能打不开。
ENGINE_IDS = ("auto", "local", "cloud")

DEFAULT_CONFIG: dict[str, Any] = {
    "schema": SCHEMA_VERSION,
    # auto = 能用本地就用本地；本地不可用且云端配好了才走云端
    "engine": "auto",
    "local": {
        "detect_regions": True,
        "detect_text": True,
        # 面积下限按比例算，换分辨率不用改数字
        "min_region_area": 0.0015,
        "simplify": 0.012,
        "max_regions": 60,
        "max_texts": 300,
        "blur": 5,
        # auto / rapidocr / tesseract / paddleocr / easyocr / none
        # （顺序即 auto 的挑选顺序：轻的优先。详见 local.py 的 ocr_backend()）
        "ocr": "auto",
    },
    "cloud": {
        # data/ai/ai.yaml 里的服务商名；密钥不复制到这里
        "provider": "",
        "detect_regions": True,
        "detect_text": True,
        "max_regions": 60,
        "max_texts": 300,
        "prompt": "",
    },
}


def _merge(base: dict, raw: dict) -> dict:
    out = dict(base)
    for k, v in raw.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            out[k] = {**base[k], **v}
        else:
            out[k] = v
    return out


def load_config() -> dict:
    """读配置。文件不在 / 读坏了都回默认值 —— 识别不可用不该连累界面打不开。"""
    p = paths.vision_config_file()
    raw: dict = {}
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            raw = data if isinstance(data, dict) else {}
        except Exception as exc:
            log.warning("识别配置读不出来，用默认值：%s", exc)
            raw = {}
    cfg = _merge(DEFAULT_CONFIG, raw)
    if cfg.get("engine") not in ENGINE_IDS:
        cfg["engine"] = "auto"
    return cfg


def save_config(patch: dict) -> dict:
    """合并保存。只认白名单里的键，其余原样留着（向前兼容）。"""
    cur = load_config()
    clean: dict = {}
    if isinstance(patch.get("engine"), str) and patch["engine"] in ENGINE_IDS:
        clean["engine"] = patch["engine"]
    for section in ("local", "cloud"):
        if isinstance(patch.get(section), dict):
            merged = {**cur.get(section, {})}
            for k, v in patch[section].items():
                if k == "__replace__":  # 整节替换的逃生口，测试用
                    continue
                merged[k] = v
            clean[section] = merged
    cfg = _merge(cur, clean)
    cfg["schema"] = SCHEMA_VERSION
    if cfg.get("engine") not in ENGINE_IDS:
        cfg["engine"] = "auto"

    p = paths.vision_config_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)
    return cfg


def public_config() -> dict:
    """给界面看的配置。

    这里**没有密钥** —— 云端那节只有服务商名字。真钥匙在 `data/ai/ai.yaml`，
    由 AI 配置页管，本页只做引用。
    """
    cfg = load_config()
    return {
        "schema": cfg.get("schema", SCHEMA_VERSION),
        "engine": cfg.get("engine", "auto"),
        "local": dict(cfg.get("local") or {}),
        "cloud": dict(cfg.get("cloud") or {}),
        "available": [e for e in ENGINE_IDS if e != "auto"],
    }
