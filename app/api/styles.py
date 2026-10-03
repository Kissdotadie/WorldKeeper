"""可视化样式包（P5）—— 「一键变换样式」的那套东西。

存哪：`books/<书>/view/styles/`
- `index.json`       有哪些包、当前用哪个
- `<pack_id>.json`   单个样式包的内容（改一个只重写这一个文件）

另外两条接口管**图上的装饰**：
- `view/nodes.json`        单个节点的外观覆盖（形状/颜色/图片/标签/高亮）
- `view/decorations.json`  贴纸（按视图分区）

**三条铁律在这里怎么落**：
1. 全部落在 `view/` —— 装饰层，`entities/` 一个字不动。样式删光最多图变回默认长相。
2. 单节点覆盖 **永远赢** 批量规则：手动调过的节点，切样式包不会被冲掉。
   这是刻意的 —— 否则「一键变身」会变成「一键毁掉我调了半小时的那个节点」。
3. id 与 name 解耦：id 是结构标识（导出/导入认它），name 可以随便改。
"""

from __future__ import annotations

import json
import re
import secrets
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

from .. import paths
from ..styles_builtin import (
    BACKGROUNDS,
    BUILTIN_PACKS,
    DEFAULT_PACK_ID,
    EDGE_CURVES,
    LAYOUTS,
    NODE_SHAPES,
    PALETTES,
    builtin_by_id,
    pack_meta,
)
from ._common import check_book_id

router = APIRouter(tags=["styles"])

MAX_PACK_BYTES = 256 * 1024
MAX_NODES_BYTES = 4 * 1024 * 1024  # 几千个节点各一条覆盖，足够
MAX_DECOR_BYTES = 2 * 1024 * 1024

# 样式包目录（~ 缓存）的版本号。形状一变就 +1，见 read_index() 的迁移分支。
#  1 → 2：pack_meta 增加 spec（缩略预览参数，P11-1️⃣⑤）
INDEX_SCHEMA = 2

_BAD_ID = re.compile(r"[^A-Za-z0-9._-]")
MAX_NAME = 40


def safe_pack_id(raw: str) -> str:
    """样式包 id。只收 ASCII 安全字符 —— 它同时是文件名，中文名留给 `name`。"""
    key = (raw or "").strip()
    if not key or _BAD_ID.search(key) or len(key) > 64 or key.startswith("."):
        raise HTTPException(status_code=400, detail=f"样式包 id 不合法：{raw!r}")
    return key


def new_pack_id() -> str:
    """自建包的 id：`u-` 前缀 + 随机段。**不要用名字当 id** —— 改个名就断链。"""
    return f"u-{secrets.token_hex(4)}"


def clean_name(raw: object, fallback: str = "未命名样式") -> str:
    name = str(raw or "").strip()
    return name[:MAX_NAME] if name else fallback


# --------------------------------------------------------------------------
# 校验：客户端传上来的一切都不能信
# --------------------------------------------------------------------------


def _one_of(value: object, allowed: tuple[str, ...], default: str) -> str:
    return value if isinstance(value, str) and value in allowed else default


def _num(value: object, lo: float, hi: float, default: float) -> float:
    try:
        n = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    if n != n:  # NaN
        return default
    return max(lo, min(hi, n))


def _color(value: object) -> str:
    """颜色只收 `#rgb` / `#rrggbb` / `#rrggbbaa`。

    为什么不收 `var(--x)`：样式包要能导出给别人，别人那份主题里未必有同名变量，
    导过去就变成透明。色板走 palette id，具体色值走十六进制。
    """
    s = str(value or "").strip()
    if re.fullmatch(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})", s):
        return s.lower()
    return ""


def clean_style(raw: object) -> dict:
    """规则里那份「改哪儿」的小对象。不认识的字段直接丢。"""
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    if "shape" in raw:
        shape = _one_of(raw.get("shape"), NODE_SHAPES, "")
        if shape:
            out["shape"] = shape
    for key in ("fill", "stroke"):
        if key in raw:
            c = _color(raw.get(key))
            if c:
                out[key] = c
    if "highlight" in raw:
        out["highlight"] = bool(raw.get("highlight"))
    if "sizeScale" in raw:
        out["sizeScale"] = _num(raw.get("sizeScale"), 0.3, 4.0, 1.0)
    return out


