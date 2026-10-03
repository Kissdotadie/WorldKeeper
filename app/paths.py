"""统一路径解析。

铁律：程序目录 != 数据目录。

- 程序目录：代码与静态资源所在。安装后位于 C:\\Program Files\\ 一类只读位置。
- 数据目录：用户可写。存放 books/、logs/、preferences.json。

任何模块都不得自行拼接相对路径，一律经由本模块。
这是「安装分发口子 A1 / A2」的落地。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# 数据目录由 config 初始化时注入，避免 paths 与 config 循环依赖
_data_dir: Path | None = None

APP_NAME = "世界观查询器"
APP_DIR_NAME = "WorldKeeper"

# 环境变量：优先于配置文件，供测试与便携模式使用
ENV_DATA_DIR = "WKV_DATA_DIR"


# --------------------------------------------------------------------------
# 程序目录
# --------------------------------------------------------------------------

def is_frozen() -> bool:
    """是否运行在打包 / 嵌入式环境中。

    PyInstaller 会在 sys 上挂 _MEIPASS；嵌入式 Python 不一定有，
    因此同时检查 sys.frozen。
    """
    return bool(getattr(sys, "frozen", False) or hasattr(sys, "_MEIPASS"))


def program_dir() -> Path:
    """程序根目录（只读资源所在）。

    - 开发期：本项目目录
    - 打包后：可执行文件所在目录（或 PyInstaller 的解包目录）
    """
    if is_frozen():
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass)
        return Path(sys.executable).resolve().parent
    # app/paths.py -> app/ -> 项目根
    return Path(__file__).resolve().parent.parent


def resource_path(*parts: str) -> Path:
    """只读资源路径（前端构建产物、内置模板、迁移脚本等）。"""
    return program_dir() / "resources" / Path(*parts) if parts else program_dir() / "resources"


def web_dist_dir() -> Path:
    """前端构建产物目录。开发期在 web/dist，打包后由程序目录托管。"""
    return program_dir() / "web" / "dist"


def config_dir() -> Path:
    """程序配置文件目录（随程序走，非用户数据）。"""
    return program_dir() / "config"


# --------------------------------------------------------------------------
# 程序包内置资源（只读真源）
# --------------------------------------------------------------------------

def bundled_donate_dir() -> Path:
    """打赏码原图（**编在程序包里**，只读）。

    为什么不像外观素材那样放数据目录：放在数据目录意味着任何能写那个目录的
    东西都能把收款码换掉，而界面上看不出差别。放进程序包之后，改数据目录里的
    副本不再影响对外服务 —— 后端每次自检会拿 `app/donate_manifest.py` 里的
    sha256 比对，不符就从包内原图覆盖回去，并留一条清不掉的告警。

    注意：打包（PyInstaller / 嵌入式 Python）时必须把这个目录一并带上，
    见 PLAN.md 的 P8 打包清单。
    """
    return Path(__file__).resolve().parent / "assets" / "donate"


def global_config_file() -> Path:
    """程序目录里的配置**种子**（只读，安装时预置或首次运行生成）。

    ⚠️ 安装后这个文件在 `C:\\Program Files\\` 下 —— **不可写**。
    用户真正能改的那一份在数据目录里，见 `user_config_file()`。
    """
    return config_dir() / "config.yaml"


def user_config_file() -> Path:
    """数据目录里的用户全局配置（**可写**，覆盖程序目录那份种子）。

    为什么必须有这一层：装进 `Program Files` 之后，程序目录整棵是只读的，
    而「改端口 / 开局域网 / 填更新地址」是用户随时要干的事 ——
    没有这一层，那些设置就只能靠管理员权限去改安装目录里的文件。
    """
    return data_dir() / "config.yaml"


# --------------------------------------------------------------------------
# 数据目录
# --------------------------------------------------------------------------

def _is_writable(path: Path) -> bool:
    """探测目录是否可写 —— **只探测，不创建**。

    这里踩过真实的坑：早先的实现为了探测而 `path.mkdir(parents=True, exist_ok=True)`，
    于是「探测」变成了「创建」。装到 Program Files 后，若进程恰好以管理员运行
    （安装向导最后一页勾选「运行」启动的程序会继承提权），探测就把 `data/`
    建进了程序目录，数据也跟着落在那儿 —— 违反「程序目录 != 数据目录」铁律。

    规则：目录**不存在**就是不可写（便携模式要求目录已存在）；
    探针文件写完即删，不留痕迹。
    """
    if not path.is_dir():
        return False
    try:
        probe = path / ".wkv_write_probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return True
    except Exception:
        return False


def default_data_dir() -> Path:
    """未配置时推导数据目录。

    便携模式的门槛：`<程序目录>/data` **已经存在**且可写 —— 用它。
    存在性这一条是防事故的关键：绝不在程序目录里凭空建 data/。
    安装模式下种子配置会给出数据目录，根本走不到这里；本函数主要是
    开发期、「config 尚未初始化」的兜底情形在用。
    """
    portable = program_dir() / "data"
    if portable.is_dir() and _is_writable(portable):
        return portable
    docs = Path(os.path.expanduser("~")) / "Documents"
    if not docs.exists():
        docs = Path(os.path.expanduser("~"))
    return docs / APP_DIR_NAME


def set_data_dir(path: str | Path) -> None:
    """由 config 初始化时调用。"""
    global _data_dir
    _data_dir = Path(path).expanduser().resolve()


def data_dir() -> Path:
    """当前生效的数据目录。未初始化则按默认规则推导。"""
    if _data_dir is None:
        # 兜底：允许在 config 尚未初始化时也能工作（例如迁移脚本）
        set_data_dir(default_data_dir())
    assert _data_dir is not None
    return _data_dir


def ensure_data_dirs() -> None:
    """确保数据目录骨架存在（含外观素材、主题与 AI 的子目录）。"""
    dirs = [data_dir(), books_dir(), logs_dir(), assets_dir(), themes_dir(),
            ai_dir(), ai_cache_dir(), ai_prompts_dir(), vision_dir(), vision_cache_dir(),
            snapshots_dir(), jobs_dir()]
    dirs += [asset_kind_dir(k) for k in ASSET_KINDS]
    for p in dirs:
        p.mkdir(parents=True, exist_ok=True)


# --------------------------------------------------------------------------
# 数据子路径
# --------------------------------------------------------------------------

def books_dir() -> Path:
    return data_dir() / "books"


def book_dir(book_id: str) -> Path:
    return books_dir() / book_id


def ensure_inside_book(book_id: str, p: str | Path) -> Path:
    """确认路径真的落在本书目录内，返回 resolve 后的路径；不在就抛 ValueError。

    索引里的 file_path 是**绝对路径** —— 万一索引是从别处整份拷来的
    （测试副本、换了数据目录），路径就会指向这本书之外的文件。
    删除是不可逆动作，动手前必须过这一关：路径错了宁可拒删，让用户重建索引。

    典型事故（已发生过一次）：拿真实数据拷贝做测试副本，索引里的路径还指着
    原目录，副本上点「删除」，真实文件被删了。有了这道闸，副本上会直接报错。
    """
    rp = Path(p).resolve()
    root = book_dir(book_id).resolve()
    try:
        rp.relative_to(root)
    except ValueError:
        raise ValueError(
            f"档案路径不在本书目录内（{rp}），疑似索引过期或数据目录被移动 —— 请重建索引后再操作"
        ) from None
    return rp


def ensure_book_root(book_id: str) -> Path:
    """确认 book_id 解析出来正是 `books/` 下的**直接子目录**，返回 resolve 后的路径。

    整书删除是不可逆动作，光靠 book_id 拼路径不够 —— `..` 一旦漏进来就会删到
    数据目录外面去。所以这一关要求：
      - 非空、不是 `.` / `..`、不含路径分隔符
      - resolve 之后 parent 必须**就是** books_dir() 本身

    与 `ensure_inside_book` 的分工：那个管「某本书里的某个文件」，
    这个管「这本书本身」。
    """
    bid = (book_id or "").strip()
    if not bid or bid in (".", ".."):
        raise ValueError(f"书目 ID 不合法：{book_id!r}")
    if "/" in bid or "\\" in bid:
        raise ValueError(f"书目 ID 不该含路径分隔符：{book_id!r}")
    rp = book_dir(bid).resolve()
    root = books_dir().resolve()
    if rp.parent != root:
        raise ValueError(f"书目路径不在 books/ 下（{rp}），拒绝操作")
    return rp


def entities_dir(book_id: str) -> Path:
    return book_dir(book_id) / "entities"


def chapters_dir(book_id: str) -> Path:
    """正文目录 —— 只读区，工具永不写入。"""
    return book_dir(book_id) / "chapters"


def world_dir(book_id: str) -> Path:
    return book_dir(book_id) / "world"


def view_dir(book_id: str) -> Path:
    """视图装饰层（布局 / 相机 / 贴纸），与内容数据物理隔离。"""
    return book_dir(book_id) / "view"


def maps_dir(book_id: str) -> Path:
    """地图。

    一间目录放全部地图：`index.json` 是目录（标题 / 父子 / 顺序），
    `<map_id>.json` 是单张图的内容（点位 / 区域）。

    为什么不塞进一个文件：一张图一个文件，坏一张只坏一张；而且拖一个点位
    只重写那一个文件，不用把整本书的地图重写一遍。
    """
    return view_dir(book_id) / "maps"


def styles_dir(book_id: str) -> Path:
    """可视化样式包（P5）。

    和地图同一套思路：`index.json` 是目录（有哪些包、当前用哪个），
    `<pack_id>.json` 是单个样式包。改一个包只重写那一个文件。

    ⚠️ 这是**装饰层**，与 `entities/` 的内容数据物理隔离 ——
    样式包删光、改烂，最多图变回默认长相，实体一个字都不少。
    """
    return view_dir(book_id) / "styles"


def node_styles_file(book_id: str) -> Path:
    """单节点的外观覆盖（`view/nodes.json`）。

    为什么不写进实体 frontmatter：把这个节点画成什么形状、什么颜色，
    是**这张图上的观感**，不是这个实体是什么。写进内容文件既会污染
    「Markdown 是唯一真源」这条线，也会让改一次颜色就重排整个文件。
    """
    return view_dir(book_id) / "nodes.json"


def decorations_file(book_id: str) -> Path:
    """贴纸（`view/decorations.json`）：按视图分区存位置与图层。"""
    return view_dir(book_id) / "decorations.json"


def book_config_file(book_id: str) -> Path:
    return book_dir(book_id) / "book.yaml"


def index_file() -> Path:
    """SQLite 索引 —— 可随时删除重建。"""
    return data_dir() / "index.db"


def logs_dir() -> Path:
    return data_dir() / "logs"


def preferences_file() -> Path:
    return data_dir() / "preferences.json"


def assets_dir() -> Path:
    return data_dir() / "assets"


def snapshots_dir() -> Path:
    return data_dir() / "snapshots"


def jobs_dir() -> Path:
    """异步任务的记录与暂存（P11-A3）。

    **刻意不放在书目录里**，也不进 `index.db`：
    - 不在书目录：不会被数据指纹扫成「外部改动」，不会被整本快照带走，
      不会被整书导出打包（它是运行期痕迹，不是你的作品内容）
    - 不进索引：铁律「索引零独占状态」—— 索引可以随时删掉重建，
      而「第 12 章已经抽过了」这种进度删掉就是真的没了
    """
    return data_dir() / "jobs"


# --------------------------------------------------------------------------
# AI 层（密钥 / 计量 / 缓存 / 提示词）
#
# 密钥与用量都是**用户数据**，按铁律落数据目录 —— 程序目录只读。
# 计量与缓存不是 md 派生数据，所以**不进 index.db**（索引零独占状态）。
# --------------------------------------------------------------------------

def ai_dir() -> Path:
    return data_dir() / "ai"


def ai_config_file() -> Path:
    """AI 服务商配置（含密钥）。机密：不进版本控制、不写日志、不回显明文。"""
    return ai_dir() / "ai.yaml"


def ai_metering_file() -> Path:
    """token 计量流水（JSONL 追加）。"""
    return ai_dir() / "metering.jsonl"


def ai_cache_dir() -> Path:
    """AI 响应缓存（键 = 内容hash + 提示词版本 + 模型 + 服务商）。"""
    return ai_dir() / "cache"


def ai_monitor_file() -> Path:
    """词元监测开关状态（active / started_at / label）。"""
    return ai_dir() / "monitor.json"


def ai_prompts_dir() -> Path:
    """提示词模板（版本化）：<name>/current.md + <name>/versions/vNNN.md"""
    return ai_dir() / "prompts"


def skills_dir() -> Path:
    """AI 技能卡（提示词模板库）：一卡一文件 <id>.md。

    全局一份、跨书共享 —— 「怎么读正文」是方法论层面的东西，
    换一本书不必重录。卡里的模板只产出分析结果，绝不写正文。
    """
    return data_dir() / "skills"


# --------------------------------------------------------------------------
# 识别引擎（P4.5.3）
#
# 配置是**全局一份**（跟 ai.yaml 一个待遇，不分书）—— 「这台机器上有没有
# OCR、默认走本地还是云端」是机器级事实，不该每本书问一遍。
# 但它和 ai.yaml 分开存：那边是密钥，这边是算法参数，混在一起容易误传。
# --------------------------------------------------------------------------

def vision_dir() -> Path:
    return data_dir() / "vision"


def vision_config_file() -> Path:
    """识别引擎配置（引擎选择 / 本地参数 / 云端用哪个服务商）。"""
    return vision_dir() / "config.json"


def vision_cache_dir() -> Path:
    """识别结果缓存。键 = 底图内容 hash + 引擎 id + 参数指纹。

    为什么不复用 ai/cache：识别是**幂等且贵**的活（云端一次几毛、本地一次几秒），
    同一张底图同一套参数重跑没有意义。缓存只存候选，不存任何已确认的数据。
    """
    return vision_dir() / "cache"


# --------------------------------------------------------------------------
# 外观素材（口子：装饰数据与内容数据物理隔离）
#
# 字体、背景、贴纸统统放 data/assets/ 下，**不碰 entities/**。
# 这样「删掉 assets 只丢外观、绝不丢内容」，反过来也一样。
# --------------------------------------------------------------------------

#: 素材种类 → 允许的扩展名（白名单，其他一律拒收）
ASSET_KINDS: dict[str, tuple[str, ...]] = {
    "fonts": (".ttf", ".otf", ".woff", ".woff2"),
    "backgrounds": (".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif"),
    "stickers": (".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif"),
    #: 节点/实体图标。与 stickers 分开：贴纸是界面装饰，图标是往图谱上挂的
    "icons": (".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif"),
    #: 书目封面。同 icons 一样是展示素材，但挂在书上而不是实体上
    "covers": (".png", ".jpg", ".jpeg", ".webp", ".avif"),
    #: 地图底图。只收静态位图 —— svg 当底图会被浏览器当文档执行脚本，风险不值当
    "maps": (".png", ".jpg", ".jpeg", ".webp", ".avif"),
}


def asset_kind_dir(kind: str) -> Path:
    if kind not in ASSET_KINDS:
        raise ValueError(f"未知素材种类：{kind}")
    return assets_dir() / kind


def themes_dir() -> Path:
    """自定义主题目录（`data/themes/*.json`）。

    铁律「程序目录只读」：用户存的主题是用户数据，必须落在数据目录。
    内置主题由代码常量提供（app/api/appearance.py 的 BUILTIN_THEMES），
    不依赖任何文件。
    """
    return data_dir() / "themes"


def legacy_themes_dir() -> Path:
    """旧主题目录（程序目录 `config/themes/`）。

    仅用于启动时的一次性迁移（把用户自定义主题搬进数据目录），
    除此之外不再读写 —— 打包安装后这里可能根本不可写。
    """
    return config_dir() / "themes"
