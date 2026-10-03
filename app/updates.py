"""C1：有新版本的「提示」。

十五条承诺过的边界：**只提示，绝不自动下载、绝不自动替换程序**。
远端地址没有定 → 一切都是配置项 + 占位格式，配了 URL 才会真的去查。

远端约定（占位格式，谁挂谁负责）：一个返回 JSON 的地址：
    {"version": "0.12.0", "notes": "更新说明…", "url": "https://…下载页"}
"""

from __future__ import annotations

import json
import re
import time
import urllib.request

from . import __version__

# {url: (checked_at, result)} —— 进程内缓存。检查频率（interval_hours）
# 就是靠它实现的：间隔内的重复检查直接用上次结果，不去敲远端。
_MEM: dict[str, tuple[float, dict]] = {}


def _ver_tuple(v: str) -> tuple[int, ...]:
    """'0.12.3-beta' → (0, 12, 3)。非数字段忽略 —— 版本号只用于比较大小。"""
    parts = re.findall(r"\d+", str(v))
    return tuple(int(p) for p in parts) if parts else (0,)


def has_update(current: str, latest: str) -> bool:
    """latest > current 才算有新版。位数不齐就按 0 补齐（0.2 > 0.1.9）。"""
    a, b = _ver_tuple(current), _ver_tuple(latest)
    n = max(len(a), len(b))
    a += (0,) * (n - len(a))
    b += (0,) * (n - len(b))
    return b > a


def check(url: str, timeout: float = 4.0) -> dict:
    """真的去查一次。**任何失败都返回结构化的结果，绝不抛异常** ——
    更新检查是锦上添花，不能因为它把界面搞出错误弹窗。"""
    try:
        req = urllib.request.Request(
            url, headers={"User-Agent": f"world-keeper/{__version__}"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        latest = str(data.get("version") or "").strip()
        if not latest:
            return {"checked": False, "error": "远端返回里没有 version 字段"}
        return {
            "checked": True,
            "current": __version__,
            "latest": latest,
            "has_update": has_update(__version__, latest),
            "notes": str(data.get("notes") or ""),
            "url": str(data.get("url") or ""),
        }
    except Exception as e:  # noqa: BLE001 —— 见上，失败是正常路径之一
        return {"checked": False, "error": f"{type(e).__name__}: {e}"[:200]}


def check_cached(url: str, interval_hours: float, enabled: bool, force: bool = False) -> dict:
    """入口。未开启或没配地址 → 如实说「没检查」（不报错、不弹提示）。
    force=True 无视缓存立刻查（设置页的「重新检查」按钮用）。"""
    current = {"current": __version__}
    if not enabled or not (url or "").strip():
        return {
            **current,
            "checked": False,
            "skipped": True,
            "reason": "更新检查未开启，或未配置远端地址（config.yaml → updates.url）",
        }
    now = time.time()
    if not force:
        hit = _MEM.get(url)
        if hit and now - hit[0] < interval_hours * 3600:
            return hit[1]
    result = check(url)
    _MEM[url] = (now, result)
    return result
