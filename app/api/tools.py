"""工具箱：免费对话 / 图片生成的网页端入口合集（P7）。

收藏夹式的纯链接合集 —— 不嵌任何第三方页面，只存「名字 + 网址 + 备注」，
点击就是新开标签页跳过去。数据存**数据目录**（tools.json），
不进程序目录：程序目录在打包后是只读的，且用户数据永远跟着数据目录走。

首次访问时给一份内置默认清单（主流免费入口），保存后整份落盘，
之后就是用户自己的了。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from pydantic import field_validator

from .. import paths
from ..logging_setup import get_logger

log = get_logger(__name__)
router = APIRouter(tags=["tools"])

#: 分组是固定的两组 —— 界面按这两组做标签页，多出来的组名直接拒收
GROUP_KEYS = {"free-chat": "免费对话", "image-gen": "图片生成"}

TOOL_DEFAULTS: dict[str, list[dict]] = {
    "free-chat": [
        {"name": "DeepSeek", "url": "https://chat.deepseek.com", "note": "深度思考模式，长文推理"},
        {"name": "豆包", "url": "https://www.doubao.com", "note": "字节出品，中文场景顺手"},
        {"name": "通义千问", "url": "https://tongyi.aliyun.com", "note": "阿里出品，长文本能力强"},
        {"name": "Kimi", "url": "https://kimi.moonshot.cn", "note": "超长上下文，整章丢进去问"},
        {"name": "文心一言", "url": "https://yiyan.baidu.com", "note": "百度出品"},
        {"name": "智谱清言", "url": "https://chatglm.cn", "note": "清华系，免费额度足"},
        {"name": "ChatGPT", "url": "https://chatgpt.com", "note": "OpenAI 出品"},
        {"name": "Claude", "url": "https://claude.ai", "note": "Anthropic 出品，长文写作口碑好"},
        {"name": "Gemini", "url": "https://gemini.google.com", "note": "Google 出品"},
    ],
    "image-gen": [
        {"name": "即梦", "url": "https://jimeng.jianying.com", "note": "字节出品，中文提示词友好"},
        {"name": "通义万相", "url": "https://tongyi.aliyun.com/wanxiang", "note": "阿里出品，每日免费额度"},
        {"name": "文心一格", "url": "https://yige.baidu.com", "note": "百度出品"},
        {"name": "Midjourney", "url": "https://www.midjourney.com", "note": "艺术风格见长"},
        {"name": "DALL·E", "url": "https://openai.com/dall-e-3", "note": "OpenAI 出品，集成在 ChatGPT 里"},
        {"name": "Ideogram", "url": "https://ideogram.ai", "note": "图里带字是强项"},
        {"name": "Recraft", "url": "https://www.recraft.ai", "note": "矢量图 / 图标风格"},
        {"name": "Stable Diffusion", "url": "https://stablediffusionweb.com", "note": "开源生态，网页版免安装"},
    ],
}


def _tools_file():
    return paths.data_dir() / "tools.json"


def _default_payload() -> dict:
    return {
        "version": 1,
        "groups": [
            {"key": key, "label": label, "links": [dict(x) for x in TOOL_DEFAULTS[key]]}
            for key, label in GROUP_KEYS.items()
        ],
    }


def load_tools() -> dict:
    f = _tools_file()
    if not f.exists():
        return _default_payload()
    try:
        import json

        data = json.loads(f.read_text(encoding="utf-8"))
        groups = data.get("groups") or []
        # 落过盘的数据也要按固定分组归位，防止旧版本/手改留下脏组名
        by_key = {g.get("key"): g for g in groups if g.get("key") in GROUP_KEYS}
        out = {"version": 1, "groups": []}
        for key, label in GROUP_KEYS.items():
            g = by_key.get(key) or {}
            out["groups"].append({"key": key, "label": label, "links": list(g.get("links") or [])})
        return out
    except Exception as exc:
        log.warning("工具箱配置读取失败，回落到内置默认：%s", exc)
        return _default_payload()


def save_tools(payload: dict) -> dict:
    import json

    groups = payload.get("groups") or []
    by_key = {g.get("key"): g for g in groups}
    missing = set(GROUP_KEYS) - set(by_key)
    if missing:
        raise ValueError(f"缺少分组：{', '.join(sorted(missing))}")
    cleaned = {"version": 1, "groups": []}
    for key, label in GROUP_KEYS.items():
        links = []
        seen_names: set[str] = set()
        for item in by_key[key].get("links") or []:
            name = str(item.get("name") or "").strip()[:60]
            url = str(item.get("url") or "").strip()[:500]
            note = str(item.get("note") or "").strip()[:200]
            if not name or not url.lower().startswith(("http://", "https://")):
                continue
            if name in seen_names:
                continue
            seen_names.add(name)
            links.append({"name": name, "url": url, "note": note})
        cleaned["groups"].append({"key": key, "label": label, "links": links})

    f = _tools_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(cleaned, ensure_ascii=False, indent=2), encoding="utf-8")
    return cleaned


class ToolLink(BaseModel):
    name: str = Field(default="", max_length=60)
    url: str = Field(default="", max_length=500)
    note: str = Field(default="", max_length=200)

    @field_validator("url")
    @classmethod
    def _url_http(cls, v: str) -> str:
        v = v.strip()
        if v and not v.lower().startswith(("http://", "https://")):
            raise ValueError("网址必须以 http:// 或 https:// 开头")
        return v


class ToolGroupIn(BaseModel):
    key: str
    links: list[ToolLink]


class ToolsIn(BaseModel):
    groups: list[ToolGroupIn]


@router.get("/tools")
def api_get_tools() -> dict:
    return load_tools()


@router.put("/tools")
def api_put_tools(payload: ToolsIn) -> dict:
    """整份保存。url 的 http(s) 校验由 ToolLink 的 validator 做 ——
    非法输入要 422 明确拒绝，而不是悄悄丢掉让用户以为存上了。"""
    try:
        return save_tools(payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
