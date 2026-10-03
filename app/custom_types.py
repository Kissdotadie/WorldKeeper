"""自定义实体类型（P7.6）：注册表按书存 `book.yaml` 的 `custom_types`。

设计要点：
- 内置 8 个类型（models.ENTITY_TYPES）是**结构性的**：目录、ID 前缀、迁移
  逻辑都焊在代码里，永不开放删除。自定义类型是「开新部门」，不是改旧的。
- 每个自定义类型 = {key, label, prefix} 三件套 + 可选颜色：
    key     英文短名（species），同时是目录名（entities/species/）
    label   界面显示名（种族）
    prefix  ID 前缀（spe → spe-0001），**全库唯一**，防止编号撞车
- 删除保护：类型名下还有实体时不许删 —— 档案变孤儿比类型多一点严重得多。
"""

from __future__ import annotations

import re

from . import config, paths
from .logging_setup import get_logger
from .models import ENTITY_TYPES

log = get_logger(__name__)

#: 每本书的自定义类型上限。类型太多，颜色板/筛选器/环形图都会被撑爆 ——
#: 「种族、船、阵法」这种量级是健康的，「几十个」说明该用标签了。
MAX_CUSTOM = 16

_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{1,15}$")
_PREFIX_RE = re.compile(r"^[a-z]{2,5}$")
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

#: 自动分配用的色板（避开内置 8 类的既有色相，取中间调保证明暗主题都可读）
PALETTE = [
    "#7fc8a9", "#c9a86a", "#8fb8de", "#d48fb8", "#a3d48f",
    "#de8f8f", "#8fd4d0", "#bfa3e0", "#d4c28f", "#8fa3d4",
    "#d48f9e", "#9ed4b8",
]


class TypeError_(ValueError):
    """类型注册表的业务错误（API 层转 400/409/422）。"""


def _custom_raw(book_id: str) -> list[dict]:
    cfg = config.load_book_config(book_id)
    raw = cfg.get("custom_types")
    return [t for t in raw if isinstance(t, dict)] if isinstance(raw, list) else []


def _save_custom(book_id: str, items: list[dict]) -> None:
    cfg = config.load_book_config(book_id)
    if items:
        cfg["custom_types"] = items
    else:
        cfg.pop("custom_types", None)  # 空表不落盘，别留一行空字段
    config.save_book_config(book_id, cfg)


def list_types(book_id: str) -> dict[str, dict]:
    """本书的完整类型注册表：内置 8 个 + 自定义。

    key -> {label, subdir, prefix, color, builtin}
    label 是**基础名**；显示名覆盖（type_labels）在 _common.type_labels_for 里合并。
    """
    out: dict[str, dict] = {
        k: {"label": v[0], "subdir": v[1], "prefix": v[2], "color": None, "builtin": True}
        for k, v in ENTITY_TYPES.items()
    }
    for t in _custom_raw(book_id):
        key = str(t.get("key") or "")
        if key in out:
            continue  # 内置的同名条目以内置为准（防手改 book.yaml 搞出影子类型）
        out[key] = {
            "label": str(t.get("label") or key),
            "subdir": key,
            "prefix": str(t.get("prefix") or key[:3]),
            "color": t.get("color") or None,
            "builtin": False,
        }
    return out


def subdir_for(book_id: str, type_key: str) -> str:
    """类型的存储子目录。自定义类型 = key 本身（entities/species/）。"""
    t = list_types(book_id).get(type_key)
    return t["subdir"] if t else type_key + "s"


def prefix_for(book_id: str, type_key: str) -> str:
    t = list_types(book_id).get(type_key)
    return t["prefix"] if t else type_key[:3]


def make_id(book_id: str, type_key: str, seq: int) -> str:
    """按注册表前缀生成实体 ID（spe-0001）。

    ⚠️ 不要用 models.make_entity_id —— 它走的是静态内置表，
    自定义类型会被兜底成「key 本身」（species-0001），前缀唯一性就废了。
    """
    return f"{prefix_for(book_id, type_key)}-{seq:04d}"


