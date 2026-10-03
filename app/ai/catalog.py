"""AI 服务商申请引导 —— 回答「我完全不懂 API，Key 从哪弄？」。

**为什么要有这个文件**（用户 2026-10-03 提出，N1）：

    目标用户可能对 AI API 一窍不通。界面不能只丢一个空的 `base_url / model / key`
    三件套问他，那等于把「你不会」当成「你懒得」。

三条自定的规矩，改内容时请继续遵守：

  1. **只放官方直链** —— 不放任何推广链、返利链、第三方镜像。
  2. **不替用户做决定** —— 只把「去哪申请、要不要代理、大概什么价、有什么坑」讲清楚，
     推荐只标一个（新手最省事的那个），不排名、不比较精度。
  3. **隐私必须写在最显眼处** —— 正文会离开这台机器，这是未发表作品。

和 `app/vision/catalog.py` 同一套做法：内容归后端，界面只管渲染。
改文案不用碰前端，也不用重新构建界面。
"""

from __future__ import annotations

#: 「是什么」—— 给完全没概念的人看的两句打比方。
#: 不写技术定义（什么叫 REST、什么叫 Bearer Token），写了也没用。
INTRO: dict = {
    "title": "API 是什么？Key 是什么？",
    "api": "把 AI 想象成一家餐厅：**API 就是点菜窗口**。你不用自己开火，"
           "把要问的写在单子上递进去，厨房做好端出来。这个工具就是这么跟 AI 打交道的 —— "
           "你把章节交给它读，它把抽出来的条目送回来。",
    "key": "**API Key 就是你的会员卡号**。窗口认卡不认人 —— "
           "谁拿着卡号，谁就能替你点菜、**花你的钱**。所以：不要截图发群里、"
           "不要贴进聊天记录、不要提交到代码仓库。",
    "where": "卡号只存在你自己电脑的数据目录里，界面永远只显示打码形态；"
             "填进去之后，除了你自己，谁也看不到。",
}

#: 新手三步 —— 不做成「一键代申请」，申请要注册、实名、掏钱，那是用户自己的账号。
STEPS: list[dict] = [
    {
        "n": 1,
        "title": "去官网注册一个账号",
        "detail": "下面每一家都给了直链。**认准域名**，别在搜索引擎里点广告位。",
    },
    {
        "n": 2,
        "title": "充一点点钱，建一个 API Key",
        "detail": "多数平台最低充 10 元起，够抽完好几本书。"
                  "建 Key 的那一页通常叫「API Keys / 密钥管理」，"
                  "复制出来是一长串以 `sk-` 开头的字符 —— 那就是会员卡号。",
    },
    {
        "n": 3,
        "title": "回到上面「AI 服务商」，加一家填进去",
        "detail": "三家字段照着下表的「base_url / 模型名」抄，key 粘进密钥框，"
                  "点【保存】再点【测连通】—— **通了才算配好**，没通会当场告诉你原因。",
    },
]

