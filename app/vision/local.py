"""本地识别引擎：OpenCV 抽区域 + 可选 OCR 认字。

**全部依赖都是可选的**。这台机器上没装 OpenCV / 没装 OCR，功能就降级，
不是报错把界面卡住 —— 与「AI 可降级」同一条原则。
不可用的原因会原样送到界面上（含怎么装），不许吞。

算法思路（都是老办法，因为手绘地图的老办法反而稳）：

**区域**：转灰度 → 模糊压掉纸纹与扫描噪点 → 自适应阈值（局部对比，
不依赖整张纸的明暗）→ 形态学闭运算把断续的线连上 → `findContours`
→ 按面积筛掉噪点 → `approxPolyDP` 把锯齿边简化成多边形 → 归一化。

**特意没做的事**：
- 不做「空白区域识别后自动填色」。什么叫「空白」得看语义 —— 图上大片留白
  可能是海，也可能是没画完。这活交给云端 VL 更合适（它能读到图上的字）。
  本地这一档只交**封闭区域的轮廓**，填不填色、填什么色，人点。
- 不给 confidence 编数字。轮廓提取算不出有意义的置信度，一律 0，
  并在 notes 里说清楚 —— 界面拿它排序的话，0 会沉底，那正是应该的。
"""

from __future__ import annotations

import time

from ..logging_setup import get_logger
from .base import (
    MAX_POINTS,
    RegionCandidate,
    TextCandidate,
    VisionError,
    VisionOptions,
    VisionResult,
    to_unit,
)

log = get_logger(__name__)

#: 处理尺度上限。4000px 的手绘扫描件按原尺寸跑轮廓要好几秒，
#: 缩到 1600 长边后区域形状几乎不变，但快一个数量级。
#: 归一化坐标是相对值，所以缩图**不影响结果的精度语义**（只影响细节颗粒度）。
WORK_MAX_SIDE = 1600


# --------------------------------------------------------------------------
# 几何小工具
# --------------------------------------------------------------------------


def _iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    """两个外接框的交并比。用来判断「这两块轮廓其实是同一个东西」。"""
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    iw = min(ax1, bx1) - max(ax0, bx0)
    ih = min(ay1, by1) - max(ay0, by0)
    if iw <= 0 or ih <= 0:
        return 0.0
    inter = iw * ih
    union = (ax1 - ax0) * (ay1 - ay0) + (bx1 - bx0) * (by1 - by0) - inter
    return inter / union if union > 0 else 0.0


def _depths(hierarchy) -> list[int]:
    """每个轮廓的嵌套深度。偶数 = 一块区域的外轮廓，奇数 = 洞。

    `findContours` 给的层级是 [next, prev, child, parent] 四个下标，
    这里顺着 parent 往上数。带 guard：手改过或极端的图可能给出畸形层级，
    数不完也不能卡死。
    """
    h = hierarchy[0] if hierarchy is not None and len(hierarchy) else []
    out: list[int] = []
    for i in range(len(h)):
        d = 0
        p = int(h[i][3])
        while p != -1 and d < 64:
            d += 1
            p = int(h[p][3])
        out.append(d)
    return out


# --------------------------------------------------------------------------
# 可选依赖：只在这里探测，import 时不碰
# --------------------------------------------------------------------------

def _load_cv():
    try:
        import cv2  # noqa: PLC0415
        import numpy as np  # noqa: PLC0415

        return cv2, np, ""
    except Exception as exc:  # pragma: no cover - 取决于本机环境
        return None, None, f"没装 OpenCV（{exc.__class__.__name__}）"


def _rapidocr_ok() -> tuple[bool, str]:
    """探测 rapidocr，**连推理后端一起探**。

    rapidocr 3.x 把 onnxruntime 拆成了可选依赖（不在 Requires 里）：
    只 `pip install rapidocr` 的话 `RapidOCR()` 一初始化就抛 ImportError。
    以前这会一路走到「本机没装 OCR」这个**不准确的**结论 —— 用户明明装了，
    照着提示再装一遍还是不行。所以这里分两步问，缺什么说什么。
    """
    try:
        import rapidocr  # noqa: F401, PLC0415
    except Exception:
        return False, "没装 rapidocr"
    try:
        import onnxruntime  # noqa: F401, PLC0415
    except Exception:
        return False, "装了 rapidocr，但缺推理后端 onnxruntime（3.x 把它拆成了单独的包）"
    return True, ""


