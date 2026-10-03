"""面板布局存档（Adobe 式自由布局的「存多套 + 一键切换」）。

**这里不解析布局内容。** dockview 的布局 JSON 长什么样，是前端的事；
后端只当它有名字的一坨 JSON 存起来，将来前端换掉布局引擎也不用改这里。

存放位置刻意选在 `books/<book_id>/view/layouts.json`：
- 每本书的界面组合不同（写战斗的书和写宫廷的书看的面板不一样）
- `view/` 是**装饰层**，与 `entities/` 的内容数据物理隔离
  —— 布局文件删了、改烂了，最多重摆一次面板，实体一个字都不少
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

from .. import paths
from ._common import check_book_id

router = APIRouter(tags=["layouts"])

_BAD_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
MAX_LAYOUT_BYTES = 512 * 1024  # 一份布局撑死几百 KB，超了说明传错了


def safe_layout_name(name: str) -> str:
    raw = (name or "").strip().strip(". ")
    if not raw or _BAD_NAME.search(raw):
        raise HTTPException(status_code=400, detail=f"布局名不合法：{name!r}")
    if len(raw) > 40:
        raise HTTPException(status_code=400, detail="布局名太长（上限 40 字）")
    return raw


def layouts_file(book_id: str) -> Path:
    return paths.view_dir(book_id) / "layouts.json"


def read_store(book_id: str) -> dict:
    p = layouts_file(book_id)
    if not p.is_file():
        return {"schema": 1, "active": "", "layouts": {}}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        # 布局坏了不该让工具打不开，退回空存档
        return {"schema": 1, "active": "", "layouts": {}}
    if not isinstance(data, dict):
        return {"schema": 1, "active": "", "layouts": {}}
    data.setdefault("schema", 1)
    data.setdefault("active", "")
    if not isinstance(data.get("layouts"), dict):
        data["layouts"] = {}
    return data


def write_store(book_id: str, store: dict) -> Path:
    p = layouts_file(book_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")
    return p


@router.get("/books/{book_id}/layouts")
def api_layouts_list(book_id: str) -> dict:
    """列出全部布局预设。`active` 是上次用的那套 —— 打开界面时直接恢复它。"""
    check_book_id(book_id)
    store = read_store(book_id)
    out = []
    for name, body in store["layouts"].items():
        # `__` 开头是内部槽位（自动快照），不当作预设暴露出来
        if name.startswith("__"):
            continue
        panels = body.get("panels") if isinstance(body, dict) else None
        out.append(
            {
                "name": name,
                "panel_count": len(panels) if isinstance(panels, dict) else None,
                "size": len(json.dumps(body, ensure_ascii=False)),
            }
        )
    out.sort(key=lambda x: x["name"])
    return {
        "book_id": book_id,
        "active": store["active"],
        "names": [x["name"] for x in out],
        "layouts": out,
        "count": len(out),
        "file": str(layouts_file(book_id)),
    }


@router.put("/books/{book_id}/layouts/active")
def api_layout_set_active(book_id: str, payload: dict = Body(...)) -> dict:
    """切换当前布局。名字传空串表示「下次用默认布局」。

    ⚠️ 这条必须注册在 `PUT .../layouts/{name}` **之前** ——
    否则 "active" 会被当成一个布局名捕获。FastAPI 按定义顺序匹配。
    """
    check_book_id(book_id)
    raw = str(payload.get("name") or "").strip()
    store = read_store(book_id)
    if not raw:
        store["active"] = ""
        write_store(book_id, store)
        return {"active": "", "book_id": book_id}
    key = safe_layout_name(raw)
    if key not in store["layouts"]:
        raise HTTPException(status_code=404, detail=f"没有这个布局：{key}")
    store["active"] = key
    write_store(book_id, store)
    return {"active": key, "book_id": book_id}


@router.get("/books/{book_id}/layouts/{name}")
def api_layout_get(book_id: str, name: str) -> dict:
    check_book_id(book_id)
    key = safe_layout_name(name)
    store = read_store(book_id)
    body = store["layouts"].get(key)
    if body is None:
        raise HTTPException(status_code=404, detail=f"没有这个布局：{key}")
    return {"book_id": book_id, "name": key, "layout": body}


@router.put("/books/{book_id}/layouts/{name}")
def api_layout_put(book_id: str, name: str, payload: dict = Body(...)) -> dict:
    """保存一份布局。同名直接覆盖 —— 布局是随手存的东西，不做版本历史。"""
    check_book_id(book_id)
    key = safe_layout_name(name)
    body = payload.get("layout", payload)

    if len(json.dumps(body, ensure_ascii=False)) > MAX_LAYOUT_BYTES:
        raise HTTPException(status_code=400, detail="布局数据过大")

    store = read_store(book_id)
    store["layouts"][key] = body
    # `__` 开头的是内部槽位（自动快照），不算「用户选中的预设」，不能顶掉 active
    if not key.startswith("__"):
        store["active"] = key
    p = write_store(book_id, store)
    return {"saved": True, "name": key, "active": store["active"], "file": str(p)}


@router.delete("/books/{book_id}/layouts/{name}")
def api_layout_delete(book_id: str, name: str) -> dict:
    check_book_id(book_id)
    key = safe_layout_name(name)
    store = read_store(book_id)
    if key not in store["layouts"]:
        raise HTTPException(status_code=404, detail=f"没有这个布局：{key}")
    store["layouts"].pop(key)
    if store.get("active") == key:
        store["active"] = next(iter(store["layouts"]), "")
    write_store(book_id, store)
    return {"deleted": True, "name": key, "active": store["active"]}


# --------------------------------------------------------------------------
# 3D 场景（scene.json）：锁定坐标 / 相机 / 播放状态
#
# 3D 力导向每次从零模拟，节点会「乱飞」—— 所以模拟稳定后把坐标锁进
# `view/scene.json`，下次打开原样摆回去。这是**装饰层**：丢了最多重新排一次。
# --------------------------------------------------------------------------

MAX_SCENE_BYTES = 2 * 1024 * 1024  # 几百个节点的坐标 + 相机，2MB 足够


def scene_file(book_id: str) -> Path:
    return paths.view_dir(book_id) / "scene.json"


@router.get("/books/{book_id}/scene")
def api_scene_get(book_id: str) -> dict:
    """读 3D 场景（锁定坐标、相机、上次播放到第几章）。没有就给空壳。"""
    check_book_id(book_id)
    p = scene_file(book_id)
    if not p.is_file():
        return {"book_id": book_id, "exists": False, "scene": {"schema": 1, "graphs": {}}}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError
    except Exception:
        return {"book_id": book_id, "exists": False, "scene": {"schema": 1, "graphs": {}}}
    return {"book_id": book_id, "exists": True, "scene": data}


@router.put("/books/{book_id}/scene")
def api_scene_put(book_id: str, payload: dict = Body(...)) -> dict:
    """整体覆盖写。前端按「图」分区存（relation / world / geo…），后端不解析。"""
    check_book_id(book_id)
    scene = payload.get("scene", payload)
    if not isinstance(scene, dict):
        raise HTTPException(status_code=400, detail="scene 必须是对象")
    if len(json.dumps(scene, ensure_ascii=False)) > MAX_SCENE_BYTES:
        raise HTTPException(status_code=400, detail="场景数据过大")
    scene.setdefault("schema", 1)
    p = scene_file(book_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(scene, ensure_ascii=False), encoding="utf-8")
    return {"saved": True, "file": str(p)}


@router.delete("/books/{book_id}/scene")
def api_scene_delete(book_id: str) -> dict:
    """丢掉锁定坐标 —— 下次打开重新自动排版（「重新布局」按钮用）。"""
    check_book_id(book_id)
    p = scene_file(book_id)
    if p.is_file():
        p.unlink()
    return {"deleted": True}


@router.delete("/books/{book_id}/scene/graphs/{graph_key}")
def api_scene_graph_delete(book_id: str, graph_key: str) -> dict:
    """只丢某一张图的锁定坐标，**保留**样式等其余装饰。

    为什么要单独开这个口子：整份删除会把按类型配的图标、辉光开关一起抹掉，
    而「重新排版」只该动坐标。
    """
    check_book_id(book_id)
    p = scene_file(book_id)
    if not p.is_file():
        return {"cleared": False, "reason": "还没有场景文件"}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        raise HTTPException(status_code=409, detail="场景文件读不出来，请整体重置")
    graphs = data.get("graphs")
    if not isinstance(graphs, dict) or graph_key not in graphs:
        return {"cleared": False, "reason": "这张图没有锁定坐标"}
    graphs.pop(graph_key, None)
    data["graphs"] = graphs
    p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return {"cleared": True, "graph": graph_key, "file": str(p)}
