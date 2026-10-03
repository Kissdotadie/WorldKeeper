"""三层配置。

1. 全局：`<数据目录>/config.yaml`（用户可改，可写）
   另有程序目录 `config/config.yaml` 作**只读种子**（安装向导预置），被前者覆盖
2. 书目：`data/books/<book_id>/book.yaml`
3. 用户偏好：`data/preferences.json`

优先级：环境变量 > 用户配置 > 程序目录种子 > 内置默认值。
`storage.data_dir` 例外 —— 只认环境变量与种子（见 load_settings 的说明）。
**无任何硬编码路径**（口子 6）。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from . import paths

# --------------------------------------------------------------------------
# 内置默认值
# --------------------------------------------------------------------------

DEFAULTS: dict[str, Any] = {
    "server": {
        "host": "127.0.0.1",       # 默认仅本机；开启局域网时改为 0.0.0.0
        "port": 8765,
        "port_scan": 20,           # 端口被占用时向后顺延的尝试次数
        "open_browser": True,
        "lan_access": False,       # 局域网访问开关（A4 / 移动端前置条件）
    },
    "storage": {
        "data_dir": None,          # None = 自动推导（便携优先，其次用户文档）
        "snapshot_before_write": True,
    },
    # 定时快照与保留策略（P11-A6）。空/缺项一律落回 app/snapshot.py 的 DEFAULT_POLICY
    "snapshot": {
        "auto_enabled": True,      # 关掉之后只剩「删除前快照」与手动「立即快照」
        "interval_hours": 24,      # 距上次自动快照多久算「到点」
        "keep_count": 20,          # 最多保留几份（按时间保新删旧）
        "max_total_mb": 512,       # 快照目录总量上限；0 = 只看份数
    },
    "ui": {
        "theme": "默认",
        "font_scale": 1.0,
    },
    "log": {
        "level": "INFO",
        "keep_days": 14,
    },
    "ai": {
        "enabled": False,          # P2 才会真正用到
        "base_url": "",
        "model": "",
        "monthly_limit": None,     # 花费上限（元），None = 不限制
    },
}


def _deep_merge(base: dict, override: dict) -> dict:
    """递归合并，override 覆盖 base。"""
    out = dict(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


# --------------------------------------------------------------------------
# 全局配置
# --------------------------------------------------------------------------

@dataclass
class Settings:
    raw: dict = field(default_factory=dict)
    data_dir: Path = field(default_factory=paths.data_dir)
    config_file: Path | None = None

    # -- 便捷访问 --------------------------------------------------------
    @property
    def server(self) -> dict:
        return self.raw.get("server", {})

    @property
    def host(self) -> str:
        return self.server.get("host", "127.0.0.1")

    @property
    def port(self) -> int:
        return int(self.server.get("port", 8765))

    @property
    def port_scan(self) -> int:
        return int(self.server.get("port_scan", 20))

    @property
    def lan_access(self) -> bool:
        return bool(self.server.get("lan_access", False))

    @property
    def bind_host(self) -> str:
        """实际绑定地址：开启局域网时为 0.0.0.0。"""
        return "0.0.0.0" if self.lan_access else self.host

    @property
    def log_level(self) -> str:
        return str(self.raw.get("log", {}).get("level", "INFO"))

    @property
    def log_keep_days(self) -> int:
        return int(self.raw.get("log", {}).get("keep_days", 14))

    @property
    def snapshot_before_write(self) -> bool:
        return bool(self.raw.get("storage", {}).get("snapshot_before_write", True))

    @property
    def snapshot_policy(self) -> dict:
        """定时快照策略（缺项由 app/snapshot.py 的 DEFAULT_POLICY 兜底）。"""
        return self.raw.get("snapshot", {}) or {}

    @property
    def snapshot_auto_enabled(self) -> bool:
        return bool(self.snapshot_policy.get("auto_enabled", True))

    @property
    def ai(self) -> dict:
        return self.raw.get("ai", {})

    @property
    def updates(self) -> dict:
        """C1 更新提示。只提示、绝不自动替换；url 没配 = 不检查。"""
        return self.raw.get("updates", {}) or {}


_settings: Settings | None = None


def _read_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        # 配置坏了不能让工具起不来，退回默认值
        return {}


def load_settings(reload: bool = False) -> Settings:
    """加载并缓存全局配置。首次调用会据此初始化数据目录。

    合并顺序（后者覆盖前者）：
        DEFAULTS  <  程序目录种子 config.yaml  <  数据目录 config.yaml  <  环境变量

    为什么分「种子」与「用户」两层：装进 `Program Files` 之后程序目录只读，
    而端口 / 局域网开关 / 更新地址都是用户随时要改的，必须有一份可写的。
    数据目录的位置**只能**由环境变量或种子决定 —— 它要是也能被数据目录里那份
    配置改，下次启动就换地方了（等于自己把自己搬走）。
    """
    global _settings
    if _settings is not None and not reload:
        return _settings

    seed_file = paths.global_config_file()      # 程序目录：安装时预置，只读
    seed = _read_yaml(seed_file)

    # 先定数据目录：环境变量 > 种子文件 > 自动推导
    env_data = os.environ.get(paths.ENV_DATA_DIR)
    raw_data_dir = env_data or (seed.get("storage") or {}).get("data_dir")
    data_dir = Path(raw_data_dir).expanduser() if raw_data_dir else paths.default_data_dir()
    paths.set_data_dir(data_dir)
    paths.ensure_data_dirs()

    user_file = paths.user_config_file()        # 数据目录：用户可改，可写
    merged = _deep_merge(_deep_merge(DEFAULTS, seed), _read_yaml(user_file))
    # 数据目录一旦定下就不许配置文件再动它（否则下次启动会换地方）
    merged.setdefault("storage", {})["data_dir"] = str(paths.data_dir())

    # 环境变量覆盖（测试 / 便携模式）
    env_port = os.environ.get("WKV_PORT")
    if env_port and env_port.isdigit():
        merged["server"]["port"] = int(env_port)
    env_lan = os.environ.get("WKV_LAN")
    if env_lan is not None:
        merged["server"]["lan_access"] = env_lan not in ("", "0", "false", "False")

    # 报告实际生效的那份文件（用户那份优先 —— 后台要显示正确的路径）
    if user_file.exists():
        effective = user_file
    elif seed_file.exists():
        effective = seed_file
    else:
        effective = None

    _settings = Settings(raw=merged, data_dir=paths.data_dir(), config_file=effective)
    return _settings


def get_settings() -> Settings:
    return load_settings()


def write_default_config(overwrite: bool = False) -> Path:
    """首次运行时生成一份带注释的 config.yaml。

    ⚠️ 写的是**数据目录**里那份（用户可写），不是程序目录里的。
    装在 `Program Files` 下时程序目录只读，往那儿写必然失败。
    程序目录那份由安装向导预置，只作「种子」，用户改不到也不需要改。
    """
    target = paths.user_config_file()
    if target.exists() and not overwrite:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    template = (
        "# 世界观查询器 — 全局配置（用户配置，随数据目录走）\n"
        "# 程序目录下若有一份同名文件，那是安装时预置的只读种子；\n"
        "# 这里改的值覆盖它，改不动它也不影响 —— 改完重启程序生效。\n\n"
        "server:\n"
        "  host: 127.0.0.1        # 仅本机访问\n"
        "  port: 8765\n"
        "  port_scan: 20          # 端口被占用时向后顺延\n"
        "  open_browser: true\n"
        "  lan_access: false      # 开启后手机可在同一 WiFi 下访问\n\n"
        "storage:\n"
        "  data_dir: null         # 数据目录：只认程序目录种子或 WKV_DATA_DIR，改这里不生效（防自搬）\n"
        "  snapshot_before_write: true\n\n"
        "snapshot:\n"
        "  auto_enabled: true     # 启动时与每 interval_hours 自动存一份\n"
        "  interval_hours: 24     # 距上次自动快照多久算「到点」\n"
        "  keep_count: 20         # 最多保留几份（保新删旧）\n"
        "  max_total_mb: 512      # 快照目录总量上限；0 = 只看份数\n\n"
        "ui:\n"
        "  theme: 默认\n"
        "  font_scale: 1.0\n\n"
        "log:\n"
        "  level: INFO\n"
        "  keep_days: 14\n\n"
        "ai:\n"
        "  enabled: false\n"
        "  base_url: ''\n"
        "  model: ''\n"
        "  monthly_limit: null\n"
        "\n"
        "updates:\n"
        "  enabled: true         # 启动后异步查一次新版本；只提示，绝不自动下载替换\n"
        "  url: ''               # 远端版本清单地址（JSON：version/notes/url），空 = 不检查\n"
        "  interval_hours: 24    # 检查频率：间隔内的重复检查直接用上次结果\n"
    )
    target.write_text(template, encoding="utf-8")
    return target


# --------------------------------------------------------------------------
# 书目配置
# --------------------------------------------------------------------------

BOOK_DEFAULTS: dict[str, Any] = {
    "book_id": "",
    "title": "",
    "author": "",
    "entity_types": [
        {"key": "character", "label": "人物"},
        {"key": "location", "label": "地点"},
        {"key": "faction", "label": "势力"},
        {"key": "organization", "label": "机构"},
        {"key": "item", "label": "物品"},
        {"key": "concept", "label": "概念"},
        {"key": "realm", "label": "境界"},
    ],
    "narrative_time": {"calendar": "", "current": ""},
    "schema_version": 1,
}


def book_config_path(book_id: str) -> Path:
    return paths.book_config_file(book_id)


def load_book_config(book_id: str) -> dict:
    return _deep_merge(BOOK_DEFAULTS, _read_yaml(book_config_path(book_id)))


def save_book_config(book_id: str, cfg: dict) -> None:
    p = book_config_path(book_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False), encoding="utf-8")


# --------------------------------------------------------------------------
# 用户偏好（视图状态、上次打开的书等 —— 属于「非索引」信息，必须落文件）
# --------------------------------------------------------------------------

def load_preferences() -> dict:
    p = paths.preferences_file()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_preferences(prefs: dict) -> None:
    p = paths.preferences_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(prefs, ensure_ascii=False, indent=2), encoding="utf-8")