def _paddleocr_ok() -> tuple[bool, str]:
    """探测 PaddleOCR。它自带模型下载，所以「装了」不一定「能跑」——
    这里只探包在不在，真跑不动由 _texts() 的异常兜底（不影响区域结果）。"""
    try:
        import paddleocr  # noqa: F401, PLC0415
    except Exception:
        return False, "没装 paddleocr"
    try:
        import paddle  # noqa: F401, PLC0415
    except Exception:
        return False, "装了 paddleocr，但缺推理框架 paddlepaddle（两个都要装）"
    return True, ""


def _easyocr_ok() -> tuple[bool, str]:
    """探测 EasyOCR。它依赖 PyTorch，缺了 torch 会在 Reader 初始化时炸。"""
    try:
        import easyocr  # noqa: F401, PLC0415
    except Exception:
        return False, "没装 easyocr"
    try:
        import torch  # noqa: F401, PLC0415
    except Exception:
        return False, "装了 easyocr，但缺推理框架 torch（它体积很大，约 2GB）"
    return True, ""


def ocr_backend(prefer: str = "auto") -> tuple[str, str]:
    """探测可用的 OCR 后端。返回 (后端名, 不可用原因)。

    按「装得上、体积小、协议干净、中文够用」排序（用户 2026-10-03 追加了
    paddleocr / easyocr 两个大体积候选，但**默认排序不变** —— auto 仍然
    优先挑轻的那个，装了 2GB 的 torch 不代表就该用它）：
    - `rapidocr`：PP-OCR 的 ONNX 版，Apache-2.0，中文好，约 75MB，不带 torch/paddle
    - `tesseract`：Apache-2.0，但要另装系统程序与中文语言包
    - `paddleocr`：Apache-2.0，中文精度略好，但 1GB 起步
    - `easyocr`：Apache-2.0，最省心，但拖一整套 PyTorch（2GB 起步）
    - 都没有 → 只出区域，不出文字
    """
    if prefer == "none":
        return "none", ""

    probed: list[tuple[str, callable]] = [
        ("rapidocr", _rapidocr_ok),
        ("paddleocr", _paddleocr_ok),
        ("easyocr", _easyocr_ok),
    ]

    if prefer != "auto":
        # 指名要哪个就只试哪个，失败时说清楚缺什么、怎么装
        for name, probe in probed:
            if name == prefer:
                ok, why = probe()
                if ok:
                    return name, ""
                return "none", f"指定用 {name}，但{why}"
        if prefer == "tesseract":
            try:
                import shutil  # noqa: PLC0415

                if shutil.which("tesseract"):
                    return "tesseract", ""
            except Exception:
                pass
            return "none", "指定用 tesseract，但系统里找不到 tesseract 程序"
        return "none", f"不认识的 OCR 后端「{prefer}」"

    # auto：按轻到重挑第一个能用的
    for name, probe in probed:
        ok, _why = probe()
        if ok:
            return name, ""
    try:
        import shutil  # noqa: PLC0415

        if shutil.which("tesseract"):
            return "tesseract", ""
    except Exception:
        pass
    return "none", "本机没装 OCR —— 这次只出区域轮廓，认不出图上的字"


#: OCR 后端 id → 人话（界面的下拉也照这个列）
OCR_BACKENDS = ("auto", "rapidocr", "tesseract", "paddleocr", "easyocr", "none")


# --------------------------------------------------------------------------
# 引擎
# --------------------------------------------------------------------------


