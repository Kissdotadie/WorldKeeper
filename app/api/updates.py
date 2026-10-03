"""C1：更新提示接口。

前端启动后**异步**调一次（不拖慢启动）；是否真去查远端由
config.yaml → updates（enabled / url / interval_hours）决定。
只返回信息，**不做任何下载或替换动作**。
"""

from __future__ import annotations

from fastapi import APIRouter

from .. import config
from .. import updates as updates_core

router = APIRouter()


@router.get("/app/update-check", tags=["meta"])
def update_check(force: bool = False) -> dict:
    cfg = config.get_settings().updates
    result = updates_core.check_cached(
        url=str(cfg.get("url") or ""),
        interval_hours=float(cfg.get("interval_hours", 24)),
        enabled=bool(cfg.get("enabled", True)),
        force=force,
    )
    # 配置本身也回给前端：设置页要能显示「开着没、指到哪、多久查一次」
    result["enabled"] = bool(cfg.get("enabled", True))
    result["configured"] = bool(str(cfg.get("url") or "").strip())
    result["interval_hours"] = cfg.get("interval_hours", 24)
    return result
