"""快照 —— 「档案可回滚」的那一半。

两条路，共用同一份落盘逻辑（`snapshot_files`）：

1. **写操作前**（`snapshot_files`）：动手删之前把即将消失的文件整体复制到
   `snapshots/<书目>-<时间戳>-<缘由>/`，保持原有的相对目录结构，
   真出事了按同样的路径拷回去就行。
2. **按时间**（`snapshot_book` / `maybe_auto_snapshot`，P11-A6）：
   启动时与每 N 小时各存一整份，另配保留策略（份数 + 总量）自动清理。

为什么不做「每次写都存一份」：编辑走的是「先写临时文件、再原子替换」，
本身不会丢内容；而快照是整份复制，几千条实体的书每次都存一份，
占的空间很快就超过它能兜住的收益。**删除才是真正不可逆的那个动作。**

不备份 `index.db`：索引是可抛弃的派生数据，重建即可 —— 这也是铁律之一。
顺带一提，它本来就不在 `books/<书>/` 里（在数据目录根下），所以整份复制
书目录天然不会把它卷进去。
"""

from __future__ import annotations

import json
import shutil
import threading
import time
from datetime import datetime
from pathlib import Path

from . import paths
from .logging_setup import get_logger

log = get_logger(__name__)


def snapshot_files(book_id: str, files: list[Path], reason: str = "delete") -> dict:
    """把一批文件备份进快照目录。

    返回 `{"dir", "count", "files"}`。**任何一个文件拷不过去都抛异常** ——
    调用方应当据此中止原操作：宁可这次不删，也不能留下「以为有备份、
    其实没有」这种局面。
    """
    book_root = paths.book_dir(book_id).resolve()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    safe = "".join(c for c in reason if c.isalnum() or c in "-_")[:24] or "snap"
    dest = paths.snapshots_dir() / f"{book_id}-{stamp}-{safe}"
    # 同一秒内连存两次（手快点了两下「立即快照」、或自动快照与手动快照撞在一起）
    # 目录名会一样 —— 那样第二份会**悄悄写进第一份里**，清单被覆盖、份数也不对。
    # 撞名就往后加序号，宁可多一个目录，也不能把两次操作混成一份。
    if dest.exists():
        for n in range(2, 100):
            alt = paths.snapshots_dir() / f"{book_id}-{stamp}-{safe}-{n}"
            if not alt.exists():
                dest = alt
                break
        else:  # pragma: no cover - 同秒存 100 份不现实，兜底加个随机尾缀
            import uuid

            dest = paths.snapshots_dir() / f"{book_id}-{stamp}-{safe}-{uuid.uuid4().hex[:6]}"
    dest.mkdir(parents=True, exist_ok=True)

    saved: list[str] = []
    total_bytes = 0
    for f in files:
        rf = Path(f).resolve()
        if not rf.exists():
            continue
        try:
            rel = rf.relative_to(book_root)
        except ValueError:
            rel = Path(rf.name)  # 不在本书目录下时就平铺，至少别丢
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(rf, target)
        saved.append(rel.as_posix())
        try:
            total_bytes += target.stat().st_size
        except OSError:
            pass

    # 顺手写一份清单：过两个月回头看，得一眼知道这份快照是谁、什么时候、为什么存的。
    # 「字节数」写进清单是为了后面列出快照列表时不必逐个目录去 stat ——
    # 20 份 × 上千个文件重复统计会明显拖慢后台页面。
    (dest / "_manifest.txt").write_text(
        f"书目：{book_id}\n源目录：{book_root}\n时间：{stamp}\n缘由：{reason}\n"
        f"文件数：{len(saved)}\n字节数：{total_bytes}\n\n" + "\n".join(saved) + "\n",
        encoding="utf-8",
    )
    log.info("已快照 %d 个文件到 %s", len(saved), dest)
    return {"dir": str(dest), "count": len(saved), "bytes": total_bytes, "files": saved}


# --------------------------------------------------------------------------
# 按时间的自动快照 + 保留策略（P11-A6）
# --------------------------------------------------------------------------

#: 状态文件（记录上次自动快照的时间）。是**文件**不是目录，
#: 所以不会被下面的「只看直接子目录」的枚举逻辑当成一份快照。
STATE_FILE = "_state.json"

