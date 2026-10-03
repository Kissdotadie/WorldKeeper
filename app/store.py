"""SQLite 索引 —— 可抛弃的派生数据。

**铁律：索引零独占状态。**
任何时候删掉 `index.db`，都必须能仅凭 Markdown 文件重建出完全一致的数据。
因此这里不存任何「只在索引里存在」的信息（审核状态、偏好、视图装饰都在别处落文件）。

**检索策略**（P11-A4）：
- 可搜的文本**只有一处真源** —— `entities_fts` 里存的就是「名字 + 别名 + 标签 + 摘要 + 正文」
  拼起来的全文。两条检索路径都打这张表，只是取数手段不同，所以不会出现
  「用 FTS 搜得到、换成短词就搜不到」这种口径漂移。
- 词长 ≥3 走 FTS5(trigram 分词)，有索引、有 bm25 排序；
  **词长 1~2 走 LIKE** —— trigram 分词器要求查询串至少 3 个字符，中文人名地名
  恰恰大量是两个字（「裴渊」「中州」），这条回退路不是补丁，是必经之路。
  代价是全表 LIKE 扫描（千条量级、毫秒级），换来的是「短词也能搜到正文」。
- 查询按空白切成多个词，词与词是 **AND**（都要命中）。
  以前的写法把整串当一个短语，搜「裴渊 剑」等于找一个包含空格的连续子串 —— 什么都搜不到。
- 高亮**由这里算**：返回的是纯文本片段 + 命中区间 `spans`（相对片段的下标对），
  由前端按区间包 `<mark>`。**刻意不返回 `<mark>` HTML 文本** ——
  正文是用户写的，里面真出现 `<mark>` 三个字不该被当成标记；而前端一旦改用
  `innerHTML` 渲染，用户正文里的一段 `<img onerror=...>` 就成了注入面。
"""

from __future__ import annotations

import atexit
import hashlib
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable

from . import config, entities, paths
from .logging_setup import get_logger
from .models import Entity

log = get_logger(__name__)

#: 索引结构版本。改表结构就 +1 —— 启动时发现不一致会直接丢表重建（索引可抛弃）。
SCHEMA_VERSION = 3

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS books (
    book_id      TEXT PRIMARY KEY,
    title        TEXT,
    author       TEXT,
    path         TEXT,
    entity_count INTEGER DEFAULT 0,
    updated_at   TEXT
);

CREATE TABLE IF NOT EXISTS entities (
    id           TEXT NOT NULL,
    book_id      TEXT NOT NULL,
    type         TEXT NOT NULL,
    name         TEXT NOT NULL,
    file_path    TEXT,
    status       TEXT,
    first_appear TEXT,
    icon         TEXT,
    summary      TEXT,
    updated_at   TEXT,
    -- ID 是「书内」编号（char-0001），因此主键必须带 book_id，
    -- 否则两本书的 char-0001 会互相顶掉（多书并行的前提）
    PRIMARY KEY (book_id, id)
);
CREATE INDEX IF NOT EXISTS idx_entities_book ON entities(book_id, type);

