"""打赏码图清单 —— 由 scripts/donate_rebuild.py 生成，请勿手改。

这里存的是**程序包内**那三张原图的 sha256。后端每次自检都拿它跟
`app/assets/donate/*.png` 比对：对不上说明程序文件被动过，界面会给一条
**清不掉**的告警（代码与资源同时被改就防不住了 —— 那已经是另一个程序）。

token 用于图片 URL 的随机后缀，重建一次变一次。
"""

from __future__ import annotations

SCHEMA = 1

TOKEN = "25cce24b916c462e0c411ef3f6fcd52c"

LABELS: dict[str, str] = {
    "alipay": "支付宝",
    "wechat": "微信支付",
    "qqgroup": "QQ 群",
}

ITEMS: dict[str, dict[str, object]] = {
    "alipay": {
        "file": "alipay.png",
        "sha256": "0b35368633ba41939e83f310d83458549dfac45fdce6930e3ddb8a87354af658",
        "bytes": 130303,
        "w": 720,
        "h": 720,
    },
    "wechat": {
        "file": "wechat.png",
        "sha256": "86567e10666f17c36729231025c64626ea8895fae28cf63189e2a430abdc4991",
        "bytes": 154223,
        "w": 720,
        "h": 720,
    },
    "qqgroup": {
        "file": "qqgroup.png",
        "sha256": "2780f9a3b16b6550a02ab7acf7f14ef01962f74641f06d4c23bf4f92b8a64419",
        "bytes": 510932,
        "w": 720,
        "h": 720,
    },
}