def clean_rules(raw: object) -> list[dict]:
    """批量规则。最多留 200 条 —— 再多说明用法不对，不是数据大。"""
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for it in raw[:200]:
        if not isinstance(it, dict):
            continue
        m = it.get("match")
        if not isinstance(m, dict):
            continue
        by = m.get("by")
        if by not in ("type", "tag"):
            continue
        value = str(m.get("value") or "").strip()
        if not value:
            continue
        style = clean_style(it.get("style"))
        if not style:
            continue
        out.append({"match": {"by": by, "value": value[:48]}, "style": style})
    return out


def clean_graph(raw: object) -> dict:
    src = raw if isinstance(raw, dict) else {}
    edge = src.get("edge") if isinstance(src.get("edge"), dict) else {}
    label = src.get("label") if isinstance(src.get("label"), dict) else {}
    return {
        "layout": _one_of(src.get("layout"), LAYOUTS, "force"),
        "shape": _one_of(src.get("shape"), NODE_SHAPES, "auto"),
        "palette": _one_of(src.get("palette"), PALETTES, "type"),
        "sizeScale": _num(src.get("sizeScale"), 0.3, 4.0, 1.0),
        "edge": {
            "curve": _one_of(edge.get("curve"), EDGE_CURVES, "straight"),
            "dashed": bool(edge.get("dashed")),
            "arrow": edge.get("arrow") is not False,
            "width": _num(edge.get("width"), 0.4, 4.0, 1.0),
        },
        "label": {
            "show": label.get("show") is not False,
            "scale": _num(label.get("scale"), 0.5, 2.5, 1.0),
        },
        "background": _one_of(src.get("background"), BACKGROUNDS, "none"),
    }


def clean_pack(raw: object, pack_id: str, *, builtin: bool = False) -> dict:
    src = raw if isinstance(raw, dict) else {}
    return {
        "schema": 1,
        "id": pack_id,
        "name": clean_name(src.get("name"), pack_id),
        "desc": str(src.get("desc") or "")[:200],
        "builtin": bool(builtin),
        # 内置包被改过就记一笔：界面要能显示「改过」，也能一键恢复出厂
        "modified": bool(src.get("modified")),
        "graph": clean_graph(src.get("graph")),
        "rules": clean_rules(src.get("rules")),
    }


# --------------------------------------------------------------------------
# 存档读写
# --------------------------------------------------------------------------


def index_file(book_id: str) -> Path:
    return paths.styles_dir(book_id) / "index.json"


def pack_file(book_id: str, pack_id: str) -> Path:
    return paths.styles_dir(book_id) / f"{pack_id}.json"


def _read_json(p: Path) -> dict | None:
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        # 单个文件坏了不该让整页打不开
        return None
    return data if isinstance(data, dict) else None


def _write_json(p: Path, data: dict) -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return p


def read_index(book_id: str) -> dict:
    """目录。**第一次打开这本书时**把内置包落盘 —— 之后用户改内置包才有地方存。

    目录是个**缓存**（包文件才是真源），所以它带了 `schema`：元信息的形状一变
    就升版，老目录在读到的时候**从包文件重建一遍**，不用用户手动删文件。
    （这正是 P0 那条「frontmatter 带 schema_version + 迁移脚本」的同一套做法。）

    - schema 1：只有 id/name/desc/builtin/modified/layout
    - schema 2：多一个 `spec`，供样式卡画缩略预览（P11-1️⃣⑤）
    """
    data = _read_json(index_file(book_id))
    if data is None:
        return seed_index(book_id)
    index = {
        "schema": INDEX_SCHEMA,
        "active": str(data.get("active") or ""),
        "packs": [p for p in (data.get("packs") or []) if isinstance(p, dict) and p.get("id")],
    }
    if not index["packs"]:
        # 目录被清空了（手删、坏档）→ 重新播种出厂包，别让界面空着
        return seed_index(book_id)
    if int(data.get("schema") or 1) < INDEX_SCHEMA:
        # 老目录：meta 是旧版形状。**只重建目录，不碰任何包文件、不碰 active** ——
        # 用户在包里改过的形状/配色原样保留，这里只是把它们的摘要重新描述一遍。
        metas = []
        for meta in index["packs"]:
            body = read_pack(book_id, meta["id"])
            metas.append(pack_meta(body) if body else meta)
        index["packs"] = sorted(metas, key=lambda p: (not p.get("builtin"), p.get("name", "")))
        _write_json(index_file(book_id), index)
    known = {p["id"] for p in index["packs"]}
    if index["active"] not in known:
        index["active"] = index["packs"][0]["id"]
    return index


