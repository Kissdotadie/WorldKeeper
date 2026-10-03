"""世界观查询器 —— FastAPI 入口。

启动顺序：
1. 加载配置（同时确定数据目录 —— 程序目录 ≠ 数据目录）
2. 初始化日志（落文件）
3. 检查是否已有实例在跑（有则唤起并退出，口子 A5）
4. 探测可用端口（口子 A4）
5. 首次运行自动建索引；索引缺失则从 Markdown 重建
6. 挂载 API 与前端静态资源（开发走 Vite，打包走 dist —— 口子 A3）
"""

from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import APP_ID, __version__, config, fingerprint, paths, runtime, snapshot, store
from . import entities as entity_repo
from .api import appearance
from .api import router as api_router
from .logging_setup import get_logger, setup_logging

log = get_logger(__name__)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    """启动：迁移旧主题 → 落内置主题参考副本 → 确保索引。关闭时无清理。"""
    # 旧位置 config/themes/ 的自定义主题搬进数据目录（程序目录可能只读）。
    # 数据目录被环境变量覆盖时（测试 / 便携调试）跳过迁移 ——
    # 否则测试跑一次就把真实主题搬进临时目录删掉了。
    if not os.environ.get(paths.ENV_DATA_DIR):
        try:
            mig = appearance.migrate_legacy_themes()
            if mig["moved"]:
                log.info("已迁移自定义主题到数据目录：%s", "、".join(mig["moved"]))
            if mig["skipped"]:
                log.warning("以下主题未能迁移（重名或无权限），仍在旧位置：%s", "、".join(mig["skipped"]))
        except Exception as exc:
            log.warning("主题迁移失败（不影响运行）：%s", exc)
    # 内置主题落一份参考副本到 data/themes/_builtin/ —— 给你照着改（已有则不覆盖）
    try:
        written = appearance.write_builtin_themes()
        if written:
            log.info("已写入内置主题参考副本：%s", "、".join(written))
    except OSError as exc:
        log.warning("内置主题参考副本写入失败（不影响运行）：%s", exc)
    _ensure_index()
    # 打赏码自检：包内原图 vs 代码内哈希；数据目录副本被改就自动覆盖回去。
    # 失败不影响启动 —— 告警会在界面上照报（这是「不静默」的落点之一）。
    try:
        from .api import donate as donate_api

        res = donate_api.self_check(force=True)
        if res["bundle_bad"]:
            log.error("打赏码与程序内置哈希不符（拒绝显示）：%s", "、".join(res["bundle_bad"]))
        if res["restored"]:
            log.warning("打赏码副本被动过，已自动恢复原图：%s", "、".join(res["restored"]))
        if res["failed"]:
            log.error("打赏码副本无法恢复（数据目录不可写？）：%s", "、".join(res["failed"]))
    except Exception as exc:
        log.warning("打赏码自检失败（不影响启动）：%s", exc)
    log.info("服务已启动，数据目录：%s", paths.data_dir())
    yield


def create_app() -> FastAPI:
    settings = config.load_settings()

    # 无论从哪条路径启动（main / uvicorn 工厂 / 测试），都要保证日志落盘 —— 口子 A6。
    setup_logging(settings.log_level, settings.log_keep_days)

    app = FastAPI(
        title="世界观查询器",
        version=__version__,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        lifespan=_lifespan,
    )

    # 开发期前端跑在 Vite dev server（另一个端口）
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.middleware("http")(_fingerprint_after_write)

    app.include_router(api_router)

    _mount_frontend(app)

    @app.exception_handler(Exception)
    async def _unhandled(request, exc):  # pragma: no cover
        log.exception("未处理异常：%s", exc)
        return JSONResponse(status_code=500, content={"detail": str(exc)})

    return app


