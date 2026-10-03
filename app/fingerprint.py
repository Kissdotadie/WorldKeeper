"""数据指纹 —— 发现「你在外部编辑器改过 md」（P11-A5，第二梯队口子 #20）。

## 为什么需要它

Markdown 是唯一真源，所以你可以随时用任何编辑器改档案、改正文 —— 这是设计的一部分。
但工具不知道你改了：索引还是老的，界面上看到的是旧内容，直到你恰好重建索引。
等到「数据不一致」了再回头查，就变成破案了。

这里记下每个内容文件的 `mtime + 大小 + 内容 sha1`，进书时比一遍：

- **mtime 与大小都没动** → 一定没改，跳过（省掉读盘与哈希，1213 个文件约 30ms）
- **动了** → 再算 sha1 定真伪：**sha1 一样说明只是被 touch 过**（复制、同步盘、
  回收站还原都会改 mtime），不该拿它吓人

所以报告分两档：`content_changed`（内容真变了，值得重扫）与 `meta_only`（只是时间戳变了）。

## 存哪儿

`books/<书>/fingerprint.json`。它是**簿记**，既不是内容也不是装饰：

- 删掉它唯一的后果是下次进书重建一遍基线，档案一个字不动；
- 放书目录里是为了**跟着书走** —— 整书导出/搬走再导入，指纹一起过来，
  不会因为 mtime 全变而在新机器上当场报一屏假改动（sha1 相同就没事）。

**它不覆盖 `view/`**：那是布局/地图/样式/贴纸这些装饰层，工具写得频繁，
而且它们本来就不是内容真源（改烂最多图变样，实体一个字不少）。

## 怎么避免把自己改的东西报成「外部改动」

写盘方（中间件）在**请求成功之后**调 `schedule(book_id)` 排一次重扫 ——
一处覆盖全部写接口，不用逐个端点打补丁。漏一个补丁就会误报，
而中间件不会漏。排的是**延迟重扫**（见 `DEBOUNCE`），
这样批量导入 30 章不会连扫 30 遍，也避开「上一个写还没落完」的中间态。
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
from datetime import datetime
from pathlib import Path

from . import paths
from .logging_setup import get_logger

log = get_logger(__name__)

#: 文件名叫得直白些 —— 用户在文件管理器里看到也知道它是什么
FP_NAME = "fingerprint.json"
SCHEMA = 1

#: 不进指纹的顶层目录（装饰层）。
SKIP_TOP = {"view"}

#: 一次返回的变化条目上限 —— 整书被换掉时不该回一屏 JSON
MAX_REPORT = 200

#: 写操作之后延迟多久重扫。批量导入时把一串写合并成一次扫描，
#: 也避开「前一个写刚动完、后一个写正在写」的中间态。
DEBOUNCE = 1.2


# --------------------------------------------------------------------------
# 扫描
# --------------------------------------------------------------------------

def tracked_files(book_id: str) -> dict[str, Path]:
    """本书该纳入指纹的文件：`相对路径 -> 绝对路径`。

    判据是「内容真源」：实体档案、世界观文档、章节正文、时间线/伏笔、书目配置。
    排除 `view/`（装饰）、`fingerprint.json` 自己、以及任何点开头的文件
    （临时文件、.DS_Store 之类，不该因为它们报改动）。
    """
    root = paths.book_dir(book_id)
    if not root.is_dir():
        return {}
    out: dict[str, Path] = {}
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        try:
            rel = p.relative_to(root)
        except ValueError:
            continue
        parts = rel.parts
        if not parts:
            continue
        if parts[0] in SKIP_TOP or parts[0].startswith("."):
            continue
        if any(seg.startswith(".") for seg in parts):
            continue
        if rel.as_posix() == FP_NAME:
            continue
        out[rel.as_posix()] = p
    return out


def _sha1(p: Path) -> str:
    h = hashlib.sha1()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def _entry(p: Path) -> dict | None:
    try:
        st = p.stat()
    except OSError:
        return None
    return {"mtime": round(st.st_mtime, 3), "size": st.st_size, "sha1": _sha1(p)}


def scan(book_id: str, prev: dict | None = None) -> dict[str, dict]:
    """全量扫描。`prev` 里 mtime 与大小都没变的文件直接沿用旧 sha1 —— 省掉读盘与哈希。

    这是本模块的性能关键：日常改动通常只有一两个文件，
    但基线必须覆盖全部文件，不能只记改了的那几个。
    """
    prev_files = (prev or {}).get("files") or {}
    now: dict[str, dict] = {}
    for rel, p in tracked_files(book_id).items():
        try:
            st = p.stat()
        except OSError:
            continue
        old = prev_files.get(rel)
        if old and old.get("mtime") == round(st.st_mtime, 3) and old.get("size") == st.st_size:
            now[rel] = old
            continue
        h = _sha1(p)
        if h is None:  # pragma: no cover - _sha1 不返回 None，留个防御位
            continue
        now[rel] = {"mtime": round(st.st_mtime, 3), "size": st.st_size, "sha1": h}
    return now


# --------------------------------------------------------------------------
# 读写基线
# --------------------------------------------------------------------------

def fp_file(book_id: str) -> Path:
    return paths.book_dir(book_id) / FP_NAME


def read(book_id: str) -> dict:
    f = fp_file(book_id)
    if not f.exists():
        return {}
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except Exception as exc:
        log.warning("指纹文件读不动（当作没有基线）：%s", exc)
        return {}
    if not isinstance(data, dict) or int(data.get("schema") or 0) != SCHEMA:
        return {}
    files = data.get("files")
    if not isinstance(files, dict):
        return {}
    return data


def save(book_id: str, files: dict[str, dict]) -> dict:
    """原子写（先写 .tmp 再替换）—— 指纹写坏了等于丢了基线，比没有更糟。"""
    f = fp_file(book_id)
    f.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "schema": SCHEMA,
        "taken_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(files),
        "files": files,
    }
    tmp = f.with_name(FP_NAME + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(f)
    return data


def refresh(book_id: str) -> dict:
    """重扫并覆盖基线。返回 `{"count", "taken_at"}`。"""
    prev = read(book_id)
    files = scan(book_id, prev)
    data = save(book_id, files)
    return {"count": data["count"], "taken_at": data["taken_at"]}


# --------------------------------------------------------------------------
# 比对
# --------------------------------------------------------------------------

def diff(book_id: str, cap: int = MAX_REPORT) -> dict:
    """把基线和当前磁盘比一遍。**只读**，不动任何文件。"""
    stored = read(book_id)
    if not stored:
        return {
            "has_baseline": False,
            "stored_at": "",
            "tracked": len(tracked_files(book_id)),
            "changed": [],
            "content_changed": 0,
            "meta_only": 0,
            "truncated": False,
        }

    prev_files: dict = stored.get("files") or {}
    cur = scan(book_id, stored)

    changed: list[dict] = []
    content = 0
    meta = 0
    for rel, ent in cur.items():
        old = prev_files.get(rel)
        if old is None:
            changed.append({"path": rel, "kind": "added", "content_changed": True})
            content += 1
        elif old.get("sha1") != ent["sha1"]:
            changed.append({"path": rel, "kind": "modified", "content_changed": True})
            content += 1
        elif old.get("mtime") != ent["mtime"]:
            # 内容一模一样，只是时间戳变了：复制、同步盘、还原都会这样，不该吓人
            changed.append({"path": rel, "kind": "touched", "content_changed": False})
            meta += 1
    for rel in prev_files:
        if rel not in cur:
            changed.append({"path": rel, "kind": "removed", "content_changed": True})
            content += 1

    # 内容真变了的排前面 —— 那是需要人处理的
    changed.sort(key=lambda x: (not x["content_changed"], x["path"]))
    return {
        "has_baseline": True,
        "stored_at": stored.get("taken_at") or "",
        "tracked": len(cur),
        "changed": changed[:cap],
        "content_changed": content,
        "meta_only": meta,
        "truncated": len(changed) > cap,
    }


def status(book_id: str) -> dict:
    """给界面用的状态：没有基线就**顺手建立一份**。

    为什么顺手建：老版本留下的书目录本来就没有指纹文件。不建的话，
    第一次进书会把「全书 1213 个文件都是新增」摆到人脸上，那是纯噪音 ——
    而且这个报告本身没有信息量（我们本来就没有基线可比）。
    建完如实回 `has_baseline=False`，让人知道「从这一刻起才开始盯着」。
    """
    if not read(book_id):
        try:
            r = refresh(book_id)
            out = diff(book_id)
            # diff() 看到的是「刚刚建好的那份」基线，于是必然报 has_baseline=True、
            # 差异为空。那不是「你没问题」，是「我们还没有可比的东西」——
            # 所以这里把 has_baseline 改回 False：它问的是「这次有没有拿旧基线比过」。
            out["has_baseline"] = False
            out["baseline_just_created"] = True
            out["baseline_count"] = r["count"]
            return out
        except OSError as exc:
            log.warning("建立指纹基线失败（不影响使用）：%s", exc)
    return diff(book_id)


# --------------------------------------------------------------------------
# 写操作之后的重扫（由 main.py 的中间件调用）
# --------------------------------------------------------------------------

_timer_lock = threading.Lock()
_timers: dict[str, threading.Timer] = {}


def refresh_now(book_id: str) -> None:
    try:
        if not paths.book_dir(book_id).is_dir():
            return
        refresh(book_id)
    except Exception as exc:  # pragma: no cover - 指纹失败不该影响任何正常功能
        log.warning("写后重扫指纹失败（忽略）：%s", exc)


def schedule(book_id: str) -> None:
    """排一次延迟重扫。同一本书上连着来多次写，只留最后一次的定时器。

    为什么不立刻扫：批量导入是一串写，立刻扫就是扫 30 遍；
    而且「刚写完这一个、下一个正在写」的中间态被记进基线，
    随后文件写完，就又成了「外部改动」。
    """
    with _timer_lock:
        old = _timers.get(book_id)
        if old:
            old.cancel()
        t = threading.Timer(DEBOUNCE, lambda: _fire(book_id))
        t.daemon = True
        _timers[book_id] = t
        t.start()


def _fire(book_id: str) -> None:
    with _timer_lock:
        _timers.pop(book_id, None)
    refresh_now(book_id)


def flush() -> None:
    """把还没到点的定时器立刻兑现（退出前/测试里用）。"""
    with _timer_lock:
        pending = list(_timers.items())
        _timers.clear()
    for book_id, t in pending:
        t.cancel()
        refresh_now(book_id)
