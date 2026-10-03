"""识别引擎目录 —— 给界面用的「去哪下载 / 怎么装 / 什么许可」清单。

**为什么要有这个文件**（用户 2026-10-03 拍板）：

    识别引擎**不进安装包**，只在界面上给出下载地址与安装方法。

理由不是懒，是三条实打实的：
  1. **体积**：本地识别全家桶 163 MB（含 OCR 239 MB），而基础包只有 14.8 MB ——
     为了一个「可能用不上」的功能把包撑大十倍，不划算。
  2. **许可**：OpenCV 官方轮子里捆绑的 `opencv_videoio_ffmpeg*_64.dll`（29.4 MB）
     是 FFmpeg 的 **LGPL-2.1** 二进制重分发（`cv2/LICENSE-3RD-PARTY.txt` 第 243 行
     原文声明）。本项目的铁律是「全链路可商用」，与其辩经不如不分发。
  3. **适配面**：OCR 后端本来就是可选件，装不装都不影响其他任何功能
     （`available_engines()` 会探测出「没装」，界面变灰而已）。

这里每一条都必须是**真的**：真的许可、真的下载地址、真的体积量级。
凡是作者没在本机跑通过的，`adapted` 一律标 `"code"` 而不是 `"verified"` ——
宁可写「代码已就位但未实测」，也不假装验过。界面会照着这个字段显示徽标。
"""

from __future__ import annotations

from pathlib import Path

#: 作者本机上真跑通过的引擎（`verified`）/ 代码写好但没条件实测的（`code`）
ADAPTED_VERIFIED = "verified"
ADAPTED_CODE = "code"

#: 本地引擎（图不出这台机器）。顺序 = 推荐顺序：越靠前越轻、越省事。
LOCAL_ENGINES: list[dict] = [
    {
        "id": "opencv",
        "label": "OpenCV",
        "role": "基座（必需）",
        "license": "Apache-2.0",
        "pip": "opencv-python-headless numpy",
        "size": "约 120 MB（其中 29.4 MB 是捆绑的 FFmpeg，可删）",
        "url": "https://pypi.org/project/opencv-python-headless/",
        "url_label": "PyPI 项目页",
        "adapted": ADAPTED_VERIFIED,
        "needed": True,
        "note": "找闭合区域全靠它。**不装它，本地识别与云端识别都用不了**（云端也要它读图、缩图）。",
    },
    {
        "id": "rapidocr",
        "label": "RapidOCR",
        "role": "OCR（推荐）",
        "license": "Apache-2.0",
        "pip": "rapidocr onnxruntime",
        "size": "约 75 MB",
        "url": "https://github.com/RapidAI/RapidOCR",
        "url_label": "GitHub 项目页",
        "adapted": ADAPTED_VERIFIED,
        "note": "PP-OCR 的 ONNX 版，中文识别好、不拖 torch/paddle。作者本机默认就用这个。"
                "注意 3.x 把 onnxruntime 拆成了单独包，**两个都要装**。",
    },
    {
        "id": "tesseract",
        "label": "Tesseract",
        "role": "OCR（备用）",
        "license": "Apache-2.0",
        "pip": "pytesseract",
        "size": "系统程序约 100 MB（另需中文语言包 chi_sim）",
        "url": "https://github.com/UB-Mannheim/tesseract/wiki",
        "url_label": "Windows 安装包下载页",
        "adapted": ADAPTED_VERIFIED,
        "note": "老牌 OCR，**要另外装系统程序**，装完还得下载中文语言包并勾选。"
                "手写体它本来就不擅长，认不出是常事。",
    },
    {
        "id": "paddleocr",
        "label": "PaddleOCR",
        "role": "OCR（大体积）",
        "license": "Apache-2.0",
        "pip": "paddleocr paddlepaddle",
        "size": "约 1 GB 以上（paddlepaddle 本体很大）",
        "url": "https://github.com/PaddlePaddle/PaddleOCR",
        "url_label": "GitHub 项目页",
        "adapted": ADAPTED_CODE,
        "note": "中文精度通常略好于 RapidOCR，但代价是 1 GB 起步。"
                "**代码已就位，但作者本机没装过，未实测** —— 装完如果报错，先回 RapidOCR。",
    },
    {
        "id": "easyocr",
        "label": "EasyOCR",
        "role": "OCR（大体积）",
        "license": "Apache-2.0",
        "pip": "easyocr",
        "size": "约 2 GB 以上（依赖 PyTorch）",
        "url": "https://github.com/JaidedAI/EasyOCR",
        "url_label": "GitHub 项目页",
        "adapted": ADAPTED_CODE,
        "note": "用起来最省心，但它会拖来一整套 PyTorch。"
                "**代码已就位，但作者本机没装过，未实测**。",
    },
]