class LocalEngine:
    id = "local"
    label = "本地识别（OpenCV + OCR）"
    sends_image_offsite = False

    def availability(self) -> tuple[bool, str]:
        cv2, _np, why = _load_cv()
        if cv2 is None:
            return False, f"{why}。装上就能用：pip install opencv-python-headless numpy"
        return True, ""

    def analyze(self, image: bytes, opts: VisionOptions, *, book_id: str = "") -> VisionResult:
        cv2, np, why = _load_cv()
        if cv2 is None:
            raise VisionError("unavailable", why)

        started = time.monotonic()
        notes: list[str] = []

        arr = np.frombuffer(image, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            raise VisionError("bad_image", "这张图解不开 —— 可能不是图片，或者文件坏了")

        h0, w0 = img.shape[:2]
        if h0 <= 0 or w0 <= 0:
            raise VisionError("bad_image", "图片尺寸是 0")
        # 小于 16 像素的图没有任何可识别的内容（以前会一路跑到 OpenCV
        # 内部再炸出来，日志里只剩一句 cv2.error，人看不懂）
        if min(h0, w0) < 16:
            raise VisionError(
                "bad_image",
                f"这张图只有 {w0}×{h0} 像素，太小了 —— 至少要有 16 像素宽才能识别",
            )

        # 缩到能跑得动的尺度
        scale = min(1.0, WORK_MAX_SIDE / max(h0, w0))
        if scale < 1.0:
            img = cv2.resize(
                img, (max(1, int(w0 * scale)), max(1, int(h0 * scale))),
                interpolation=cv2.INTER_AREA,
            )
            notes.append(f"底图已缩到 {int(w0 * scale)}×{int(h0 * scale)} 再识别（结果坐标是相对的，换分辨率不用重摆）")

        h, w = img.shape[:2]
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        regions: list[RegionCandidate] = []
        texts: list[TextCandidate] = []
        # OpenCV 对畸形输入（半截文件、异常通道数、超大尺寸）会直接抛
        # cv2.error。那是「这张图处理不了」，不是「服务器坏了」——
        # 翻译成人话再往上走，否则界面只会看到 500。
        try:
            if opts.detect_regions:
                regions = self._regions(cv2, np, gray, w, h, opts, notes)
            if opts.detect_text:
                texts = self._texts(cv2, img, w, h, opts, notes)
        except cv2.error as exc:
            raise VisionError(
                "bad_image",
                f"这张图处理不了（{exc.__class__.__name__}）—— 可能是格式怪或尺寸极端",
            ) from exc

        return VisionResult(
            engine=self.id,
            regions=regions,
            texts=texts,
            width=w,
            height=h,
            elapsed_ms=int((time.monotonic() - started) * 1000),
            notes=notes,
        )

    # ---- 区域 ----------------------------------------------------------

    def _regions(self, cv2, np, gray, w: int, h: int, opts: VisionOptions,
                 notes: list[str]) -> list[RegionCandidate]:
        if opts.blur >= 3:
            k = opts.blur if opts.blur % 2 == 1 else opts.blur + 1
            gray = cv2.bilateralFilter(gray, k, 60, 60)

        # 自适应阈值：手绘纸的明暗不均匀，全局阈值会把一边整片糊成黑
        block = max(11, (min(w, h) // 20) | 1)
        binary = cv2.adaptiveThreshold(
            gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, block, 8
        )
        # 闭运算把描线的断口连上（铅笔线常有断）
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        ink = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)

        # **要找的是「线围出来的那块地」，不是线条本身。**
        # 这一步搞反（早先就是反的），候选会全是描边的碎圈 —— 一根线出外沿、
        # 内沿、线身三块轮廓，人得自己拼回去，功能等于废掉。
        # 所以取反，在**空白**上找连通块。
        blank = cv2.bitwise_not(ink)

        contours, hierarchy = cv2.findContours(blank, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
        depths = _depths(hierarchy)
        total = float(w * h)
        found: list[tuple[float, list]] = []
        for i, c in enumerate(contours):
            # 奇数深度 = 「洞」。**必须靠层级分辨，不能靠面积**：
            # 线条外沿（背景块身上的洞）和真正的空白块大小几乎一样，
            # 面积、外接框、IoU 全分不开 —— 早先就是在这里把一根线认成两块地的。
            if depths[i] % 2:
                continue
            area = float(cv2.contourArea(c))
            if area < opts.min_region_area * total:
                continue
            x, y, cw, ch = cv2.boundingRect(c)
            # 贴着画布边的空白是「画面外面那片」，不是区域 ——
            # 没封闭的留白本来也不该算数，这条正好把它们一起筛掉。
            if x <= 1 or y <= 1 or x + cw >= w - 1 or y + ch >= h - 1:
                continue
            found.append((area, c))

        found.sort(key=lambda t: -t[0])

        # 同一根线会给出好几块轮廓：描线的外沿、内沿、还有线本身。
        # 不去重的话「画了两个方框」会冒出六块候选，人得自己一块块认，
        # 这个功能也就废了。按外接框交并比去重，面积大的先留下。
        # 阈值取 0.9（保守）：大陆里嵌个国家这种**真嵌套**的 IoU 通常远低于此，
        # 不会误杀。
        deduped: list[tuple[float, list]] = []
        boxes: list[tuple[float, float, float, float]] = []
        for area, c in found:
            bx, by, bw, bh = cv2.boundingRect(c)
            box = (float(bx), float(by), float(bx + bw), float(by + bh))
            if any(_iou(box, b) > 0.9 for b in boxes):
                continue
            boxes.append(box)
            deduped.append((area, c))
        if len(deduped) < len(found):
            notes.append(
                f"合并了 {len(found) - len(deduped)} 块重复轮廓（同一根线会画出好几层）"
            )
        found = deduped

        if len(found) > opts.max_regions:
            notes.append(f"面积最大的前 {opts.max_regions} 块（共找到 {len(found)} 块）")
            found = found[: opts.max_regions]

        # 简化强度跟着图的大小走，不然大图上 epsilon 太小、小图上太大
        eps = max(1.0, opts.simplify * min(w, h) * 0.5)
        out: list[RegionCandidate] = []
        for area, c in found:
            approx = cv2.approxPolyDP(c, eps, True)
            pts = [tuple(p[0]) for p in approx]
            if len(pts) < 3:
                # 简化狠了会把小三角形压成一条线 —— 退回原始轮廓抽稀
                pts = [tuple(p[0]) for p in c[:: max(1, len(c) // MAX_POINTS)]]
            if len(pts) < 3:
                continue
            if len(pts) > MAX_POINTS:
                step = len(pts) / MAX_POINTS
                pts = [pts[int(i * step)] for i in range(MAX_POINTS)]
            out.append(
                RegionCandidate(
                    points=[(to_unit(px, w), to_unit(py, h)) for px, py in pts],
                    confidence=0.0,
                    source=self.id,
                )
            )

        if not out:
            notes.append("没找到闭合区域 —— 线条可能太淡、太断，或者这块本来就没画边界")
        else:
            notes.append("区域是「线条围出来的轮廓」，没有语义 —— 哪块是海、哪块是国界，得你点")
        return out

    # ---- 文字 ----------------------------------------------------------

    def _texts(self, cv2, img, w: int, h: int, opts: VisionOptions,
               notes: list[str]) -> list[TextCandidate]:
        backend, why = ocr_backend(opts.ocr)
        if backend == "none":
            if why:
                notes.append(why)
            return []
        try:
            handler = {
                "rapidocr": self._texts_rapidocr,
                "tesseract": self._texts_tesseract,
                "paddleocr": self._texts_paddleocr,
                "easyocr": self._texts_easyocr,
            }.get(backend)
            if handler is None:
                notes.append(f"没有对应的 OCR 实现：{backend}")
                return []
            return handler(cv2, img, w, h, opts, notes)
        except Exception as exc:
            notes.append(f"OCR（{backend}）这次没认出字：{exc.__class__.__name__} —— 不影响区域结果")
            return []

    def _texts_rapidocr(self, cv2, img, w, h, opts, notes) -> list[TextCandidate]:
        engine = _rapidocr_singleton()
        result = engine(img)
        boxes, txts, scores = _rapidocr_unpack(result)
        out: list[TextCandidate] = []
        for box, text, score in zip(boxes, txts, scores):
            text = (text or "").strip()
            if not text:
                continue
            xs = [float(p[0]) for p in box]
            ys = [float(p[1]) for p in box]
            x0, x1 = min(xs), max(xs)
            y0, y1 = min(ys), max(ys)
            out.append(
                TextCandidate(
                    text=text,
                    x=to_unit((x0 + x1) / 2, w),
                    y=to_unit((y0 + y1) / 2, h),
                    confidence=float(score or 0),
                    source="rapidocr",
                    box=(to_unit(x0, w), to_unit(y0, h),
                         to_unit(x1 - x0, w), to_unit(y1 - y0, h)),
                )
            )
            if len(out) >= opts.max_texts:
                break
        if not out:
            notes.append("OCR 跑通了但没认出字 —— 手写体认不出是常事，别指望它")
        return out

    def _texts_tesseract(self, cv2, img, w, h, opts, notes) -> list[TextCandidate]:
        import pytesseract  # noqa: PLC0415

        data = pytesseract.image_to_data(
            img, lang="chi_sim+eng", output_type=pytesseract.Output.DICT
        )
        out: list[TextCandidate] = []
        for i, text in enumerate(data.get("text", [])):
            text = (text or "").strip()
            if not text:
                continue
            try:
                conf = float(data["conf"][i])
            except (TypeError, ValueError, KeyError):
                conf = 0.0
            if conf < 30:  # tesseract 的低分项基本都是噪点
                continue
            x, y, bw, bh = (data["left"][i], data["top"][i], data["width"][i], data["height"][i])
            out.append(
                TextCandidate(
                    text=text,
                    x=to_unit(x + bw / 2, w),
                    y=to_unit(y + bh / 2, h),
                    confidence=conf / 100.0,
                    source="tesseract",
                    box=(to_unit(x, w), to_unit(y, h), to_unit(bw, w), to_unit(bh, h)),
                )
            )
            if len(out) >= opts.max_texts:
                break
        if not out:
            notes.append("Tesseract 没认出字 —— 中文手写体它本来就不擅长")
        return out

    def _texts_paddleocr(self, cv2, img, w, h, opts, notes) -> list[TextCandidate]:
        """PaddleOCR。**未在本机实测**（体积 1GB 起步，作者没装）——
        所以整套逻辑套在 try 里，跑不动就只出区域、并说明原因。"""
        engine = _paddleocr_singleton()
        raw = _paddleocr_run(engine, img)
        out: list[TextCandidate] = []
        for poly, text, score in _paddleocr_unpack(raw):
            text = (text or "").strip()
            if not text:
                continue
            try:
                xs = [float(p[0]) for p in poly]
                ys = [float(p[1]) for p in poly]
            except Exception:
                continue
            x0, x1 = min(xs), max(xs)
            y0, y1 = min(ys), max(ys)
            out.append(
                TextCandidate(
                    text=text,
                    x=to_unit((x0 + x1) / 2, w),
                    y=to_unit((y0 + y1) / 2, h),
                    confidence=float(score or 0),
                    source="paddleocr",
                    box=(to_unit(x0, w), to_unit(y0, h),
                         to_unit(x1 - x0, w), to_unit(y1 - y0, h)),
                )
            )
            if len(out) >= opts.max_texts:
                break
        if not out:
            notes.append("PaddleOCR 跑通了但没认出字 —— 第一次用要下模型，也可能还在下载中")
        return out

    def _texts_easyocr(self, cv2, img, w, h, opts, notes) -> list[TextCandidate]:
        """EasyOCR。**未在本机实测**（拖一整套 PyTorch，作者没装）。
        首次调用会联网下载识别模型（约 100MB），会卡一会儿，属正常。"""
        reader = _easyocr_singleton()
        raw = reader.readtext(img)
        out: list[TextCandidate] = []
        for item in raw or []:
            try:
                poly, text, score = item[0], item[1], item[2]
            except (IndexError, TypeError):
                continue
            text = str(text or "").strip()
            if not text:
                continue
            try:
                xs = [float(p[0]) for p in poly]
                ys = [float(p[1]) for p in poly]
            except Exception:
                continue
            x0, x1 = min(xs), max(xs)
            y0, y1 = min(ys), max(ys)
            out.append(
                TextCandidate(
                    text=text,
                    x=to_unit((x0 + x1) / 2, w),
                    y=to_unit((y0 + y1) / 2, h),
                    confidence=float(score or 0),
                    source="easyocr",
                    box=(to_unit(x0, w), to_unit(y0, h),
                         to_unit(x1 - x0, w), to_unit(y1 - y0, h)),
                )
            )
            if len(out) >= opts.max_texts:
                break
        if not out:
            notes.append("EasyOCR 跑通了但没认出字 —— 第一次用要下模型，也可能还在下载中")
        return out


#: OCR 模型加载一次要一两秒，进程内复用
_RAPIDOCR = None

def _rapidocr_singleton():
    global _RAPIDOCR
    if _RAPIDOCR is None:
        from rapidocr import RapidOCR  # noqa: PLC0415

        _RAPIDOCR = RapidOCR()
    return _RAPIDOCR


#: PaddleOCR / EasyOCR 的模型加载比 rapidocr 更重（秒级到十几秒），必须复用
_PADDLEOCR = None
_EASYOCR = None


def _paddleocr_singleton():
    global _PADDLEOCR
    if _PADDLEOCR is None:
        from paddleocr import PaddleOCR  # noqa: PLC0415

        # 2.x / 3.x 的构造参数名改过，宁可少给参数也别让它抛 TypeError
        try:
            _PADDLEOCR = PaddleOCR(lang="ch")
        except TypeError:
            _PADDLEOCR = PaddleOCR()
    return _PADDLEOCR


def _easyocr_singleton():
    global _EASYOCR
    if _EASYOCR is None:
        import easyocr  # noqa: PLC0415

        # gpu=False：不给没装 CUDA 的机器添麻烦。首次调用会联网下模型（约 100MB）
        _EASYOCR = easyocr.Reader(["ch_sim", "en"], gpu=False, verbose=False)
    return _EASYOCR


def _paddleocr_run(engine, img):
    """3.x 用 predict，2.x 用 ocr —— 升个版本不该让识别整个哑掉。"""
    if hasattr(engine, "predict"):
        return engine.predict(img)
    return engine.ocr(img)


def _paddle_attrs(item):
    """从 3.x 的 OCRResult 里取 (rec_polys, rec_texts, rec_scores)。

    取不到（是 2.x 的嵌套 list）就返回 None，交给调用方走老结构。
    OCRResult 同时支持 `item['rec_texts']` 与 `.rec_texts`，两种都试一遍。
    """

    def pick(key):
        try:
            v = item[key]
            if v is not None:
                return v
        except Exception:
            pass
        return getattr(item, key, None)

    texts = pick("rec_texts")
    if texts is None:
        return None
    polys = pick("rec_polys")
    if polys is None:
        polys = pick("dt_polys")
    scores = pick("rec_scores")
    try:
        n = len(texts)
    except TypeError:
        return None
    if polys is None or len(polys) != n:
        return None
    if scores is None or len(scores) != n:
        scores = [0.0] * n
    return polys, texts, scores


def _paddleocr_unpack(raw) -> list[tuple[object, str, float]]:
    """把 PaddleOCR 的返回值统一拆成 [(poly, text, score)]。

    2.x 返回 `[[ [box, (text, score)], ... ]]`，3.x 换成了 OCRResult 对象。
    两代结构完全不同，这里做一次兼容 —— 用户装的版本不由我们决定。
    """
    out: list[tuple[object, str, float]] = []
    if raw is None:
        return out
    seq = raw if isinstance(raw, (list, tuple)) else [raw]
    for item in seq:
        got = _paddle_attrs(item)
        if got is not None:
            polys, texts, scores = got
            for poly, t, sc in zip(polys, texts, scores):
                try:
                    out.append((poly, str(t), float(sc)))
                except (TypeError, ValueError):
                    out.append((poly, str(t), 0.0))
            continue
        # 2.x 结构
        if isinstance(item, (list, tuple)):
            for line in item:
                try:
                    poly = line[0]
                    payload = line[1]
                    text, score = payload[0], payload[1]
                except (IndexError, TypeError):
                    continue
                try:
                    out.append((poly, str(text), float(score or 0)))
                except (TypeError, ValueError):
                    out.append((poly, str(text), 0.0))
    return out


def _rapidocr_unpack(result):
    """把 rapidocr 的返回值拆成 (boxes, texts, scores)。

    rapidocr 各版本返回形状不一样（有的给对象、有的给 tuple），
    这里做一次兼容 —— 升级包不该让识别整个哑掉。
    """
    for attr in ("boxes", "txts", "scores"):
        if hasattr(result, attr):
            boxes = getattr(result, "boxes")
            txts = getattr(result, "txts")
            scores = getattr(result, "scores")
            return (list(boxes) if boxes is not None else [],
                    list(txts) if txts is not None else [],
                    list(scores) if scores is not None else [])
    if isinstance(result, tuple):
        if len(result) >= 3:
            boxes, txts, scores = result[0], result[1], result[2]
        elif len(result) == 2:
            boxes, txts = result
            scores = [0.0] * len(txts or [])
        else:
            return [], [], []
        if boxes is None:
            return [], [], []
        return list(boxes), list(txts or []), list(scores or [])
    return [], [], []
