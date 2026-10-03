"""数据模型与实体 ID 规则。

**口子 1 的落地**：实体 ID 与文件名解耦。
- ID：`{类型前缀}-{4位序号}`，创建后永不变更，所有引用只认它
- 文件名：`{主名}.md`，可读、可随主名变化而重命名，不影响引用
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

CST = timezone(timedelta(hours=8))

SCHEMA_VERSION = 1

# 实体类型：key -> (中文标签, 存储子目录, ID 前缀)
ENTITY_TYPES: dict[str, tuple[str, str, str]] = {
    "character": ("人物", "characters", "char"),
    "location": ("地点", "locations", "loc"),
    "faction": ("势力", "factions", "fac"),
    "organization": ("机构", "organizations", "org"),
    "item": ("物品", "items", "item"),
    "concept": ("概念", "concepts", "con"),
    "realm": ("境界", "realms", "realm"),
    # 方法论：某种意义上的哲学观 —— 意识形态、戒律、主义、公约、思维方式。
    # 独立成类型，是因为它既能被单独浏览（方法论界面），
    # 又能作为标签挂在角色身上（「谁信奉晨曦主义」）。
    "methodology": ("方法论", "methodologies", "meth"),
}

#: 方法论在角色等实体上的引用字段名（frontmatter 里的键）
METHODOLOGY_FIELD = "methodologies"

# 正文小节的标准名称（顺序即渲染顺序）
BODY_SECTIONS = ["摘要", "属性", "出场记录", "关联", "待补充"]


def now_iso() -> str:
    return datetime.now(CST).isoformat(timespec="seconds")


def type_label(type_key: str) -> str:
    return ENTITY_TYPES.get(type_key, (type_key, type_key + "s", type_key))[0]


def type_subdir(type_key: str) -> str:
    return ENTITY_TYPES.get(type_key, (type_key, type_key + "s", type_key))[1]


def type_prefix(type_key: str) -> str:
    return ENTITY_TYPES.get(type_key, (type_key, type_key + "s", type_key))[2]


def make_entity_id(type_key: str, seq: int) -> str:
    """生成稳定 ID，如 char-0001。"""
    return f"{type_prefix(type_key)}-{seq:04d}"


_ID_RE = re.compile(r"^([a-z]+)-(\d+)$")


def parse_entity_id(entity_id: str) -> tuple[str, int] | None:
    m = _ID_RE.match(entity_id or "")
    if not m:
        return None
    return m.group(1), int(m.group(2))


_INVALID_FILENAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def safe_filename(name: str) -> str:
    """把实体主名转成安全的文件名（保留中文，剔除非法字符）。"""
    cleaned = _INVALID_FILENAME.sub("_", (name or "").strip())
    cleaned = cleaned.strip(". ")
    return cleaned or "未命名"


# --------------------------------------------------------------------------
# 结构化的正文小节
# --------------------------------------------------------------------------

def empty_body() -> dict[str, Any]:
    return {
        "摘要": "",
        "属性": [],        # list[[字段, 值]]
        "出场记录": [],    # list[[章节, 表现]]
        "关联": [],        # list[str]，可含 [[双链]]
        "待补充": [],      # list[str]
    }


@dataclass
class Entity:
    id: str
    book_id: str
    type: str
    name: str
    aliases: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    first_appear: str | None = None
    status: str | None = None
    #: 自定义图标（素材库相对路径，如 `icons/knight.png`）。
    #: 存相对路径而不是完整 URL —— 换域名/换前缀不会让 406 个实体集体失效。
    icon: str | None = None
    #: 方法论引用（名字数组）。不是所有实体都有，所以只在非空时才写进文件。
    methodologies: list[str] = field(default_factory=list)
    schema_version: int = SCHEMA_VERSION
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)
    # 出处（口子 2）：录入方式 + 来源
    provenance: dict[str, Any] = field(default_factory=lambda: {"method": "manual", "sources": []})
    body: dict[str, Any] = field(default_factory=empty_body)
    # 运行时信息，不写入文件
    file_path: str | None = None

    # -- 序列化 ----------------------------------------------------------
    def to_frontmatter(self) -> dict[str, Any]:
        fm: dict[str, Any] = {
            "id": self.id,
            "book_id": self.book_id,
            "type": self.type,
            "name": self.name,
            "aliases": list(self.aliases),
            "tags": list(self.tags),
        }
        # 空列表不落盘 —— 免得每个实体都多两行空字段，diff 全是噪音
        if self.methodologies:
            fm["methodologies"] = list(self.methodologies)
        fm.update(
            {
                "first_appear": self.first_appear,
                "status": self.status,
                "schema_version": self.schema_version,
                "created_at": self.created_at,
                "updated_at": self.updated_at,
                "provenance": {
                    "method": self.provenance.get("method", "manual"),
                    "sources": self.provenance.get("sources", []),
                },
            }
        )
        # 有图标才写这一行 —— 没图标的实体不该多出一行空字段
        if self.icon:
            fm["icon"] = self.icon
        return fm

    def to_meta(self) -> dict[str, Any]:
        """给索引用的扁平结构（索引只是派生数据）。"""
        return {
            "id": self.id,
            "book_id": self.book_id,
            "type": self.type,
            "name": self.name,
            "aliases": self.aliases,
            "tags": self.tags,
            "methodologies": self.methodologies,
            "first_appear": self.first_appear,
            "status": self.status,
            "icon": self.icon,
            "summary": self.body.get("摘要", ""),
            "file_path": self.file_path or "",
            "updated_at": self.updated_at,
        }

    @staticmethod
    def from_frontmatter(fm: dict[str, Any], body: dict[str, Any], file_path: str | None = None) -> "Entity":
        prov = fm.get("provenance") or {}
        meths = fm.get(METHODOLOGY_FIELD) or []
        if isinstance(meths, str):
            # 手写的单值写法也认
            meths = [meths]
        return Entity(
            id=str(fm.get("id") or ""),
            book_id=str(fm.get("book_id") or ""),
            type=str(fm.get("type") or "concept"),
            name=str(fm.get("name") or ""),
            aliases=list(fm.get("aliases") or []),
            tags=list(fm.get("tags") or []),
            first_appear=fm.get("first_appear"),
            status=fm.get("status"),
            icon=(str(fm["icon"]).strip() or None) if fm.get("icon") else None,
            methodologies=[str(m).strip() for m in meths if str(m).strip()],
            schema_version=int(fm.get("schema_version") or SCHEMA_VERSION),
            created_at=str(fm.get("created_at") or now_iso()),
            updated_at=str(fm.get("updated_at") or now_iso()),
            provenance={
                "method": prov.get("method", "manual"),
                "sources": list(prov.get("sources") or []),
            },
            body=body,
            file_path=file_path,
        )


@dataclass
class Book:
    book_id: str
    title: str
    author: str = ""
    entity_count: int = 0