def add_custom(book_id: str, label: str, key: str | None = None,
               prefix: str | None = None, color: str | None = None) -> dict:
    """注册一个自定义类型。全部校验在这里，API 层只转状态码。"""
    label = (label or "").strip()
    if not label or len(label) > 12:
        raise TypeError_("显示名要 1~12 个字（如：种族、船）")

    items = _custom_raw(book_id)
    if len(items) >= MAX_CUSTOM:
        raise TypeError_(f"自定义类型最多 {MAX_CUSTOM} 个 —— 再多该用标签而不是开新类型")

    registry = list_types(book_id)

    # key：用户给的就校验，没给就从显示名猜（猜不出版合法字符就要求用户给）
    key = (key or "").strip().lower() or None
    if key is None:
        # 显示名常是中文，猜不出 key —— 要求显式给一个，报错信息里教怎么填
        raise TypeError_("请给一个英文短名（key），如 species、vessel —— 它会用作目录名")
    if not _KEY_RE.match(key):
        raise TypeError_("英文短名只能是 2~16 位小写字母/数字/下划线，且以字母开头")
    if key in registry:
        raise TypeError_(f"类型 {key} 已存在（内置或自定义），换一个名字")

    # prefix：没给就取 key 前 3 位，撞了再让用户给
    prefix = (prefix or "").strip().lower() or key[:3]
    if not _PREFIX_RE.match(prefix):
        raise TypeError_("ID 前缀只能是 2~5 位小写字母（如 spe、vsl）")
    used = {t["prefix"] for t in registry.values()}
    if prefix in used:
        raise TypeError_(f"ID 前缀 {prefix}- 已被别的类型占用，编号会撞车，换一个")

    color = (color or "").strip() or None
    if color and not _COLOR_RE.match(color):
        raise TypeError_("颜色要 #RRGGBB 格式，或留空自动分配")
    if not color:
        color = PALETTE[len(items) % len(PALETTE)]

    entry = {"key": key, "label": label, "prefix": prefix, "color": color}
    items.append(entry)
    _save_custom(book_id, items)

    # 目录现在就建好 —— 建实体时 save_entity_file 也会建，但空类型立刻在
    # 「按类型浏览」里可见比「第一条实体出现才有目录」直观
    (paths.entities_dir(book_id) / key).mkdir(parents=True, exist_ok=True)
    log.info("新增自定义类型：%s（%s，前缀 %s-）", label, key, prefix)
    return {**entry, "subdir": key, "builtin": False}


def count_entities(book_id: str, type_key: str) -> int:
    """某类型名下的实体数（以**文件系统**为准 —— 索引是可抛弃的派生数据）。"""
    d = paths.entities_dir(book_id) / subdir_for(book_id, type_key)
    if not d.exists():
        return 0
    return sum(1 for p in d.rglob("*.md") if not p.name.startswith("."))


def count_all(book_id: str) -> dict[str, int]:
    """一次遍历数出全部类型的实体数（按一级子目录归堆）。

    GET /types 要给每个类型配计数 —— 逐类型 rglob 会把同一棵树走 N 遍，
    千级实体上纯浪费。key 是**子目录名**，类型 key ≠ 目录名（character →
    characters），调用方用 subdir_for 去查。
    """
    base = paths.entities_dir(book_id)
    counts: dict[str, int] = {}
    if not base.exists():
        return counts
    for p in base.rglob("*.md"):
        if p.name.startswith("."):
            continue
        top = p.relative_to(base).parts[0] if p.relative_to(base).parts else ""
        if top:
            counts[top] = counts.get(top, 0) + 1
    return counts


def remove_custom(book_id: str, key: str) -> dict:
    """注销一个自定义类型。名下必须已经没有实体。"""
    if key in ENTITY_TYPES:
        raise TypeError_("内置类型不能删除 —— 它们是结构，动一个字就要迁移")
    items = _custom_raw(book_id)
    kept = [t for t in items if t.get("key") != key]
    if len(kept) == len(items):
        raise TypeError_(f"类型 {key} 不存在（或不是自定义类型）")

    n = count_entities(book_id, key)
    if n:
        raise TypeError_(f"「{key}」名下还有 {n} 个实体 —— 先移走或删光它们再删类型")

    _save_custom(book_id, kept)
    # 空目录顺手清掉（rmdir 只删空目录，里面万一有东西会安全失败）
    d = paths.entities_dir(book_id) / key
    try:
        d.rmdir()
    except OSError:
        pass  # 目录不空/不存在都无所谓 —— 注册表才是真源
    log.info("删除自定义类型：%s", key)
    return {"removed": key}
