"""地图（地理观扩展，P4.5）。

**这是什么**：把「地点」实体摆到一张图上。底图是用户自己传的图片（手绘、
扫描、网图都行），图上每个点（pin）指向一个 `location` 实体 —— 于是
「灰烬之地在这个世界的哪个位置」这件事终于有了坐标。

**真源在哪**：
- 「灰烬之地是个什么地方」→ 实体 Markdown（内容）
- 「灰烬之地画在图上哪个位置」→ `view/maps/`（装饰）

两边物理隔离：删掉整间 `view/maps/` 只丢摆位，实体一个字不动；反过来亦然。
地图上的点**不新建任何关系**——想连关系还是去实体的「关联」段写 [[双链]]。

**坐标为什么是归一化的**：pin 存 0~1 的相对坐标，不存像素。换一张分辨率
更高的底图（同一张图的扫描件重传）时，所有点自动跟着走，不用重摆。

**为什么一张图一个文件**（P4.5.4 改）：早先是 `view/maps.json` 整体覆盖写。
300 张图攒到 1MB 之后，「拖一下点位」变成「重写整本书的地图」，而且一次写坏
**全部地图一起丢**。现在拆成：

    view/maps/index.json        目录：order + 每张图的标题/底图/尺寸/父图/层级标签/备注
    view/maps/index.json.bak    目录的上一版（丢了就不知道有哪些图了，值得留）
    view/maps/<map_id>.json     单张图的内容：pins + regions

于是：坏一张只坏一张；拖点位只重写那一个文件（内容哈希没变就整个跳过）；
手改某张图的文件也只影响那张图。单图文件用「临时文件 + 原子替换」落盘，
不会出现写了一半的半截文件。

**层级模型（重要，别改错）**：
- `parent` = **归属**（怎么*找到*它，目录收纳）：宇宙图 → 位面图 → 城市图 → 房间图
- `portal` = **连通**（世界观里怎么*通*）：凡界 ↔ 神界 ↔ 地狱
两件事大部分时候一致，但三界不一致 —— **凡界/神界/地狱是平级的，不是父子**。
所以 `parent` 只是收纳，不表达世界结构；世界结构靠 `portal`。
**不做多父**：多父会让面包屑变多条路径，打开图时不知道该显示哪条。

**`level` 是给人看的自由文本**（P4.5.4）：有人没有神界，有人是十八层地狱，
有人是七个平行宇宙 —— 枚举一写死，遇到不合套的小说就废了。所以它**不参与
任何逻辑**，既不决定 parent 也不决定缩进，只用于左栏显示与配色。

为什么不做成 entities 的一种：
- 地图是**视图**不是内容。同一批地点可以摆在「政治区划图」上，也可以摆在
  「地形图」上，摆法不同但不产生两个「北境」。
- 地图天然是多层的（世界 → 区域 → 城市），层与层之间还有 portal 跳转，
  这套东西塞进实体 schema 会把内容层搞脏。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

from .. import paths, store
from ._common import check_book_id

router = APIRouter(tags=["maps"])

#: 存储格式版本。1 = 单文件整体（P4.5.1）；2 = 一图一文件（P4.5.4）。
#: 老的 1 会在第一次读取时自动升级，旧文件改名留档不删。
SCHEMA_VERSION = 2

#: 单张地图的点位上限。一张手绘世界图撑死几百个地名，超过必然是出了错
MAX_PINS_PER_MAP = 800
MAX_REGIONS_PER_MAP = 400
MAX_POINTS_PER_REGION = 400

#: 一本书的地图张数上限。
#: 为什么不设小：世界观是分尺度的 —— 宇宙图 → 位面图 → 区域图 → 城市图 →
#: 建筑图 → 房间图，一层就是一张图。认真写一套设定，光城市和房间就轻松破百，
#: 60 张会在写到一半时卡住人。上限的作用只是拦住「写坏的循环」，不是省地方。
MAX_MAPS = 300

#: 单张图内容的体积上限。800 个点位 + 400 块区域约 200KB，2MB 很宽裕。
MAX_MAP_BYTES = 2 * 1024 * 1024

#: 整个请求体的上限，纯粹防异常大的请求把内存撑爆。
MAX_BODY_BYTES = 16 * 1024 * 1024

_TEXT_MAX = 120
_COLOR_MAX = 32

#: 地图 id 会被当成文件名，所以字符集必须卡死 —— 挡住 `../` 这类路径穿越。
_ID_OK = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


# --------------------------------------------------------------------------
# 落盘 / 读取
# --------------------------------------------------------------------------


def index_file(book_id: str) -> Path:
    return paths.maps_dir(book_id) / "index.json"


def legacy_file(book_id: str) -> Path:
    """P4.5.1 时代的单文件。只在升级时读一次。"""
    return paths.view_dir(book_id) / "maps.json"


def content_file(book_id: str, map_id: str) -> Path:
    """单张图的内容文件。map_id 必须已经过 `_safe_id` 校验。"""
    return paths.maps_dir(book_id) / f"{map_id}.json"


def _safe_id(v: object) -> str | None:
    """地图 id 当文件名用，只放行 `[A-Za-z0-9_-]`。不合规的一律丢掉。"""
    if not isinstance(v, str):
        return None
    return v if _ID_OK.match(v) else None


def _atomic_write(p: Path, text: str) -> None:
    """先写临时文件再原子替换 —— 要么是旧内容要么是新内容，没有半截。"""
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, p)


def _rev_of(payload: str) -> str:
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def _empty_index() -> dict:
    return {"schema": SCHEMA_VERSION, "order": [], "maps": {}}


def _read_index(book_id: str) -> dict:
    """读目录。坏文件当空的，别让整个界面打不开。"""
    p = index_file(book_id)
    if not p.is_file():
        return _empty_index()
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError
    except Exception:
        return _empty_index()

    out = _empty_index()
    src = data.get("maps")
    if isinstance(src, dict):
        out["maps"] = {
            k: v for k, v in src.items() if _safe_id(k) is not None and isinstance(v, dict)
        }
    if isinstance(data.get("order"), list):
        out["order"] = [x for x in data["order"] if isinstance(x, str) and x in out["maps"]]
    for mid in out["maps"]:
        if mid not in out["order"]:
            out["order"].append(mid)
    return out


def _read_content(book_id: str, map_id: str) -> dict:
    """读单张图的内容。

    文件不在（还没画过 / 被手删了）不算错：目录里还记着这张图，
    它就还在，只是图上一个点都没有。坏文件同理。
    """
    empty = {"pins": [], "regions": []}
    p = content_file(book_id, map_id)
    if not p.is_file():
        return empty
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return empty
    if not isinstance(data, dict):
        return empty
    return {
        "pins": data.get("pins") if isinstance(data.get("pins"), list) else [],
        "regions": data.get("regions") if isinstance(data.get("regions"), list) else [],
    }


def _write_index(book_id: str, index: dict) -> Path:
    p = index_file(book_id)
    payload = json.dumps(index, ensure_ascii=False, indent=1)
    # 目录丢了就不知道有哪些图了，比单图内容金贵 —— 落盘前留一份上一版
    if p.is_file():
        try:
            (p.parent / "index.json.bak").write_text(p.read_text(encoding="utf-8"), encoding="utf-8")
        except OSError:
            pass  # 备份失败不该挡住保存
    _atomic_write(p, payload)
    return p


def _write_split(book_id: str, doc: dict, old_revs: dict[str, str]) -> dict:
    """把一份完整文档拆开落盘：目录写 index.json，内容写各自的文件。

    内容哈希和上一版一样就**跳过不写** —— 拖一个点位只该重写那一个文件，
    不该把 300 张图全刷一遍。
    """
    paths.maps_dir(book_id).mkdir(parents=True, exist_ok=True)

    index_maps: dict[str, dict] = {}
    written = 0
    for mid, one in doc["maps"].items():
        content = {
            "schema": SCHEMA_VERSION,
            "id": mid,
            "pins": one.get("pins", []),
            "regions": one.get("regions", []),
        }
        payload = json.dumps(content, ensure_ascii=False, indent=1)
        if len(payload.encode("utf-8")) > MAX_MAP_BYTES:
            raise HTTPException(
                status_code=400,
                detail=f"地图「{one.get('title') or mid}」内容过大，点位或区域太多了",
            )
        rev = _rev_of(payload)
        if old_revs.get(mid) != rev:
            _atomic_write(content_file(book_id, mid), payload)
            written += 1
        index_maps[mid] = {
            "title": one["title"],
            "image": one["image"],
            "width": one["width"],
            "height": one["height"],
            "parent": one["parent"],
            "level": one.get("level", ""),
            "note": one["note"],
            "rev": rev,
        }

    # 目录里已经没有的图，把内容文件也删掉，别留孤儿文件
    removed = 0
    for mid in old_revs:
        if mid in index_maps or _safe_id(mid) is None:
            continue
        f = content_file(book_id, mid)
        if f.is_file():
            try:
                f.unlink()
                removed += 1
            except OSError:
                pass

    _write_index(book_id, {"schema": SCHEMA_VERSION, "order": doc["order"], "maps": index_maps})
    return {"written": written, "removed": removed, "map_count": len(index_maps)}


def _ensure_migrated(book_id: str) -> None:
    """把 P4.5.1 时代的整体文件 `view/maps.json` 升级成「一图一文件」。

    只在 index.json 还不存在、而旧的 maps.json 在的时候做一次。
    升级完把旧文件改名为 `maps.json.migrated`（留档不删）——
    万一新格式有问题，还能翻回原样看。
    """
    if index_file(book_id).is_file():
        return
    legacy = legacy_file(book_id)
    if not legacy.is_file():
        return
    try:
        data = json.loads(legacy.read_text(encoding="utf-8"))
    except Exception:
        return
    if not isinstance(data, dict):
        return
    try:
        doc = _clean_doc(data)
    except HTTPException:
        return
    if not doc["maps"]:
        return
    _write_split(book_id, doc, {})
    try:
        legacy.replace(legacy.with_name("maps.json.migrated"))
    except OSError:
        pass


def _read_doc(book_id: str) -> dict:
    """目录 + 各自的内容，合并成一份完整文档（形状和 P4.5.1 一样，前端无感）。"""
    _ensure_migrated(book_id)
    idx = _read_index(book_id)
    known = set(idx["maps"])

    maps: dict[str, dict] = {}
    for mid, meta in idx["maps"].items():
        raw = dict(meta)
        raw.update(_read_content(book_id, mid))
        cleaned = _clean_map(mid, raw, known)
        if cleaned:
            maps[mid] = cleaned

    _drop_dangling(maps)
    order = [x for x in idx["order"] if x in maps]
    for mid in maps:
        if mid not in order:
            order.append(mid)
    return {"schema": SCHEMA_VERSION, "maps": maps, "order": order}


def map_image_ref(book_id: str, map_id: str) -> str:
    """取某张地图的底图相对路径（`maps/xxx.png`）。没有就返回空串。

    给识别接口用：它只知道地图 id，得先问到「要认哪张图」。
    只读目录不读内容 —— 底图路径记在目录里，不用为此解析一整张图的点位。
    """
    if _safe_id(map_id) is None:
        return ""
    meta = _read_index(book_id)["maps"].get(map_id) or {}
    image = meta.get("image")
    return image if isinstance(image, str) else ""


def _write_doc(book_id: str, doc: dict) -> dict:
    _ensure_migrated(book_id)
    old = _read_index(book_id)
    return _write_split(book_id, doc, {mid: m.get("rev", "") for mid, m in old["maps"].items()})


# --------------------------------------------------------------------------
# 清洗与校验
#
# 前端已经保证了形状，但落盘文件是用户可以手改的，进来的一律当不可信输入。
# 一条坏数据不该让整张地图打不开，所以这里**丢弃**而不是抛错。
# --------------------------------------------------------------------------


def _text(v: object, limit: int = _TEXT_MAX) -> str:
    if not isinstance(v, str):
        return ""
    return v.strip()[:limit]


def _unit(v: object, default: float = 0.5) -> float:
    """坐标夹到 0~1。越界的点宁可贴在边上，也别让它飘到画布外面找不着。"""
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    if f != f:  # NaN
        return default
    return 0.0 if f < 0 else 1.0 if f > 1 else f


def _clean_pin(raw: object) -> dict | None:
    if not isinstance(raw, dict):
        return None
    pid = _text(raw.get("id"), 64)
    if not pid:
        return None
    return {
        "id": pid,
        "entity_id": _text(raw.get("entity_id"), 64) or None,
        "label": _text(raw.get("label")),
        "x": _unit(raw.get("x")),
        "y": _unit(raw.get("y")),
        "portal": _text(raw.get("portal"), 64) or None,
        "kind": _text(raw.get("kind"), 24) or None,
        "color": _text(raw.get("color"), _COLOR_MAX) or None,
        "note": _text(raw.get("note"), 400),
    }


def _clean_region(raw: object) -> dict | None:
    if not isinstance(raw, dict):
        return None
    rid = _text(raw.get("id"), 64)
    if not rid:
        return None
    pts_raw = raw.get("points")
    if not isinstance(pts_raw, list):
        return None
    points: list[list[float]] = []
    for pt in pts_raw[:MAX_POINTS_PER_REGION]:
        if isinstance(pt, (list, tuple)) and len(pt) >= 2:
            points.append([_unit(pt[0]), _unit(pt[1])])
    if len(points) < 3:
        # 少于三个顶点画不出面，留着只会让渲染器崩
        return None
    try:
        opacity = float(raw.get("opacity", 0.25))
    except (TypeError, ValueError):
        opacity = 0.25
    return {
        "id": rid,
        "name": _text(raw.get("name")),
        "entity_id": _text(raw.get("entity_id"), 64) or None,
        "points": points,
        "fill": _text(raw.get("fill"), _COLOR_MAX) or None,
        "opacity": 0.0 if opacity < 0 else 1.0 if opacity > 1 else opacity,
    }


def _clean_map(map_id: str, raw: object, known: set[str]) -> dict | None:
    if not isinstance(raw, dict):
        return None
    try:
        width = int(raw.get("width") or 0)
        height = int(raw.get("height") or 0)
    except (TypeError, ValueError):
        width = height = 0

    pins_raw = raw.get("pins")
    pins: list[dict] = []
    seen: set[str] = set()
    if isinstance(pins_raw, list):
        for item in pins_raw[:MAX_PINS_PER_MAP]:
            pin = _clean_pin(item)
            if pin and pin["id"] not in seen:
                seen.add(pin["id"])
                pins.append(pin)

    regions_raw = raw.get("regions")
    regions: list[dict] = []
    seen_r: set[str] = set()
    if isinstance(regions_raw, list):
        for item in regions_raw[:MAX_REGIONS_PER_MAP]:
            rgn = _clean_region(item)
            if rgn and rgn["id"] not in seen_r:
                seen_r.add(rgn["id"])
                regions.append(rgn)

    parent = _text(raw.get("parent"), 64) or None
    # 指不到的父图会让树断掉，直接当顶层
    if parent and parent not in known and parent != map_id:
        parent = None

    return {
        "id": map_id,
        "title": _text(raw.get("title"), 80) or "未命名地图",
        "image": _text(raw.get("image"), 300),
        "width": max(0, width),
        "height": max(0, height),
        "parent": parent,
        # 自由文本，故意不做词典校验 —— 每种小说分层的方式都不一样
        "level": _text(raw.get("level"), 40),
        "note": _text(raw.get("note"), 400),
        "pins": pins,
        "regions": regions,
    }


def _drop_dangling(maps: dict[str, dict]) -> None:
    """把指不到东西的引用清空：父图不存在就提回顶层，门户不存在就取消跳转。

    不清的话界面上会出现「点进去没反应」的入口，比没有更让人困惑。
    """
    for one in maps.values():
        if one["parent"] and one["parent"] not in maps:
            one["parent"] = None
        for pin in one["pins"]:
            if pin["portal"] and pin["portal"] not in maps:
                pin["portal"] = None


def _clean_doc(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="maps 必须是对象")
    src = raw.get("maps")
    if not isinstance(src, dict):
        raise HTTPException(status_code=400, detail="maps 字段缺失")

    # id 会被当成文件名，所以先过一遍字符集；不合规的直接丢
    ids: list[str] = []
    for k in src:
        sid = _safe_id(k)
        if sid is not None and sid not in ids:
            ids.append(sid)
        if len(ids) >= MAX_MAPS:
            break

    known = set(ids)
    maps: dict[str, dict] = {}
    for mid in ids:
        cleaned = _clean_map(mid, src[mid], known)
        if cleaned:
            maps[mid] = cleaned

    _drop_dangling(maps)

    order_raw = raw.get("order")
    order = [x for x in order_raw if isinstance(x, str) and x in maps] if isinstance(order_raw, list) else []
    for mid in maps:
        if mid not in order:
            order.append(mid)

    return {"schema": SCHEMA_VERSION, "maps": maps, "order": order}


# --------------------------------------------------------------------------
# 接口
# --------------------------------------------------------------------------


def _entity_index(book_id: str, ids: set[str]) -> dict[str, dict]:
    """给用到的实体 id 补上名字与类型 —— 前端画 pin 标签不用再逐个请求。

    实体可能已经被删了：这里如实返回 `exists: False`，
    让界面把那个点画成虚的（和关系图里的「未录入」节点一个道理）。
    """
    if not ids:
        return {}
    marks = ",".join("?" * len(ids))
    with store.connect() as conn:
        rows = [
            dict(r)
            for r in conn.execute(
                f"SELECT id, name, type, status FROM entities WHERE book_id=? AND id IN ({marks})",
                (book_id, *sorted(ids)),
            )
        ]
    found = {r["id"]: {"name": r["name"], "type": r["type"], "status": r["status"], "exists": True} for r in rows}
    for eid in ids:
        found.setdefault(eid, {"name": "", "type": "", "status": None, "exists": False})
    return found


@router.get("/books/{book_id}/maps")
def api_maps_get(book_id: str) -> dict:
    """读这本书的全部地图。顺带把 pin 指向的实体名/类型回填，省掉 N 次请求。"""
    check_book_id(book_id)
    doc = _read_doc(book_id)

    used: set[str] = set()
    for one in doc["maps"].values():
        for pin in one.get("pins", []):
            if pin.get("entity_id"):
                used.add(pin["entity_id"])
        for rgn in one.get("regions", []):
            if rgn.get("entity_id"):
                used.add(rgn["entity_id"])

    return {
        "book_id": book_id,
        "exists": index_file(book_id).is_file(),
        "schema": doc["schema"],
        "maps": doc["maps"],
        "order": doc["order"],
        "entities": _entity_index(book_id, used),
        "limits": {
            "max_pins_per_map": MAX_PINS_PER_MAP,
            "max_regions_per_map": MAX_REGIONS_PER_MAP,
            "max_points_per_region": MAX_POINTS_PER_REGION,
            "max_maps": MAX_MAPS,
        },
    }


@router.put("/books/{book_id}/maps")
def api_maps_put(book_id: str, payload: dict = Body(...)) -> dict:
    """整体语义、增量落盘。

    前端仍然提交**整份**文档（它只知道整份），后端负责比对内容哈希，
    只重写真正变了的那些图 —— 拖一个点位 = 写一个文件。
    这样接口契约没变，但写盘代价从「300 张图」降到「1 张图」。

    为什么不改成「加一个点 / 挪一个点」的细粒度接口：
    摆点是个高频连续动作，细粒度接口会打出一串请求，而且中途落盘存到一半
    的位置很难看。前端攒着、松手提交整份，是这个场景下最不容易写坏的形状。
    """
    check_book_id(book_id)
    body = payload.get("maps_doc", payload)
    try:
        size = len(json.dumps(body, ensure_ascii=False).encode("utf-8"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="maps 不是合法 JSON")
    if size > MAX_BODY_BYTES:
        raise HTTPException(status_code=400, detail="地图数据过大")

    doc = _clean_doc(body)
    stat = _write_doc(book_id, doc)
    return {
        "saved": True,
        "file": str(index_file(book_id)),
        "map_count": stat["map_count"],
        "written": stat["written"],
        "removed": stat["removed"],
    }


@router.delete("/books/{book_id}/maps/{map_id}")
def api_maps_delete(book_id: str, map_id: str) -> dict:
    """删掉一张地图。它的子图提上来挂到它原来的父图上，不做连带删除。"""
    check_book_id(book_id)
    if _safe_id(map_id) is None:
        raise HTTPException(status_code=404, detail="没有这张地图")

    doc = _read_doc(book_id)
    if map_id not in doc["maps"]:
        raise HTTPException(status_code=404, detail="没有这张地图")

    gone = doc["maps"].pop(map_id)
    doc["order"] = [x for x in doc["order"] if x != map_id]
    for one in doc["maps"].values():
        if one.get("parent") == map_id:
            one["parent"] = gone.get("parent") or None
        # 指向这张图的跳转一并清掉，免得点了没反应
        for pin in one.get("pins", []):
            if pin.get("portal") == map_id:
                pin["portal"] = None

    _write_doc(book_id, doc)
    return {"deleted": True, "map_id": map_id, "remaining": len(doc["maps"])}
