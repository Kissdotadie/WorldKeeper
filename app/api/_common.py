"""接口共用的校验与工具。"""

from __future__ import annotations

import re

from fastapi import HTTPException

from .. import config, custom_types, paths
from ..models import ENTITY_TYPES

_BOOK_ID_RE = re.compile(r"^[A-Za-z0-9\u4e00-\u9fff_\- ]{1,64}$")


def check_book_id(book_id: str) -> str:
    """校验 book_id，防止目录穿越。"""
    if not _BOOK_ID_RE.match(book_id or ""):
        raise HTTPException(status_code=400, detail="书目标识不合法")
    if not paths.book_dir(book_id).exists():
        raise HTTPException(status_code=404, detail=f"书目「{book_id}」不存在")
    return book_id


def check_type(type_key: str, book_id: str | None = None) -> str:
    """类型校验：内置 8 个 + 本书注册的自定义类型。

    book_id 没给时只认内置（少数全局场景）；给了就查注册表 ——
    「种族」「船」这类自定义类型因此能走同一条建实体的路。
    """
    if type_key in ENTITY_TYPES:
        return type_key
    if book_id and type_key in custom_types.list_types(book_id):
        return type_key
    raise HTTPException(status_code=400, detail=f"未知实体类型：{type_key}")


def type_labels_for(book_id: str | None = None) -> dict[str, str]:
    """类型 key → 界面上显示的中文名（内置 + 自定义，再叠显示名覆盖）。

    内置 8 个是**结构性**的：动一个字就牵动文件目录、ID 前缀、图上按类型分簇，
    所以底层 key 永远不开放。开放的只是「显示成什么字」——
    你的书里叫「门派」不叫「势力」，那就显示「门派」，底层照旧是 faction。
    自定义类型的显示名同样可以覆盖（type_labels 对它们一样生效）。

    覆盖项按**书目**存（`book.yaml` 的 `type_labels`），因为这是这本世界的
    词汇表，不是工具的全局设置 —— 写仙侠和写科幻的两本书，用词本来就该不一样。
    没写或写了空的，回落到注册名。
    """
    if not book_id:
        return {k: v[0] for k, v in ENTITY_TYPES.items()}
    try:
        registry = custom_types.list_types(book_id)
    except Exception:
        registry = {k: {"label": v[0]} for k, v in ENTITY_TYPES.items()}
    labels = {k: t["label"] for k, t in registry.items()}
    try:
        override = config.load_book_config(book_id).get("type_labels")
    except Exception:
        return labels
    if not isinstance(override, dict):
        return labels
    for key, name in override.items():
        if key in labels and isinstance(name, str) and name.strip():
            labels[key] = name.strip()
    return labels


def type_options(book_id: str | None = None) -> list[dict]:
    """类型下拉的选项。color 是自定义类型的图上用色（内置走 CSS tokens）。"""
    if not book_id:
        return [{"key": k, "label": v} for k, v in type_labels_for(book_id).items()]
    registry = custom_types.list_types(book_id)
    labels = type_labels_for(book_id)
    return [
        {"key": k, "label": labels.get(k, t["label"]), "color": t["color"]}
        for k, t in registry.items()
    ]


#: 显示名允许的最长字数。超过多半是手滑贴了一整段，宁可截断也不让侧栏被撑爆。
TYPE_LABEL_MAX = 24


def clean_type_labels(raw: object, book_id: str | None = None) -> dict[str, str]:
    """把用户提交的显示名夹干净：只认已知的 key（内置+自定义），空值 = 恢复注册名。"""
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="labels 必须是 {类型key: 显示名}")
    known = set(ENTITY_TYPES)
    if book_id:
        known |= set(custom_types.list_types(book_id))
    out: dict[str, str] = {}
    for key, name in raw.items():
        if key not in known:
            continue
        if not isinstance(name, str):
            continue
        name = name.strip()
        if not name:
            continue  # 空串表示「这个我不改了」，直接不写进覆盖表
        out[key] = name[:TYPE_LABEL_MAX]
    return out