#: 策略默认值；实际取值来自全局配置的 `snapshot:` 段，缺项落回这里。
DEFAULT_POLICY: dict = {
    "auto_enabled": True,
    "interval_hours": 24,
    "keep_count": 20,
    "max_total_mb": 512,
}


def auto_policy() -> dict:
    """读出当前快照策略（全局配置 → 默认值）。配置坏了也不能让快照功能瘫掉。"""
    raw: dict = {}
    try:
        from . import config  # 循环导入：config 会 import paths，此处延迟到调用时

        raw = config.load_settings().raw.get("snapshot") or {}
    except Exception as exc:  # pragma: no cover - 配置异常属兜底
        log.warning("读取快照策略失败，落回默认：%s", exc)
    out = dict(DEFAULT_POLICY)
    if isinstance(raw, dict):
        for k in list(out):
            if k in raw and raw[k] is not None:
                out[k] = raw[k]
    # 夹一下，防止手改配置写成 0 或负数把策略弄成「存完立刻删」
    out["interval_hours"] = max(1, int(out.get("interval_hours") or 24))
    out["keep_count"] = max(1, int(out.get("keep_count") or 20))
    out["max_total_mb"] = max(0, int(out.get("max_total_mb") or 512))
    out["auto_enabled"] = bool(out.get("auto_enabled", True))
    return out


def _state_path() -> Path:
    return paths.snapshots_dir() / STATE_FILE


