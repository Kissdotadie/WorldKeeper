"""外观系统：素材库 + 主题包 + 用户偏好。

三条边界，写在这里免得后人踩：

1. **素材**（字体 / 背景 / 贴纸）→ `data/assets/<kind>/`
   与 `entities/` 物理隔离。删掉 assets 只丢外观，绝不丢内容。

2. **主题包**：内置主题 = 代码常量（BUILTIN_THEMES），自定义主题 → `data/themes/*.json`
   铁律「程序目录只读」：用户存的主题是用户数据，必须落数据目录。
   内置主题是**只读**的：想改先「另存为」，免得升级时被覆盖。
   启动时会把旧位置 `config/themes/` 的自定义主题一次性迁移进数据目录。

3. **用户偏好** → `data/preferences.json`
   当前用哪套主题 / 字体 / 背景 / 字号 / 布局。
   **不落索引**：索引随时可删可重建，偏好删了就真没了。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Body, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response

from .. import paths
from ..config import load_book_config, load_preferences, save_book_config, save_preferences

router = APIRouter(tags=["appearance"])

# --------------------------------------------------------------------------
# 校验
# --------------------------------------------------------------------------

#: 文件名：不许路径分隔符、不许控制字符、不许以点开头（防 . / .. 与隐藏文件）
_BAD_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_VAR_NAME = re.compile(r"^--[A-Za-z0-9-]{1,60}$")
_VAR_VALUE = re.compile(r"^[^;{}<>]{0,180}$")
_THEME_NAME = re.compile(r"^[^\\/:*?\"<>|\x00-\x1f]{1,32}$")

MAX_ASSET_BYTES = 32 * 1024 * 1024  # 单个素材 32MB 上限，字体/图都够


def safe_name(name: str) -> str:
    raw = (name or "").strip().strip(".")
    if not raw or _BAD_NAME.search(raw) or raw in (".", ".."):
        raise HTTPException(status_code=400, detail=f"名字不合法：{name!r}")
    return raw


def safe_theme_name(name: str) -> str:
    raw = (name or "").strip().strip(". ")
    if not raw or not _THEME_NAME.match(raw):
        raise HTTPException(status_code=400, detail=f"主题名不合法：{name!r}")
    return raw


def check_kind(kind: str) -> str:
    if kind not in paths.ASSET_KINDS:
        raise HTTPException(status_code=400, detail=f"未知素材种类：{kind}")
    return kind


# --------------------------------------------------------------------------
# 素材库
# --------------------------------------------------------------------------


def _asset_entry(kind: str, f: Path) -> dict:
    st = f.stat()
    return {
        "kind": kind,
        "name": f.name,
        "stem": f.stem,
        "ext": f.suffix.lower(),
        "size": st.st_size,
        "mtime": int(st.st_mtime),
        # 前端直接拿它当 <img src> / @font-face src
        "url": f"/api/assets/{kind}/{f.name}/raw",
    }


@router.get("/assets")
def api_assets_all() -> dict:
    """一次列出全部种类的素材 —— 外观界面只需要一次请求。"""
    out: dict[str, list[dict]] = {}
    for kind in paths.ASSET_KINDS:
        d = paths.asset_kind_dir(kind)
        d.mkdir(parents=True, exist_ok=True)
        out[kind] = [
            _asset_entry(kind, f)
            for f in sorted(d.iterdir())
            if f.is_file() and f.suffix.lower() in paths.ASSET_KINDS[kind]
        ]
    return {"kinds": list(paths.ASSET_KINDS), "assets": out}


@router.get("/assets/usage")
def api_assets_usage() -> dict:
    """全部素材的**引用位置**（C4/B4：删之前告诉你会影响谁）。

    扫描策略是**文本级匹配**：把可能引用素材的文件当纯文本搜文件名
    （字体按 stem 搜——偏好里存的就是 stem）。刻意不做逐格式精配：
    以后新增引用点（新的 view 文件、新的字段）自动被覆盖，宁可多报不漏报 ——
    引用提示是给删除兜底的，多报一条顶多让人多看一眼，漏报才会删出坏图。
    """
    # 1. 收集全部素材：字体用 stem 当匹配串，其余用完整文件名
    needles: list[tuple[str, str, str]] = []  # (needle, kind, name)
    for kind in paths.ASSET_KINDS:
        d = paths.asset_kind_dir(kind)
        if not d.is_dir():
            continue
        for f in d.iterdir():
            if not f.is_file() or f.suffix.lower() not in paths.ASSET_KINDS[kind]:
                continue
            needles.append((f.stem if kind == "fonts" else f.name, kind, f.name))

    # 2. 收集候选文件：全局偏好 + 每本书的 book.yaml 与 view/ 下全部 json
    candidates: list[tuple[str, Path]] = []  # (位置标签, 文件)
    pf = paths.preferences_file()
    if pf.is_file():
        candidates.append(("全局外观偏好", pf))
    books_root = paths.books_dir()
    if books_root.is_dir():
        for book_dir in sorted(p for p in books_root.iterdir() if p.is_dir()):
            bcfg = paths.book_config_file(book_dir.name)
            if bcfg.is_file():
                candidates.append((f"书目 {book_dir.name} · book.yaml", bcfg))
            view = paths.view_dir(book_dir.name)
            if view.is_dir():
                for f in sorted(view.rglob("*.json")):
                    candidates.append((f"书目 {book_dir.name} · view/{f.relative_to(view).as_posix()}", f))

    # 3. 逐文件文本扫描
    usages: dict[str, list[dict]] = {}
    for label, path in candidates:
        try:
            if path.stat().st_size > 4 * 1024 * 1024:
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for needle, kind, name in needles:
            if needle and needle in text:
                usages.setdefault(f"{kind}/{name}", []).append(
                    {"label": label, "file": str(path)}
                )
    return {"usages": usages}


@router.get("/assets/{kind}")
def api_assets_list(kind: str) -> dict:
    check_kind(kind)
    d = paths.asset_kind_dir(kind)
    d.mkdir(parents=True, exist_ok=True)
    items = [
        _asset_entry(kind, f)
        for f in sorted(d.iterdir())
        if f.is_file() and f.suffix.lower() in paths.ASSET_KINDS[kind]
    ]
    return {"kind": kind, "count": len(items), "items": items,
            "accepts": list(paths.ASSET_KINDS[kind])}


@router.post("/assets/{kind}", status_code=201)
async def api_assets_upload(kind: str, file: UploadFile = File(...)) -> dict:
    """上传一份素材。扩展名走白名单，大小有上限，同名直接覆盖。"""
    check_kind(kind)
    name = safe_name(Path(file.filename or "").name)
    ext = Path(name).suffix.lower()
    if ext not in paths.ASSET_KINDS[kind]:
        raise HTTPException(
            status_code=400,
            detail=f"{kind} 只收 {'、'.join(paths.ASSET_KINDS[kind])}，收到 {ext or '无扩展名'}",
        )

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="文件是空的")
    if len(data) > MAX_ASSET_BYTES:
        raise HTTPException(status_code=400, detail=f"超过 {MAX_ASSET_BYTES // 1024 // 1024}MB 上限")

    target = paths.asset_kind_dir(kind) / name
    target.write_bytes(data)
    return _asset_entry(kind, target)


@router.get("/assets/{kind}/{name}/raw")
def api_asset_raw(kind: str, name: str) -> FileResponse:
    """原样吐出素材文件。前端的图片与字体都从这里取。"""
    check_kind(kind)
    f = paths.asset_kind_dir(kind) / safe_name(name)
    if not f.is_file():
        raise HTTPException(status_code=404, detail="素材不存在")
    return FileResponse(f)


@router.delete("/assets/{kind}/{name}")
def api_asset_delete(kind: str, name: str) -> dict:
    check_kind(kind)
    f = paths.asset_kind_dir(kind) / safe_name(name)
    if not f.is_file():
        raise HTTPException(status_code=404, detail="素材不存在")
    f.unlink()
    return {"deleted": True, "name": name, "kind": kind}


# --------------------------------------------------------------------------
# 主题包
# --------------------------------------------------------------------------


def _builtin_theme(name: str) -> dict | None:
    """内置主题从代码常量取 —— 不依赖任何文件，打包后照样可用。"""
    for t in BUILTIN_THEMES:
        if t["name"] == name:
            return t
    return None


def _theme_path(name: str) -> Path:
    """自定义主题的文件位置（数据目录）。"""
    return paths.themes_dir() / f"{safe_theme_name(name)}.json"


def _read_theme(name: str) -> dict | None:
    """内置优先（只读语义的根基：自定义永远盖不住内置）。"""
    builtin = _builtin_theme(name)
    if builtin is not None:
        return builtin
    p = _theme_path(name)
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def validate_theme(raw: dict) -> dict:
    """只留下认识的东西。CSS 变量名与值都走正则，避免脏数据把界面搞坏。"""
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="主题必须是一个 JSON 对象")

    name = safe_theme_name(str(raw.get("name") or ""))
    vars_in = raw.get("vars") or {}
    if not isinstance(vars_in, dict):
        raise HTTPException(status_code=400, detail="vars 必须是对象")

    clean: dict[str, dict[str, str]] = {}
    for mode in ("dark", "light"):
        block = vars_in.get(mode)
        if not isinstance(block, dict):
            continue
        kept: dict[str, str] = {}
        for k, v in block.items():
            if not _VAR_NAME.match(str(k)):
                continue
            sv = str(v).strip()
            if not _VAR_VALUE.match(sv):
                raise HTTPException(status_code=400, detail=f"变量 {k} 的值不合法")
            kept[str(k)] = sv
        if kept:
            clean[mode] = kept

    return {
        "schema": 1,
        "name": name,
        "description": str(raw.get("description") or "")[:200],
        "builtin": bool(raw.get("builtin", False)),
        "vars": clean,
    }


# -- 内置主题 --------------------------------------------------------------
# 只覆盖「语义层」变量：palette 是原始色板，改它会把别的主题也带歪。
# 每套都同时给 dark / light 两份，切明暗不丢配色。

BUILTIN_THEMES: list[dict] = [
    {
        "schema": 1,
        "name": "默认",
        "description": "出厂配色。深色为主，浅色备用。",
        "builtin": True,
        "vars": {"dark": {}, "light": {}},
    },
    {
        "schema": 1,
        "name": "午夜蓝",
        "description": "藏青底 + 亮蓝主色，冷调，长时间写作不刺眼。",
        "builtin": True,
        "vars": {
            "dark": {
                "--bg-app": "#060911",
                "--bg-sunken": "#0a0f1a",
                "--bg-surface": "#0f1624",
                "--bg-raised": "#141d2e",
                "--bg-hover": "#1b2739",
                "--bg-active": "#223145",
                "--bg-input": "#0a0f1a",
                "--border-subtle": "rgba(122, 162, 255, 0.10)",
                "--border-default": "rgba(122, 162, 255, 0.18)",
                "--border-strong": "rgba(122, 162, 255, 0.32)",
                "--text-primary": "#dfe8fa",
                "--text-secondary": "#a8b8d6",
                "--text-muted": "#7d8dab",
                "--text-faint": "#5d6b86",
                "--accent": "#7aa2ff",
                "--accent-hover": "#9ab8ff",
                "--accent-pressed": "#5b86e0",
                "--accent-soft": "rgba(122, 162, 255, 0.16)",
                "--accent-soft-strong": "rgba(122, 162, 255, 0.28)",
            },
            "light": {
                "--bg-app": "#eef2f9",
                "--bg-surface": "#ffffff",
                "--bg-sunken": "#e6ebf5",
                "--bg-raised": "#ffffff",
                "--accent": "#3f6fd8",
                "--accent-soft": "rgba(63, 111, 216, 0.12)",
            },
        },
    },
    {
        "schema": 1,
        "name": "暖纸",
        "description": "米黄纸感，浅色为主。像在稿纸上改字。",
        "builtin": True,
        "vars": {
            "dark": {
                "--bg-app": "#1a1713",
                "--bg-sunken": "#211d18",
                "--bg-surface": "#26221c",
                "--bg-raised": "#2c2822",
                "--text-primary": "#f0e6d8",
                "--text-secondary": "#c8b9a4",
                "--accent": "#d9a05b",
                "--accent-soft": "rgba(217, 160, 91, 0.16)",
            },
            "light": {
                "--bg-app": "#f2ece0",
                "--bg-sunken": "#eae2d3",
                "--bg-surface": "#fbf7ee",
                "--bg-raised": "#fbf7ee",
                "--bg-hover": "#efe7d7",
                "--bg-active": "#e5dcc9",
                "--bg-input": "#fffdf7",
                "--text-primary": "#3a332a",
                "--text-secondary": "#5f5647",
                "--text-muted": "#857a68",
                "--text-faint": "#a3967f",
                "--border-subtle": "rgba(58, 51, 42, 0.08)",
                "--border-default": "rgba(58, 51, 42, 0.16)",
                "--border-strong": "rgba(58, 51, 42, 0.30)",
                "--accent": "#a3662a",
                "--accent-hover": "#8a5520",
                "--accent-pressed": "#6f4419",
                "--accent-soft": "rgba(163, 102, 42, 0.13)",
                "--accent-soft-strong": "rgba(163, 102, 42, 0.22)",
            },
        },
    },
    {
        "schema": 1,
        "name": "墨绿",
        "description": "深墨绿底，青玉主色。沉静，适合夜里写。",
        "builtin": True,
        "vars": {
            "dark": {
                "--bg-app": "#08110e",
                "--bg-sunken": "#0c1714",
                "--bg-surface": "#111e1a",
                "--bg-raised": "#16261f",
                "--bg-hover": "#1d312a",
                "--bg-active": "#243d35",
                "--bg-input": "#0c1714",
                "--text-primary": "#dceee6",
                "--text-secondary": "#a5c6b8",
                "--text-muted": "#7b9c8e",
                "--text-faint": "#5d7a6e",
                "--accent": "#4fd1a5",
                "--accent-hover": "#72e0bb",
                "--accent-pressed": "#36b48b",
                "--accent-soft": "rgba(79, 209, 165, 0.15)",
                "--accent-soft-strong": "rgba(79, 209, 165, 0.26)",
                "--border-default": "rgba(79, 209, 165, 0.16)",
                "--border-strong": "rgba(79, 209, 165, 0.30)",
            },
            "light": {
                "--bg-app": "#edf5f1",
                "--bg-surface": "#ffffff",
                "--bg-sunken": "#e3efea",
                "--accent": "#187a5c",
                "--accent-soft": "rgba(24, 122, 92, 0.12)",
            },
        },
    },
    {
        "schema": 1,
        "name": "高对比",
        "description": "纯黑纯白、粗边框。给弱视或小屏用，别拿它写散文。",
        "builtin": True,
        "vars": {
            "dark": {
                "--bg-app": "#000000",
                "--bg-sunken": "#000000",
                "--bg-surface": "#0a0a0a",
                "--bg-raised": "#141414",
                "--bg-hover": "#242424",
                "--bg-active": "#333333",
                "--bg-input": "#000000",
                "--text-primary": "#ffffff",
                "--text-secondary": "#e8e8e8",
                "--text-muted": "#c8c8c8",
                "--text-faint": "#a0a0a0",
                "--border-subtle": "rgba(255, 255, 255, 0.30)",
                "--border-default": "rgba(255, 255, 255, 0.55)",
                "--border-strong": "rgba(255, 255, 255, 0.90)",
                "--accent": "#ffe14d",
                "--accent-hover": "#fff07a",
                "--accent-soft": "rgba(255, 225, 77, 0.22)",
                "--accent-soft-strong": "rgba(255, 225, 77, 0.36)",
            },
            "light": {
                "--bg-app": "#ffffff",
                "--bg-sunken": "#ffffff",
                "--bg-surface": "#ffffff",
                "--bg-raised": "#f7f7f7",
                "--bg-hover": "#ececec",
                "--text-primary": "#000000",
                "--text-secondary": "#1a1a1a",
                "--text-muted": "#3a3a3a",
                "--border-subtle": "rgba(0, 0, 0, 0.35)",
                "--border-default": "rgba(0, 0, 0, 0.60)",
                "--border-strong": "rgba(0, 0, 0, 0.95)",
                "--accent": "#0033cc",
                "--accent-soft": "rgba(0, 51, 204, 0.16)",
            },
        },
    },
]


def write_builtin_themes(overwrite: bool = False) -> list[str]:
    """把内置主题落一份**参考副本**到 `data/themes/_builtin/`。

    真源是代码常量，这些文件纯粹给你「照着抄一份再改」用，
    列表接口不扫描 `_builtin/` 子目录，改它们不会影响任何东西。
    放在数据目录是因为程序目录可能只读。
    """
    d = paths.themes_dir() / "_builtin"
    d.mkdir(parents=True, exist_ok=True)
    written: list[str] = []
    for t in BUILTIN_THEMES:
        p = d / f"{t['name']}.json"
        if p.exists() and not overwrite:
            continue
        p.write_text(json.dumps(t, ensure_ascii=False, indent=2), encoding="utf-8")
        written.append(t["name"])
    return written


def migrate_legacy_themes() -> dict:
    """把旧位置 `config/themes/` 的主题一次性搬进数据目录。

    - 自定义主题（builtin=False）→ 移动到 `data/themes/`
    - 内置主题副本 → 删除（代码常量已是真源，留着只会误导）
    - 任何失败都不阻断启动，只记录到返回值
    """
    legacy = paths.legacy_themes_dir()
    target = paths.themes_dir()
    report: dict[str, list[str]] = {"moved": [], "removed_builtin": [], "skipped": []}
    try:
        if not legacy.is_dir() or legacy.resolve() == target.resolve():
            return report
    except OSError:
        return report

    target.mkdir(parents=True, exist_ok=True)
    for p in sorted(legacy.glob("*.json")):
        name = p.stem
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            raw = {}
        is_builtin = isinstance(raw, dict) and raw.get("builtin")
        try:
            if is_builtin:
                p.unlink()
                report["removed_builtin"].append(name)
            else:
                dest = target / p.name
                if dest.exists():
                    report["skipped"].append(name)  # 不覆盖数据目录里已有的同名主题
                else:
                    p.replace(dest)
                    report["moved"].append(name)
        except OSError:
            report["skipped"].append(name)
    return report


@router.get("/themes")
def api_themes_list() -> dict:
    """列出全部主题包（内置常量 + 数据目录里的自定义），并标出当前生效的那个。"""
    items = [
        {
            "name": t["name"],
            "description": t.get("description", ""),
            "builtin": True,
            "modes": sorted((t.get("vars") or {}).keys()),
            "file": "",
        }
        for t in BUILTIN_THEMES
    ]
    builtin_names = {t["name"] for t in BUILTIN_THEMES}
    d = paths.themes_dir()
    if d.is_dir():
        for p in sorted(d.glob("*.json")):  # 只扫顶层，_builtin/ 是参考副本目录
            if p.stem in builtin_names:
                continue  # 内置只读，同名文件没资格出现
            t = _read_theme(p.stem)
            if not t:
                continue
            items.append(
                {
                    "name": t.get("name", p.stem),
                    "description": t.get("description", ""),
                    "builtin": bool(t.get("builtin")),
                    "modes": sorted((t.get("vars") or {}).keys()),
                    "file": str(p),
                }
            )
    active = (load_preferences().get("ui") or {}).get("theme") or "默认"
    return {"themes": items, "active": active, "count": len(items)}


@router.get("/themes/{name}")
def api_theme_get(name: str) -> dict:
    t = _read_theme(name)
    if not t:
        raise HTTPException(status_code=404, detail=f"主题不存在：{name}")
    return t


@router.put("/themes/{name}")
def api_theme_put(name: str, payload: dict = Body(...)) -> dict:
    """保存主题。**内置主题只读**，要改请先另存为新名字。"""
    clean = validate_theme({**payload, "name": payload.get("name") or name})
    # builtin 只属于随程序出厂的内置主题，用户存的永远是自定义主题
    clean["builtin"] = False
    if clean["name"] != safe_theme_name(name):
        raise HTTPException(status_code=400, detail="body 里的 name 与 URL 不一致")

    existing = _read_theme(clean["name"])
    if existing and existing.get("builtin"):
        raise HTTPException(
            status_code=400,
            detail=f"「{clean['name']}」是内置主题，只读。请另存为新名字再改。",
        )

    p = _theme_path(clean["name"])
    p.write_text(json.dumps(clean, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"saved": True, "name": clean["name"], "file": str(p)}


@router.delete("/themes/{name}")
def api_theme_delete(name: str) -> dict:
    t = _read_theme(name)
    if not t:
        raise HTTPException(status_code=404, detail=f"主题不存在：{name}")
    if t.get("builtin"):
        raise HTTPException(status_code=400, detail="内置主题不可删除")
    _theme_path(name).unlink()
    return {"deleted": True, "name": name}


@router.get("/themes/{name}/export")
def api_theme_export(name: str):
    """导出一个主题包 JSON。自定义走文件；内置主题没有文件，直接序列化常量。"""
    t = _read_theme(name)
    if not t:
        raise HTTPException(status_code=404, detail=f"主题不存在：{name}")
    p = _theme_path(name)
    if p.is_file():
        return FileResponse(p, media_type="application/json", filename=f"{name}.theme.json")
    quoted = quote(f"{name}.theme.json")
    return Response(
        content=json.dumps(t, ensure_ascii=False, indent=2),
        media_type="application/json",
        # 中文文件名必须走 RFC 5987，否则 latin-1 编码直接炸
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quoted}"},
    )


@router.post("/themes/import", status_code=201)
async def api_theme_import(
    file: UploadFile = File(...),
    rename: str | None = Query(default=None, description="重名时改用它"),
) -> dict:
    """导入一个主题包 JSON。重名会自动加后缀，不覆盖你现有的。"""
    try:
        raw = json.loads((await file.read()).decode("utf-8"))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"不是合法的 JSON：{e}") from e

    clean = validate_theme(raw)
    clean["builtin"] = False
    if rename:
        clean["name"] = safe_theme_name(rename)

    final = clean["name"]
    if _theme_path(final).exists():
        base = final
        for i in range(2, 100):
            final = f"{base} ({i})"
            if not _theme_path(final).exists():
                break
    clean["name"] = final

    p = _theme_path(final)
    p.write_text(json.dumps(clean, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"imported": True, "name": final, "file": str(p)}


# --------------------------------------------------------------------------
# 用户偏好
# --------------------------------------------------------------------------

_PREF_UI_DEFAULTS: dict = {
    "theme": "默认",
    "mode": "dark",
    "font_scale": 1,
    "font_ui": "",
    "font_mono": "",
    "sidebar_open": True,
    "panel_alpha": 1,
    # 顶栏/侧栏/弹窗的毛玻璃。默认关 —— backdrop-filter 在大面积多层的界面上
    # 是很重的合成开销，开着背景图时尤其明显。
    "panel_blur": False,
    "background": {
        "kind": "none",  # none | color | gradient | image
        "color": "",
        "from": "",
        "to": "",
        "angle": 135,
        "image": "",     # 素材名（backgrounds 类）
        "fit": "cover",
        "blur": 0,
        "dim": 0.55,
    },
}


@router.get("/prefs")
def api_prefs_get() -> dict:
    """读用户偏好，缺的键补上默认值（前端就不用到处写 ?? 兜底）。"""
    prefs = load_preferences()
    ui = {**_PREF_UI_DEFAULTS, **(prefs.get("ui") or {})}
    ui["background"] = {**_PREF_UI_DEFAULTS["background"], **(ui.get("background") or {})}
    return {**prefs, "ui": ui}


@router.put("/prefs")
def api_prefs_put(patch: dict = Body(...)) -> dict:
    """按顶层键深合并。只传要改的那部分即可。"""
    prefs = load_preferences()
    for key, value in (patch or {}).items():
        if key == "ui" and isinstance(value, dict):
            merged = {**(_PREF_UI_DEFAULTS), **(prefs.get("ui") or {})}
            for k, v in value.items():
                if k == "background" and isinstance(v, dict):
                    merged["background"] = {**(merged.get("background") or {}), **v}
                else:
                    merged[k] = v
            prefs["ui"] = merged
        elif isinstance(value, dict) and isinstance(prefs.get(key), dict):
            prefs[key] = {**prefs[key], **value}
        else:
            prefs[key] = value
    save_preferences(prefs)
    return {"saved": True, "prefs": prefs}


@router.get("/prefs/defaults")
def api_prefs_defaults() -> dict:
    return {"ui": _PREF_UI_DEFAULTS}


# --------------------------------------------------------------------------
# 书目独立外观（P11-C2）
# --------------------------------------------------------------------------
# 多书并行时每本书可以各持一套主题/字体/背景，互不干扰：
#   * 覆盖值落 `books/<id>/book.yaml` 的 appearance 键 —— **随整本导出/快照走**，
#     不进索引（索引零独占状态），删索引重建后外观原样。
#   * 覆盖是**稀疏的**：只钉用户在这本书里真正改过的键，没动过的键继续跟随
#     全局偏好 —— 改一次全局主题，所有「没单独设置过」的书跟着换，这才省事。
#   * 解析顺序：书目覆盖 > 全局偏好 > 出厂默认。


def _book_appearance_404(book_id: str) -> None:
    # 不查索引（索引可抛弃，空书在索引里也可能没有行）—— 看磁盘上的书目录
    if not paths.book_dir(book_id).is_dir():
        raise HTTPException(status_code=404, detail=f"书目不存在：{book_id}")


def _resolve_book_ui(book_id: str) -> dict:
    """书目覆盖叠在全局偏好之上，返回**补齐了默认值**的完整 ui。"""
    override = (load_book_config(book_id).get("appearance") or {}) if _book_cfg_exists(book_id) else {}
    prefs = load_preferences()
    ui = {**_PREF_UI_DEFAULTS, **(prefs.get("ui") or {})}
    ui["background"] = {**_PREF_UI_DEFAULTS["background"], **(ui.get("background") or {})}
    for k, v in override.items():
        if k == "background" and isinstance(v, dict):
            ui["background"] = {**ui["background"], **v}
        else:
            ui[k] = v
    return ui


def _book_cfg_exists(book_id: str) -> bool:
    return paths.book_config_file(book_id).is_file()


@router.get("/books/{book_id}/appearance")
def api_book_appearance_get(book_id: str) -> dict:
    _book_appearance_404(book_id)
    cfg = load_book_config(book_id)
    return {
        "ui": _resolve_book_ui(book_id),
        "has_override": bool(cfg.get("appearance")),
        "scope": "book",
    }


@router.put("/books/{book_id}/appearance")
def api_book_appearance_put(book_id: str, patch: dict = Body(...)) -> dict:
    """写这本书的独立外观。patch = {"ui": {...增量...}} 或 {"reset": true}。

    reset = 清掉这本书的全部覆盖，改回跟随全局（不碰全局偏好本身）。
    """
    _book_appearance_404(book_id)
    if patch.get("reset"):
        cfg = load_book_config(book_id)
        cfg.pop("appearance", None)
        save_book_config(book_id, cfg)
    else:
        ui_patch = patch.get("ui") or {}
        if not isinstance(ui_patch, dict):
            raise HTTPException(status_code=422, detail="ui 必须是对象")
        cfg = load_book_config(book_id)
        cur = cfg.get("appearance") or {}
        for k, v in ui_patch.items():
            if k == "background" and isinstance(v, dict):
                cur["background"] = {**(cur.get("background") or {}), **v}
            else:
                cur[k] = v
        cfg["appearance"] = cur
        save_book_config(book_id, cfg)
    return {
        "ui": _resolve_book_ui(book_id),
        "has_override": bool(load_book_config(book_id).get("appearance")),
        "scope": "book",
    }


# --------------------------------------------------------------------------
# 数据目录占用情况（外观界面顺手显示一下，让你知道素材放哪了）
# --------------------------------------------------------------------------


@router.get("/appearance/where")
def api_appearance_where() -> dict:
    return {
        "assets_dir": str(paths.assets_dir()),
        "themes_dir": str(paths.themes_dir()),
        "legacy_themes_dir": str(paths.legacy_themes_dir()),
        "preferences_file": str(paths.preferences_file()),
        "kinds": {
            k: {
                "dir": str(paths.asset_kind_dir(k)),
                "count": len([f for f in paths.asset_kind_dir(k).glob("*") if f.is_file()])
                if paths.asset_kind_dir(k).is_dir()
                else 0,
            }
            for k in paths.ASSET_KINDS
        },
        "free_hint": "素材与内容物理隔离：删掉 assets/ 只丢外观，实体数据不受影响。",
    }