def seed_index(book_id: str) -> dict:
    """把出厂包落成文件，并写好目录。幂等：已有的包文件不动（用户改过的留着）。"""
    index: dict = {"schema": INDEX_SCHEMA, "active": DEFAULT_PACK_ID, "packs": []}
    for pack in BUILTIN_PACKS:
        key = pack["id"]
        if pack_file(book_id, key).is_file():
            body = read_pack(book_id, key) or clean_pack(pack, key, builtin=True)
        else:
            body = clean_pack(pack, key, builtin=True)
            body["desc"] = pack.get("desc", "")
            _write_json(pack_file(book_id, key), body)
        index["packs"].append(pack_meta(body))
    _write_json(index_file(book_id), index)
    return index


def read_pack(book_id: str, pack_id: str) -> dict | None:
    key = safe_pack_id(pack_id)
    data = _read_json(pack_file(book_id, key))
    if data is not None:
        return clean_pack(data, key, builtin=bool(data.get("builtin")))
    # 目录里有、文件没了（或者内置包被删了文件）→ 用出厂定义兜底
    b = builtin_by_id().get(key)
    if b:
        body = clean_pack(b, key, builtin=True)
        body["desc"] = b.get("desc", "")
        return body
    return None


def active_pack(book_id: str) -> dict:
    index = read_index(book_id)
    pack = read_pack(book_id, index["active"]) if index["active"] else None
    if pack is None:
        pack = clean_pack(builtin_by_id()[DEFAULT_PACK_ID], DEFAULT_PACK_ID, builtin=True)
    return pack


# --------------------------------------------------------------------------
# 路由
# --------------------------------------------------------------------------


@router.get("/books/{book_id}/styles")
def api_styles(book_id: str) -> dict:
    """目录 + **当前生效的整包**一次给全。

    为什么要连整包一起给：前端每次开图都要按包规则算一遍节点的形状与颜色，
    分两次请求就多一次「先画默认色、再闪一下变成样式色」。
    """
    check_book_id(book_id)
    index = read_index(book_id)
    return {
        "book_id": book_id,
        "active": index["active"],
        "packs": index["packs"],
        "active_pack": active_pack(book_id),
        "shapes": list(NODE_SHAPES),
        "palettes": list(PALETTES),
        "layouts": list(LAYOUTS),
        "edge_curves": list(EDGE_CURVES),
        "backgrounds": list(BACKGROUNDS),
        "dir": str(paths.styles_dir(book_id)),
    }


@router.put("/books/{book_id}/styles/active")
def api_style_set_active(book_id: str, payload: dict = Body(...)) -> dict:
    """切当前样式包。整张图下次渲染就变形。

    ⚠️ 必须注册在 `GET/PUT /styles/{pack_id}` **之前**，否则 "active" 会被当成
    一个包 id 捕获。FastAPI 按定义顺序匹配（layouts.py 里同一个坑）。
    """
    check_book_id(book_id)
    key = safe_pack_id(str(payload.get("id") or ""))
    index = read_index(book_id)
    if key not in {p["id"] for p in index["packs"]} and read_pack(book_id, key) is None:
        raise HTTPException(status_code=404, detail=f"没有这个样式包：{key}")
    index["active"] = key
    _write_json(index_file(book_id), index)
    return {"active": key, "pack": active_pack(book_id)}


@router.post("/books/{book_id}/styles", status_code=201)
def api_style_create(book_id: str, payload: dict = Body(...)) -> dict:
    """新建一个样式包。传 `from` = 以某个现成的包为底改，不传就是默认长相。"""
    check_book_id(book_id)
    base = payload.get("from")
    src = read_pack(book_id, str(base)) if base else None
    pack_id = new_pack_id()
    body = clean_pack(
        {
            "name": payload.get("name") or "我的样式",
            "desc": payload.get("desc") or "",
            "graph": payload.get("graph") or (src or {}).get("graph"),
            "rules": payload.get("rules") or (src or {}).get("rules"),
        },
        pack_id,
        builtin=False,
    )
    _write_json(pack_file(book_id, pack_id), body)
    index = read_index(book_id)
    index["packs"].append(pack_meta(body))
    index["active"] = pack_id
    _write_json(index_file(book_id), index)
    return {"created": True, "pack": body, "active": pack_id}


