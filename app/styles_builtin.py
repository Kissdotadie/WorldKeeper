"""内置可视化样式包（P5）。

一个样式包 = 一张图「长什么样」的一整套设定：布局、节点形状、配色、连线、
标签、背景，外加若干条**批量规则**（按类型 / 按标签）。

为什么要放后端而不是前端常量：**导入导出要能自洽**。用户把某个包导出来发给
别人，对方导入后看到的必须是一模一样的东西 —— 如果内置包只在 JS 里，
导出文件里就得塞一份完整副本，两边迟早对不上。

样式包是**装饰层**，落 `books/<书>/view/styles/`，永不碰 `entities/`。

⚠️ 改这里的任何字段名 = 改存档格式：`web/src/graph/styles.ts` 里有一份
逐字段对应的类型定义（`GraphSpec` / `EdgeCurve` 等），两边必须同时改。
"""

from __future__ import annotations

from typing import Any

#: 节点形状。`auto` = 按类型自动（沿用老行为）；`image` = 用素材库的图片。
NODE_SHAPES = ("auto", "circle", "square", "diamond", "hex", "capsule", "image")

#: 配色方案。`type` / `theme` 是「跟随全局」，其余是固定色板。
PALETTES = ("type", "theme", "dark-gold", "vivid", "mono", "pastel")

#: 连线形态。
#: straight 直线 / curve 贝塞尔曲线 / elbow 折线（各自独立的竖段）
#: bracket 括号（**同一父节点的子边合流成一根竖脊**，像一对大括号把一组子节点括起来）
#: step 阶梯（正交阶梯：水平竖直交替递进，层级感最强）
EDGE_CURVES = ("straight", "curve", "elbow", "bracket", "step")

#: 背景
BACKGROUNDS = ("none", "grid", "stars", "solid")

#: 布局。前四个是老的，后两个是 P5 新增（线索时间轴 / 势力鱼骨）。
LAYOUTS = ("force", "radial", "tree", "circle", "timeline", "fishbone")


def _graph(**over: Any) -> dict:
    """一份完整的图设定。缺的用默认补齐 —— 存档里不留半截对象。"""
    base: dict[str, Any] = {
        "layout": "force",
        "shape": "auto",
        "palette": "type",
        "sizeScale": 1.0,
        "edge": {"curve": "straight", "dashed": False, "arrow": True, "width": 1.0},
        "label": {"show": True, "scale": 1.0},
        "background": "none",
    }
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            base[k] = {**base[k], **v}
        else:
            base[k] = v
    return base


def _rule(by: str, value: str, **style: Any) -> dict:
    return {"match": {"by": by, "value": value}, "style": style}


#: 内置样式包。id 是**结构标识**（导出文件里认它），name 才是给人看的 ——
#: 和「实体 ID 与文件名解耦」同一条教训：名字改了不该断掉引用。
BUILTIN_PACKS: list[dict] = [
    {
        "id": "mindmap",
        "name": "思维导图",
        "desc": "树形铺开、圆节点，最像纸上的思维导图。适合先把一个主题摊开看全。",
        "graph": _graph(layout="radial", shape="circle", palette="theme", background="grid"),
        "rules": [],
    },
    {
        "id": "council",
        "name": "权谋谱系",
        "desc": "组织架构式左右排开、方框节点、暗金配色。适合看朝堂势力与从属等级。",
        "graph": _graph(
            layout="tree",
            shape="square",
            palette="dark-gold",
            background="none",
            label={"show": True, "scale": 0.95},
        ),
        # 势力与机构用方框 + 金边 —— 一眼分出「它是组织，不是个人」
        "rules": [
            _rule("type", "faction", shape="square"),
            _rule("type", "organization", shape="square"),
            _rule("type", "character", shape="circle", highlight=True),
        ],
    },
    {
        "id": "starmap",
        "name": "人物星图",
        "desc": "力导向自然聚类、圆节点、按类型上色。适合看关系网全貌，谁是枢纽一目了然。",
        "graph": _graph(layout="force", shape="circle", palette="type", sizeScale=1.15),
        "rules": [_rule("type", "character", highlight=True)],
    },
    {
        "id": "thread",
        "name": "线索时间轴",
        "desc": "按首现时间排成一条横轴、胶囊节点。适合理事件顺序与因果链。",
        "graph": _graph(
            layout="timeline",
            shape="capsule",
            palette="pastel",
            background="none",
            edge={"curve": "curve", "dashed": False, "arrow": True, "width": 1.0},
        ),
        "rules": [],
    },
    {
        "id": "brace",
        "name": "括号大纲",
        "desc": "同一父节点的子边合成一根竖脊，像大括号一样把一组子节点括起来。子节点多时最清爽。",
        "graph": _graph(
            layout="tree",
            shape="square",
            palette="mono",
            background="none",
            edge={"curve": "bracket", "dashed": False, "arrow": False, "width": 1.2},
        ),
        "rules": [_rule("type", "character", shape="circle", highlight=True)],
    },
    {
        "id": "fishbone",
        "name": "势力鱼骨",
        "desc": "一条主脊、分支出各方势力。适合拆解一个事件的多方动因。",
        "graph": _graph(
            layout="fishbone",
            shape="diamond",
            palette="vivid",
            background="none",
            edge={"curve": "straight", "dashed": True, "arrow": False, "width": 1.0},
        ),
        "rules": [],
    },
]

#: 出厂默认用哪一套。选「人物星图」而不是「思维导图」：默认这张图是关系网，
#: 力导向最能说明「谁和谁有关」。
DEFAULT_PACK_ID = "starmap"


def builtin_by_id() -> dict[str, dict]:
    return {p["id"]: p for p in BUILTIN_PACKS}


def pack_meta(pack: dict) -> dict:
    """目录里存的那点信息 —— 不含内容，列个表不用把每个包全读出来。

    `spec` 是专给**缩略预览**用的一小撮图形参数（P11-1️⃣⑤）：样式卡上要画一张
    1 父 2 子的迷你图，好让人「不点也知道这套包长什么样」。这里只捞预览要用的
    那几个键，整份 `rules` 不跟着走 —— 预览画不到那么细，白搭带宽。
    """
    graph = pack.get("graph") or {}
    edge = graph.get("edge") or {}
    label = graph.get("label") or {}
    return {
        "id": pack.get("id", ""),
        "name": pack.get("name", ""),
        "desc": pack.get("desc", ""),
        "builtin": bool(pack.get("builtin")),
        "modified": bool(pack.get("modified")),
        "layout": graph.get("layout", ""),
        "spec": {
            "shape": graph.get("shape", "auto"),
            "palette": graph.get("palette", "type"),
            "sizeScale": graph.get("sizeScale", 1.0),
            "edgeCurve": edge.get("curve", "straight"),
            "edgeDashed": bool(edge.get("dashed")),
            "edgeArrow": bool(edge.get("arrow", True)),
            "background": graph.get("background", "none"),
            "showLabel": bool(label.get("show", True)),
        },
    }