#: 云端引擎 —— 严格说不是「引擎」而是「控制台」，图会上传、按 token 计费。
#: 地址全部指向官方控制台 / 开放平台，不放任何第三方镜像。
CLOUD_ENGINES: list[dict] = [
    {
        "id": "qwen-vl",
        "label": "通义千问 VL",
        "role": "视觉大模型",
        "license": "商用需按阿里云条款",
        "provider_hint": "qwen",
        "url": "https://bailian.console.aliyun.com/",
        "url_label": "阿里云百炼控制台",
        "note": "国内直连快，中文地名/题字识别稳。模型名如 qwen-vl-max。",
    },
    {
        "id": "glm-v",
        "label": "智谱 GLM-4V",
        "role": "视觉大模型",
        "license": "商用需按智谱条款",
        "provider_hint": "zhipu",
        "url": "https://open.bigmodel.cn/",
        "url_label": "智谱开放平台",
        "note": "国内直连，接口兼容 OpenAI 格式。",
    },
    {
        "id": "doubao-v",
        "label": "豆包视觉（火山方舟）",
        "role": "视觉大模型",
        "license": "商用需按火山引擎条款",
        "provider_hint": "doubao",
        "url": "https://console.volcengine.com/ark",
        "url_label": "火山方舟控制台",
        "note": "国内直连，需要先开通推理接入点。",
    },
    {
        "id": "kimi-v",
        "label": "Kimi（月之暗面）",
        "role": "视觉大模型",
        "license": "商用需按月之暗面条款",
        "provider_hint": "moonshot",
        "url": "https://platform.moonshot.cn/",
        "url_label": "月之暗面开放平台",
        "note": "长上下文见长，单张地图识别够用。",
    },
    {
        "id": "openai-v",
        "label": "OpenAI（GPT 视觉）",
        "role": "视觉大模型",
        "license": "商用需按 OpenAI 条款",
        "provider_hint": "openai",
        "url": "https://platform.openai.com/api-keys",
        "url_label": "OpenAI API Keys",
        "note": "国内访问通常需要代理。",
    },
    {
        "id": "claude-v",
        "label": "Anthropic Claude",
        "role": "视觉大模型",
        "license": "商用需按 Anthropic 条款",
        "provider_hint": "anthropic",
        "url": "https://console.anthropic.com/",
        "url_label": "Anthropic Console",
        "note": "国内访问通常需要代理。",
    },
    {
        "id": "gemini-v",
        "label": "Google Gemini",
        "role": "视觉大模型",
        "license": "商用需按 Google 条款",
        "provider_hint": "gemini",
        "url": "https://aistudio.google.com/apikey",
        "url_label": "Google AI Studio",
        "note": "有免费额度；国内访问通常需要代理。",
    },
]


def how_to_install(program_dir: str = "", venv_python: str = "") -> dict:
    """把「怎么装」写清楚 —— 分源码运行 / 安装版两种情形。

    不做成一键执行：装依赖是要联网、要写磁盘、要几分钟的动作，
    让用户看着命令自己跑，比背后偷偷装更让人放心（也和本项目
    「AI 只读不写、关键动作必须人工确认」的一贯风格一致）。

    **路径事实**（实测确认，别改错）：
      正式程序的嵌入式 Python 在 `<程序目录>\\runtime\\python.exe`，
      依赖装在 `<程序目录>\\Lib\\site-packages`（由 `python313._pth` 里的
      `..\\Lib\\site-packages` 指定）。**不是** `python\\` 子目录。

    **pip 事实**：官方 python-embed 压缩包**不带 pip，也不带 ensurepip**
    （实测 `runtime\\python.exe -m ensurepip` → `No module named ensurepip`）。
    所以正式包里的 pip 是**构建时**由 build.py 装进去的 —— 见该脚本
    `install_deps()` 的包列表。没有这一步，「你自己 pip 装引擎」就是句空话。
    """
    py_in_pkg = str(Path(program_dir) / "runtime" / "python.exe") if program_dir else r"<程序目录>\runtime\python.exe"
    src_cmd = (
        f'"{venv_python}" -m pip install -r requirements-vision.txt'
        if venv_python
        else r".venv\Scripts\python.exe -m pip install -r requirements-vision.txt"
    )
    return {
        "source_run": {
            "label": "源码运行（你在自己电脑上跑的这份）",
            "commands": [
                src_cmd,
                r":: 国内网络慢就加镜像： -i https://pypi.tuna.tsinghua.edu.cn/simple",
            ],
            "note": "装完重启程序即可，界面里「本地」那一项就不再是灰的。",
        },
        "installed": {
            "label": "安装版（安装向导装出来的正式程序）",
            "commands": [
                rf'"{py_in_pkg}" -m pip install opencv-python-headless numpy',
                rf'"{py_in_pkg}" -m pip install rapidocr onnxruntime',
                r":: 网络慢就加： -i https://pypi.tuna.tsinghua.edu.cn/simple",
            ],
            "note": "装的东西写在程序目录里，**卸载程序会一起删掉**。"
                    "如果提示 pip 不存在，说明你装的是旧版本程序 —— 新版构建时已经把 pip 打进去了。"
                    "另外注意：程序若装在 C:\\Program Files 下，写权限受 UAC 限制，"
                    "命令需用「管理员身份运行」的终端执行。",
        },
        "manual": {
            "label": "完全离线（拷进去）",
            "commands": [],
            "note": "在有网的机器上 `pip download` 出 whl，解压后把里面的包目录拷到 "
                    "`<程序目录>\\Lib\\site-packages` —— "
                    "嵌入式 Python 找的就是这个目录（由 `runtime\\python313._pth` 指定）。",
        },
    }


def catalog(program_dir: str = "", venv_python: str = "") -> dict:
    """整份目录：本地引擎 + 云端控制台 + 安装方法 + 一句总说明。"""
    return {
        "local": LOCAL_ENGINES,
        "cloud": CLOUD_ENGINES,
        "install": how_to_install(program_dir, venv_python),
        "note": "识别引擎不进安装包 —— 想要哪个自己装，装错、装坏都不影响其他功能："
                "缺了哪个，界面上那项变灰并告诉你缺什么。",
        "license_note": "全部本地引擎都是 Apache-2.0（可商用）。"
                        "OpenCV 官方轮子里捆绑的 FFmpeg 是 LGPL-2.1，"
                        "本项目**不分发**它 —— 你自己装的话不受本项目约束。",
    }
