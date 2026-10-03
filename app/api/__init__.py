"""API 路由汇总。

统一前缀 `/api`。**所有业务路由的第一参数是 book_id**（口子 4）。

路由分区预留：
- `/api`   桌面端与通用接口
- `/m`     移动端只读页（P6）
- `/admin` 后台页面（P7）
"""

from __future__ import annotations

from fastapi import APIRouter

from .. import APP_ID, __version__
from . import (
    admin,
    ai,
    appearance,
    books,
    chapters,
    docs,
    donate,
    entities,
    jobs,
    layouts,
    maps,
    sample,
    skills,
    styles,
    tools,
    updates,
    views,
    vision,
)

router = APIRouter(prefix="/api")


@router.get("/health", tags=["meta"])
def health() -> dict:
    """健康检查。运行时用它探测「是否已有实例在跑」（口子 A5）。"""
    return {"app": APP_ID, "version": __version__, "status": "ok"}


router.include_router(books.router)
router.include_router(entities.router)
router.include_router(views.router)
router.include_router(chapters.router)
router.include_router(docs.router)
router.include_router(appearance.router)
router.include_router(layouts.router)
router.include_router(maps.router)
router.include_router(styles.router)
router.include_router(vision.router)
router.include_router(admin.router)
router.include_router(jobs.router)  # P11-A3：异步任务。放在 admin 之后 —— 路径不重叠
router.include_router(ai.router)
router.include_router(tools.router)
router.include_router(skills.router)
router.include_router(donate.router)
router.include_router(sample.router)
router.include_router(updates.router)  # P11-C1：更新提示。只查不说教，更不替换

__all__ = ["router"]