CREATE TABLE IF NOT EXISTS entity_aliases (
    book_id   TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    alias     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alias_lookup ON entity_aliases(book_id, alias);

CREATE TABLE IF NOT EXISTS entity_tags (
    book_id   TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    tag       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tag_lookup ON entity_tags(book_id, tag);

-- 方法论引用：真源是实体 frontmatter 里的 methodologies 字段。
-- 单拎一张表，是为了能反查「谁信奉晨曦主义」而不必扫全部文件。
CREATE TABLE IF NOT EXISTS entity_methodologies (
    book_id       TEXT NOT NULL,
    entity_id     TEXT NOT NULL,
    methodology   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meth_lookup ON entity_methodologies(book_id, methodology);

CREATE TABLE IF NOT EXISTS relations (
    book_id   TEXT NOT NULL,
    from_id   TEXT NOT NULL,
    to_name   TEXT NOT NULL,
    to_id     TEXT,
    kind      TEXT,
    source    TEXT
);
CREATE INDEX IF NOT EXISTS idx_rel_from ON relations(book_id, from_id);

CREATE TABLE IF NOT EXISTS appearances (
    book_id   TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    chapter   TEXT NOT NULL,
    note      TEXT
);

CREATE TABLE IF NOT EXISTS chapters (
    book_id     TEXT NOT NULL,
    chapter_no  INTEGER,
    title       TEXT,
    volume      TEXT,
    file_path   TEXT,
    source_file TEXT,
    summary     TEXT,
    hook        TEXT,
    emotion     TEXT,
    word_count  INTEGER,
    PRIMARY KEY (book_id, chapter_no)
);

CREATE TABLE IF NOT EXISTS file_fingerprints (
    book_id  TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    mtime    REAL,
    size     INTEGER,
    hash     TEXT,
    PRIMARY KEY (book_id, rel_path)
);

CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
    entity_id UNINDEXED,
    book_id   UNINDEXED,
    name,
    aliases,
    tags,
    summary,
    body,
    tokenize = 'trigram'
);
"""


#: 已经确保过建表的数据目录。「程序目录 != 数据目录」意味着数据目录可能在
#: 运行期被换掉（测试、便携模式），所以记的是目录而不是布尔值。
_ready_for: str | None = None


# ---------------------------------------------------------------------------
# 「守连接」—— 一条只开不查的常驻连接
# ---------------------------------------------------------------------------
#
# 为什么要它：WAL 库要 mmap 一个 `-shm` 共享内存文件，**第一个连接建它、
# 最后一个连接拆它**。在这台 Windows 上，这一下要 **约 70ms**；而
# `connect()` 是每次数据操作都调一次 —— 全站每调一次白交 70ms。
#
# 实测（本机，1169 条实体的库，每次操作各开一次连接）：
#
# | 方案                        | 读一次 | 写一条  |
# |----------------------------|-------|--------|
# | WAL，无守连接（原状）          | ~110ms | ~117ms |
# | **WAL + 一条守连接**          | **4.2ms** | **11.9ms** |
# | 普通日志（非 WAL），无守连接     | ~2ms   | ~61ms  |
#
# 结论：**保留 WAL 再加一条守连接**两侧都最好。顺带说明为什么不是
# 「干脆不用 WAL」—— 普通日志每条 commit 都要 fsync，写入反而慢 5 倍。
#
# 这条连接**从不在上面执行查询**，只为了让 `-shm` 不被拆掉。
# 它唯一的副作用是：在 Windows 上会占住索引文件的句柄（删不掉），
# 所以凡是「删索引文件」的地方必须先 `close_keeper()` —— 这是显式的、
# 有意的代价，而不是悄悄失效。
_keeper_conn: sqlite3.Connection | None = None
_keeper_stamp: tuple | None = None
_keeper_lock = threading.Lock()


def _file_stamp(db: Path) -> tuple | None:
    """文件的**身份**（设备号 + inode），用来认「这还是同一个库吗」。

    刻意不拿 mtime/size —— 那两者每次写入都变，会导致连接被反复重建。
    Windows 上 Python 也会填 st_ino（文件索引），删掉重建后会变，实测可用。
    """
    try:
        st = db.stat()
    except OSError:
        return None
    return (st.st_dev, st.st_ino)


def _keeper() -> sqlite3.Connection | None:
    """确保有一条常驻连接守着当前索引库。"""
    global _keeper_conn, _keeper_stamp
    db = paths.index_file()
    db.parent.mkdir(parents=True, exist_ok=True)
    stamp = _file_stamp(db)
    if _keeper_conn is not None and stamp is not None and stamp == _keeper_stamp:
        return _keeper_conn
    with _keeper_lock:
        # 双重检查：等锁期间别人可能已经建好了
        stamp = _file_stamp(db)
        if _keeper_conn is not None and stamp is not None and stamp == _keeper_stamp:
            return _keeper_conn
        close_keeper()
        try:
            conn = sqlite3.connect(str(db), timeout=15.0, check_same_thread=False)
            # WAL 是库文件的持久属性，设一次就记住；由守连接来设，
            # 是因为它**先于**任何业务连接建立，此刻没人和它抢锁。
            mode = conn.execute("PRAGMA journal_mode=WAL").fetchone()[0]
            conn.execute("PRAGMA synchronous=NORMAL").fetchone()
            # ⚠️ **这一步不能省**：在一张刚建出来的空文件上设 WAL，只是把标志位
            # 写进文件头，**并不会建立 `-shm`**。守连接若不真去读一下，
            # 就是「挂着一条连接却没 attach 到共享内存」—— 下一个业务连接照样
            # 自己建 `-shm`、自己拆掉，每次 70ms 的老毛病原样复发（而且看上去
            # 守连接明明在）。真读一次才会把 `-shm` 建起来并一直占住。
            conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
            if str(mode).lower() != "wal":
                log.warning("索引没切成 WAL（当前 %s），本次运行检索会偏慢", mode)
        except sqlite3.Error as exc:
            # 切不过去也不能把业务拖垮 —— 只是回到「每次都慢」的老样子
            log.warning("守连接建立失败（%s），本次运行检索会偏慢", exc)
            return None
        _keeper_conn = conn
        _keeper_stamp = _file_stamp(db)
        return conn


def close_keeper() -> None:
    """放掉守连接。

    **凡是「删掉索引文件」的地方都要先调它** —— Windows 上句柄还在就删不掉，
    而删索引是「索引坏了就重建」这条自愈路径的第一步。
    """
    global _keeper_conn, _keeper_stamp
    conn, _keeper_conn = _keeper_conn, None
    _keeper_stamp = None
    if conn is not None:
        try:
            conn.close()
        except sqlite3.Error:
            pass


atexit.register(close_keeper)


def ensure_tables() -> None:
    """惰性建表 —— startup 没跑到也不会一读就崩（「架构必须可自愈」）。

    正常启动路径是 main.py 的 startup 调 init_schema()；
    但脚本、测试、或异常启动都可能绕过它。这里兜一道。
    """
    global _ready_for
    try:
        current = str(paths.data_dir())
    except Exception:
        return
    if _ready_for == current:
        return
    # 先置位再建表：init_schema() 内部会调 connect()，不置位会无限递归
    _ready_for = current
    try:
        init_schema()
    except Exception as exc:  # 建不了也别把调用方拖垮，让它去报自己的错
        log.warning("惰性建表失败（可稍后在界面里重建索引）：%s", exc)


@contextmanager
def connect():
    """每次操作独立连接。换来的是线程安全与零状态。

    ⚠️ **`PRAGMA journal_mode` 不在这里设**，原因见下面 `_keeper()` 的说明。
    """
    ensure_tables()
    _keeper()
    db = paths.index_file()
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db), timeout=15.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA foreign_keys=ON")
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_schema() -> None:
    """建表。若库里的 schema_version 与代码不一致，直接丢掉重建 —— 索引本来就是可抛弃的。"""
    if paths.index_file().exists():
        _drop_if_stale()
    with connect() as conn:
        conn.executescript(SCHEMA_SQL)
        conn.execute(
            "INSERT INTO meta(key, value) VALUES('schema_version', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (str(SCHEMA_VERSION),),
        )


def _drop_if_stale() -> None:
    try:
        with connect() as conn:
            row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            if row is not None and str(row["value"]) == str(SCHEMA_VERSION):
                return
            log.info("索引结构版本变更（%s -> %s），丢弃旧索引待重建", row["value"] if row else "?", SCHEMA_VERSION)
            conn.executescript(
                "DROP TABLE IF EXISTS entities_fts;"
                "DROP TABLE IF EXISTS entities;"
                "DROP TABLE IF EXISTS entity_aliases;"
                "DROP TABLE IF EXISTS entity_tags;"
                "DROP TABLE IF EXISTS entity_methodologies;"
                "DROP TABLE IF EXISTS relations;"
                "DROP TABLE IF EXISTS appearances;"
                "DROP TABLE IF EXISTS chapters;"
                "DROP TABLE IF EXISTS file_fingerprints;"
                "DROP TABLE IF EXISTS books;"
                "DROP TABLE IF EXISTS meta;"
            )
    except sqlite3.DatabaseError as exc:
        log.warning("旧索引无法读取（%s），直接删除重建", exc)
        # 先放掉守连接 —— Windows 上句柄还占着就删不掉文件，
        # 那会让「索引坏了就重建」这条自愈路径**静默失效**
        close_keeper()
        for suffix in ("", "-wal", "-shm"):
            try:
                Path(str(paths.index_file()) + suffix).unlink(missing_ok=True)
            except OSError as unlink_exc:
                log.warning("删不掉 %s（%s），重建可能不彻底", suffix or "index.db", unlink_exc)


def is_initialized() -> bool:
    if not paths.index_file().exists():
        return False
    try:
        with connect() as conn:
            row = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='entities'").fetchone()
            return row is not None
    except Exception:
        return False


def file_hash(path: Path) -> str:
    h = hashlib.blake2b(digest_size=16)
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return ""


# --------------------------------------------------------------------------
# 写入
# --------------------------------------------------------------------------

def _entity_body_text(entity: Entity) -> str:
    parts = [entity.body.get("摘要", "")]
    for row in entity.body.get("属性", []):
        parts.append(" ".join(str(c) for c in row))
    for row in entity.body.get("出场记录", []):
        parts.append(" ".join(str(c) for c in row))
    parts.extend(str(x) for x in entity.body.get("关联", []))
    parts.extend(str(x) for x in entity.body.get("待补充", []))
    return "\n".join(p for p in parts if p)


def upsert_entity(conn: sqlite3.Connection, entity: Entity) -> None:
    meta = entity.to_meta()
    conn.execute(
        """INSERT INTO entities(id, book_id, type, name, file_path, status, first_appear, icon, summary, updated_at)
           VALUES(:id, :book_id, :type, :name, :file_path, :status, :first_appear, :icon, :summary, :updated_at)
           ON CONFLICT(book_id, id) DO UPDATE SET
             type=excluded.type, name=excluded.name,
             file_path=excluded.file_path, status=excluded.status,
             first_appear=excluded.first_appear, icon=excluded.icon, summary=excluded.summary,
             updated_at=excluded.updated_at""",
        meta,
    )

    for table, column in (("entity_aliases", "alias"), ("entity_tags", "tag")):
        conn.execute(f"DELETE FROM {table} WHERE book_id=? AND entity_id=?", (entity.book_id, entity.id))
        values = entity.aliases if column == "alias" else entity.tags
        for v in values:
            if str(v).strip():
                conn.execute(
                    f"INSERT INTO {table}(book_id, entity_id, {column}) VALUES(?,?,?)",
                    (entity.book_id, entity.id, str(v).strip()),
                )

    # 方法论引用（真源在 frontmatter，这里只做派生索引）
    conn.execute("DELETE FROM entity_methodologies WHERE book_id=? AND entity_id=?", (entity.book_id, entity.id))
    for m in entity.methodologies:
        if str(m).strip():
            conn.execute(
                "INSERT INTO entity_methodologies(book_id, entity_id, methodology) VALUES(?,?,?)",
                (entity.book_id, entity.id, str(m).strip()),
            )

    # 关系：真源是正文里的 [[双链]]，这里只做派生
    conn.execute("DELETE FROM relations WHERE book_id=? AND from_id=?", (entity.book_id, entity.id))
    for rel in entity.body.get("关联", []):
        text = str(rel)
        kind: str | None = None
        if "：" in text:
            candidate = text.split("：", 1)[0].strip()
            if candidate and "[[" not in candidate and len(candidate) <= 12:
                kind = candidate
        for target in _extract_links(text):
            conn.execute(
                "INSERT INTO relations(book_id, from_id, to_name, to_id, kind, source) VALUES(?,?,?,?,?,?)",
                (entity.book_id, entity.id, target, None, kind, "关联"),
            )

    # 方法论也进关系图 —— 这样「角色 → 信奉的方法论」在关系网里看得见。
    # source 标成「方法论」，好和正文里的双链区分开。
    for m in entity.methodologies:
        conn.execute(
            "INSERT INTO relations(book_id, from_id, to_name, to_id, kind, source) VALUES(?,?,?,?,?,?)",
            (entity.book_id, entity.id, str(m).strip(), None, "方法论", "方法论"),
        )

    conn.execute("DELETE FROM appearances WHERE book_id=? AND entity_id=?", (entity.book_id, entity.id))
    for row in entity.body.get("出场记录", []):
        if len(row) >= 2 and str(row[0]).strip():
            conn.execute(
                "INSERT INTO appearances(book_id, entity_id, chapter, note) VALUES(?,?,?,?)",
                (entity.book_id, entity.id, str(row[0]).strip(), str(row[1]).strip()),
            )

    conn.execute("DELETE FROM entities_fts WHERE book_id=? AND entity_id=?", (entity.book_id, entity.id))
    conn.execute(
        "INSERT INTO entities_fts(entity_id, book_id, name, aliases, tags, summary, body) VALUES(?,?,?,?,?,?,?)",
        (
            entity.id,
            entity.book_id,
            entity.name,
            " ".join(entity.aliases),
            " ".join(entity.tags),
            entity.body.get("摘要", ""),
            _entity_body_text(entity),
        ),
    )


def _extract_links(text: str) -> list[str]:
    import re

    return [m.strip() for m in re.findall(r"\[\[([^\[\]]+)\]\]", text) if m.strip()]


def delete_entity(conn: sqlite3.Connection, book_id: str, entity_id: str) -> None:
    for table in ("entities", "entity_aliases", "entity_tags", "entity_methodologies",
                  "relations", "appearances"):
        if table == "relations":
            conn.execute(f"DELETE FROM {table} WHERE book_id=? AND from_id=?", (book_id, entity_id))
        elif table == "entities":
            conn.execute(f"DELETE FROM {table} WHERE book_id=? AND id=?", (book_id, entity_id))
        else:
            conn.execute(f"DELETE FROM {table} WHERE book_id=? AND entity_id=?", (book_id, entity_id))
    conn.execute("DELETE FROM entities_fts WHERE book_id=? AND entity_id=?", (book_id, entity_id))


def upsert_entity_single(entity: Entity) -> None:
    """单条实体落盘后同步索引（不需要全量重建）。"""
    with connect() as conn:
        upsert_entity(conn, entity)
        _record_fingerprint(conn, entity.book_id, entity.file_path)


def delete_entity_single(book_id: str, entity_id: str) -> None:
    with connect() as conn:
        delete_entity(conn, book_id, entity_id)


def delete_entities_bulk(book_id: str, entity_ids: list[str]) -> None:
    """一批实体共用一个事务删掉。

    逐条走 `delete_entity_single` 的话，每条都要开一次连接、提交一次、让 WAL
    落一次盘 —— 上百条就能拖到分钟级，界面看着像卡死。批量清理必须走这里。
    """
    if not entity_ids:
        return
    with connect() as conn:
        for eid in entity_ids:
            delete_entity(conn, book_id, eid)


def rebuild_book_relations(book_id: str) -> None:
    """重算 [[双链]] 到实体 ID 的解析结果（关系真源仍是双链本身）。"""
    with connect() as conn:
        _resolve_relations(conn, book_id)


# --------------------------------------------------------------------------
# 全量重建（索引可抛弃的核心保证）
# --------------------------------------------------------------------------

def rebuild_book(book_id: str) -> dict:
    """从 Markdown 全量重建某一本书的索引。"""
    started = time.time()
    cfg = config.load_book_config(book_id)

    with connect() as conn:
        for table in ("entities", "entity_aliases", "entity_tags", "entity_methodologies",
                      "relations", "appearances", "chapters"):
            conn.execute(f"DELETE FROM {table} WHERE book_id=?", (book_id,))
        conn.execute("DELETE FROM entities_fts WHERE book_id=?", (book_id,))
        conn.execute("DELETE FROM file_fingerprints WHERE book_id=?", (book_id,))

        count = 0
        for entity in entities.load_all_entities(book_id):
            if not entity.id:
                continue
            upsert_entity(conn, entity)
            count += 1
            _record_fingerprint(conn, book_id, entity.file_path)

        # 关系回填：把 [[名字]] 解析成实体 ID（关系真源是双链，这里只是补解析结果）
        _resolve_relations(conn, book_id)

        conn.execute(
            """INSERT INTO books(book_id, title, author, path, entity_count, updated_at)
               VALUES(?,?,?,?,?,datetime('now'))
               ON CONFLICT(book_id) DO UPDATE SET
                 title=excluded.title, author=excluded.author,
                 path=excluded.path, entity_count=excluded.entity_count,
                 updated_at=excluded.updated_at""",
            (book_id, cfg.get("title") or book_id, cfg.get("author") or "",
             str(paths.book_dir(book_id)), count),
        )

    # 章节正文（真源是 chapters/*.md）。放在 with 之外，避免嵌套连接
    sync_chapters(book_id)

    elapsed = round(time.time() - started, 3)
    log.info("重建索引完成：%s，%s 个实体，耗时 %ss", book_id, count, elapsed)
    return {"book_id": book_id, "entities": count, "elapsed_seconds": elapsed}


def rebuild_all(on_book=None) -> dict:
    """重建全部书目的索引。

    `on_book(result)` 每重建完一本被调一次（P11-A3 的任务进度靠它）——
    做成回调而不是把循环搬到调用方，是为了让「幽灵条目清理 + 逐本重建」
    这套语义**只有一处实现**。回调里抛异常会中断整个重建（任务中断就是这样）。
    """
    init_schema()
    on_disk = {b["book_id"] for b in entities.list_books()}
    # 手删过目录的书：索引里还留着它的行 —— 那是**幽灵条目**。
    # 书目列表看不见它（列表读的是磁盘），但按 id 查还能查出来，
    # 「不一致体检」这类全库扫描也还会把它的数据算进去。
    # 重建索引本来就是自愈手段，顺手把这种残留清掉。
    for stale in sorted(known_book_ids() - on_disk):
        log.info("索引里残留着已不存在的书目「%s」，已清除其全部记录", stale)
        forget_book(stale)
    results = []
    for b in entities.list_books():
        r = rebuild_book(b["book_id"])
        results.append(r)
        if on_book is not None:
            on_book(r)
    return {"books": results, "total_entities": sum(r["entities"] for r in results)}


def known_book_ids() -> set[str]:
    """索引里出现过的全部 book_id（含磁盘上已经没有的）。"""
    out: set[str] = set()
    with connect() as conn:
        for table in ("entities", "books", "chapters"):
            try:
                for r in conn.execute(f"SELECT DISTINCT book_id FROM {table}"):
                    if r["book_id"]:
                        out.add(str(r["book_id"]))
            except sqlite3.DatabaseError:
                continue
    return out


def forget_book(book_id: str) -> None:
    """把某一本书的行从索引里**彻底抹掉**（书目目录已经不在了时用）。

    注意这是「忘掉索引里的记录」，不是「删数据」—— 数据真源是磁盘上的
    Markdown，目录没了记录还留着才是问题（幽灵条目）。
    """
    with connect() as conn:
        for table in ("entities", "entity_aliases", "entity_tags", "entity_methodologies",
                      "relations", "appearances", "chapters", "file_fingerprints", "books"):
            conn.execute(f"DELETE FROM {table} WHERE book_id=?", (book_id,))
        conn.execute("DELETE FROM entities_fts WHERE book_id=?", (book_id,))
    log.info("已清除书目「%s」在索引里的全部记录", book_id)


def _record_fingerprint(conn: sqlite3.Connection, book_id: str, file_path: str | None) -> None:
    if not file_path:
        return
    p = Path(file_path)
    try:
        st = p.stat()
    except OSError:
        return
    conn.execute(
        """INSERT INTO file_fingerprints(book_id, rel_path, mtime, size, hash) VALUES(?,?,?,?,?)
           ON CONFLICT(book_id, rel_path) DO UPDATE SET
             mtime=excluded.mtime, size=excluded.size, hash=excluded.hash""",
        (book_id, p.name, st.st_mtime, st.st_size, file_hash(p)),
    )


def _resolve_relations(conn: sqlite3.Connection, book_id: str) -> None:
    """把关系里的目标名字解析成实体 ID（名字或别名均可命中）。"""
    rows = conn.execute("SELECT rowid, to_name FROM relations WHERE book_id=?", (book_id,)).fetchall()
    if not rows:
        return
    name_map: dict[str, str] = {}
    for r in conn.execute("SELECT id, name FROM entities WHERE book_id=?", (book_id,)):
        name_map[str(r["name"]).strip()] = r["id"]
    for r in conn.execute("SELECT entity_id, alias FROM entity_aliases WHERE book_id=?", (book_id,)):
        name_map.setdefault(str(r["alias"]).strip(), r["entity_id"])

    for row in rows:
        target = name_map.get(str(row["to_name"]).strip())
        if target:
            conn.execute("UPDATE relations SET to_id=? WHERE rowid=?", (target, row["rowid"]))


# --------------------------------------------------------------------------
# 查询
# --------------------------------------------------------------------------

def list_entities(book_id: str, type_key: str | None = None, tag: str | None = None,
                  sort: str = "name") -> list[dict]:
    # 别名 / 标签顺手聚合出来 —— 列表、表格、卡片都得用，
    # 免得前端为每一条再发一次详情请求
    sql = (
        "SELECT e.*,"
        "  (SELECT group_concat(a.alias, '、') FROM entity_aliases a"
        "    WHERE a.book_id=e.book_id AND a.entity_id=e.id) AS aliases,"
        "  (SELECT group_concat(t.tag, '、') FROM entity_tags t"
        "    WHERE t.book_id=e.book_id AND t.entity_id=e.id) AS tags,"
        "  (SELECT group_concat(m.methodology, '、') FROM entity_methodologies m"
        "    WHERE m.book_id=e.book_id AND m.entity_id=e.id) AS methodologies"
        " FROM entities e WHERE e.book_id=?"
    )
    params: list[Any] = [book_id]
    if type_key:
        sql += " AND e.type=?"
        params.append(type_key)
    if tag:
        sql += " AND e.id IN (SELECT entity_id FROM entity_tags WHERE book_id=? AND tag=?)"
        params.extend([book_id, tag])

    order = {"name": "e.name COLLATE NOCASE", "updated": "e.updated_at DESC", "type": "e.type, e.name"}.get(sort, "e.name")
    sql += f" ORDER BY {order}"
    with connect() as conn:
        rows = [dict(r) for r in conn.execute(sql, params)]
    for r in rows:
        r["aliases"] = [s for s in (r.get("aliases") or "").split("、") if s]
        r["tags"] = [s for s in (r.get("tags") or "").split("、") if s]
        r["methodologies"] = [s for s in (r.get("methodologies") or "").split("、") if s]
    return rows


def get_entity(book_id: str, entity_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM entities WHERE book_id=? AND id=?", (book_id, entity_id)).fetchone()
        if not row:
            return None
        out = dict(row)
        out["aliases"] = [r["alias"] for r in conn.execute(
            "SELECT alias FROM entity_aliases WHERE book_id=? AND entity_id=?", (book_id, entity_id))]
        out["tags"] = [r["tag"] for r in conn.execute(
            "SELECT tag FROM entity_tags WHERE book_id=? AND entity_id=?", (book_id, entity_id))]
        out["methodologies"] = [r["methodology"] for r in conn.execute(
            "SELECT methodology FROM entity_methodologies WHERE book_id=? AND entity_id=?",
            (book_id, entity_id))]
        out["appearances"] = [dict(r) for r in conn.execute(
            "SELECT chapter, note FROM appearances WHERE book_id=? AND entity_id=? ORDER BY chapter",
            (book_id, entity_id))]
        out["relations"] = [dict(r) for r in conn.execute(
            "SELECT to_name, to_id, kind FROM relations WHERE book_id=? AND from_id=?", (book_id, entity_id))]
    return out


#: trigram 分词器要求查询串至少这么多个字符 —— 更短的词请走 LIKE。
#: 这个数字不是拍脑袋：SQLite 的 trigram 分词器按 3 个连续字符切 token，
#: 两字符的查询串切不出任何 token，MATCH 只会返回空结果（而且不报错，
#: 静默漏掉 —— 那才是最坑的）。
FTS_MIN_CHARS = 3

#: 片段窗口宽度（字符）。命中处居中，两侧各留一半。
SNIPPET_WIDTH = 90


def _terms(q: str) -> list[str]:
    """把查询串切成词。空白分词，词与词是 AND。"""
    return [t for t in (q or "").split() if t]


def _fts_query(terms: list[str]) -> str:
    """把词列表转成安全的 FTS5 查询串：每个词加引号当短语，词间 AND。

    加引号是为了让词里的 `-` `*` `(` 之类的 FTS5 语法字符失效 ——
    用户搜 `破-军` 时不该因为一个连字符就把整个查询判成语法错。
    """
    return " AND ".join('"' + t.replace('"', '""') + '"' for t in terms)


def _window(text: str, terms: list[str]) -> tuple[str, list[list[int]]]:
    """从长文本里裁一小段出来，并给出命中区间。

    返回 `(片段, [[起, 止], ...])`，区间是**相对片段**的字符下标（左闭右开）。
    一处命中都没有时返回开头那一段与空区间 —— 调用方仍能拿它当摘要显示。
    """
    text = text or ""
    if not text:
        return "", []
    if not terms:
        return text[:SNIPPET_WIDTH], []

    low = text.lower()
    hits: list[tuple[int, int]] = []
    for t in terms:
        tl = t.lower()
        if not tl:
            continue
        start = 0
        while True:
            i = low.find(tl, start)
            if i < 0:
                break
            hits.append((i, i + len(t)))
            # 从命中处往后一格继续找 —— 允许重叠词各自报一次，
            # 但绝不能原地打转（词非空，至少前进 1）
            start = i + 1
    hits.sort()

    if not hits:
        return text[:SNIPPET_WIDTH], []

    # 窗口以**第一处命中**为中心。取第一处而不是全部：片段只有一行宽，
    # 把远处那处命中硬塞进来只会让片段变成两段不相干的文字。
    first_at = hits[0][0]
    left = max(0, first_at - SNIPPET_WIDTH // 2)
    right = min(len(text), left + SNIPPET_WIDTH)
    left = max(0, right - SNIPPET_WIDTH)  # 贴到尾部时把窗口往左拉满

    cut = text[left:right]
    spans: list[list[int]] = []
    for a, b in hits:
        a2, b2 = a - left, b - left
        if b2 <= 0 or a2 >= len(cut):
            continue  # 落在窗口外
        a2, b2 = max(0, a2), min(len(cut), b2)
        if spans and a2 <= spans[-1][1]:
            # 与上一处重叠/相接 → 合并，免得前端渲染出嵌套的 <mark>
            spans[-1][1] = max(spans[-1][1], b2)
        else:
            spans.append([a2, b2])

    # 用省略号标出「这不是全文」。三个点占一个字符位，真实下标要跟着平移。
    prefix = 1 if left > 0 else 0
    if prefix:
        cut = "…" + cut
    suffix = 1 if right < len(text) else 0
    if suffix:
        cut = cut + "…"
    spans = [[a + prefix, b + prefix] for a, b in spans]
    return cut, spans


#: LIKE 路最多捞这么多行再排序。多词短查询可能命中一大片，
#: 全捞进内存没必要；这个上限远高于任何一屏能看的量。
LIKE_ROW_CAP = 1000


def _hit_kind(name: str, aliases: str, tags: str, terms: list[str]) -> int:
    """命中在哪一层 —— 数字越小越该排前面。

    排序有据，不是「数据库爱怎么给就怎么给」：名字是人的第一直觉，
    正文里恰好提了一次是另一回事。
    """
    low_name = (name or "").lower()
    for t in terms:
        if t.lower() in low_name:
            return 0
    low_rest = ((aliases or "") + "\n" + (tags or "")).lower()
    for t in terms:
        if t.lower() in low_rest:
            return 1
    return 2


def _snippet_of(row, terms: list[str]) -> tuple[str, list[list[int]]]:
    """挑一个最能说明「为什么它被搜出来」的片段。

    优先摘要在前正文在后：摘要是人写的门面，正文是流水。
    只有名字/别名/标签命中时才落到「摘要开头」这种没有高亮的片段 ——
    那种情况下高亮本就该打在前端渲染的名字上。
    """
    for field in (row["summary"], row["body"]):
        snip, spans = _window(field or "", terms)
        if spans:
            return snip, spans
    return _window(row["summary"] or row["body"] or "", terms)


def search(book_id: str, q: str, limit: int = 50) -> list[dict]:
    """全文检索。

    返回的每条都带 `snippet`（纯文本片段）与 `spans`（高亮区间，相对片段），
    另外标了这次走的哪条路（`engine`：`"fts"` 或 `"like"`）——
    排查「为什么这条搜不到」时，第一件要知道的就是它到底走没走索引。
    """
    terms = _terms(q)
    if not terms:
        return []

    # 所有词都得够长才敢走 FTS5：只要有一个短词，trigram 对它无能为力，
    # 而 MATCH 会**静默地**少算那个词（结果看着对、其实漏了一片）。
    use_fts = all(len(t) >= FTS_MIN_CHARS for t in terms)
    engine = "fts" if use_fts else "like"

    select = """SELECT f.entity_id, f.name, f.aliases, f.tags, f.summary, f.body,
                       e.type AS type, {score} AS score
                FROM entities_fts f JOIN entities e ON e.id = f.entity_id
                WHERE f.book_id=? AND {cond}"""

    with connect() as conn:
        rows = []
        if use_fts:
            try:
                rows = conn.execute(
                    select.format(score="bm25(entities_fts)", cond="entities_fts MATCH ?"),
                    (book_id, _fts_query(terms)),
                ).fetchall()
            except sqlite3.OperationalError as exc:
                # 语法出问题就老实退到 LIKE，而不是回一个空列表让人以为「没有」
                log.warning("FTS 查询失败，退回 LIKE：%s", exc)
                engine = "like"

        if not rows and engine == "like":
            # 短词（或 FTS 失手）走 LIKE。打的是**同一张表** —— 所以
            # 「名字 / 别名 / 标签 / 摘要 / 正文」五处一起搜，不存在只搜前三处的缺口。
            #
            # 括号的层次是关键：**每种字段内 OR、词与词之间 AND**。
            # 写反了（列内 AND、跨列 OR）就成了「名字里得同时出现所有词」——
            # 那种查询对多词输入几乎永远返回空，而且看不出是写错了。
            cols = ("f.name", "f.aliases", "f.tags", "f.summary", "f.body")
            one_term = "(" + " OR ".join(f"COALESCE({c},'') LIKE ?" for c in cols) + ")"
            cond = " AND ".join(one_term for _ in terms)
            args: list[Any] = [book_id]
            for _t in terms:
                for _c in cols:
                    args.append(f"%{_t}%")
            try:
                rows = conn.execute(
                    select.format(score="0.0", cond=cond) + f" LIMIT {LIKE_ROW_CAP}",
                    args,
                ).fetchall()
            except sqlite3.OperationalError as exc:  # pragma: no cover - 兜底
                log.error("LIKE 检索也失败了：%s", exc)
                return []

        out: list[dict] = []
        for r in rows:
            snip, spans = _snippet_of(r, terms)
            out.append({
                "id": r["entity_id"],
                "name": r["name"],
                "type": r["type"],
                "summary": r["summary"],
                "snippet": snip,
                "spans": spans,
                "engine": engine,
                "_kind": _hit_kind(r["name"], r["aliases"] or "", r["tags"] or "", terms),
                "_score": r["score"],
            })

        # 先按「命中在哪一层」，再按 bm25（越小越相关），
        # 最后按名字短长、字典序 —— 保证同一份数据两次搜索顺序完全一致
        out.sort(key=lambda x: (x["_kind"], x["_score"], len(x["name"] or ""), x["name"] or ""))
        out = out[:limit]
        for x in out:
            del x["_kind"], x["_score"]
    return out


def stats(book_id: str) -> dict:
    with connect() as conn:
        by_type = {
            r["type"]: r["c"]
            for r in conn.execute(
                "SELECT type, COUNT(*) AS c FROM entities WHERE book_id=? GROUP BY type", (book_id,)
            )
        }
        total = conn.execute("SELECT COUNT(*) AS c FROM entities WHERE book_id=?", (book_id,)).fetchone()["c"]
        relations = conn.execute("SELECT COUNT(*) AS c FROM relations WHERE book_id=?", (book_id,)).fetchone()["c"]
    return {"book_id": book_id, "total": total, "by_type": by_type, "relations": relations}


#: 完备度口径（0~4 分）：有摘要 + 有标签 + (有别名或出场记录) + 有关系。
#:
#: ⚠️ **口径只此一处，别处必须照抄**。名册页（`api/views.py`）要逐条返回分数，
#: 那边是 Python 侧算的同一件事 —— 改这里必须同步改那里。两处一旦分叉，
#: 同一本册子会在「汇总页的平均完备度」和「名册页的每格」上给出两个答案。
_COMPLETENESS_SQL = """
    (CASE WHEN trim(coalesce(e.summary, '')) <> '' THEN 1 ELSE 0 END)
  + (CASE WHEN EXISTS (SELECT 1 FROM entity_tags t
                        WHERE t.book_id = e.book_id AND t.entity_id = e.id)
          THEN 1 ELSE 0 END)
  + (CASE WHEN EXISTS (SELECT 1 FROM entity_aliases a
                        WHERE a.book_id = e.book_id AND a.entity_id = e.id)
           OR EXISTS (SELECT 1 FROM appearances ap
                       WHERE ap.book_id = e.book_id AND ap.entity_id = e.id)
          THEN 1 ELSE 0 END)
  + (CASE WHEN EXISTS (SELECT 1 FROM relations r
                        WHERE r.book_id = e.book_id AND r.from_id = e.id)
          THEN 1 ELSE 0 END)
"""

#: 关系度数的分档。空档（某档一个都没有）也要返回，图上的横轴才稳定 ——
#: 否则「0 条」那档在某本书里会凭空消失，两本书的图没法对比。
_DEGREE_BUCKETS: list[tuple[str, int, int]] = [
    ("0", 0, 0),
    ("1-2", 1, 2),
    ("3-5", 3, 5),
    ("6-10", 6, 10),
    ("11+", 11, 10**9),
]


def dashboard_overview(book_id: str) -> dict:
    """汇总页要的全部数字，**一次往返拿完**。

    为什么单独做一个聚合接口，而不是让前端并发调五六个：汇总页是「打开首页」
    的路径，多一次往返就多一次白屏。这里只读索引、不扫文件，几百条实体的
    量级下全部查询合起来是毫秒级；索引旧了交给「重建索引」，不在这里兜底。
    """
    with connect() as conn:
        total = conn.execute(
            "SELECT COUNT(*) AS c FROM entities WHERE book_id=?", (book_id,)
        ).fetchone()["c"]
        by_type = {
            r["type"]: r["c"]
            for r in conn.execute(
                "SELECT type, COUNT(*) AS c FROM entities WHERE book_id=? GROUP BY type", (book_id,)
            )
        }

        rel = conn.execute(
            """SELECT COUNT(*) AS total,
                      SUM(CASE WHEN to_id IS NOT NULL THEN 1 ELSE 0 END) AS linked
               FROM relations WHERE book_id=?""",
            (book_id,),
        ).fetchone()
        rel_total = rel["total"] or 0
        rel_linked = rel["linked"] or 0

        tag_total = conn.execute(
            "SELECT COUNT(DISTINCT tag) AS c FROM entity_tags WHERE book_id=?", (book_id,)
        ).fetchone()["c"]
        top_tags = [
            {"name": r["tag"], "count": r["c"]}
            for r in conn.execute(
                """SELECT tag, COUNT(*) AS c FROM entity_tags WHERE book_id=?
                   GROUP BY tag ORDER BY c DESC, tag LIMIT 12""",
                (book_id,),
            )
        ]

        # ---- 完备度分布 ----
        score_rows = conn.execute(
            f"SELECT {_COMPLETENESS_SQL} AS score FROM entities e WHERE e.book_id=?",
            (book_id,),
        ).fetchall()
        buckets = [0, 0, 0, 0, 0]
        for r in score_rows:
            s = int(r["score"] or 0)
            if 0 <= s <= 4:
                buckets[s] += 1
        avg = round(sum(i * n for i, n in enumerate(buckets)) / total, 2) if total else 0.0

        # ---- 关系度数分布 + 谁连线最多 ----
        degrees = [
            (r["id"], r["name"], r["type"], r["d"] or 0)
            for r in conn.execute(
                """SELECT e.id, e.name, e.type,
                          (SELECT COUNT(*) FROM relations r
                            WHERE r.book_id = e.book_id AND r.from_id = e.id) AS d
                   FROM entities e WHERE e.book_id=?""",
                (book_id,),
            )
        ]
        deg_buckets = []
        for label, lo, hi in _DEGREE_BUCKETS:
            deg_buckets.append(
                {
                    "label": label,
                    "count": sum(1 for _, _, _, d in degrees if lo <= d <= hi),
                }
            )
        top_degree = [
            {"id": i, "name": n, "type": t, "count": d}
            for i, n, t, d in sorted(degrees, key=lambda x: -x[3])[:8]
            if d > 0
        ]

        # ---- 章节体量 ----
        ch_rows = conn.execute(
            """SELECT chapter_no, title, word_count FROM chapters
               WHERE book_id=? ORDER BY chapter_no""",
            (book_id,),
        ).fetchall()
        chapter_series = [
            {
                "no": r["chapter_no"],
                "title": r["title"] or "",
                "words": int(r["word_count"] or 0),
            }
            for r in ch_rows
        ]
        chapter_words = sum(c["words"] for c in chapter_series)

        # ---- 每章出场实体数（谁在哪一章登场）----
        appear = [
            {"chapter": str(r["chapter"]), "count": r["c"]}
            for r in conn.execute(
                """SELECT chapter, COUNT(DISTINCT entity_id) AS c FROM appearances
                   WHERE book_id=? GROUP BY chapter
                   ORDER BY CAST(chapter AS INTEGER), chapter""",
                (book_id,),
            )
        ]

    return {
        "book_id": book_id,
        "entities": {"total": total, "by_type": by_type},
        "relations": {
            "total": rel_total,
            "linked": rel_linked,
            "dangling": rel_total - rel_linked,
        },
        "tags": {"total": tag_total, "top": top_tags},
        "completeness": {"average": avg, "buckets": buckets},
        "degree": {"buckets": deg_buckets, "top": top_degree},
        "chapters": {
            "count": len(chapter_series),
            "words": chapter_words,
            "series": chapter_series,
        },
        "appearances": appear,
    }


def all_tags(book_id: str) -> list[str]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT DISTINCT tag FROM entity_tags WHERE book_id=? ORDER BY tag", (book_id,)
        ).fetchall()
    return [r["tag"] for r in rows]


def methodology_overview(book_id: str) -> dict:
    """方法论总览：每条方法论 + 信奉它的实体。

    真源是实体 frontmatter 的 methodologies 字段，这里是派生视图。
    方法论本身若已建成实体，则把它的 id 也带上（前端据此跳转）。
    """
    with connect() as conn:
        rows = conn.execute(
            """SELECT m.methodology AS name, m.entity_id AS entity_id,
                      e.name AS holder, e.type AS holder_type
               FROM entity_methodologies m
               LEFT JOIN entities e ON e.book_id=m.book_id AND e.id=m.entity_id
               WHERE m.book_id=?
               ORDER BY m.methodology, e.name""",
            (book_id,),
        ).fetchall()
        # 已建为实体的方法论（用于跳转与「有哪些方法论还没建实体」）
        known = {
            r["name"]: r["id"]
            for r in conn.execute(
                "SELECT id, name FROM entities WHERE book_id=? AND type='methodology'", (book_id,)
            )
        }

    bucket: dict[str, dict] = {}
    for r in rows:
        name = r["name"]
        item = bucket.setdefault(
            name,
            {"name": name, "id": known.get(name), "holders": [], "count": 0},
        )
        if r["holder"]:
            item["holders"].append({"id": r["entity_id"], "name": r["holder"], "type": r["holder_type"]})
            item["count"] += 1

    # 已建成实体但暂时没挂角色的方法论也要列出来，否则「建了却看不见」
    for name, eid in known.items():
        bucket.setdefault(name, {"name": name, "id": eid, "holders": [], "count": 0})

    items = sorted(bucket.values(), key=lambda x: (-x["count"], x["name"]))
    return {
        "book_id": book_id,
        "items": items,
        "total": len(items),
        # 被角色引用、但还没建成自己的实体文件 —— 前端提示「这些可以补建」
        "missing": sorted(n for n in bucket if not bucket[n]["id"]),
    }


def sync_chapters(book_id: str) -> int:
    """把 `chapters/*.md` 同步进索引表。

    章节真源是 Markdown 文件，这里只是派生 —— 索引删了能重建。
    """
    from . import chapters as ch_mod

    items = ch_mod.list_chapters(book_id)
    with connect() as conn:
        conn.execute("DELETE FROM chapters WHERE book_id=?", (book_id,))
        for c in items:
            conn.execute(
                """INSERT INTO chapters(book_id, chapter_no, title, volume, file_path,
                                        source_file, summary, hook, emotion, word_count)
                   VALUES(?,?,?,?,?,?,?,?,?,?)""",
                (book_id, c.chapter_no, c.title, c.volume, c.file_path,
                 c.source_file, "", "", "", c.word_count),
            )
    return len(items)


def list_chapters(book_id: str) -> list[dict]:
    with connect() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM chapters WHERE book_id=? ORDER BY chapter_no", (book_id,))]
    return rows


def changed_files(book_id: str) -> list[dict]:
    """检测被外部编辑器改动过的实体文件（第三梯队口子：数据指纹）。"""
    out: list[dict] = []
    with connect() as conn:
        known = {
            r["rel_path"]: (r["mtime"], r["size"])
            for r in conn.execute(
                "SELECT rel_path, mtime, size FROM file_fingerprints WHERE book_id=?", (book_id,)
            )
        }
    for path in entities.iter_entity_files(book_id):
        try:
            st = path.stat()
        except OSError:
            continue
        prev = known.get(path.name)
        if prev is None or abs(prev[0] - st.st_mtime) > 1e-6 or prev[1] != st.st_size:
            out.append({"file": path.name, "path": str(path)})
    return out
