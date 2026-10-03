"""打赏与交流群的 HTTP 接口。

防护模型（2026-10-02 拍板：**告警 + 自动恢复原图**）
--------------------------------------------------
三张码的**真源在程序包里**（`app/assets/donate/*.png`），哈希**写在代码里**
（`app/donate_manifest.py`）。因此：

1. **对外吐图只从程序包读** —— 数据目录里那份副本怎么改都不影响界面显示的码。
2. **每次自检**（启动一次 + 每次读接口）：包内图哈希与代码内清单比对。
   - 不符 → 说明**程序文件被动过**。这是最严重的一档：告警标 critical，
     并且**拒绝吐图**（409）—— 宁可不显示，也不能显示一张可能被换过的收款码。
   - 数据目录副本缺失或被改 → **自动覆盖回原图**，并留一条告警。
3. 告警记在 `data/assets/donate/current.json` 的 `events` 里，**不会自己消失**；
   只有人在「支持作者」页明确点「已知悉」才会清（`POST /api/donate/ack`）。

防不住的边界要说清楚：代码和资源同时被改就防不住 —— 那已经是另一个程序了。
真正的完整性保证只能靠**代码签名**（P8），本模块只负责「被换过就别装作没事」。
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .. import donate_manifest, paths

router = APIRouter(tags=["donate"])

#: 键顺序即界面顺序；**白名单**，绝不接受路径拼接
KEYS: tuple[str, ...] = ("alipay", "wechat", "qqgroup")

_MEDIA = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}

#: 自检缓存的存活秒数。3 张图 < 1MB，全量 sha256 不到 10ms，
#: 但界面挂个轮询就没必要每次都算 —— 短缓存既保新鲜又不浪费。
_CHECK_TTL = 2.0

#: 事件只留最近这些条，避免 current.json 无限长
_MAX_EVENTS = 50

_lock = threading.Lock()
_cache: tuple[float, dict] | None = None


# ---------------------------------------------------------------------------
# 路径与状态
# ---------------------------------------------------------------------------

def bundle_dir() -> Path:
    """程序包内的原图目录（只读真源）。"""
    return paths.bundled_donate_dir()


def mirror_dir() -> Path:
    """数据目录里的副本（**不参与服务**，仅供查看与留痕）。"""
    return paths.assets_dir() / "donate"


def state_file() -> Path:
    return mirror_dir() / "current.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def _load_state() -> dict:
    p = state_file()
    base: dict = {"schema": 2, "token": "", "synced_at": None,
                  "files": {}, "events": [], "acknowledged_at": None}
    if not p.is_file():
        return base
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return base
    if not isinstance(data, dict):
        return base
    for k, v in base.items():
        data.setdefault(k, v)
    if not isinstance(data.get("events"), list):
        data["events"] = []
    if not isinstance(data.get("files"), dict):
        data["files"] = {}
    return data


def _save_state(state: dict) -> None:
    try:
        d = mirror_dir()
        d.mkdir(parents=True, exist_ok=True)
        state_file().write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        # 数据目录只读之类的极端情况：告警还会靠「实时比对」照常报出来，
        # 事件留痕失败不影响本次响应
        pass


def _push_event(state: dict, key: str, kind: str, detail: str, restored: bool) -> None:
    if restored:
        # 之前那条「恢复不了」若已解决，必须一并翻转 —— 否则红条会永远挂着，
        # 而「永远挂着的红条」很快就会被当成噪音无视，告警就白做了。
        for e in state["events"]:
            if e.get("key") == key and not e.get("restored"):
                e["restored"] = True
                e["detail"] = f"{e.get('detail', '')}（后续自检已恢复）"
    events = state["events"]
    events.append({
        "at": _now_iso(),
        "ts": time.time(),
        "key": key,
        "kind": kind,          # modified / missing / restore_failed
        "restored": restored,
        "detail": detail,
    })
    del events[:-_MAX_EVENTS]


# ---------------------------------------------------------------------------
# 自检 + 自动恢复
# ---------------------------------------------------------------------------

def _restore(src: Path, dst: Path) -> bool:
    """把包内原图覆盖到数据目录副本上。写不进去就返回 False（不抛异常）。"""
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_suffix(dst.suffix + ".tmp")
        tmp.write_bytes(src.read_bytes())
        tmp.replace(dst)          # 原子替换：中途断电不会留下半个图
        return True
    except OSError:
        return False


def _run_check() -> dict:
    state = _load_state()
    state["token"] = donate_manifest.TOKEN
    known: dict = state["files"] if isinstance(state.get("files"), dict) else {}

    per_key: dict[str, dict] = {}
    bundle_bad: list[str] = []
    restored_keys: list[str] = []
    failed_keys: list[str] = []
    first_sync: list[str] = []
    dirty = False

    for key in KEYS:
        meta = donate_manifest.ITEMS.get(key)
        bf = bundle_dir() / f"{key}.png"

        if meta is None or not bf.is_file():
            per_key[key] = {"state": "absent"}
            continue

        digest = _sha256(bf)
        if digest != meta["sha256"]:
            # 程序文件被动过 —— 不吐图，也不尝试「恢复」（改的是真源本身）
            per_key[key] = {"state": "bundle_tampered", "sha256": digest}
            bundle_bad.append(key)
            continue

        per_key[key] = {"state": "ok", "sha256": digest, "bytes": meta["bytes"]}

        # 数据目录里有没有 **登记过** 这张码的副本。
        # 没登记过 = 第一次落盘（新装 / 新数据目录），这是正常流程，不是被篡改 ——
        # 否则每次新建数据目录都会收到一条假的「有人动过你的收款码」。
        seen_before = known.get(key) is not None

        mf = mirror_dir() / f"{key}.png"
        if not mf.is_file():
            if _restore(bf, mf):
                if seen_before:
                    restored_keys.append(key)
                    _push_event(state, key, "missing", "数据目录里的码图不见了", True)
                else:
                    first_sync.append(key)
                dirty = True
            else:
                failed_keys.append(key)
                _push_event(state, key, "restore_failed", "码图不见了，且写不回数据目录", False)
                dirty = True
        elif _sha256(mf) != digest:
            if _restore(bf, mf):
                restored_keys.append(key)
                _push_event(state, key, "modified", "数据目录里的码图与程序包内的不一致", True)
            else:
                failed_keys.append(key)
                _push_event(state, key, "restore_failed", "码图被改过，且改不回原样", False)
            dirty = True

        want = {"sha256": digest, "bytes": meta["bytes"]}
        if known.get(key) != want:
            state["files"][key] = want
            dirty = True

    # 包体被改不落事件 —— 它是实时状态，只要文件还是改过的就一直报，
    # 不存在「被点掉」的可能。
    if dirty:
        state["synced_at"] = _now_iso()
        _save_state(state)

    return {
        "per_key": per_key,
        "bundle_bad": bundle_bad,
        "restored": restored_keys,
        "failed": failed_keys,
        "first_sync": first_sync,
        "state": state,
    }


def _check() -> dict:
    """带短缓存的自检（并发请求只跑一次）。"""
    global _cache
    with _lock:
        now = time.monotonic()
        if _cache and now - _cache[0] < _CHECK_TTL:
            return _cache[1]
        result = _run_check()
        _cache = (now, result)
        return result


def invalidate() -> None:
    """强制下次访问重新自检（换码脚本、手工重检时用）。"""
    global _cache
    with _lock:
        _cache = None


# ---------------------------------------------------------------------------
# 告警
# ---------------------------------------------------------------------------

def _build_alerts(res: dict) -> list[dict]:
    alerts: list[dict] = []

    # ① 包体被改 —— 最严重，且不可点掉
    if res["bundle_bad"]:
        keys = "、".join(donate_manifest.LABELS.get(k, k) for k in res["bundle_bad"])
        alerts.append({
            "level": "critical",
            "code": "bundle_tampered",
            "title": "程序文件里的收款码被改动过",
            "detail": (
                f"{keys} 的图片与程序内置的哈希对不上。为安全起见，界面已拒绝显示这些码。"
                "为安全起见，界面已拒绝显示这些码。请重新安装本程序。"
            ),
            "at": _now_iso(),
        })

    # ② 数据目录副本被改 / 被删（已自动恢复的要留痕，恢复不了的要升级为 critical）
    state = res["state"]
    ack = state.get("acknowledged_at")
    # 「已自动恢复」这类可以点掉（人看一眼就够）；「恢复不了」是**实时故障**，
    # 点掉就等于把红条藏起来，所以永远不过期、不受 ack 影响。
    events = [
        e for e in state.get("events", [])
        if not e.get("restored") or not ack or str(e.get("at", "")) > str(ack)
    ]
    if events:
        bad = [e for e in events if not e.get("restored")]
        good = [e for e in events if e.get("restored")]
        if bad:
            keys = "、".join(sorted({donate_manifest.LABELS.get(e["key"], e["key"]) for e in bad}))
            alerts.append({
                "level": "critical",
                "code": "mirror_unfixed",
                "title": "收款码副本被改动，且无法自动恢复",
                "detail": (
                    f"受影响：{keys}。界面显示的仍是程序包内的原图（未被替换），"
                    "但数据目录写不回去 —— 请检查该目录的写入权限。"
                ),
                "at": bad[-1]["at"],
            })
        if good:
            keys = "、".join(sorted({donate_manifest.LABELS.get(e["key"], e["key"]) for e in good}))
            alerts.append({
                "level": "warn",
                "code": "mirror_restored",
                "title": "收款码副本曾被改动，已自动恢复原图",
                "detail": (
                    f"受影响：{keys}。程序已用内置原图覆盖回去，界面显示的码始终是原图。"
                    "这条提示不会自动消失 —— 确认无误后可在「设置 · 支持作者」里清除。"
                ),
                "at": good[-1]["at"],
            })
    return alerts


def _integrity(res: dict) -> str:
    """ok / repaired / tampered / absent。

    - ok       一切正常
    - repaired 本轮发生过自动恢复（码本身没被换掉，只是副本被动过）
    - tampered 程序文件被动过，或恢复失败 —— 界面会同时给 critical 告警
    - absent   程序包里根本没有码图（开发期未登记）
    """
    if res["bundle_bad"] or res["failed"]:
        return "tampered"
    if res["restored"]:
        return "repaired"
    if any(v.get("state") == "ok" for v in res["per_key"].values()):
        return "ok"
    return "absent"


# ---------------------------------------------------------------------------
# 接口
# ---------------------------------------------------------------------------

def self_check(force: bool = False) -> dict:
    """启动时的自检入口（main.py 调用）。返回自检结论，顺手刷掉缓存。"""
    if force:
        invalidate()
    return _check()


@router.get("/donate")
def api_donate_info() -> dict:
    res = _check()
    per_key = res["per_key"]
    items: dict[str, dict] = {}
    for key in KEYS:
        v = per_key.get(key, {"state": "absent"})
        exists = v.get("state") == "ok"
        items[key] = {
            "exists": exists,
            "url": f"/api/donate/img/{key}?v={donate_manifest.TOKEN}" if exists else None,
            "label": donate_manifest.LABELS.get(key, key),
            "sha256": v.get("sha256"),
            "bytes": v.get("bytes") or (donate_manifest.ITEMS.get(key) or {}).get("bytes"),
            "state": v.get("state", "absent"),
        }
    return {
        "enabled": any(v["exists"] for v in items.values()),
        "items": items,
        "integrity": _integrity(res),
        "alerts": _build_alerts(res),
        "token": donate_manifest.TOKEN,
        "checked_at": _now_iso(),
        # 刻意**不吐**任何文件路径（bundle 目录 / 数据目录）——
        # 防替换说明不该反过来给别有用心者指道（作者要求，2026-10-02）
    }


@router.post("/donate/ack")
def api_donate_ack() -> dict:
    """清掉「已自动恢复」这类告警。**只清得掉留痕事件**，包体被改那类清不掉。"""
    state = _load_state()
    state["acknowledged_at"] = _now_iso()
    _save_state(state)
    invalidate()
    return {"ok": True, "acknowledged_at": state["acknowledged_at"]}


@router.post("/donate/verify")
def api_donate_verify() -> dict:
    """强制重跑一次自检（界面上的「重新检查」按钮）。"""
    invalidate()
    return api_donate_info()


@router.get("/donate/img/{key}")
def api_donate_img(key: str) -> FileResponse:
    if key not in KEYS:
        raise HTTPException(status_code=404, detail="没有这张码")

    meta = donate_manifest.ITEMS.get(key)
    f = bundle_dir() / f"{key}.png"
    if meta is None or not f.is_file():
        raise HTTPException(status_code=404, detail="程序包里没有这张码")

    # 吐图前再比一次哈希：**宁可不显示，也不显示一张可能被换过的收款码**
    if _sha256(f) != meta["sha256"]:
        raise HTTPException(
            status_code=409,
            detail="这张码与程序内置的哈希对不上，已拒绝显示 —— 请重新安装本程序",
        )

    return FileResponse(
        f,
        media_type=_MEDIA.get(f.suffix.lower(), "application/octet-stream"),
        headers={"Cache-Control": "no-store"},
    )