def _read_state() -> dict:
    f = _state_path()
    if not f.exists():
        return {}
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_state(data: dict) -> None:
    """原子写状态文件 —— 半个 JSON 比没有状态更糟（会让「到点没」判断永远失败）。"""
    f = _state_path()
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_name(STATE_FILE + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(f)


def last_auto_info() -> dict | None:
    """上次自动快照的时间信息；从没存过就返回 None。"""
    st = _read_state()
    if not st.get("last_auto_ts"):
        return None
    return {
        "ts": float(st["last_auto_ts"]),
        "at": st.get("last_auto_at") or "",
        "books": st.get("last_auto_books") or [],
    }


def snapshot_book(book_id: str, reason: str = "auto") -> dict:
    """整本书快照（不含索引 —— 索引不在书目录里，天然卷不进来）。

    与 `snapshot_files` 的关系：那个负责「怎么存」，这个负责「存哪些」。
    按时间快照要的是「这本书此刻的完整样子」，所以把书目录下所有文件都列进去。
    """
    book_root = paths.book_dir(book_id).resolve()
    if not book_root.is_dir():
        raise FileNotFoundError(f"书目目录不存在：{book_root}")
    files = [p for p in book_root.rglob("*") if p.is_file()]
    if not files:
        # 空目录不生成空快照：一堆 0 字节快照会把保留额度吃光，什么都没兜住
        raise FileNotFoundError(f"书目「{book_id}」下没有任何文件，不生成空快照")
    return snapshot_files(book_id, files, reason=reason)


# --------------------------------------------------------------------------
# 列出 / 清理
# --------------------------------------------------------------------------

def _dir_bytes(p: Path) -> int:
    total = 0
    for f in p.rglob("*"):
        if f.is_file():
            try:
                total += f.stat().st_size
            except OSError:
                pass
    return total


def _manifest_fields(d: Path) -> dict:
    """从 `_manifest.txt` 前六行读回元信息。"""
    info = {"book_id": "", "reason": "", "stamp": "", "count": 0, "bytes": -1}
    mf = d / "_manifest.txt"
    if not mf.exists():
        return info
    try:
        text = mf.read_text(encoding="utf-8")
    except OSError:
        return info
    for line in text.splitlines()[:8]:
        if line.startswith("书目："):
            info["book_id"] = line[3:].strip()
        elif line.startswith("缘由："):
            info["reason"] = line[3:].strip()
        elif line.startswith("时间："):
            info["stamp"] = line[3:].strip()
        elif line.startswith("文件数："):
            try:
                info["count"] = int(line[4:].strip() or 0)
            except ValueError:
                pass
        elif line.startswith("字节数："):
            try:
                info["bytes"] = int(line[4:].strip() or 0)
            except ValueError:
                pass
    return info


def list_snapshots() -> list[dict]:
    """列出全部快照，按时间从新到旧。

    **只认 snapshots 目录的直接子目录** —— 不递归、不跟进符号链接，
    免得将来某个目录结构变化把枚举带到别处去（删除逻辑就建立在它之上）。
    """
    root = paths.snapshots_dir()
    if not root.is_dir():
        return []
    out: list[dict] = []
    for d in root.iterdir():
        try:
            if not d.is_dir():
                continue
            st = d.stat()
        except OSError:
            continue
        info = _manifest_fields(d)
        # 老快照的清单里没有「字节数」（该字段是 P11-A6 才加的），此时才真的去数
        size = info["bytes"] if info["bytes"] >= 0 else _dir_bytes(d)
        # 排序以**清单里的时间**为准，不是目录 mtime ——
        # 目录 mtime 会因为「后来往里补了个文件」而变，那会让新老实录错位。
        # 手搓的目录没清单，才退回 mtime。
        stamp = info["stamp"] or datetime.fromtimestamp(st.st_mtime).strftime("%Y%m%d-%H%M%S")
        out.append(
            {
                "name": d.name,
                "dir": str(d),
                "book_id": info["book_id"] or d.name.rsplit("-", 1)[0],
                "reason": info["reason"] or "unknown",
                "created_at": info["stamp"],
                "stamp": stamp,
                "mtime": st.st_mtime,
                "count": info["count"],
                "bytes": size,
                "has_manifest": (d / "_manifest.txt").exists(),
            }
        )
    # 同一秒内建的多份（自动快照对多本书是同一次调用）用目录名兜底排序，保证稳定
    out.sort(key=lambda x: (x["stamp"], x["name"]), reverse=True)
    return out


def prune_snapshots(
    keep_count: int = 20,
    max_total_mb: int = 512,
    dry_run: bool = False,
) -> dict:
    """按策略清理旧快照。**两条规则叠着生效，都是「保新删旧」**：

    1. **份数**：按时间从新到旧，留下前 `keep_count` 份；
    2. **总量**：在留下的那些里再从新到旧累计，超出 `max_total_mb` 的部分继续删；
       传 0 表示**不限总量，只看份数**。

    三条保险：
    - **最新的一份永不删** —— 否则把上限设成 0 就会当场自毁，快照功能反而成了风险源；
    - **只删 snapshots 目录的直接子目录** —— 逐个校验父目录，路径不对就跳过并记进
      `failed`，绝不顺着清单里的路径乱走（铁律：删除类操作校验路径归属）；
    - **非目录一律不碰** —— 状态文件、临时文件都散在同一层，不能被误当快照清掉。
    """
    root = paths.snapshots_dir().resolve()
    items = list_snapshots()
    if not items:
        return {"removed": [], "freed_bytes": 0, "kept": 0, "failed": [], "dry_run": dry_run}

    keep_names: set[str] = set()
    # 1) 份数
    for it in items[: max(1, int(keep_count))]:
        keep_names.add(it["name"])
    # 2) 总量（只在上一步活下来的里面再砍）
    budget = max(0, int(max_total_mb)) * 1024 * 1024
    if budget > 0:
        used = 0
        for it in items:
            if it["name"] not in keep_names:
                continue
            if used and used + it["bytes"] > budget:
                keep_names.discard(it["name"])  # used 非 0 才允许砍 → 最新一份自动豁免
                continue
            used += it["bytes"]

    removed: list[dict] = []
    failed: list[dict] = []
    for it in items:
        if it["name"] in keep_names:
            continue
        target = Path(it["dir"])
        try:
            resolved = target.resolve()
        except OSError as exc:
            failed.append({"name": it["name"], "error": str(exc)})
            continue
        # 路径安全闸：只允许删 snapshots 目录的**直接子目录**
        if resolved == root or resolved.parent != root:
            log.warning("跳过快照 %s：路径不在 snapshots 目录内（%s）", it["name"], resolved)
            failed.append({"name": it["name"], "error": "路径不在快照目录内，已跳过"})
            continue
        if dry_run:
            removed.append({"name": it["name"], "bytes": it["bytes"], "book_id": it["book_id"]})
            continue
        try:
            shutil.rmtree(resolved)
        except OSError as exc:
            failed.append({"name": it["name"], "error": str(exc)})
            continue
        removed.append({"name": it["name"], "bytes": it["bytes"], "book_id": it["book_id"]})

    if removed and not dry_run:
        log.info("快照清理：删除 %d 份，释放 %.1f MB", len(removed),
                 sum(r["bytes"] for r in removed) / 1024 / 1024)
    return {
        "removed": removed,
        "freed_bytes": sum(r["bytes"] for r in removed),
        "kept": len(keep_names),
        "failed": failed,
        "dry_run": dry_run,
    }


# --------------------------------------------------------------------------
# 自动快照
# --------------------------------------------------------------------------

def maybe_auto_snapshot(reason: str = "auto", force: bool = False) -> dict:
    """到点就给每本书各存一份，然后按策略清理。

    判断依据是**状态文件里的上次时间**，不是「今天有没有存过」——
    这样休眠一整天回来只会补一次，不会补一打；而间隔改成 6 小时之后
    下一轮又立刻生效，不用等自然日。
    """
    pol = auto_policy()
    if not pol["auto_enabled"] and not force:
        return {"skipped": "auto-disabled", "taken": [], "failed": []}

    interval_s = pol["interval_hours"] * 3600
    state = _read_state()
    last = float(state.get("last_auto_ts") or 0)
    now = time.time()
    if not force and last and (now - last) < interval_s:
        return {
            "skipped": "not-due",
            "next_in_seconds": int(interval_s - (now - last)),
            "taken": [],
            "failed": [],
        }

    books_root = paths.books_dir()
    taken: list[dict] = []
    failed: list[dict] = []
    if books_root.is_dir():
        for d in sorted(books_root.iterdir()):
            # 认「书名目录」的标志是 book.yaml —— 别的一律不当成书
            if not d.is_dir() or not (d / "book.yaml").exists():
                continue
            try:
                r = snapshot_book(d.name, reason=reason)
                taken.append({"book_id": d.name, "dir": r["dir"], "count": r["count"]})
            except Exception as exc:
                log.warning("自动快照失败（跳过 %s）：%s", d.name, exc)
                failed.append({"book_id": d.name, "error": str(exc)})

    # 只有真存下东西才推进时间戳。一本都没存成却记成「已存」，
    # 下一次要等一整个间隔才重试 —— 那才是真正的静默失败。
    if taken:
        _write_state(
            {
                "last_auto_ts": now,
                "last_auto_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "last_auto_books": [t["book_id"] for t in taken],
            }
        )

    pruned = None
    if taken:
        try:
            pruned = prune_snapshots(pol["keep_count"], pol["max_total_mb"])
        except Exception as exc:  # pragma: no cover - 清理失败不能影响快照本身
            log.warning("快照清理失败（不影响运行）：%s", exc)

    return {"skipped": None, "taken": taken, "failed": failed, "pruned": pruned}


def start_auto_scheduler(interval_minutes: int = 30) -> None:
    """后台守护线程：每隔一段时间看一次「到点没」，到点就存。

    为什么用轮询而不是算准时间 sleep 到点：笔记本合盖、系统休眠都会让
    sleep 变得不可靠；轮询只关心「现在到点了吗」，唤醒晚了也能补上，
    而且「改配置立刻生效」是白送的。

    只在真正的启动入口（`app.main:main`）里调用，**不放进 lifespan** ——
    测试用 TestClient 也会走 lifespan，那样每跑一次冒烟就多一份快照，
    既有断言（快照目录数 +1）会随机变红。定时快照是运行期行为，不是应用构造行为。
    """
    interval_s = max(60, int(interval_minutes) * 60)

    def _loop() -> None:
        while True:
            try:
                res = maybe_auto_snapshot(reason="auto")
                if res.get("taken"):
                    log.info(
                        "自动快照完成：%s",
                        "、".join(f"{t['book_id']}({t['count']} 个文件)" for t in res["taken"]),
                    )
            except Exception as exc:  # pragma: no cover - 巡检出错就下一轮再来
                log.warning("自动快照巡检异常（下轮重试）：%s", exc)
            time.sleep(interval_s)

    threading.Thread(target=_loop, name="wkv-autosnap", daemon=True).start()