# --------------------------------------------------------------------------
# 写后指纹重扫（P11-A5）
#
# 挂在中间件上，而不是逐个写接口加钩子。理由是「漏」的代价不对称：
# 漏一个钩子 → 把自己刚改的东西报成「外部改动」，而且这种误报是**静默**的
# （用户看到黄条只会以为工具不准）。中间件一处覆盖全部写接口，漏不了。
#
# 只排「延迟重扫」，不在这里同步扫：批量导入是一串写，同步扫就是扫 30 遍。
# --------------------------------------------------------------------------

_WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

#: 这几个写接口路径里没有 book_id，但确实会动档案（或需要以磁盘为准重新对齐基线）
_FP_BY_ALL_BOOKS = (
    "/api/admin/lint/delete",
    "/api/admin/rebuild-index",
)


def _book_id_from_path(path: str) -> str | None:
    """从 `/api/books/<book_id>/...` 里取出 book_id（URL 编码要还原）。"""
    parts = [p for p in path.split("/") if p]
    if len(parts) >= 3 and parts[0] == "api" and parts[1] == "books":
        from urllib.parse import unquote

        return unquote(parts[2])
    return None


def _all_book_ids() -> list[str]:
    try:
        root = paths.books_dir()
        if not root.is_dir():
            return []
        return [d.name for d in root.iterdir() if d.is_dir() and (d / "book.yaml").exists()]
    except OSError:
        return []


async def _fingerprint_after_write(request, call_next):
    response = await call_next(request)
    try:
        if request.method in _WRITE_METHODS and response.status_code < 400:
            path = request.url.path
            book_id = _book_id_from_path(path)
            if book_id:
                fingerprint.schedule(book_id)
            elif path in _FP_BY_ALL_BOOKS:
                for bid in _all_book_ids():
                    fingerprint.schedule(bid)
    except Exception as exc:  # pragma: no cover - 指纹是附加能力，绝不能影响主流程
        log.warning("排指纹重扫失败（忽略）：%s", exc)
    return response


def _mount_frontend(app: FastAPI) -> None:
    """静态资源托管（口子 A3）。

    - 开发期：`web/dist` 不存在时，根路径给出提示（实际访问 Vite 的 5173）
    - 打包后：`web/dist` 存在，由 FastAPI 直接托管，并做 SPA 回退
    """
    dist = paths.web_dist_dir()
    index_file = dist / "index.html"

    if index_file.exists():
        app.mount("/assets", StaticFiles(directory=str(dist / "assets")), name="assets")

        @app.get("/", include_in_schema=False)
        def _index():
            return FileResponse(str(index_file))

        @app.get("/{full_path:path}", include_in_schema=False)
        def _spa_fallback(full_path: str):
            # `/api/*` 的未匹配路径必须 404 —— 否则调用方会收到一份 HTML
            # 当 JSON 解析，报错信息会离谱到查不出来。
            if full_path == "api" or full_path.startswith("api/"):
                return JSONResponse(status_code=404, content={"detail": "Not Found"})
            # `/m` 是手机版入口，前端按 location.pathname 自己分流。
            #
            # ⚠️ 但 `/m/`（带尾斜杠）与 `/m/xxx` 必须**重定向**回 `/m`，不能直接
            # 回 SPA：构建产物用的是相对 base（`./assets/...`），浏览器在 `/m/`
            # 下会把它解析成 `/m/assets/...`，而那个路径落到这里又回一份 HTML ——
            # JS 请求收到 HTML，模块加载失败，**手机端整页白屏**。
            # 移动端是 hash 路由（`/m#/entity/xx`），`/m` 之下没有任何合法路径。
            if full_path == "m/" or full_path.startswith("m/"):
                return RedirectResponse(url="/m", status_code=302)
            # `admin/` 是规划中的后台路由，还没做，先照旧挡住。
            if full_path.startswith("admin/"):
                return JSONResponse(status_code=404, content={"detail": "Not Found"})
            candidate = dist / full_path
            if candidate.is_file():
                return FileResponse(str(candidate))
            return FileResponse(str(index_file))
    else:
        @app.get("/", include_in_schema=False)
        def _dev_hint():
            return JSONResponse(
                {
                    "app": APP_ID,
                    "hint": "前端尚未构建。开发时请访问 Vite 开发服务器；正式运行请先执行 web 目录下的构建。",
                    "api_docs": "/api/docs",
                    "data_dir": str(paths.data_dir()),
                }
            )


