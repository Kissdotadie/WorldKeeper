"""识别引擎的契约与数据结构。

坐标一律**归一化 0~1** —— 和 `view/maps/` 里的点位、区域同一条规矩。
理由也一样：换一张分辨率更高的底图（同一张画重扫一遍），候选区域不用重算。
引擎拿到的是像素，吐出来的必须是归一化值；换算只在一处做（`base.to_unit`）。

`confidence` 是**引擎自报的信心**，不是概率。本地轮廓提取给不出有意义的
信心值，就填 0 并在 `notes` 里说明 —— 编一个 0.87 出来比不填更坏，
界面会拿它排序，人就会以为机器有把握。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


class VisionError(Exception):
    """kind: unavailable / bad_image / network / auth / rate_limit / server / bad_response

    和 `app/ai/client.AIError` 同一套 kind 词表 —— 前端处理降级时不用记两套。
    """

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


# --------------------------------------------------------------------------
# 候选
# --------------------------------------------------------------------------

#: 顶点数上限。归一化坐标 + 40 个点足够描出任何手绘边界；
#   再多就是像素级抖动，存下来只是给落盘文件和渲染添负担。
MAX_POINTS = 40
#: 区域数上限。一张图上真有人圈得下 100 块以上的国界吗？没有。
MAX_REGIONS = 60
#: 文字候选上限。
MAX_TEXTS = 300


@dataclass
class RegionCandidate:
    """一块候选区域。`points` 是归一化多边形，至少 3 个点。"""

    points: list[tuple[float, float]]
    label: str = ""
    confidence: float = 0.0
    source: str = ""

    def to_dict(self) -> dict:
        # 显式 float()：引擎吐出来的可能是 numpy 标量，落盘与 JSON 序列化
        # 都只认原生类型，早转早干净。
        return {
            "points": [[float(round(x, 5)), float(round(y, 5))] for x, y in self.points],
            "label": self.label,
            "confidence": float(round(float(self.confidence), 3)),
            "source": self.source,
        }


@dataclass
class TextCandidate:
    """一段候选文字及其位置（归一化中心点）。"""

    text: str
    x: float
    y: float
    confidence: float = 0.0
    source: str = ""
    #: 归一化的 [x, y, w, h] 包围盒，画在图上给人对位置用
    box: tuple[float, float, float, float] | None = None

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "x": float(round(float(self.x), 5)),
            "y": float(round(float(self.y), 5)),
            "confidence": float(round(float(self.confidence), 3)),
            "source": self.source,
            "box": [float(round(v, 5)) for v in self.box] if self.box else None,
        }


@dataclass
class VisionOptions:
    """跑一次识别的参数。全部来自 `data/vision/config.json`，界面可改。"""

    detect_regions: bool = True
    detect_text: bool = True
    #: 区域面积下限（占整图比例）。太小的多半是噪点或标点符号
    min_region_area: float = 0.0015
    #: 多边形简化强度。越大越方，越小越贴边
    simplify: float = 0.012
    max_regions: int = MAX_REGIONS
    max_texts: int = MAX_TEXTS
    #: 本地引擎：OCR 后端 auto / rapidocr / tesseract / none
    ocr: str = "auto"
    #: 本地引擎：先模糊一次再找边，压掉纸纹与扫描噪点
    blur: int = 5
    #: 云端引擎：留空用内置提示词
    prompt: str = ""

    @classmethod
    def from_config(cls, cfg: dict, *, engine_id: str = "local") -> "VisionOptions":
        """从配置里那一节取参数。缺失一律落默认值 —— 手改坏的配置不该让识别直接崩。"""
        raw = cfg.get(engine_id) if isinstance(cfg.get(engine_id), dict) else {}
        raw = raw or {}
        opt = cls()
        for name in ("detect_regions", "detect_text"):
            if isinstance(raw.get(name), bool):
                setattr(opt, name, raw[name])
        for name in ("min_region_area", "simplify"):
            try:
                if raw.get(name) is not None:
                    setattr(opt, name, float(raw[name]))
            except (TypeError, ValueError):
                pass
        for name in ("max_regions", "max_texts", "blur"):
            try:
                if raw.get(name) is not None:
                    setattr(opt, name, int(raw[name]))
            except (TypeError, ValueError):
                pass
        if isinstance(raw.get("ocr"), str):
            opt.ocr = raw["ocr"]
        if isinstance(raw.get("prompt"), str):
            opt.prompt = raw["prompt"]
        # 夹到合理区间，别让一个手改的 0 把识别变成空跑
        opt.min_region_area = min(max(opt.min_region_area, 0.0001), 0.2)
        opt.simplify = min(max(opt.simplify, 0.001), 0.08)
        opt.max_regions = min(max(opt.max_regions, 1), 400)
        opt.max_texts = min(max(opt.max_texts, 1), 2000)
        opt.blur = min(max(opt.blur, 0), 31)
        return opt


@dataclass
class VisionResult:
    """一次识别的产出。**这只是候选** —— 落盘与否由人点。"""

    engine: str
    #: 引擎的中文名，界面直接显示，不用再去引擎列表里查一遍
    engine_label: str = ""
    #: 这一次**实际**有没有把图发到外网。`auto` 模式下两种都可能，所以
    #: 必须由「这次的结果」自己说清楚，不能靠读配置去猜。
    sends_image_offsite: bool = False
    regions: list[RegionCandidate] = field(default_factory=list)
    texts: list[TextCandidate] = field(default_factory=list)
    #: 处理用的图像尺寸（不是原始尺寸：本地引擎会先缩到能跑得动的尺度）
    width: int = 0
    height: int = 0
    elapsed_ms: int = 0
    #: 给人看的说明：降级原因、跳过了什么。界面必须原样显示，不许吞
    notes: list[str] = field(default_factory=list)
    #: 云端才有：token 与花费
    usage: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "engine": self.engine,
            "engine_label": self.engine_label,
            "sends_image_offsite": self.sends_image_offsite,
            "regions": [r.to_dict() for r in self.regions],
            "texts": [t.to_dict() for t in self.texts],
            "width": self.width,
            "height": self.height,
            "elapsed_ms": self.elapsed_ms,
            "notes": self.notes,
            "usage": self.usage,
        }


# --------------------------------------------------------------------------
# 引擎契约
# --------------------------------------------------------------------------


class VisionEngine(Protocol):
    """一个识别引擎。"""

    id: str
    label: str
    #: 会不会把图片发到外网 —— 界面必须据此提醒隐私
    sends_image_offsite: bool

    def availability(self) -> tuple[bool, str]:
        """(可用?, 不可用原因)。原因要能直接显示给人看，含怎么装。"""
        ...

    def analyze(self, image: bytes, opts: VisionOptions, *, book_id: str = "") -> VisionResult:
        ...


def clamp01(v: float) -> float:
    return 0.0 if v < 0 else (1.0 if v > 1 else v)


def to_unit(v: float, total: float) -> float:
    """像素 → 归一化。除零、负值、越界一律夹住 —— 脏坐标比没有坐标更糟。"""
    if total <= 0:
        return 0.0
    return clamp01(v / total)
