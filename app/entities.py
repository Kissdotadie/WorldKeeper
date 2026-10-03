"""实体文件的读写：Markdown 是真源。

文件结构：
    ---
    <frontmatter>
    ---
    ## 摘要
    ## 属性          | 字段 | 值 |
    ## 出场记录      | 章节 | 表现 |
    ## 关联
    ## 待补充

写入策略：只重写被改动的那个文件（一实体一文件），避免整份文件 diff 全红。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import frontmatter
import yaml

from . import config, custom_types, paths, snapshot
from .models import BODY_SECTIONS, Entity, empty_body, now_iso, safe_filename

# --------------------------------------------------------------------------
# 正文小节解析 / 渲染
# --------------------------------------------------------------------------

_H2_RE = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)


def _split_sections(text: str) -> dict[str, str]:
    """把 markdown 正文按二级标题切成 {小节名: 内容}。"""
    sections: dict[str, str] = {}
    matches = list(_H2_RE.finditer(text))
    if not matches:
        return {"摘要": text.strip()} if text.strip() else {}
    for i, m in enumerate(matches):
        title = m.group(1).strip()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        sections[title] = text[start:end].strip()
    return sections


def _parse_table(block: str) -> list[list[str]]:
    rows: list[list[str]] = []
    for line in block.splitlines():
        line = line.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if not cells:
            continue
        # 跳过表头分隔行 |---|---|
        if all(set(c) <= set("-: ") for c in cells):
            continue
        rows.append(cells)
    if rows:
        rows = rows[1:]  # 去掉表头
    return rows


def _parse_list(block: str) -> list[str]:
    out: list[str] = []
    for line in block.splitlines():
        line = line.strip()
        if not line:
            continue
        m = re.match(r"^[-*]\s+(.*)$", line)
        if m:
            out.append(m.group(1).strip())
        elif re.match(r"^\d+\.\s+", line):
            out.append(re.sub(r"^\d+\.\s+", "", line).strip())
    return out


def parse_body(text: str) -> dict[str, Any]:
    raw = _split_sections(text or "")
    body = empty_body()

    body["摘要"] = (raw.get("摘要") or "").strip()

    for row in _parse_table(raw.get("属性", "")):
        if len(row) >= 2:
            body["属性"].append([row[0], row[1]])

    for row in _parse_table(raw.get("出场记录", "")):
        if len(row) >= 2:
            body["出场记录"].append([row[0], row[1]])

    body["关联"] = _parse_list(raw.get("关联", ""))

    for item in _parse_list(raw.get("待补充", "")):
        body["待补充"].append(re.sub(r"^\[[ xX]\]\s*", "", item).strip())

    return body


def render_body(body: dict[str, Any]) -> str:
    parts: list[str] = []

    summary = (body.get("摘要") or "").strip()
    parts.append("## 摘要\n")
    parts.append((summary or "_待补充_") + "\n")

    parts.append("\n## 属性\n")
    attrs = body.get("属性") or []
    if attrs:
        parts.append("| 字段 | 值 |\n| --- | --- |\n")
        for row in attrs:
            if len(row) >= 2 and str(row[0]).strip():
                parts.append(f"| {row[0]} | {row[1]} |\n")
    else:
        parts.append("_暂无_\n")

    parts.append("\n## 出场记录\n")
    apps = body.get("出场记录") or []
    if apps:
        parts.append("| 章节 | 表现 |\n| --- | --- |\n")
        for row in apps:
            if len(row) >= 2 and str(row[0]).strip():
                parts.append(f"| {row[0]} | {row[1]} |\n")
    else:
        parts.append("_暂无_\n")

    parts.append("\n## 关联\n")
    rels = [r for r in (body.get("关联") or []) if str(r).strip()]
    if rels:
        for r in rels:
            parts.append(f"- {r}\n")
    else:
        parts.append("_暂无_\n")

    parts.append("\n## 待补充\n")
    todos = [t for t in (body.get("待补充") or []) if str(t).strip()]
    if todos:
        for t in todos:
            parts.append(f"- [ ] {t}\n")
    else:
        parts.append("_暂无_\n")

    return "".join(parts).strip() + "\n"


# --------------------------------------------------------------------------
# 文件读写
# --------------------------------------------------------------------------

def entity_file_path(book_id: str, entity_type: str, name: str) -> Path:
    """实体文件路径：entities/characters/裴渊.md

    文件名可读、可随主名变化；实体的身份由 frontmatter 里的 id 决定。
    """
    return paths.entities_dir(book_id) / custom_types.subdir_for(book_id, entity_type) / f"{safe_filename(name)}.md"


def _dedupe_path(path: Path, keep: Path | None = None) -> Path:
    """文件名冲突时追加序号，避免同名覆盖。"""
    if not path.exists() or (keep is not None and path.resolve() == keep.resolve()):
        return path
    stem, suffix, parent = path.stem, path.suffix, path.parent
    i = 2
    while True:
        candidate = parent / f"{stem}-{i}{suffix}"
        if not candidate.exists() or (keep is not None and candidate.resolve() == keep.resolve()):
            return candidate
        i += 1


def load_entity_file(path: Path) -> Entity:
    post = frontmatter.load(str(path))
    fm = dict(post.metadata or {})
    body = parse_body(post.content or "")
    entity = Entity.from_frontmatter(fm, body, file_path=str(path))
    return entity


def save_entity_file(entity: Entity) -> Path:
    """写入实体文件。若主名变化导致路径变化，会移动到新路径。"""
    assert entity.book_id, "实体缺少 book_id"
    assert entity.id, "实体缺少 id"

    old_path = Path(entity.file_path) if entity.file_path else None
    target = entity_file_path(entity.book_id, entity.type, entity.name)

    if old_path and old_path.exists() and old_path.resolve() != target.resolve():
        # 换类型目录或改了主名：文件名跟着改，ID 不变
        target.parent.mkdir(parents=True, exist_ok=True)
        target = _dedupe_path(target, keep=old_path)
        payload = _render_document(entity)
        target.write_text(payload, encoding="utf-8")
        old_path.unlink()
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        target = _dedupe_path(target, keep=old_path)
        target.write_text(_render_document(entity), encoding="utf-8")

    entity.file_path = str(target)
    return target


def _render_document(entity: Entity) -> str:
    fm_text = yaml.safe_dump(
        entity.to_frontmatter(), allow_unicode=True, sort_keys=False, default_flow_style=False
    ).strip()
    return f"---\n{fm_text}\n---\n\n{render_body(entity.body)}"


def touch(entity: Entity) -> Entity:
    entity.updated_at = now_iso()
    return entity


def iter_entity_files(book_id: str):
    """遍历一本书下的全部实体文件。"""
    root = paths.entities_dir(book_id)
    if not root.exists():
        return
    for path in sorted(root.rglob("*.md")):
        if path.name.startswith("."):
            continue
        yield path


def load_all_entities(book_id: str) -> list[Entity]:
    out: list[Entity] = []
    for path in iter_entity_files(book_id):
        try:
            entity = load_entity_file(path)
            if not entity.book_id:
                entity.book_id = book_id
            out.append(entity)
        except Exception:
            # 单个文件坏了不能拖垮整本书
            continue
    return out


def next_sequence(book_id: str, type_key: str) -> int:
    """扫描现有实体，推算下一个可用序号。"""
    from .models import parse_entity_id

    prefix = custom_types.prefix_for(book_id, type_key)
    max_seq = 0
    for path in iter_entity_files(book_id):
        try:
            post = frontmatter.load(str(path))
            parsed = parse_entity_id(str((post.metadata or {}).get("id") or ""))
            if parsed and parsed[0] == prefix:
                max_seq = max(max_seq, parsed[1])
        except Exception:
            continue
    return max_seq + 1


# --------------------------------------------------------------------------
# 书目
# --------------------------------------------------------------------------

def list_books() -> list[dict]:
    out: list[dict] = []
    root = paths.books_dir()
    if not root.exists():
        return out
    for d in sorted(root.iterdir()):
        if not d.is_dir() or d.name.startswith("."):
            continue
        cfg = config.load_book_config(d.name)
        count = sum(1 for _ in iter_entity_files(d.name))
        out.append(
            {
                "book_id": d.name,
                "title": cfg.get("title") or d.name,
                "author": cfg.get("author") or "",
                "genre": cfg.get("genre", ""),
                "cover": cfg.get("cover", ""),
                "entity_count": count,
                "path": str(d),
            }
        )
    return out


def create_book(book_id: str, title: str, author: str = "", genre: str = "",
                cover: str | None = None) -> dict:
    book_id = safe_filename(book_id)
    d = paths.book_dir(book_id)
    if d.exists():
        raise ValueError(f"书目「{book_id}」已存在")
    for sub in ("entities/characters", "entities/locations", "entities/factions",
                "entities/organizations", "entities/items", "entities/concepts", "entities/realms",
                "entities/methodologies",
                "world", "view", "chapters"):
        (d / sub).mkdir(parents=True, exist_ok=True)
    cfg = config.load_book_config(book_id)
    cfg.update({"book_id": book_id, "title": title or book_id, "author": author})
    # 题材决定录入界面的示例与占位文案（玄幻书别给你看科幻例子）；封面是素材库引用
    if genre:
        cfg["genre"] = genre
    if cover:
        cfg["cover"] = cover
    config.save_book_config(book_id, cfg)
    return {"book_id": book_id, "title": cfg["title"], "author": author,
            "genre": cfg.get("genre", ""), "entity_count": 0, "path": str(d)}


def update_book(book_id: str, patch: dict) -> dict:
    """改书目的元数据（书名/作者/题材/封面）。只动 book.yaml，不碰实体与正文。

    patch 的值假定都已就绪（API 层 exclude_none 过滤）—— 这里只做防御：
    None 一律当「没给」处理，绝不落成字符串 "None"。
    """
    cfg = config.load_book_config(book_id)
    title = patch.get("title")
    if isinstance(title, str) and title.strip():
        cfg["title"] = title.strip()
    author = patch.get("author")
    if isinstance(author, str):
        cfg["author"] = author.strip()
    if "genre" in patch:
        g = str(patch["genre"] or "").strip()
        if g:
            cfg["genre"] = g
        else:
            cfg.pop("genre", None)  # 空值 = 清掉，恢复无题材状态
    if "cover" in patch:
        c = str(patch["cover"] or "").strip()
        if c:
            cfg["cover"] = c
        else:
            cfg.pop("cover", None)
    config.save_book_config(book_id, cfg)
    return {"book_id": book_id, **{k: cfg[k] for k in ("title", "author", "genre", "cover") if k in cfg}}


# --------------------------------------------------------------------------
# 实体合并（P7 别名管理）
# --------------------------------------------------------------------------

def _chapter_no_of(value: Any) -> int:
    """first_appear / 出场记录里的章号抽成整数，解析不了给个大数（排后面）。"""
    m = re.search(r"\d+", str(value or ""))
    return int(m.group()) if m else 10**9


def rewrite_links_to(book_id: str, from_names: list[str], to_name: str,
                     skip_paths: set[Path] | None = None) -> int:
    """全库实体档案里，把指向 from_names 的 [[双链]] 改写成 to_name。

    只动实体档案 —— **章节正文一个字都不碰**（正文只读是铁律）。
    关系的真源是双链本身，改完档案重建关系解析就是干净的。
    """
    import frontmatter as _fm

    touched = 0
    for path in iter_entity_files(book_id):
        if skip_paths and path in skip_paths:
            continue
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError:
            continue
        new = raw
        for name in from_names:
            if not name:
                continue
            esc = re.escape(name)
            # 两种写法都认：[[名字]] 与 [[名字|显示字]]
            new = re.sub(rf"\[\[{esc}\]\]", f"[[{to_name}]]", new)
            new = re.sub(rf"\[\[{esc}\|", f"[[{to_name}|", new)
        if new != raw:
            try:
                post = _fm.loads(new)
                post.metadata["updated_at"] = now_iso()
                path.write_text(f"---\n{yaml.safe_dump(post.metadata, allow_unicode=True, sort_keys=False, default_flow_style=False).strip()}\n---\n\n{post.content}", encoding="utf-8")
                touched += 1
            except Exception:
                # 单个文件坏了不拖垮整次合并
                continue
    return touched


def merge_entity_files(book_id: str, target_id: str, source_id: str,
                       name_owner: dict[str, str] | None = None) -> dict:
    """把 source 实体并入 target 实体（档案层）。

    - source 的名字与别名全部变成 target 的别名（搜索、双链解析都按别名命中）
    - 出场记录、待补充并入；摘要只在 target 为空时借用
    - 首现取两者中更早的章
    - 全库档案里指向 source 的 [[双链]] 改写为 target 的主名
    - source 档案文件删除

    name_owner：名字 → 实体 ID 的全局映射（由调用方用索引算出来）。
    只改写**无歧义**的名字 —— 同一个别名挂在两个实体上时不许乱改。
    """
    src_path = t_path = None
    target = source = None
    for path in iter_entity_files(book_id):
        try:
            e = load_entity_file(path)
        except Exception:
            continue
        if e.id == target_id:
            target, t_path = e, path
        elif e.id == source_id:
            source, src_path = e, path
    if not target or not source:
        raise ValueError("找不到要合并的实体档案，请重建索引后重试")

    # 1) 别名并入：source 的主名 + 别名都归 target（去掉和 target 撞名的）
    taken = {target.name, *target.aliases}
    incoming = [n for n in (source.name, *source.aliases) if n and n not in taken]
    target.aliases = list(dict.fromkeys([*target.aliases, *incoming]))

    # 2) 摘要只在为空时借用 —— 不自动拼接，免得污染人工写过的内容
    if not (target.body.get("摘要") or "").strip():
        target.body["摘要"] = source.body.get("摘要", "")

    # 3) 出场记录按章号去重并入；首现取更早的
    seen_ap = {(str(r[0]) if isinstance(r, list) else str(r)) for r in target.body.get("出场记录", [])}
    for row in source.body.get("出场记录", []):
        key = str(row[0]) if isinstance(row, list) else str(row)
        if key not in seen_ap:
            target.body.setdefault("出场记录", []).append(row)
            seen_ap.add(key)
    src_first, tgt_first = _chapter_no_of(source.first_appear), _chapter_no_of(target.first_appear)
    if src_first < tgt_first:
        target.first_appear = source.first_appear

    # 4) 关联 / 待补充并入（关联行保持原文，双链改写交给第 6 步统一做）
    for key in ("关联", "待补充"):
        rows = target.body.get(key) or []
        rows += [r for r in (source.body.get(key) or []) if r not in rows]
        target.body[key] = rows

    # 5) 出处并入（出处永不丢失）—— 合并这件事本身也记一条
    for s in source.provenance.get("sources", []):
        target.provenance.setdefault("sources", []).append(s)
    target.provenance.setdefault("sources", []).append(
        {"merged_from": source.id, "merged_name": source.name, "merged_at": now_iso()}
    )
    target.updated_at = now_iso()

    # 6) 保存 target，改写全库双链，再删 source
    save_entity_file(target)
    src_names = [n for n in (source.name, *source.aliases) if n]
    owner = name_owner or {}
    unambiguous = [n for n in src_names if owner.get(n) == source_id]
    skipped = [n for n in src_names if owner.get(n) not in (None, source_id)]
    moved_links = rewrite_links_to(book_id, unambiguous, target.name,
                                   skip_paths={t_path, src_path} if src_path else {t_path})
    if src_path and src_path.exists():
        # 路径安全闸 + 删前备份（合并结果已写进 target、双链也改过了，
        # 但至少 source 原文还能从快照里捞回来）
        try:
            src_checked = paths.ensure_inside_book(book_id, src_path)
        except ValueError as exc:
            raise ValueError(str(exc)) from exc
        try:
            snapshot.snapshot_files(book_id, [src_checked], reason=f"merge-{source_id}")
        except OSError as exc:
            raise ValueError(f"合并前快照失败，已中止：{exc}") from exc
        src_checked.unlink()

    return {
        "target": target.id,
        "source": source.id,
        "absorbed_names": incoming,
        "moved_links": moved_links,
        "skipped_ambiguous": skipped,
    }
