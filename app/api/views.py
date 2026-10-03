"""面向视图的聚合接口：关系图谱、时间线、名册。

这三个都是**从实体数据派生**的视图 —— 不引入任何新的真源，
删掉索引重建后，图谱与时间线必须完全一致（「索引零独占状态」）。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .. import entities as entities_mod
from .. import store
from ..models import now_iso
from ._common import check_book_id, check_type, type_labels_for, type_options

router = APIRouter(tags=["views"])

# --------------------------------------------------------------------------
# 关系图谱
# --------------------------------------------------------------------------


@router.get("/books/{book_id}/graph")
def api_graph(
    book_id: str,
    types: str | None = Query(default=None, description="逗号分隔的类型白名单，如 location"),
    include_isolated: bool = Query(
        default=False, description="是否保留一个关系都没有的实体"
    ),
) -> dict:
    """把 [[双链]] 解析结果吐成一张图。

    指向「还没录入的实体」的双链不会丢掉，而是作为**虚线节点**返回 ——
    这正是「哪条关系还没补录」的线索，比只画已有实体有用得多。

    两个可选参数的用途不同：
    - `include_isolated`：关系网界面默认 **不**带上孤立实体（否则一屏全是散点）；
      世界观 / 地理观这类「全册都要看」的界面则要带上，否则没连线的条目会凭空消失。
    - `types`：按类型取子图，是用来派生「只看得见地点」「只看得见设定」这类视图的。
    """
    check_book_id(book_id)

    keep: set[str] | None = None
    if types:
        keep = {t.strip() for t in types.split(",") if t.strip()}
        for t in keep:
            check_type(t, book_id)
        keep = keep or None

    with store.connect() as conn:
        raw_nodes = [
            dict(r)
            for r in conn.execute(
                "SELECT id, name, type, status, first_appear, icon FROM entities WHERE book_id=?",
                (book_id,),
            )
        ]
        raw_edges = [
            dict(r)
            for r in conn.execute(
                "SELECT from_id, to_name, to_id, kind FROM relations WHERE book_id=?",
                (book_id,),
            )
        ]
        # 标签一次全取回来。样式系统的「按标签批量上色」要用它 ——
        # 少了这个，「所有带『隐龙院』标签的节点统一配色」就没法在图里算。
        raw_tags: dict[str, list[str]] = {}
        for r in conn.execute(
            "SELECT entity_id, tag FROM entity_tags WHERE book_id=? ORDER BY tag", (book_id,)
        ):
            raw_tags.setdefault(r["entity_id"], []).append(r["tag"])

    degree: dict[str, int] = {}
    edges: list[dict] = []
    dangling: dict[str, dict] = {}

    for e in raw_edges:
        src = e["from_id"]
        if e["to_id"]:
            edges.append({"source": src, "target": e["to_id"], "kind": e["kind"]})
            degree[src] = degree.get(src, 0) + 1
            degree[e["to_id"]] = degree.get(e["to_id"], 0) + 1
        else:
            name = (e["to_name"] or "").strip()
            if not name:
                continue
            key = f"?{name}"
            dangling.setdefault(
                key,
                {"id": key, "name": name, "type": "", "unresolved": True, "status": None,
                 "first_appear": None, "tags": []},
            )
            edges.append({"source": src, "target": key, "kind": e["kind"]})
            degree[key] = degree.get(key, 0) + 1
            degree[src] = degree.get(src, 0) + 1

    nodes = [
        {**n, "degree": degree.get(n["id"], 0), "unresolved": False, "tags": raw_tags.get(n["id"], [])}
        for n in raw_nodes
    ]
    if keep is not None:
        nodes = [n for n in nodes if n["type"] in keep]
    # 关系网界面默认不带孤立实体（否则一屏全是散点）；全册视图要带
    if not include_isolated:
        nodes = [n for n in nodes if n["degree"] > 0]

    live = {n["id"] for n in nodes}
    # 虚线节点只在「还连着一个被保留下来的实体」时才有意义
    for key, d in dangling.items():
        if any(e["source"] in live and e["target"] == key for e in edges):
            nodes.append({**d, "degree": degree.get(key, 0)})
            live.add(key)

    edges = [e for e in edges if e["source"] in live and e["target"] in live]

    return {
        "book_id": book_id,
        "nodes": nodes,
        "edges": edges,
        "resolved_nodes": sum(1 for n in nodes if not n["unresolved"]),
        "dangling_nodes": sum(1 for n in nodes if n["unresolved"]),
        "types": type_options(book_id),
        "type_labels": type_labels_for(book_id),
    }


# --------------------------------------------------------------------------
# 时间线
# --------------------------------------------------------------------------

_DIGITS = re.compile(r"(\d+)")


def chapter_order(text: str) -> int | None:
    """从「第12章」这类文本里抽出排序用的数字。抽不到就返回 None。"""
    m = _DIGITS.search(text or "")
    return int(m.group(1)) if m else None


@router.get("/books/{book_id}/timeline")
def api_timeline(
    book_id: str,
    type: str | None = Query(default=None, description="只看某类实体"),
) -> dict:
    """叙事序时间线：把每个实体的「首次出场」与「出场记录」按章节聚到一起。

    注意这是**叙事序**（第几章），不是故事内时间（明显帝143年秋）。
    故事内时间要等 world/ 里的纪年表落地后才能双轨对齐。
    """
    check_book_id(book_id)
    if type:
        check_type(type, book_id)

    sql = "SELECT id, name, type, first_appear FROM entities WHERE book_id=?"
    params: list = [book_id]
    if type:
        sql += " AND type=?"
        params.append(type)

    with store.connect() as conn:
        ents = [dict(r) for r in conn.execute(sql, params)]
        apps = [
            dict(r)
            for r in conn.execute(
                "SELECT entity_id, chapter, note FROM appearances WHERE book_id=?", (book_id,)
            )
        ]

    meta = {e["id"]: e for e in ents}
    buckets: dict[str, list[dict]] = {}

    for e in ents:
        first = (e.get("first_appear") or "").strip()
        if first:
            buckets.setdefault(first, []).append(
                {"entity_id": e["id"], "name": e["name"], "type": e["type"], "note": "", "kind": "first"}
            )

    for a in apps:
        e = meta.get(a["entity_id"])
        if not e:
            continue
        chapter = (a.get("chapter") or "").strip() or "（未标章节）"
        buckets.setdefault(chapter, []).append(
            {
                "entity_id": e["id"],
                "name": e["name"],
                "type": e["type"],
                "note": (a.get("note") or "").strip(),
                "kind": "appearance",
            }
        )

    def sort_key(item: tuple[str, list]) -> tuple:
        chapter = item[0]
        n = chapter_order(chapter)
        # 抽得出序号的一律排在前面，按序号；抽不出的（故事内时间等）排后面按字面
        return (0, n, chapter) if n is not None else (1, 0, chapter)

    ordered = sorted(buckets.items(), key=sort_key)

    return {
        "book_id": book_id,
        "chapter_count": len(ordered),
        "entry_count": sum(len(v) for _, v in ordered),
        "chapters": [
            {"chapter": ch, "order": chapter_order(ch), "entries": entries}
            for ch, entries in ordered
        ],
        "types": type_options(book_id),
    }


# --------------------------------------------------------------------------
# 名册（角色录等按类型整册浏览）
# --------------------------------------------------------------------------


@router.get("/books/{book_id}/roster")
def api_roster(
    book_id: str,
    type: str = Query(default="character"),
    group_by: str = Query(default="none", description="none / tag / faction"),
) -> dict:
    """某个类型的完整名册，附带分组信息与登记完备度。

    「完备度」是给自录场景用的：一条实体光有名字没用，
    得让它自己暴露「谁还只有个名字」。
    """
    check_book_id(book_id)
    check_type(type, book_id)

    with store.connect() as conn:
        rows = [
            dict(r)
            for r in conn.execute(
                """SELECT e.id, e.name, e.type, e.status, e.first_appear, e.summary, e.updated_at, e.icon,
                          (SELECT group_concat(a.alias, '、') FROM entity_aliases a
                            WHERE a.book_id=e.book_id AND a.entity_id=e.id) AS aliases,
                          (SELECT group_concat(t.tag, '、') FROM entity_tags t
                            WHERE t.book_id=e.book_id AND t.entity_id=e.id) AS tags,
                          (SELECT COUNT(*) FROM appearances ap
                            WHERE ap.book_id=e.book_id AND ap.entity_id=e.id) AS appearance_count,
                          (SELECT COUNT(*) FROM relations r
                            WHERE r.book_id=e.book_id AND r.from_id=e.id) AS relation_count
                   FROM entities e
                   WHERE e.book_id=? AND e.type=?
                   ORDER BY e.name COLLATE NOCASE""",
                (book_id, type),
            )
        ]

    items = []
    for r in rows:
        aliases = [s for s in (r.get("aliases") or "").split("、") if s]
        tags = [s for s in (r.get("tags") or "").split("、") if s]
        # 完备度：有摘要 + 有标签 +（有别名或出场记录）+ 有关系，各记 1 分。
        #
        # ⚠️ 口径的**权威定义**在 `store._COMPLETENESS_SQL`（汇总页是 SQL 侧算的）。
        # 这里是 Python 侧逐条算同一件事 —— 那边改了必须同步改这里，
        # 否则同一本册子会在「平均完备度」和「每一格」上给出两个答案。
        score = (
            (1 if (r.get("summary") or "").strip() else 0)
            + (1 if tags else 0)
            + (1 if aliases or r["appearance_count"] else 0)
            + (1 if r["relation_count"] else 0)
        )
        items.append(
            {
                **{k: v for k, v in r.items() if k not in ("aliases", "tags")},
                "aliases": aliases,
                "tags": tags,
                "completeness": score,
            }
        )

    buckets: dict[str, list[str]] = {}
    if group_by == "tag":
        for it in items:
            for t in it["tags"] or ["（无标签）"]:
                buckets.setdefault(t, []).append(it["id"])
    elif group_by == "faction":
        # 按「势力」类实体反查：谁和某个势力有双链
        with store.connect() as conn:
            fac = {
                r["id"]: r["name"]
                for r in conn.execute(
                    "SELECT id, name FROM entities WHERE book_id=? AND type IN ('faction','organization')",
                    (book_id,),
                )
            }
            rel = [
                dict(r)
                for r in conn.execute(
                    "SELECT from_id, to_id FROM relations WHERE book_id=? AND to_id IS NOT NULL",
                    (book_id,),
                )
            ]
        member = {fid: [] for fid in fac}
        for r in rel:
            if r["to_id"] in fac:
                member[r["to_id"]].append(r["from_id"])
        ids = {it["id"] for it in items}
        for fid, members in member.items():
            for mid in members:
                if mid in ids:
                    buckets.setdefault(fac[fid], []).append(mid)
        for it in items:
            if not any(it["id"] in v for v in buckets.values()):
                buckets.setdefault("（未归属）", []).append(it["id"])

    return {
        "book_id": book_id,
        "type": type,
        "type_label": type_labels_for(book_id).get(type, ""),
        "count": len(items),
        "items": items,
        "groups": buckets,
        "average_completeness": round(sum(i["completeness"] for i in items) / len(items), 2) if items else 0,
    }


# --------------------------------------------------------------------------
# 方法论
# --------------------------------------------------------------------------

@router.get("/books/{book_id}/methodologies")
def api_methodologies(
    book_id: str,
    tag: str | None = Query(default=None, description="按标签筛选"),
) -> dict:
    """方法论总览：每条方法论 + 信奉它的角色。

    两个来源合一：
    1. 已建成 methodology 实体的（有正文、能单独浏览）
    2. 只在角色身上被引用、还没建实体的（前端提示「可补建」）
    """
    check_book_id(book_id)
    data = store.methodology_overview(book_id)

    # 把已建实体的详情补进来（摘要、标签、别名）
    with store.connect() as conn:
        rows = {
            r["name"]: dict(r)
            for r in conn.execute(
                """SELECT e.id, e.name, e.summary, e.status, e.updated_at,
                          (SELECT group_concat(a.alias, '、') FROM entity_aliases a
                            WHERE a.book_id=e.book_id AND a.entity_id=e.id) AS aliases,
                          (SELECT group_concat(t.tag, '、') FROM entity_tags t
                            WHERE t.book_id=e.book_id AND t.entity_id=e.id) AS tags
                   FROM entities e WHERE e.book_id=? AND e.type='methodology'""",
                (book_id,),
            )
        }

    items = []
    for it in data["items"]:
        meta = rows.get(it["name"])
        if tag and not (meta and tag in (meta.get("tags") or "").split("、")):
            continue
        items.append(
            {
                **it,
                "summary": (meta or {}).get("summary", ""),
                "tags": [s for s in ((meta or {}).get("tags") or "").split("、") if s],
                "aliases": [s for s in ((meta or {}).get("aliases") or "").split("、") if s],
                "has_entity": meta is not None,
                "updated_at": (meta or {}).get("updated_at", ""),
            }
        )

    tags: dict[str, int] = {}
    for it in items:
        for t in it["tags"]:
            tags[t] = tags.get(t, 0) + 1

    return {
        "book_id": book_id,
        "count": len(items),
        "items": items,
        "missing": [i["name"] for i in items if not i["has_entity"]],
        "tags": sorted(tags, key=lambda t: -tags[t]),
        "holders_total": sum(i["count"] for i in items),
    }


class MethodologyAttachIn(BaseModel):
    """给一批实体挂上 / 摘掉一条方法论。"""

    methodology: str = Field(..., min_length=1, max_length=80)
    entity_ids: list[str] = Field(default_factory=list)
    mode: Literal["add", "remove"] = "add"


@router.post("/books/{book_id}/methodologies/attach")
def api_methodology_attach(book_id: str, payload: MethodologyAttachIn) -> dict:
    """批量挂/摘方法论标签（改的是实体的 frontmatter，真源仍是实体文件）。"""
    check_book_id(book_id)
    name = payload.methodology.strip()
    if not payload.entity_ids:
        return {"book_id": book_id, "methodology": name, "mode": payload.mode,
                "changed": 0, "items": []}

    marks = ",".join("?" * len(payload.entity_ids))
    with store.connect() as conn:
        rows = [
            dict(r)
            for r in conn.execute(
                f"SELECT id, file_path FROM entities WHERE book_id=? AND id IN ({marks})",
                (book_id, *payload.entity_ids),
            )
        ]

    changed: list[dict] = []
    for row in rows:
        path = Path(row["file_path"]) if row.get("file_path") else None
        if not path or not path.exists():
            continue
        try:
            entity = entities_mod.load_entity_file(path)
        except Exception:
            continue
        current = list(entity.methodologies)
        if payload.mode == "add":
            if name in current:
                continue
            current.append(name)
        else:
            if name not in current:
                continue
            current = [m for m in current if m != name]
        entity.methodologies = current
        entity.updated_at = now_iso()
        entity.file_path = str(path)
        entities_mod.save_entity_file(entity)
        store.upsert_entity_single(entity)
        changed.append({"id": entity.id, "name": entity.name, "methodologies": current})

    return {"book_id": book_id, "methodology": name, "mode": payload.mode,
            "changed": len(changed), "items": changed}