@router.get("/books/{book_id}/styles/{pack_id}")
def api_style_get(book_id: str, pack_id: str) -> dict:
    check_book_id(book_id)
    key = safe_pack_id(pack_id)
    pack = read_pack(book_id, key)
    if pack is None:
        raise HTTPException(status_code=404, detail=f"没有这个样式包：{key}")
    return {"book_id": book_id, "pack": pack}


@router.put("/books/{book_id}/styles/{pack_id}")
def api_style_put(book_id: str, pack_id: str, payload: dict = Body(...)) -> dict:
    """保存一个样式包（同名覆盖）。"""
    check_book_id(book_id)
    key = safe_pack_id(pack_id)
    body_raw = payload.get("pack", payload)
    if len(json.dumps(body_raw, ensure_ascii=False)) > MAX_PACK_BYTES:
        raise HTTPException(status_code=400, detail="样式包数据过大")
    existing = read_pack(book_id, key)
    builtin = bool((existing or {}).get("builtin"))
    body = clean_pack(body_raw, key, builtin=builtin)
    body["modified"] = builtin  # 内置包一旦存过就算「改过」
    if not body.get("name"):
        body["name"] = (existing or {}).get("name") or key
    _write_json(pack_file(book_id, key), body)

    index = read_index(book_id)
    metas = [p for p in index["packs"] if p["id"] != key]
    metas.append(pack_meta(body))
    index["packs"] = sorted(metas, key=lambda p: (not p.get("builtin"), p.get("name", "")))
    _write_json(index_file(book_id), index)
    return {"saved": True, "pack": body, "file": str(pack_file(book_id, key))}


@router.delete("/books/{book_id}/styles/{pack_id}")
def api_style_delete(book_id: str, pack_id: str) -> dict:
    """删自建样式包；**内置包不删，恢复出厂**。

    这两种操作在用户眼里是同一件事（「这个样式我不要了」），但结果不同 ——
    所以返回里如实说清是哪一种，界面照实提示。
    """
    check_book_id(book_id)
    key = safe_pack_id(pack_id)
    existing = read_pack(book_id, key)
    if existing is None:
        raise HTTPException(status_code=404, detail=f"没有这个样式包：{key}")

    index = read_index(book_id)
    builtin = bool(existing.get("builtin"))
    factory = builtin_by_id().get(key)

    if builtin and factory:
        body = clean_pack(factory, key, builtin=True)
        body["desc"] = factory.get("desc", "")
        _write_json(pack_file(book_id, key), body)
        metas = [p for p in index["packs"] if p["id"] != key]
        metas.append(pack_meta(body))
        index["packs"] = sorted(metas, key=lambda p: (not p.get("builtin"), p.get("name", "")))
        _write_json(index_file(book_id), index)
        return {"restored": True, "id": key, "pack": body}

    pack_file(book_id, key).unlink(missing_ok=True)
    index["packs"] = [p for p in index["packs"] if p["id"] != key]
    if index["active"] == key:
        index["active"] = index["packs"][0]["id"] if index["packs"] else DEFAULT_PACK_ID
    _write_json(index_file(book_id), index)
    return {"deleted": True, "id": key, "active": index["active"]}


# --------------------------------------------------------------------------
# 单节点覆盖（view/nodes.json）
# --------------------------------------------------------------------------


def _clean_node_style(raw: object) -> dict:
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    if "shape" in raw:
        shape = _one_of(raw.get("shape"), NODE_SHAPES, "")
        if shape and shape != "auto":
            out["shape"] = shape
    for key in ("fill", "stroke"):
        if key in raw:
            c = _color(raw.get(key))
            if c:
                out[key] = c
    if "size" in raw and raw.get("size") is not None:
        out["size"] = _num(raw.get("size"), 3.0, 80.0, 0.0)
    img = str(raw.get("image") or "").strip()[:200]
    if img:
        out["image"] = img
    if "label" in raw:
        out["label"] = bool(raw.get("label"))
    if "highlight" in raw:
        out["highlight"] = bool(raw.get("highlight"))
    return out


def read_node_styles(book_id: str) -> dict:
    data = _read_json(paths.node_styles_file(book_id))
    nodes = data.get("nodes") if isinstance(data, dict) else None
    return {"schema": 1, "nodes": nodes if isinstance(nodes, dict) else {}}


