"""规则抽取 —— 从正文里挑出「可能是实体」的候选。

设计前提：**没有任何 AI，也不装词典**。
所以不追求「认全」，只追求「认出来的那批尽量对」，
剩下的交给人工在待确认清单里勾 —— 这也是 C 档「必须人工确认」的定位。

三路证据合流：
1. 说话人锚定：`X说 / X道 / X问 / X喊道` —— 小说里最可靠的指人信号
2. 引语上下文：引号附近出现的专名
3. 高频专名：反复出现的 2~4 字汉字串（配停用词表过滤）

第四路是**已知实体回扫**：库里已录的名字，在正文里出现几次、在哪几段，
这是「出场记录」的来源，不需要新建实体。

输出一律是候选，绝不落盘。
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field

# 「像不像专名」的判定只有一份，放在 lint：抽取器和后台「实体体检」面板共用。
# 两边各写一套必然漂移 —— 面板判为垃圾的名字，下次抽取又冒出来。
from .lint import GENERIC_WORDS, PRONOUNS, judge_name

# --------------------------------------------------------------------------
# 词表：停用与排除
# --------------------------------------------------------------------------

#: 说话动词（放在名字后面）
SPEECH_VERBS = (
    "说", "道", "问", "答", "喊", "叫", "笑", "叹", "哼", "吼", "喃", "嘀咕",
    "回答", "答道", "应道", "笑道", "喊道", "叹道", "问道", "说道", "低声道",
    "轻声道", "喃喃", "附和", "补充", "开口", "解释", "宣布", "命令", "提醒",
    "警告", "询问", "反问", "追问", "自言自语", "继续说", "接着说",
)

#: 情绪 / 方式副词 —— 常夹在「名字」和「说」之间，剥掉它才能拿到真名字
#: 例：「卡特疑惑道」→ 真名是「卡特」，「疑惑」是副词
MANNER_WORDS = (
    "疑惑", "欣慰", "大笑", "苦笑", "冷笑", "微笑", "大笑", "厉声", "低声", "轻声",
    "沉声", "喃喃", "急忙", "连忙", "赶紧", "淡定", "淡然", "愤怒", "恼怒", "惊讶",
    "惊恐", "无奈", "苦涩", "得意", "自信", "平静", "冷静", "温柔", "严肃", "郑重",
    "缓缓", "慢慢", "淡淡", "轻轻", "重重", "重重地", "下意识", "若有所思", "若有",
    "一边", "又", "也", "才", "便", "就", "则", "却", "忙", "笑", "怒", "叹",
    "摇头", "点头", "皱眉", "沉思", "犹豫", "解释", "补充", "强调", "重复", "回答",
)

#: 称谓 —— 挂在名字前后都要剥掉（「霍普副舰长」→「霍普」，「卡特小姐」→「卡特」）
TITLE_WORDS = (
    "副舰长", "副船长", "舰长", "船长", "老师", "先生", "小姐", "女士", "大人",
    "阁下", "长官", "队长", "司令", "将军", "上校", "中校", "少校", "上尉",
    "中尉", "少尉", "首相", "陛下", "殿下", "大主教", "主教", "神父",
    "牧师", "医生", "教授", "博士", "老板",
)

#: 结尾像地名的后缀
LOC_SUFFIX = ("城", "镇", "村", "岛", "群岛", "港", "山", "峰", "海", "洋", "川",
              "河", "湖", "谷", "森林", "沙漠", "大陆", "王国", "帝国", "共和国",
              "公国", "领", "要塞", "堡垒", "平原", "高原", "群岛", "湾", "峡",
              "码头", "机场", "铁路", "车站", "桥", "宫", "塔", "院", "堡", "区")

#: 结尾像组织 / 势力的后缀
#:
#: **两类分野要说清**：这里放的是「机构 / 组织」—— 公司、协会、委员会、政府部门
#: 这种现代或行政色彩的组织；门派、世家、帮派这种**架空势力**归 `FACTION_SUFFIX`。
#: 之所以分家：书的类型表里 `faction`（势力）与 `organization`（机构）本来就是两条，
#: 抽出来全塞进「机构」等于让用户在审核时一条条改回去。
ORG_SUFFIX = ("协会", "商会", "教会", "学院", "公司", "议会",
              "委员会", "政府", "部", "司", "厅", "署", "局",
              "所", "院", "省", "邦", "联盟", "集团", "财团",
              "调查团", "圣殿", "神庙", "内阁", "武馆", "书院",
              "学堂", "道观", "会社", "会", "团")

#: 结尾像**势力 / 门派**的后缀（架空设定里的常客）
#:
#: 这份表是补上来的 —— 实测只在现代机构词表上跑，「青云门」「天音阁」「欧阳世家」
#: 一条都出不来，于是世界观整页清一色是人物（用户 2026-10-04 反馈的「只跑了人物」）。
#: 单字后缀（宗/派/帮/门/族…）语义太散，交给 `_suffix_scan` 的「主体 ≥2 字」兜住，
#: 宁可漏掉「明教」这种两字势力，也不要把「我们」「部门」放进来。
FACTION_SUFFIX = ("门派", "宗门", "世家", "家族", "宗族", "帮派", "公会", "行会",
                  "佣兵团", "冒险者公会", "骑士团", "军团", "舰队", "联军",
                  "同盟", "王朝", "皇朝", "朝廷", "教团", "部落", "神教",
                  "圣教", "教派", "镖局", "商帮", "匪帮", "远征军", "革命军",
                  "宗", "派", "帮", "堂", "阁", "门", "族", "盟", "教")

#: 结尾像物品的后缀
ITEM_SUFFIX = ("枪", "炮", "刀", "剑", "盾", "舰", "船", "机", "车", "弹",
               "药", "石", "环", "徽章", "勋章", "杖", "弓", "甲", "盔", "仪",
               "装置", "机器", "引擎", "号")

_CN = r"\u4e00-\u9fa5"


@dataclass
class Candidate:
    name: str
    type: str = "character"
    count: int = 0
    confidence: float = 0.0
    reasons: list[str] = field(default_factory=list)
    chapters: list[int] = field(default_factory=list)
    samples: list[str] = field(default_factory=list)
    #: 出处：首次出现在哪一章的哪一段（章节 + 段落，一个都不能少）
    first_at: dict | None = None
    exists: bool = False
    entity_id: str | None = None
    #: 同句共现到的已知方法论（哲学观 / 意识形态 / 戒律 / 主义）
    methodologies: list[str] = field(default_factory=list)
    #: 每条方法论的证据：出现次数、是否明确表态、出处句子
    methodology_evidence: dict[str, dict] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "type": self.type,
            "count": self.count,
            "confidence": round(self.confidence, 2),
            "reasons": self.reasons,
            "chapters": sorted(self.chapters),
            "samples": self.samples[:3],
            "first_at": self.first_at,
            "exists": self.exists,
            "entity_id": self.entity_id,
            "methodologies": self.methodologies,
            "methodology_evidence": self.methodology_evidence,
        }


def guess_type(name: str) -> str:
    """按后缀猜类型。猜不出来就当人物。

    走的是后缀发现路用的**同一张长度倒序合并表**（`_SUFFIX_TYPES`）。
    以前是「先查地名表、再查机构表、最后器物表」的分表顺序，会算出反直觉的答案：
    地名表里有单字「院」，于是「学院」被判成**地点** ——
    而同一个名字在后缀发现路那边（长度倒序，先命中「学院」）是机构。
    同一个候选在两处显示不同类型，审核的人只会更糊涂。两条路共用一份判据。
    """
    for suf, tkey in _SUFFIX_TYPES:
        if not name.endswith(suf):
            continue
        if tkey == "item" and len(name) < 2:
            continue
        return tkey
    return "character"


def _plausible(name: str, max_len: int = 4) -> bool:
    """是不是一个像样的专名。

    判定本体在 `lint.judge_name`（后台「实体体检」面板共用同一份规则）。
    长度上限按场景给：锚点法找的是 2~4 字人名；地名 / 组织 / 器物可以长得多
    （「帕达西要塞」「骑士团」），所以后缀发现那条路传更大的上限。
    """
    return judge_name(name, max_len=max_len)["ok"]


#: manner 词 + 称谓，按长度倒序（「副舰长」先于「舰长」，「下意识」先于「下」）
_STRIP_SORTED = sorted(set(MANNER_WORDS) | set(TITLE_WORDS), key=len, reverse=True)

#: 常被误粘在名字前面的量词 / 指代词（「一名魔法师」→「魔法师」）
_PREFIX_WORDS = ("跟着", "一名", "一位", "一个", "这名", "那名", "几名", "两名",
                 "和", "与", "跟", "对", "向", "朝", "被", "让", "给", "同", "随")


def _strip_affix(raw: str) -> str:
    """把「名字+副词/称谓」还原成名字。

    中文不写空格，正则无从知道边界；靠一份词表从右往左啃，
    啃到只剩名字为止（「卡特疑惑」→「卡特」，「霍普副舰长」→「霍普」）。
    啃不出来就原样返回，交给后面的门槛过滤。
    """
    name = raw.strip("·. ")
    # 前缀介词先剥（「跟着卡特」→「卡特」）
    for w in _PREFIX_WORDS:
        if name.startswith(w) and len(name) - len(w) >= 2:
            name = name[len(w):]
            break
    for _ in range(3):  # 最多剥三层
        for w in _STRIP_SORTED:
            if name.endswith(w) and len(name) - len(w) >= 2:
                name = name[: -len(w)]
                break
        else:
            break
    # 称谓被咬掉一半的残渣：「霍普副」←「霍普副舰长」（引语归属正则吞了称谓首字）。
    # 只认「副」—— 它绝不作名字末字；「正」「前」都能是真人名末字（李正、王前），不收。
    if len(name) > 2 and name[-1] == "副":
        name = name[:-1]
    return name


# --------------------------------------------------------------------------
# 证据采集
#
# 策略：**锚定优先**。
# 不做「全文滑窗统计 2~4 字专名」—— 中文没有空格，滑窗会切出
# 「卡特顺着」「索拉诺手」这种碎片，噪声远大于信号。
# 改为先用可靠的句法锚点捞出候选名字，再用精确子串计数得到真实频次。
# --------------------------------------------------------------------------

#: 正则里用的说话动词**变体**（长的排前面，否则「回道」只会匹配到「回」）。
#:
#: 为什么单独列一份而不复用上面的 SPEECH_VERBS：那是一位一位列词的词表，
#: 这里要的是**能贴在人名后面的正则分支**。实测漏网（用户反馈的
#: 「巴兰回」「法莫回」）就是因为它只有「说道问答喊笑」——
#: 原文 `巴兰回道：“……”`，正则啃不动「回」，于是把动词首字当成了名字末字。
_SPEECH_ALT = "|".join(sorted({
    "说道", "问道", "答道", "喊道", "笑道", "叹道", "叫道", "回道", "接口道",
    "接着说", "继续说", "沉声道", "低声道", "轻声道", "淡淡道", "冷声道",
    "摇头道", "点头道", "解释道", "补充道", "追问道", "反问道", "打断道",
    "说", "道", "问", "答", "喊", "笑", "叹", "叫", "回",
}, key=len, reverse=True))

#: 引号闭合后紧跟的名字。中间只允许夹非标点字（≤5），
#: 否则「”卡特转身正对老者，……」会被误判成说话人。
_AFTER_QUOTE_RE = re.compile(
    rf"[”\"」』]\s*([{_CN}]{{2,3}})(?:[^\s。，！？；：、”“”\"'（）]{{0,5}}?)(?:{_SPEECH_ALT})"
)
#: 引语开头的呼语：「卡特，刚才导航员确认了」
_VOCATIVE_RE = re.compile(rf"[“\"「『]([{_CN}]{{2,3}})[，,：:！!]")
#: 通用说话人：名字 + 说话动词（名字先粗取，再剥 manner/称谓）
_SPEAKER_RE = re.compile(rf"([{_CN}]{{2,6}}?)(?:{_SPEECH_ALT})")
#: 对/向/朝/跟 X 说
_DATIVE_RE = re.compile(rf"(?:对|向|朝|跟|和)([{_CN}]{{2,5}}?)(?:{_SPEECH_ALT})")
#: 带称谓的名字。称谓表**按长度倒序**拼分支 —— 否则「霍普副舰长」会被
#: 「舰长」先咬掉，切出「霍普副」这种残渣（实测样本）。
_TITLE_ALT = "|".join(sorted(set(TITLE_WORDS), key=len, reverse=True))
_TITLE_RE = re.compile(rf"([{_CN}]{{2,4}}?)(?:{_TITLE_ALT})")
#: 引号
_QUOTE_RE = re.compile(r"[“\"「『]([^”\"」』]{1,200})[”\"」』]")


def _sentences(text: str) -> list[str]:
    return [s for s in re.split(r"(?<=[。！？!?；;\n])", text) if s.strip()]


#: 引语的收尾符号 —— 以这些字符开头的片段，是上一句的说话人归属
_CLOSERS = "”\"」』’'"


def _merge_attribution(sents: list[str]) -> list[str]:
    """把「引语」和「引语后的说话人」并成一句。

    中文对白几乎都是这个形状：

        “我信奉晨曦主义，老师。”卡特补充道。

    但按句号切，它会被切成两句 —— 引语在前、说话人在后。
    任何「同句共现」的判断（比如「卡特信奉晨曦主义吗」）都会因此落空。
    所以这里把以收尾引号开头的碎片粘回上一句，还原成作者本来的一个语段。
    """
    out: list[str] = []
    for s in sents:
        if out and s[:1] in _CLOSERS:
            out[-1] += s
        else:
            out.append(s)
    return out


def _sentence_pool(chapters: list[dict]) -> list[tuple[int, list[tuple[int, str]]]]:
    """一章一次切片，避免对每个候选都重新切一遍。"""
    pool: list[tuple[int, list[tuple[int, str]]]] = []
    for ch in chapters:
        no = ch.get("chapter_no") or 0
        text = ch.get("text") or ""
        sents: list[tuple[int, str]] = []
        for pno, para in enumerate(p for p in re.split(r"\n\s*\n", text) if p.strip()):
            for s in _merge_attribution(_sentences(para)):
                if s.strip():
                    sents.append((pno, s))
        pool.append((no, sents))
    return pool


# --------------------------------------------------------------------------
# 后缀发现（地名 / 组织 / 器物）
#
# 为什么需要这条路：上面三张后缀表原本只用在 `guess_type` 里 —— 也就是
# 「先捞到候选，再猜它是什么类型」。结果就是**只有人物能被捞到**，
# 地名与器物一条都出不来（用户实测反馈：62 条候选清一色人物）。
# 这里补上真正的发现器：以「后缀词结尾的汉字串」为锚点。
#
# 精度靠三道滤网守：① 前缀至少 2 字（挡掉「城市」「飞机」这类光杆词）；
# ② 常见词的显式停用表；③ 仍然走 lint.judge_name 的统一体检。
# --------------------------------------------------------------------------

def _alt(words) -> str:
    """按长度倒序拼正则分支 —— 「骑士团」必须先于「团」被匹配。"""
    return "|".join(sorted({w for w in words if w}, key=len, reverse=True))


#: 后缀 → 类型，按长度倒序（「骑士团」先于「团」）
_SUFFIX_TYPES: list[tuple[str, str]] = sorted(
    [(s, "location") for s in set(LOC_SUFFIX)]
    + [(s, "faction") for s in set(FACTION_SUFFIX)]
    + [(s, "organization") for s in set(ORG_SUFFIX)]
    + [(s, "item") for s in set(ITEM_SUFFIX)],
    key=lambda kv: len(kv[0]), reverse=True,
)

#: 向左回吞名字主体时，遇到这些字就停 —— 它们是叙述句的连接件，不入专名。
#: 为什么不能用「正则吞 2~4 个字」：实测切出「握着霜之剑」「靠在银月港」
#: 「年在铁壁城」—— 动词被算进了名字。回吞 + 停用字才是正解。
#:
#: 三类字：① 介词/连词/副词（的着过在于…）② 代词与疑问词（我你他…什么怎么）
#: ③ 程度副词（很太最…）。第 ② 类是补的：门派出后缀进来之后，
#: 「什么门派」「他们门派」这类会被整串当成专名。
_LEAD_STOP = set("的了着过在于是有和与把被向从到并而就都也还只要别没不这那其又才将给对为"
                 "我你他她它们咱谁啥怎什吗吧呢啊呀哦嗯很太最更挺真该每某另各众凡均皆整全")


def _is_cn(ch: str) -> bool:
    return "\u4e00" <= ch <= "\u9fa5"

#: 后缀发现路的显式停用词 —— 都是「汉字串 + 后缀」但确确实实不是专名的常见词。
#: 这份表宁可长一点：它们进来只会淹没真候选，人工还得一条条划掉。
_SUFFIX_STOP = {
    # 场所 / 方位
    "城市", "城镇", "山丘", "山坡", "山顶", "山脚", "山洞", "海岸", "海面",
    "河面", "湖面", "街角", "门口", "门外", "窗口", "脸上", "身上", "手上",
    # 器物泛称
    "手机", "飞机", "汽车", "火车", "轮船", "大炮", "枪支", "炮弹", "子弹",
    "盾牌", "刀刃", "剑刃", "机器", "装置", "引擎", "指针", "按钮", "机制",
    # 组织泛称 / 行政词
    "全部", "部分", "内部", "外部", "东部", "西部", "南部", "北部", "局部",
    "总部", "分部", "部门", "干部", "机构", "机关", "议会", "政府",
    # 「X 军/团/会/所/院/局」的日常义
    "所有", "场所", "厕所", "诊所", "医院", "法院", "结局", "时局", "格局",
    "机会", "会议", "宴会", "舞会", "聚会", "工会", "学会",
    "军队", "军团", "兵团", "集团", "团队", "社团", "团体",
    "学院",
    # 时间 / 抽象
    "世纪", "年纪", "时期", "时代", "地址", "岛屿",
}


def _suffix_scan(sent: str) -> list[tuple[str, str]]:
    """一句里按后缀捞候选，返回 [(全名, 类型)]。

    做法：扫到后缀词就在**原地向左回吞**名字主体（最多 6 字，
    遇停用字/非汉字/行首即停）。比正则可靠 —— 正则只能按固定长度吞，
    会把「握着」这类动词算进名字里。
    """
    out: list[tuple[str, str, str]] = []
    n = len(sent)
    i = 0
    while i < n:
        hit: tuple[str, str] | None = None
        for suf, tkey in _SUFFIX_TYPES:
            if sent.startswith(suf, i):
                hit = (suf, tkey)
                break
        if hit is None:
            i += 1
            continue
        suf, tkey = hit
        end = i + len(suf)
        j = i
        while (j > 0 and (i - j) < 6 and _is_cn(sent[j - 1])
               and sent[j - 1] not in _LEAD_STOP):
            j -= 1
        name = sent[j:end]
        prefix = len(name) - len(suf)
        # 单字后缀要求主体 ≥2 字（挡「高山」「小岛」这类光杆词）；
        # 多字后缀（要塞/骑士团）只需 ≥1 字
        need = 2 if len(suf) == 1 else 1
        if prefix >= need and name not in _SUFFIX_STOP:
            out.append((name, tkey, suf))
        i = end
    return out


def collect(text: str) -> dict:
    """从一段正文里收集证据。返回 {名字: 证据}。

    freq 不在这里统计 —— 等候选集合定下来之后用精确子串计数，
    这样「卡特」拿到的是它在全文真实的出现次数。

    同时记录**段号**：出处铁律要求「章节 + 段落」，没段号就只是半条线索。
    """
    paras = [p for p in re.split(r"\n\s*\n", text) if p.strip()]
    evidence: dict[str, dict] = defaultdict(lambda: {"after_quote": 0, "vocative": 0,
                                                     "speaker": 0, "dative": 0,
                                                     "title": 0, "suffix": 0,
                                                     "suffix_kinds": {},
                                                     "samples": [],
                                                     "paras": []})

    def bump(name: str, key: str, sample: str = "", para: int = 0,
             type_key: str | None = None, suffix_hint: str | None = None) -> None:
        """登记一条证据。**先判原始串、再剥词缀。**

        顺序不能反：剥词缀会把「对不起」剥成「不起」（前缀「对」），
        那样停用词表就永远拦不住它。所以原始串先过一遍停用词，
        剥完再判一次是否像个专名。

        type_key 由**后缀发现路**传入：那条路的候选名**本身带后缀**
        （「帕达西要塞」），不能再剥词缀，长度上限也按非人名放宽。

        suffix_hint 记下**具体是哪个后缀**命中的 —— 理由里写「后缀特征「门」」
        比只写「后缀特征」有用得多：人一眼就能判「塞东门」这种该不该留。
        """
        raw = name.strip("·. ")
        if raw in PRONOUNS or raw in GENERIC_WORDS:
            return
        if type_key is not None:
            # 后缀候选：整体就是名字，不剥词缀；非人名形态规则不通用于它
            if not _plausible(raw, max_len=24):
                return
            final = raw
        else:
            final = _strip_affix(raw)
            if not _plausible(final):
                return
        evidence[final][key] += 1
        if suffix_hint:
            kinds = evidence[final]["suffix_kinds"]
            kinds[suffix_hint] = kinds.get(suffix_hint, 0) + 1
        if para not in evidence[final]["paras"]:
            evidence[final]["paras"].append(para)
        if sample and len(evidence[final]["samples"]) < 4:
            evidence[final]["samples"].append(sample.strip()[:60])

    for pno, para in enumerate(paras):
        for sent in _merge_attribution(_sentences(para)):
            for m in _AFTER_QUOTE_RE.finditer(sent):
                bump(m.group(1), "after_quote", sent, pno)
            for m in _VOCATIVE_RE.finditer(sent):
                bump(m.group(1), "vocative", sent, pno)
            for m in _DATIVE_RE.finditer(sent):
                bump(m.group(1), "dative", sent, pno)
            for m in _TITLE_RE.finditer(sent):
                bump(m.group(1), "title", sent, pno)
            for m in _SPEAKER_RE.finditer(sent):
                bump(m.group(1), "speaker", sent, pno)
            # 地名 / 组织 / 器物：按后缀发现（N5）
            for full, tkey, suf in _suffix_scan(sent):
                bump(full, "suffix", sent, pno, type_key=tkey, suffix_hint=suf)

    return evidence


# --------------------------------------------------------------------------
# 打分
# --------------------------------------------------------------------------

def _score(ev: dict, freq: int, total_chars: int) -> tuple[float, list[str]]:
    """把证据折算成 0~1 的置信度 + 人话理由。"""
    score = 0.0
    reasons: list[str] = []

    if ev["after_quote"]:
        score += min(0.55, 0.22 * ev["after_quote"])
        reasons.append(f"引语归属 ×{ev['after_quote']}")
    if ev["vocative"]:
        score += min(0.30, 0.12 * ev["vocative"])
        reasons.append(f"被人称呼 ×{ev['vocative']}")
    if ev["title"]:
        score += min(0.25, 0.10 * ev["title"])
        reasons.append(f"带称谓 ×{ev['title']}")
    # 后缀特征（地名 / 组织 / 器物）—— 单次出现也够格进候选：
    # 「帕达西要塞」这种很可能全文只提一次，但它就是设定实体
    if ev.get("suffix"):
        score += min(0.35, 0.20 * ev["suffix"])
        kinds = ev.get("suffix_kinds") or {}
        top = "、".join(f"「{k}」" for k, _ in sorted(kinds.items(), key=lambda kv: -kv[1])[:3])
        reasons.append(f"后缀特征{top} ×{ev['suffix']}" if top else f"后缀特征 ×{ev['suffix']}")
    if ev["dative"]:
        score += min(0.18, 0.06 * ev["dative"])
        reasons.append(f"对某人说 ×{ev['dative']}")
    if ev["speaker"]:
        score += min(0.25, 0.05 * ev["speaker"])
        reasons.append(f"说话锚定 ×{ev['speaker']}")
    if freq >= 2:
        score += min(0.20, 0.035 * freq)
        reasons.append(f"全文出现 ×{freq}")

    _ = total_chars  # 目前不用密度，留作以后按篇幅归一
    return min(1.0, score), reasons


def _merge_prefixes(items: list[Candidate]) -> list[Candidate]:
    """把「某名字 + 拖尾」的碎片并回主名字。

    中文没分词，「卡特关上舱门」会被锚点切出「卡特关」这种残渣。
    既然「卡特」本身也在候选里、出现次数还更多，那就把它并回去。
    规则：A 是 B 的前缀、且 A 比 B 常见、且超出部分 ≤2 字 —— 判为同一个。
    """
    by_freq = sorted(items, key=lambda c: -c.count)
    absorbed: set[str] = set()
    for i, a in enumerate(by_freq):
        if a.name in absorbed:
            continue
        for b in by_freq[i + 1:]:
            if b.name in absorbed or len(b.name) <= len(a.name):
                continue
            if b.name.startswith(a.name) and len(b.name) - len(a.name) <= 2 and a.count >= b.count:
                absorbed.add(b.name)
                a.count = max(a.count, b.count)
                a.chapters = sorted(set(a.chapters) | set(b.chapters))
    return [c for c in items if c.name not in absorbed]


# --------------------------------------------------------------------------
# 方法论共现
#
# 「导入角色时也要给角色带上方法论标签」——纯规则下怎么做才算讲道理？
# 答案是**同句共现**：一个角色和「晨曦主义」出现在同一句话里，多半有瓜葛；
# 相隔三段出现则什么都不能说明。所以按句切，不按段切。
#
# 证据强度分两档：
#   · 句子里出现「信奉/信仰/皈依/宣誓/遵守/信奉着…」这类词 → 强证据
#   · 只是同句出现 → 弱证据
# 两档都给出来，理由写清楚，勾不勾由人定。
# --------------------------------------------------------------------------

#: 表态语境里的词 —— 同句出现这些，基本可以肯定是在说「这个人信什么」
CREED_WORDS = (
    "信奉", "信仰", "信徒", "皈依", "宣誓", "效忠", "追随", "尊奉", "奉行",
    "戒律", "教义", "教典", "布道", "祷告", "忏悔", "神谕", "圣光", "异端",
    "亵渎", "叛教", "主义", "意识形态", "政见", "主张", "宣扬", "鼓吹",
)


def attach_methodologies(
    chapters: list[dict],
    candidates: list[Candidate],
    methodologies: list[str],
) -> None:
    """给每条候选挂上「同句出现在一起」的已知方法论（原地修改）。

    只在句子粒度上判断，并且要求**候选名与方法论名同时在句**。
    证据不足就不挂 —— 宁可少挂，也不能凭三段之外的一次提及就给人贴标签。
    """
    names = sorted({m.strip() for m in methodologies if m and m.strip()}, key=len, reverse=True)
    if not names or not candidates:
        return

    pool = _sentence_pool(chapters)

    for cand in candidates:
        hit: Counter = Counter()
        strong: set[str] = set()
        where: dict[str, dict] = {}
        for no, sents in pool:
            for pno, sent in sents:
                if cand.name not in sent:
                    continue
                for m in names:
                    if m not in sent:
                        continue
                    hit[m] += 1
                    if any(w in sent for w in CREED_WORDS):
                        strong.add(m)
                    where.setdefault(m, {"chapter_no": no, "para": pno,
                                         "sentence": sent.strip()[:80]})
        if not hit:
            continue
        cand.methodologies = [
            m for m, _ in sorted(hit.items(), key=lambda kv: (-(kv[0] in strong), -kv[1], kv[0]))
        ]
        cand.methodology_evidence = {
            m: {"count": hit[m], "strong": m in strong, **where[m]} for m in hit
        }
        for m in cand.methodologies[:2]:
            tag = "明确表态" if m in strong else "同句提及"
            cand.reasons.append(f"{tag}「{m}」×{hit[m]}")


def extract(
    chapters: list[dict],
    known: dict[str, str] | None = None,
    alias_map: dict[str, str] | None = None,
    min_score: float = 0.20,
    min_count: int = 2,
    methodologies: list[str] | None = None,
) -> dict:
    """从若干章节里抽候选。

    chapters:      [{"chapter_no": 1, "title": "...", "text": "..."}]
    known:         {实体名: 实体ID}
    alias_map:     {别名: 实体ID}
    methodologies: 库里已知的方法论名 —— 用于给候选挂「信奉什么」的标签
    """
    known = known or {}
    alias_map = alias_map or {}
    lookup = {**alias_map, **known}

    keys = ("after_quote", "vocative", "speaker", "dative", "title", "suffix")
    merged: dict[str, dict] = defaultdict(
        lambda: {**{k: 0 for k in keys}, "suffix_kinds": {}, "samples": [],
                  "chapters": set(), "paras": []}
    )
    total = 0

    for ch in chapters:
        text = ch.get("text") or ""
        total += len(text)
        no = ch.get("chapter_no") or 0
        for name, data in collect(text).items():
            tgt = merged[name]
            for k in keys:
                tgt[k] += data[k]
            for suf, cnt in (data.get("suffix_kinds") or {}).items():
                tgt["suffix_kinds"][suf] = tgt["suffix_kinds"].get(suf, 0) + cnt
            for s in data["samples"]:
                if len(tgt["samples"]) < 3:
                    tgt["samples"].append(s)
            for p in data["paras"]:
                # 只留前几条，够定位就行
                if len(tgt["paras"]) < 8:
                    tgt["paras"].append({"chapter_no": no, "para": p})
            tgt["chapters"].add(no)

    # 精确子串计数 —— 「卡特」拿到的是它真实的出现次数，
    # 不受分词影响（这是放弃滑窗统计换来的好处）
    texts = [(ch.get("chapter_no") or 0, ch.get("text") or "") for ch in chapters]
    freq_of: dict[str, int] = {}
    chapters_of: dict[str, set[int]] = defaultdict(set)
    for name in merged:
        n = 0
        for no, t in texts:
            c = t.count(name)
            if c:
                n += c
                chapters_of[name].add(no)
        freq_of[name] = n

    out: list[Candidate] = []
    for name, data in merged.items():
        freq = freq_of.get(name, 0)
        anchored = data["after_quote"] + data["vocative"] + data.get("suffix", 0)
        # 门槛：要么有强锚点（含后缀特征），要么全文念叨过好几次
        if anchored == 0 and freq < min_count:
            continue
        score, reasons = _score(data, freq, total)
        eid = lookup.get(name)
        if eid:
            score = min(1.0, score + 0.3)
            reasons.insert(0, "库中已有此实体")
        if score < min_score:
            continue
        c = Candidate(
            name=name,
            type=guess_type(name),
            count=freq,
            confidence=score,
            reasons=reasons,
            chapters=sorted(data["chapters"] | chapters_of.get(name, set())),
            samples=data["samples"],
            first_at=data["paras"][0] if data["paras"] else None,
            exists=eid is not None,
            entity_id=eid,
        )
        out.append(c)

    out.sort(key=lambda c: (-c.confidence, -c.count, c.name))
    out = _merge_prefixes(out)

    # 方法论标签：句子粒度的共现，证据写进 reasons
    attach_methodologies(chapters, out, methodologies or [])
    out.sort(key=lambda c: (-c.confidence, -c.count, c.name))

    # 已知实体在正文里的出现情况 —— 这是「出场记录」的原料，不是新候选
    appearances: list[dict] = []
    for name, eid in known.items():
        # 单字名（「团」「岛」「军」）做子串统计会满篇命中，
        # 那不是「出场」，是汉字在别的词里出现。宁可不报。
        if len(name) < 2:
            continue
        freq = freq_of.get(name)
        if not freq:
            freq = sum(t.count(name) for _, t in texts)
            # 走兜底路径时 chapters_of 里没有这条 —— 顺手补上，
            # 否则界面会出现「出现 11 次，但不知在哪几章」的怪行
            if freq:
                for no, t in texts:
                    if name in t:
                        chapters_of[name].add(no)
        if freq:
            appearances.append({
                "name": name, "entity_id": eid, "count": freq,
                "chapters": sorted(chapters_of.get(name, set())),
                "samples": merged.get(name, {}).get("samples", [])[:2],
            })
    appearances.sort(key=lambda a: -a["count"])

    return {
        "candidates": [c.to_dict() for c in out],
        "appearances": appearances,
        "stats": {
            "chapters": len(chapters),
            "chars": total,
            "candidates": len(out),
            "new_candidates": sum(1 for c in out if not c.exists),
            "known_hits": len(appearances),
        },
    }
