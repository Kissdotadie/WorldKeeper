"""识别引擎（P4.5.3）：把手绘/扫描的地图图片读成「候选区域 + 候选文字」。

**一句话原则：引擎只出候选，一个字都不入库。**
识别结果走和 AI 抽取同一套人工确认 —— 机器猜的东西没经过人眼就不是知识库。
这条不是保守，是必须：手绘地图的线条没有任何规范，识别率再高的算法也会
把山脉的画风认成国界。候选列表摆在那里，人对一眼勾几块，比机器闷头写进去强。

**为什么可插拔**（`app/vision/` 四个文件各管一摊）：
- `base.py`   契约与数据结构 —— 谁想接新引擎，实现 `VisionEngine` 就行
- `local.py`  本机跑（OpenCV 抽区域 + 可选 OCR 认字），**可选依赖**，没装就降级
- `cloud.py`  把图发给视觉大模型（VL），由它回结构化 JSON
- `registry.py` 谁可用、默认用谁、为什么不可用

**引擎怎么选**：默认 `auto` = **能用本地就用本地**。
理由不是本地更准（大模型通常更准），而是：底图是用户自己的手稿与设定，
能不发到外网就不发；本地那次跑砸了，用户还能手动切云端重跑一次。
云端要花钱、要把未公开的设定发出去，**必须由人显式选择**，不能悄悄发生。
"""

from __future__ import annotations

from .base import (
    TextCandidate,
    VisionEngine,
    VisionError,
    VisionOptions,
    VisionResult,
    RegionCandidate,
)
from .registry import analyze_image, available_engines, resolve_engine

__all__ = [
    "TextCandidate",
    "RegionCandidate",
    "VisionEngine",
    "VisionError",
    "VisionOptions",
    "VisionResult",
    "analyze_image",
    "available_engines",
    "resolve_engine",
]