@router.get("/books/{book_id}/node-styles")
def api_node_styles(book_id: str) -> dict:
    """整份单节点覆盖。**一次全给** —— 图上有几百个节点，逐个问接口不现实。"""
    check_book_id(book_id)
    data = read_node_styles(book_id)
    return {
        "book_id": book_id,
        "nodes": data["nodes"],
        "count": len(data["nodes"]),
        "file": str(paths.node_styles_file(book_id)),
    }


@router.put("/books/{book_id}/node-styles")
def api_node_styles_put(book_id: str, payload: dict = Body(...)) -> dict:
    """整体覆盖写。

    为什么不按节点开 PATCH：这份文件本身小（几百条 × 几十字节），整体重写
    换来的是「不会出现半更新状态」；而且前端要改一个节点时读到的就是全部，
    本来也没法只改一个字段还保证一致。
    """
    check_book_id(book_id)
    raw = payload.get("nodes")
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="nodes 必须是 {实体id: 样式}")
    if len(raw) > 20000:
        raise HTTPException(status_code=400, detail="节点样式条数过多（上限 20000）")
    if len(json.dumps(raw, ensure_ascii=False)) > MAX_NODES_BYTES:
        raise HTTPException(status_code=400, detail="节点样式数据过大")

    nodes: dict[str, dict] = {}
    for nid, style in raw.items():
        key = str(nid).strip()[:120]
        cleaned = _clean_node_style(style)
        # 空对象 = 恢复默认，不留空壳（否则文件会越长越肥）
        if key and cleaned:
            nodes[key] = cleaned
    p = _write_json(paths.node_styles_file(book_id), {"schema": 1, "nodes": nodes})
    return {"saved": True, "count": len(nodes), "file": str(p), "nodes": nodes}


# --------------------------------------------------------------------------
# 贴纸（view/decorations.json）
# --------------------------------------------------------------------------


def _clean_decor(raw: object) -> dict:
    if not isinstance(raw, dict):
        return {}
    out: dict = {
        "id": str(raw.get("id") or "")[:40],
        "asset": str(raw.get("asset") or "")[:200],
        "x": _num(raw.get("x"), -100000, 100000, 0.0),
        "y": _num(raw.get("y"), -100000, 100000, 0.0),
        "scale": _num(raw.get("scale"), 0.05, 12.0, 1.0),
        "rot": _num(raw.get("rot"), -360, 360, 0.0),
        "opacity": _num(raw.get("opacity"), 0.05, 1.0, 1.0),
        "z": int(_num(raw.get("z"), -999, 999, 0)),
        "locked": bool(raw.get("locked")),
        "flip": bool(raw.get("flip")),
    }
    if not out["id"] or not out["asset"]:
        return {}
    return out


def read_decorations(book_id: str) -> dict:
    data = _read_json(paths.decorations_file(book_id))
    scenes = data.get("scenes") if isinstance(data, dict) else None
    return {"schema": 1, "scenes": scenes if isinstance(scenes, dict) else {}}


@router.get("/books/{book_id}/decorations")
def api_decorations(book_id: str) -> dict:
    """整本书的贴纸，按视图分区（relation / world / geo / map:<id> …）。"""
    check_book_id(book_id)
    data = read_decorations(book_id)
    total = sum(len(v) for v in data["scenes"].values() if isinstance(v, list))
    return {
        "book_id": book_id,
        "scenes": data["scenes"],
        "count": total,
        "file": str(paths.decorations_file(book_id)),
    }


@router.put("/books/{book_id}/decorations")
def api_decorations_put(book_id: str, payload: dict = Body(...)) -> dict:
    """整体覆盖写。一个视图的贴纸一次存全 —— 拖动过程中不落盘，松手才存。"""
    check_book_id(book_id)
    raw = payload.get("scenes")
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="scenes 必须是 {视图: 贴纸数组}")
    if len(json.dumps(raw, ensure_ascii=False)) > MAX_DECOR_BYTES:
        raise HTTPException(status_code=400, detail="贴纸数据过大")

    scenes: dict[str, list[dict]] = {}
    for scene, items in raw.items():
        if not isinstance(items, list):
            continue
        cleaned = [d for d in (_clean_decor(it) for it in items[:300]) if d]
        if cleaned:
            scenes[str(scene)[:64]] = cleaned
    p = _write_json(paths.decorations_file(book_id), {"schema": 1, "scenes": scenes})
    return {"saved": True, "scenes": scenes, "file": str(p)}
