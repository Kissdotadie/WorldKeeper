"""识别接口（P4.5.3）：把底图跑成「候选区域 + 候选文字」。

**这个模块永不写入知识库。** 所有产出都是候选，落到 `view/maps/` 的那一步
仍然是前端把用户勾选的结果并进地图文档、走 `PUT /maps`（P4.5.2 那条老路）。
理由和 AI 抽取一样：机器猜的东西没经过人眼就不是知识库。

**为什么要有缓存**：识别是「幂等且不便宜」的活 —— 云端一次几毛钱，本地一次
要好几秒。同一张底图、同一套参数重跑一遍没有任何新信息。缓存键 =
**底图内容 hash + 引擎 id + 参数指纹**，三者任一变了就自动重算。

**缓存里没有用户数据**：只有候选坐标与文字，删掉整个 `data/vision/cache/`
不影响任何已确认的东西（和「索引可抛弃」同一条精神）。
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel, Field

from .. import paths
from ..logging_setup import get_logger
from ..vision import catalog as vcatalog
from ..vision import config as vconfig
from ..vision import registry
from ..vision.base import VisionError, VisionOptions
from ._common import check_book_id as _check_book_id
from . import maps as maps_mod

log = get_logger(__name__)
router = APIRouter(tags=["vision"])

#: 单张底图体积上限。手绘扫描件 4000×4000 的 PNG 约 10MB，16MB 很宽裕。
MAX_IMAGE_BYTES = 16 * 1024 * 1024

#: 缓存文件数上限。一张底图 × 几套参数，200 份足够；超了按最旧的删。
CACHE_MAX_FILES = 200

#: VisionError.kind → HTTP 状态。前端按状态给不同提示。
_STATUS = {
    "bad_image": 400,
    "unavailable": 409,
    "rate_limit": 429,
    "auth": 502,
    "network": 502,
    "server": 502,
    "bad_response": 502,
}

#: 素材相对路径：`maps/xxx.png`。集合在 paths.ASSET_KINDS 里定，这里只管形状。
_REF_OK = re.compile(r"^[A-Za-z0-9_\-]+(/[^/\\:*?\"<>|]+)+$")


# --------------------------------------------------------------------------
# 底图定位
# --------------------------------------------------------------------------


def _resolve_ref(ref: str) -> Path:
    """素材相对路径 → 磁盘路径。三道检查：形状、种类、越界。"""
    raw = (ref or "").strip().replace("\\", "/")
    if not raw:
        raise HTTPException(status_code=400, detail="没指定底图")
    if raw.startswith("http://") or raw.startswith("https://") or raw.startswith("data:"):
        raise HTTPException(
            status_code=400,
            detail="底图是外链，识别读不到它 —— 先把图上传到素材库再识别",
        )
    if not _REF_OK.match(raw) or ".." in raw.split("/"):
        raise HTTPException(status_code=400, detail=f"底图路径不合法：{ref}")

    parts = [p for p in raw.split("/") if p]
    kind = parts[0]
    if kind not in paths.ASSET_KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"底图要放在素材目录里的一类下（{'、'.join(paths.ASSET_KINDS)}），收到的是「{kind}」",
        )

    root = paths.assets_dir().resolve()
    target = (root / Path(*parts)).resolve()
    if target != root and root not in target.parents:
        raise HTTPException(status_code=400, detail="底图路径越界")
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"找不到底图：{ref}")
    return target


def _read_image(p: Path) -> bytes:
    size = p.stat().st_size
    if size <= 0:
        raise HTTPException(status_code=400, detail=f"底图是空文件：{p.name}")
    if size > MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"底图 {size / 1024 / 1024:.1f}MB，超过 {MAX_IMAGE_BYTES // 1024 // 1024}MB 上限 —— 先压一下再传",
        )
    try:
        return p.read_bytes()
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"底图读不出来：{exc.strerror or exc}") from exc


def _ref_of(book_id: str, payload: "VisionAnalyzeIn") -> str:
    """这次要识别哪张图。给了 map_id 就去地图目录里查它的底图。"""
    if payload.image.strip():
        return payload.image.strip()
    mid = payload.map_id.strip()
    if not mid:
        raise HTTPException(status_code=400, detail="要么给 image（素材相对路径），要么给 map_id")
    ref = maps_mod.map_image_ref(book_id, mid)
    if not ref:
        raise HTTPException(status_code=404, detail="这张地图还没设底图，或者地图不存在")
    return ref


# --------------------------------------------------------------------------
# 缓存
# --------------------------------------------------------------------------


def _opts_fingerprint(opts: VisionOptions) -> str:
    body = json.dumps(
        {k: getattr(opts, k) for k in registry.OVERRIDE_KEYS}, sort_keys=True, ensure_ascii=False
    )
    return hashlib.sha1(body.encode("utf-8")).hexdigest()[:10]


def _cache_key(image_sha: str, engine_id: str, opts: VisionOptions) -> str:
    return f"{image_sha[:20]}-{engine_id}-{_opts_fingerprint(opts)}"


def _cache_path(key: str) -> Path:
    return paths.vision_cache_dir() / f"{key}.json"


def _cache_get(key: str) -> dict | None:
    p = _cache_path(key)
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict) or data.get("key") != key:
        return None
    result = data.get("result")
    return result if isinstance(result, dict) else None


def _cache_put(key: str, result: dict) -> None:
    p = _cache_path(key)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(
            {
                "_comment": "识别结果缓存。可随时整目录删除 —— 删了只会重算，不影响任何已确认的数据。",
                "key": key,
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "result": result,
            },
            ensure_ascii=False,
            indent=1,
        )
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(payload, encoding="utf-8")
        tmp.replace(p)
    except OSError as exc:
        # 缓存写不进去不该让识别失败 —— 用户的目的是拿到候选，不是缓存
        log.warning("识别缓存写不进去：%s", exc)
        return
    _prune_cache()


def _prune_cache() -> None:
    d = paths.vision_cache_dir()
    if not d.is_dir():
        return
    files = [f for f in d.iterdir() if f.is_file() and f.suffix == ".json"]
    if len(files) <= CACHE_MAX_FILES:
        return
    files.sort(key=lambda f: f.stat().st_mtime)
    for f in files[: len(files) - CACHE_MAX_FILES]:
        try:
            f.unlink()
        except OSError:
            pass


# --------------------------------------------------------------------------
# 配置
# --------------------------------------------------------------------------


def _catalog() -> dict:
    """识别引擎目录（去哪下载 / 怎么装 / 什么许可）。

    路径按运行形态分流，不然给出的命令会指错地方：
      打包运行 → 用的是程序目录里的嵌入式 Python（`runtime\\python.exe`）
      源码运行 → 用的是项目里的 `.venv\\Scripts\\python.exe`
    用户抄命令要能一次抄对，这里就不能含糊。
    """
    try:
        frozen = paths.is_frozen()
        root = paths.program_dir()
        return vcatalog.catalog(
            program_dir=str(root) if frozen else "",
            venv_python="" if frozen else str(root / ".venv" / "Scripts" / "python.exe"),
        )
    except Exception as exc:  # 目录读不出来也不该让整页打不开
        log.warning("识别引擎目录生成失败：%s", exc)
        return vcatalog.catalog()


@router.get("/vision/config")
def api_vision_config() -> dict:
    """识别设置。**全局一份，不分书** —— 有没有 OCR 是机器级事实。"""
    report = registry.engines_report()
    pub = vconfig.public_config()
    return {
        **report,
        "local": pub.get("local", {}),
        "cloud": pub.get("cloud", {}),
        "catalog": _catalog(),
        "limits": {
            "max_image_bytes": MAX_IMAGE_BYTES,
            "cache_max_files": CACHE_MAX_FILES,
        },
        "where": {
            "config": str(paths.vision_config_file()),
            "cache": str(paths.vision_cache_dir()),
        },
        "note": "改参数不用改代码；某张图不满意，换个参数重跑一次就行。",
    }


@router.get("/vision/catalog")
def api_vision_catalog() -> dict:
    """单独取引擎目录。识别面板里「去哪下载」那一节用它。"""
    return _catalog()


@router.put("/vision/config")
def api_vision_config_put(patch: dict = Body(...)) -> dict:
    """保存识别设置。只认白名单里的键，其余原样留着（向前兼容）。"""
    cfg = vconfig.save_config(patch if isinstance(patch, dict) else {})
    return {"saved": True, "config": {"engine": cfg.get("engine"),
                                      "local": cfg.get("local"), "cloud": cfg.get("cloud")}}


@router.get("/vision/engines")
def api_vision_engines() -> dict:
    """三个选项的可用性。界面开面板时刷新一次。"""
    return registry.engines_report()


@router.delete("/vision/cache")
def api_vision_cache_clear() -> dict:
    """清空识别缓存。删了只会重算，不影响任何数据。"""
    d = paths.vision_cache_dir()
    removed = 0
    if d.is_dir():
        for f in d.iterdir():
            if f.is_file():
                try:
                    f.unlink()
                    removed += 1
                except OSError:
                    pass
    return {"cleared": True, "removed": removed}


# --------------------------------------------------------------------------
# 识别
# --------------------------------------------------------------------------


class VisionAnalyzeIn(BaseModel):
    #: 素材相对路径，如 `maps/gray-castle.png`
    image: str = ""
    #: 或者给地图 id，后端自己去查它的底图
    map_id: str = ""
    #: 留空 = 用配置里选的那个引擎
    engine: str = ""
    #: 这次的临时参数（不落盘）
    options: dict = Field(default_factory=dict)
    #: 跳过缓存，强制重跑
    refresh: bool = False


@router.post("/books/{book_id}/vision/analyze")
def api_vision_analyze(book_id: str, payload: VisionAnalyzeIn) -> dict:
    """跑一次识别。**只出候选，不写任何知识库文件。**

    产出怎么用：前端把它和手圈的区域汇成同一份「待确认清单」，
    人勾完了再通过 `PUT /maps` 落盘。
    """
    _check_book_id(book_id)
    ref = _ref_of(book_id, payload)
    path = _resolve_ref(ref)
    image = _read_image(path)

    image_sha = hashlib.sha256(image).hexdigest()
    cfg = vconfig.load_config()
    want = (payload.engine or cfg.get("engine") or "auto").strip()
    overrides = payload.options if isinstance(payload.options, dict) else {}

    # 缓存键要含真正用到的引擎与参数，所以先解析一次引擎（便宜：只是探可用性）
    try:
        engine, _notes = registry.resolve_engine(want, cfg)
    except VisionError as exc:
        raise HTTPException(
            status_code=_STATUS.get(exc.kind, 500), detail=str(exc)
        ) from exc

    opts = registry.options_for(engine.id, cfg, overrides)
    key = _cache_key(image_sha, engine.id, opts)

    if not payload.refresh:
        hit = _cache_get(key)
        if hit is not None:
            return {
                "book_id": book_id,
                "image": {"ref": ref, "bytes": len(image), "sha256": image_sha[:16]},
                "requested_engine": want,
                "engine": hit.get("engine") or engine.id,
                "engine_label": hit.get("engine_label") or engine.label,
                "sends_image_offsite": bool(hit.get("sends_image_offsite")),
                "cached": True,
                "result": hit,
                "notes": ["这次是上次的结果（同一张图、同一套参数），没有重跑 —— 要重算点「重跑」"],
            }

    try:
        result = registry.analyze_image(book_id, image, engine_id=want, overrides=overrides)
    except VisionError as exc:
        log.info("识别失败 kind=%s：%s", exc.kind, exc)
        raise HTTPException(
            status_code=_STATUS.get(exc.kind, 500), detail=str(exc)
        ) from exc

    body = result.to_dict()
    _cache_put(key, body)

    return {
        "book_id": book_id,
        "image": {"ref": ref, "bytes": len(image), "sha256": image_sha[:16]},
        "requested_engine": want,
        "engine": result.engine,
        "engine_label": result.engine_label,
        "sends_image_offsite": result.sends_image_offsite,
        "cached": False,
        "result": body,
        "notes": list(result.notes),
    }
