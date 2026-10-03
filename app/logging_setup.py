"""日志。

安装后用户看不到控制台，所以日志必须落文件（口子 A6）。
位置：`{data_dir}/logs/app.log`，按天轮转。
"""

from __future__ import annotations

import logging
import sys
from logging.handlers import TimedRotatingFileHandler

from . import paths

_configured = False

_FMT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
_DATEFMT = "%Y-%m-%d %H:%M:%S"


class _SafeStreamHandler(logging.StreamHandler):
    """Windows 控制台在无 tty 时可能写失败，吞掉异常即可。"""

    def emit(self, record: logging.LogRecord) -> None:  # pragma: no cover
        try:
            super().emit(record)
        except Exception:
            pass


def setup_logging(level: str = "INFO", keep_days: int = 14) -> None:
    global _configured
    if _configured:
        return

    root = logging.getLogger()
    root.setLevel(getattr(logging, str(level).upper(), logging.INFO))

    formatter = logging.Formatter(_FMT, datefmt=_DATEFMT)

    try:
        log_file = paths.logs_dir() / "app.log"
        log_file.parent.mkdir(parents=True, exist_ok=True)
        fh = TimedRotatingFileHandler(
            str(log_file), when="midnight", backupCount=max(1, int(keep_days)), encoding="utf-8"
        )
        fh.setFormatter(formatter)
        root.addHandler(fh)
    except Exception:
        # 日志落盘失败不能拖垮程序
        pass

    sh = _SafeStreamHandler(stream=sys.stdout)
    sh.setFormatter(formatter)
    root.addHandler(sh)

    # 第三方库降噪
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("watchfiles").setLevel(logging.WARNING)

    _configured = True


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