def _ensure_index() -> None:
    """索引不存在或为空则从 Markdown 重建（索引可抛弃）。"""
    try:
        store.init_schema()
        books = entity_repo.list_books()
        if not books:
            return
        stats = [store.stats(b["book_id"]) for b in books]
        if all(s["total"] == 0 for s in stats):
            log.info("索引为空，按 Markdown 全量重建…")
            store.rebuild_all()
    except Exception as exc:
        log.warning("索引初始化失败（不影响启动，可在界面里重建）：%s", exc)


# --------------------------------------------------------------------------
# 命令行入口
# --------------------------------------------------------------------------

def main() -> int:
    settings = config.load_settings()
    setup_logging(settings.log_level, settings.log_keep_days)

    log.info("程序目录：%s", paths.program_dir())
    log.info("数据目录：%s", settings.data_dir)

    # 首次运行落一份**用户可改**的配置（数据目录里那份）。
    #
    # 判据是「用户那份在不在」，不是「有没有配置文件生效」—— 安装时程序目录
    # 会预置一份只读种子，`settings.config_file` 于是指向种子（非空）。若按它
    # 判断，用户那份就永远不会生成，而种子在 Program Files 下改不动，
    # 用户想改端口 / 开局域网就只能自己去数据目录手建文件。
    if not paths.user_config_file().exists():
        try:
            created = config.write_default_config()
            log.info("已生成用户配置：%s", created)
        except OSError as exc:
            # 数据目录也可能不可写（极端配置），这不影响使用
            log.warning("无法写入用户配置（不影响运行）：%s", exc)

    # 单实例：已有实例在跑就把浏览器指过去，不再起第二个（口子 A5）
    running = runtime.probe_existing_instance(settings.port, settings.port_scan)
    if running:
        url = f"http://127.0.0.1:{running}"
        print(f"\n  检测到已在运行：{url}\n  已为你打开该地址。\n", flush=True)
        if runtime.browser_allowed(settings):   # WKV_OPEN_BROWSER=0 可强制关掉
            _open_browser(url)
        return 0

    port = runtime.find_free_port(settings.port, settings.port_scan)
    runtime.install_shutdown_hooks()
    runtime.print_access_addresses(port, settings.lan_access)

    # 定时快照（P11-A6）：启动后立刻看一次「到点没」，之后每 30 分钟再看。
    # 放在这里而不是 lifespan —— 它是运行期行为，测试用 TestClient 走的是
    # lifespan，不该因为跑一次冒烟就多出一堆快照。
    if settings.snapshot_auto_enabled:
        try:
            snapshot.start_auto_scheduler()
            log.info("定时快照已开启（间隔 %s 小时，保留 %s 份）",
                     settings.snapshot_policy.get("interval_hours", 24),
                     settings.snapshot_policy.get("keep_count", 20))
        except Exception as exc:
            log.warning("定时快照启动失败（不影响运行）：%s", exc)
    else:
        log.info("定时快照已在配置里关闭（删除前快照与手动快照不受影响）")

    if runtime.browser_allowed(settings):
        _open_browser_later(port)

    import uvicorn

    uvicorn.run(
        create_app(),
        host=settings.bind_host,
        port=port,
        log_level=settings.log_level.lower(),
        access_log=False,
    )
    return 0


def _open_browser_later(port: int) -> None:
    import threading
    import time as _time

    def _worker() -> None:
        _time.sleep(1.2)
        _open_browser(f"http://127.0.0.1:{port}")

    threading.Thread(target=_worker, daemon=True).start()


def _open_browser(url: str) -> None:
    import webbrowser

    try:
        webbrowser.open(url)
    except Exception:
        pass


if __name__ == "__main__":
    sys.exit(main())