#: 服务商清单。`recommended` 只标一个：新手第一次配，选它最不容易卡住
#: （国内能直连、便宜、中文够用）。
#: ⚠️ 价钱一律只给量级，并注明「以官网为准」—— 价目表改动频繁，写死数字必过期。
PROVIDERS: list[dict] = [
    {
        "id": "deepseek",
        "label": "DeepSeek（深度求索）",
        "recommended": True,
        "access": "国内直连，不需要代理",
        "url": "https://platform.deepseek.com/api_keys",
        "url_label": "DeepSeek 开放平台 · 创建 API Key",
        "base_url": "https://api.deepseek.com/v1",
        "model": "deepseek-chat",
        "pricing": "便宜（约几元 / 百万 token 量级，以官网价目为准）",
        "signup": "手机号注册 → 实名 → 充值（最低 10 元起）→ 在「API keys」页新建一个 key",
        "note": "作者本机一直用这一家做章节抽取。中文好、便宜、不用折腾网络。"
                "**第一次配 API，选它最省事。**",
    },
    {
        "id": "moonshot",
        "label": "Kimi（月之暗面）",
        "access": "国内直连，不需要代理",
        "url": "https://platform.moonshot.cn/console/api-keys",
        "url_label": "月之暗面开放平台 · API Key 管理",
        "base_url": "https://api.moonshot.cn/v1",
        "model": "moonshot-v1-8k",
        "pricing": "中等（以官网价目为准）",
        "signup": "手机号注册 → 充值 → 「API Key 管理」页新建",
        "note": "长上下文见长，适合一次喂进去很长的一段设定。",
    },
    {
        "id": "qwen",
        "label": "通义千问（阿里云百炼）",
        "access": "国内直连，不需要代理",
        "url": "https://bailian.console.aliyun.com/",
        "url_label": "阿里云百炼控制台",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "model": "qwen-plus",
        "pricing": "中等（百炼常有新用户免费额度，以官网为准）",
        "signup": "阿里云账号登录 → 开通百炼 → 在「API-KEY 管理」新建",
        "note": "用的是「OpenAI 兼容模式」的地址（上面那条），**别直接抄成 dashscope 原生地址**，"
                "两者的路径不一样。",
    },
    {
        "id": "zhipu",
        "label": "智谱 GLM",
        "access": "国内直连，不需要代理",
        "url": "https://open.bigmodel.cn/usercenter/apikeys",
        "url_label": "智谱开放平台 · API Keys",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "model": "glm-4-flash",
        "pricing": "glm-4-flash 档很便宜（以官网价目为准）",
        "signup": "手机号注册 → 实名 → 「API Keys」页新建",
        "note": "接口兼容 OpenAI 格式，直接填上面两条就能用。",
    },
    {
        "id": "siliconflow",
        "label": "硅基流动 SiliconFlow",
        "access": "国内直连，不需要代理",
        "url": "https://cloud.siliconflow.cn/account/ak",
        "url_label": "硅基流动 · API 密钥",
        "base_url": "https://api.siliconflow.cn/v1",
        "model": "deepseek-ai/DeepSeek-V3",
        "pricing": "部分小模型有免费额度（以官网为准）",
        "signup": "手机号注册 → 「API 密钥」页新建",
        "note": "它是「聚合平台」：一个 key 能调很多家的模型，模型名写成 `厂商/模型` 那种形式。"
                "想试不同模型又不想挨家开户，用这个。",
    },
    {
        "id": "openai",
        "label": "OpenAI",
        "access": "国内访问通常需要代理",
        "url": "https://platform.openai.com/api-keys",
        "url_label": "OpenAI 平台 · API Keys",
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o-mini",
        "pricing": "偏贵，且要按美元结算（以官网为准）",
        "signup": "邮箱注册 → 绑卡充值 → 「API keys」页新建",
        "note": "国内直连基本不通，需要自己解决网络问题。新手不建议从这家开始。",
    },
]

#: 本地跑 —— 正文一个字都不出这台机器。
LOCAL_RUNNERS: list[dict] = [
    {
        "id": "ollama",
        "label": "Ollama（本地跑模型）",
        "url": "https://ollama.com/download",
        "url_label": "Ollama 官网下载",
        "base_url": "http://127.0.0.1:11434/v1",
        "model": "qwen2.5:7b",
        "note": "装完在命令行 `ollama pull qwen2.5:7b` 把模型拉下来，"
                "然后把上面两条填进「AI 服务商」，key 随便填一个非空的字符串即可"
                "（本机服务不看 key）。**适合介意正文外发的人** —— 代价是需要一台还行的电脑，"
                "7B 模型效果明显不如上面那些云端大模型。",
    },
]

#: 费用锚点 —— 用**本项目的实测数据**，不用厂商宣传数字。
#: 真实数字比任何「超便宜」都更能让人敢点下去。
COST_ANCHOR: dict = {
    "title": "大概要花多少钱？",
    "body": "拿这本书打个样：**30 章、31.3 万字**的整本抽取，"
            "用 DeepSeek 一共花了 **¥1.48**。也就是说，"
            "**一本书的 AI 开销通常是一杯咖啡以内**。"
            "具体单价随厂商调整，界面里「成本与词元」那一栏会实时记着你自己花了多少。",
}

#: 免责 + 隐私。两句都不能删：
#: 前者是「这不是广告」，后者是硬性要求（正文外发必须告知）。
DISCLAIMER = ("这里只是新手引导：**不是广告、没有返利、不代充值、不参与任何分成**。"
              "链接一律指向各家官方站点，认准域名再注册。"
              "用哪家、花多少，都由你自己决定 —— 作者不推荐具体付费方案。")

PRIVACY = ("⚠️ **正文会离开这台机器**：跑 AI 抽取时，章节原文会发送给上面你选的那家服务商。"
           "这是**未发表的作品**，介意的话就别用云端 —— 用本地的 Ollama，正文一个字都不出本机。")


def guide() -> dict:
    """整份引导：科普 + 三步 + 服务商清单 + 本地方案 + 费用锚点 + 免责 + 隐私。"""
    return {
        "intro": INTRO,
        "steps": STEPS,
        "providers": PROVIDERS,
        "local": LOCAL_RUNNERS,
        "cost": COST_ANCHOR,
        "disclaimer": DISCLAIMER,
        "privacy": PRIVACY,
        "note": "填好之后点【测连通】验证一次 —— 通不了会直接告诉你哪一步错了，"
                "比「存了但跑不动」强。",
    }
