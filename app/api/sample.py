"""新手样例书 —— 一键生成一本「各视图都有东西可看」的小书（P11-7️⃣③）。

## 为什么要有它

空库打开有几个后果：对着空白发懵、不知道一个「实体」该长什么样、不知道
双链该怎么写、不知道伏笔看板跟时间线要怎么配合。说明书解决不了这个问题 ——
**看到一份像样的样本**才解决得了。它同时还能当回归测试的真实底料。

## 刻意不做成「预置数据文件」

预置一份 `data/books/示例/` 塞进程序包里最省事，但那样数据就长在程序目录里，
出事的时候「程序目录 ≠ 数据目录」这条铁律会被它咬一口。所以这里只放**生成器**：
内容写在代码里，用户点了才按同一套数据规范落盘成一本普普通通的书 ——
跟手建的没有任何区别，随时可删。

## 关于正文

生成了三章**演示正文**。这不违反「工具绝不生成/续写/改写正文」那条铁律，因为：

- 那条铁律管的是**用户的作品**。这是工具自带的样本，内容写在程序里，
  不调用任何模型，也不碰你库里一个字；
- 它只在你主动点「新建示例书」时写进**新建的那本书**，示例书的 `book.yaml`
  里带 `sample: true`，界面据此提示「这是示例，随时可删」；
- 少而明显：三章各几百字，一眼看得出是样本，不会被误当成自己的稿子。

## 内容要「各视图都有东西可看」

所以不是随便凑 15 个名字，而是按视图反推需要什么：

| 视图 | 需要什么 | 这里给了 |
|------|---------|---------|
| 世界观 / 方法论 | 概念、境界、方法论 + 双链 | 星霜诀、淬体境、守拙之道 |
| 地理观 | 地点 + 大纲路径（成层级） | 中州 → 落霞城 / 北屏关 |
| 关系网 | 关联小节里的 `[[双链]]` | 每个实体 2~4 条，互相织起来 |
| 时间线 | `first_appear` + 出场记录 | 每人都跨 2~3 章 |
| 伏笔看板 | 埋设 / 预计回收 / 状态 | 4 条，两种状态都有 |
| 历史观 | 纪年表 | 3 行，时间正序 |
| 剧情线 | 卷/章/事件/状态 | 3 行 |
| 正文 | 章节 md | 3 章 |
| 地图 | 点位 + 区域 | 1 张图，4 点位 + 1 区域 |
| 名册录 | 摘要与属性完备 | 每条都有摘要 + 属性表 |
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

from .. import chapters as ch_mod
from .. import config, custom_types, entities as ent_mod, paths, store
from ..logging_setup import get_logger
from ..models import Entity
from . import maps as maps_api

log = get_logger(__name__)
router = APIRouter(tags=["sample"])

#: 示例书的默认书目 ID（用户可改）。改在 book.yaml 里的 `sample: true` 才是识别依据
DEFAULT_ID = "示例书-雾港纪事"

#: 示例书在 book.yaml 里的标记 —— 界面靠它认「这本是示例，可以整本删」
SAMPLE_FLAG = "sample"


# --------------------------------------------------------------------------
# 内容
# --------------------------------------------------------------------------

#: 实体表。字段与 `Entity` 对齐；`links` 是「关联」小节的原文（双链就写在这儿）
_SAMPLE_ENTITIES: list[dict] = [
    {
        "type": "character", "name": "沈砚", "aliases": ["砚郎", "三郎"],
        "tags": ["主角", "刀客"], "first_appear": "1",
        "summary": "雾港镖局的年轻镖师。刀法平平，记性好得吓人 —— 三年前看过一眼的账本，"
                   "现在还能背出第七页第七行。他为此吃了不少苦头。",
        "attrs": [["身份", "镖师"], ["年纪", "二十三"], ["兵器", "断雪刀"], ["籍贯", "落霞城"]],
        "links": ["师父：[[韦崇]]", "持有：[[断雪刀]]", "相关：[[玄枢阁]]"],
        "appearances": [["1", "替镖局押最后一趟货，货主临时改道"],
                        ["2", "在落霞城被北衙的人盯上"],
                        ["3", "翻出三年前的旧账，认出字迹"]],
        "methodologies": ["守拙之道"],
    },
    {
        "type": "character", "name": "韦崇", "aliases": ["韦老镖头"],
        "tags": ["配角", "长辈"], "first_appear": "1",
        "summary": "雾港镖局的老镖头，右手使不动刀了，改用左手。嘴上认命，"
                   "实际把最后一次出手的机会留给了沈砚。",
        "attrs": [["身份", "镖头"], ["年纪", "六十一"], ["旧伤", "右肩，三年前"]],
        "links": ["徒弟：[[沈砚]]", "旧属：[[玄枢阁]]", "旧地：[[北屏关]]"],
        "appearances": [["1", "在镖局后院磨那把补过裂的刀"], ["2", "拒绝北衙的「护送」提议"]],
        "methodologies": ["守拙之道"],
    },
    {
        "type": "character", "name": "阿箬", "aliases": ["箬丫头"],
        "tags": ["配角", "线索人物"], "first_appear": "2",
        "summary": "雾港码头卖贝壳的小姑娘。她认得每一艘靠港的船，也认得上面每个人的鞋。",
        "attrs": [["身份", "码头小贩"], ["年纪", "十二"], ["常出没", "青芜海码头"]],
        "links": ["相关：[[沈砚]]", "常出没：[[青芜海]]"],
        "appearances": [["2", "跟沈砚说了句没头没尾的话"], ["3", "认出一双不该出现的靴子"]],
    },
    {
        "type": "character", "name": "韩十七", "aliases": [],
        "tags": ["对手"], "first_appear": "2",
        "summary": "北衙的年轻校尉。做事讲规矩到近乎刻板，所以被派来做最不讲规矩的事。",
        "attrs": [["身份", "北衙校尉"], ["编号", "十七（同批第十七名）"]],
        "links": ["供职：[[北衙]]", "盯梢：[[沈砚]]"],
        "appearances": [["2", "第一次出现在落霞城茶馆"], ["3", "把一份名单压在茶碗底下"]],
    },
    {
        "type": "character", "name": "穆元帝", "aliases": ["陛下"],
        "tags": ["背景人物"], "first_appear": "3",
        "summary": "在位二十余年的皇帝。朝里人人都说他老了，只有账本记得他在做什么。",
        "attrs": [["身份", "皇帝"], ["年号", "穆元"], ["在位", "二十三年"]],
        "links": ["都城：[[落霞城]]", "直属：[[北衙]]"],
        "appearances": [["3", "名字第一次出现在账本眉批上"]],
    },
    {
        "type": "location", "name": "中州", "aliases": [],
        "tags": ["地理"], "first_appear": None,
        "summary": "故事主要发生的行省。西接山，东临海，所以既有镖路也有海路。",
        "attrs": [["大纲层级", "1"], ["大纲路径", "地理 / 中州"], ["类型", "行省"]],
        "links": ["下辖：[[落霞城]]、[[北屏关]]"],
        "appearances": [],
    },
    {
        "type": "location", "name": "落霞城", "aliases": [],
        "tags": ["地理", "都城"], "first_appear": "2",
        "summary": "中州首府，也是穆元朝的都城。城墙刷成赭红，日落时整面墙像烧起来一样，"
                   "所以叫落霞。城里最安静的地方是镖局。",
        "attrs": [["大纲层级", "2"], ["大纲路径", "地理 / 中州 / 落霞城"], ["类型", "都城"]],
        "links": ["上级：[[中州]]", "衙署：[[北衙]]"],
        "appearances": [["2", "沈砚进城送货"], ["3", "夜里下了场小雨"]],
    },
    {
        "type": "location", "name": "北屏关", "aliases": [],
        "tags": ["地理", "边关"], "first_appear": "1",
        "summary": "中州北面的关隘。三年前关外塌方封了道，至今没重开 —— 但运货的账"
                   "一个月也没断过。",
        "attrs": [["大纲层级", "2"], ["大纲路径", "地理 / 中州 / 北屏关"], ["类型", "边关"]],
        "links": ["上级：[[中州]]", "旧事：[[韦崇]]"],
        "appearances": [["1", "被当作改道的借口提起"]],
    },
    {
        "type": "location", "name": "青芜海", "aliases": [],
        "tags": ["地理"], "first_appear": "2",
        "summary": "中州东面的海。水色发青，起雾的时候整个港口像被人用布盖住。",
        "attrs": [["大纲层级", "1"], ["大纲路径", "地理 / 青芜海"], ["类型", "海域"]],
        "links": ["下辖：[[雾港]]", "相关：[[阿箬]]"],
        "appearances": [["2", "起了三天大雾"]],
    },
    {
        "type": "location", "name": "雾港", "aliases": [],
        "tags": ["地理", "港口"], "first_appear": "1",
        "summary": "青芜海最大的港口。一年里有一百多天在下雾，船靠不靠港全凭领航员的耳朵。",
        "attrs": [["大纲层级", "2"], ["大纲路径", "地理 / 青芜海 / 雾港"], ["类型", "港口"]],
        "links": ["上级：[[青芜海]]", "相关：[[沈砚]]"],
        "appearances": [["1", "故事开始的地方"], ["2", "雾里进了一条不该来的船"]],
    },
    {
        "type": "faction", "name": "玄枢阁", "aliases": [],
        "tags": ["势力"], "first_appear": "3",
        "summary": "北边的武学宗门。收徒只看一样东西：你能不能把一件事做十年。"
                   "三年前他们拒了沈砚，没给理由。",
        "attrs": [["所在", "中州以北"], ["收徒标准", "十年一事的耐力"]],
        "links": ["相关：[[守拙之道]]", "相关：[[沈砚]]、[[韦崇]]"],
        "appearances": [["3", "被韦崇提了一句「他们的规矩还在」"]],
    },
    {
        "type": "organization", "name": "北衙", "aliases": [],
        "tags": ["机构"], "first_appear": "2",
        "summary": "直属皇室的衙署，管的是「不该明着查的事」。所以他们什么都要记，"
                   "连茶碗摆在桌上哪一侧都要记。",
        "attrs": [["隶属", "皇室"], ["衙署", "落霞城城东"], ["主事", "不公开"]],
        "links": ["上级：[[穆元帝]]", "校尉：[[韩十七]]"],
        "appearances": [["2", "开始盯上沈砚"], ["3", "名单出现在茶馆"]],
    },
    {
        "type": "item", "name": "断雪刀", "aliases": [],
        "tags": ["器物"], "first_appear": "1",
        "summary": "韦崇年轻时用的刀，刀身中部有一道补过的裂 —— 补得极好，"
                   "痕迹只在对着光的时候看得见。",
        "attrs": [["持有者", "沈砚"], ["来历", "韦崇所赠"], ["特征", "刀身有补裂"]],
        "links": ["持有者：[[沈砚]]", "原主：[[韦崇]]"],
        "appearances": [["1", "在镖局后院被磨亮"], ["3", "补裂处对光看了一眼"]],
    },
    {
        "type": "concept", "name": "星霜诀", "aliases": [],
        "tags": ["功法"], "first_appear": "3",
        "summary": "一门以「记」为根本的功法。练法枯燥：把看过的东西一遍遍在心里重演，"
                   "练到不用回想也能复现。第九重能让人记住自己没见过的东西。",
        "attrs": [["类型", "功法"], ["重数", "十三重"], ["根本", "记"]],
        "links": ["相关：[[沈砚]]", "前置：[[淬体境]]"],
        "appearances": [["3", "沈砚在旧账本上认出了它的痕迹"]],
    },
    {
        "type": "realm", "name": "淬体境", "aliases": [],
        "tags": ["境界"], "first_appear": "3",
        "summary": "练体十三境里的前四境合称。特征是身体开始记得动作 —— "
                   "被人从背后推一把，不用想就知道该怎么站。",
        "attrs": [["所属", "练体十三境"], ["段位", "第一至第四境"], ["关键", "身体记忆"]],
        "links": ["相关：[[星霜诀]]"],
        "appearances": [["3", "韩十七被认成「至少第三境」"]],
    },
    {
        "type": "methodology", "name": "守拙之道", "aliases": [],
        "tags": ["哲学观"], "first_appear": None,
        "summary": "「不取巧」这三个字说起来容易。这一道的信奉者认为：把一件事做够十年，"
                   "自然就没有捷径可走了 —— 不是不愿走，是走不了。",
        "attrs": [["核心", "不取巧"], ["检验方式", "十年一事"]],
        "links": ["立宗：[[玄枢阁]]"],
        "appearances": [],
    },
]

#: 伏笔看板 —— 两种状态都要有，否则「已回收」那条路在界面上永远看不到
_FORESHADOW = [
    ["断雪刀上的补裂是谁补的", "第1章", "第3章", "已回收", "第3章沈砚对光看补裂，认出与旧账本同一处手艺"],
    ["雾里进的那条不该来的船", "第2章", "", "未回收", "阿箬说那船的靴子不对 —— 港口不该有那种鞋"],
    ["北屏关三年前塌方，账却一个月没断", "第1章", "第3章", "已回收", "第3章账本眉批解释了绕关的走法"],
    ["玄枢阁拒收沈砚的真实理由", "第3章", "", "未回收", "韦崇只说「他们的规矩还在」，没说为什么"],
    ["星霜诀为什么会出现在账本上", "第3章", "", "未回收", "账本该是钱的事，不该有功法痕迹"],
]

_CHRONOLOGY = [
    ["穆元元年", "穆元帝即位", "[[穆元帝]]", "背景"],
    ["穆元二十年 冬", "北屏关塌方封道", "[[北屏关]]、[[韦崇]]", "三年前的旧事"],
    ["穆元二十三年 春", "沈砚替镖局押最后一趟货", "[[沈砚]]、[[雾港]]", "故事从这里开始"],
]

_GEOGRAPHY = [
    ["中州", "—", "行省", "故事主要发生地"],
    ["落霞城", "中州", "都城", "城墙赭红"],
    ["北屏关", "中州", "边关", "三年前封道"],
    ["青芜海", "—", "海域", "终年多雾"],
    ["雾港", "青芜海", "港口", "镖局所在地"],
]

_PLOT = [
    ["第一卷", "第1章", "沈砚押最后一趟货，货主临时改道", "已写", "开篇：把刀与补裂交代清楚"],
    ["第一卷", "第2章", "落霞城，北衙盯上他", "已写", "引入对手视角"],
    ["第一卷", "第3章", "旧账本上的字迹", "已写", "星霜诀的钩子"],
]

_RULES = [
    ["淬体境不可越境", "未入淬体境者学不了星霜诀第四重", "天赋异禀也不行", "第3章"],
    ["雾港的领航规矩", "起雾时只看耳朵不看眼，靠港顺序由领航员定", "特例：军船可插队", ""],
]

_WORLDVIEW = """# 世界观总纲

## 时代与地理
穆元朝立国二十三年。中州是腹地行省：西接山，东临青芜海，所以镖路与海路并行，
两种走法的人互相看不起。

## 力量体系
练体十三境，前四境合称**淬体境**。淬体境之后是养气、通神，故事里还没展开。
功法多数靠师徒传，少数靠自悟 —— 自悟出的往往走得更远，但也更容易走岔。

## 社会制度
- 皇室直辖**北衙**：管不该明着查的事，什么事都记。
- 武学宗门（如**玄枢阁**）不参与朝政，但收徒标准本身就是一种态度。
- 镖局属民间行当，靠「信」吃饭：一趟货出问题，十年口碑一起没。

## 常识与禁忌
- 边关封道是常事，但**封道而货运不断**是怪事。
- 功法痕迹不该出现在账本上。
"""


# --------------------------------------------------------------------------
# 生成
# --------------------------------------------------------------------------

def _read_cfg_raw(book_id: str) -> dict:
    """读 book.yaml 的**原文**，不是合并默认值之后的结果。

    为什么不用 `config.load_book_config()`：那个会把 BOOK_DEFAULTS 深合并进来，
    回写时就会把一堆默认值固化进文件，无端多出十几行 —— 而这里只想加两个键。
    """
    import yaml

    p = paths.book_config_file(book_id)
    if not p.is_file():
        return {}
    try:
        data = yaml.safe_load(p.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _write_cfg_raw(book_id: str, cfg: dict) -> None:
    import yaml

    p = paths.book_config_file(book_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False),
                 encoding="utf-8", newline="\n")


def _write_doc(book_id: str, name: str, text: str) -> None:
    """写一份 world/ 档案。走的是与文档接口同一条规则：文件名固定、整份覆盖。"""
    root = paths.world_dir(book_id)
    root.mkdir(parents=True, exist_ok=True)
    (root / f"{name}.md").write_text(text, encoding="utf-8", newline="\n")


def _table(header: list[str], rows: list[list[str]]) -> str:
    head = "| " + " | ".join(header) + " |\n"
    sep = "|" + "|".join(["---"] * len(header)) + "|\n"
    body = "".join("| " + " | ".join(str(c) for c in r) + " |\n" for r in rows)
    return head + sep + body


def _chapter_text(no: int) -> str:
    """三章演示正文。刻意写得短、写得「一眼是样本」，别让人误当成自己的稿子。"""
    if no == 1:
        return (
            "雾是从后半夜起的，起得很安静。\n\n"
            "沈砚在镖局后院磨刀。刀是韦崇的旧刀，刀身中部有一道补过的裂，"
            "补得极好，不对着光看不出来。他磨得很慢，比起磨快，更像是要把一条线磨直。\n\n"
            "「这趟货改道。」韦崇站在廊下，右手垂着，「走北屏关。」\n\n"
            "沈砚停了一下。「关不是封了三年了吗。」\n\n"
            "「封了。」韦崇说，「所以货才要走那儿。」\n\n"
            "（本章为程序自带的示例正文，不是你的作品。）"
        )
    if no == 2:
        return (
            "落霞城的城墙是赭红色的，日落时整面墙像烧起来，所以叫落霞。\n\n"
            "沈砚把货交进城东的仓，出来时天已经擦黑。茶馆里有个人一直坐着，"
            "茶碗摆在桌子的左手侧 —— 摆得有点太正了。\n\n"
            "沈砚想起韦崇说过：北衙的人记东西，连茶碗摆哪一侧都记。\n\n"
            "他没回头，往码头走。雾港的雾一路跟到了城里，"
            "把街灯都泡软了。\n\n"
            "（本章为程序自带的示例正文，不是你的作品。）"
        )
    return (
        "旧账本压在镖局库房的第三只箱子底下，纸边已经发脆。\n\n"
        "沈砚没有翻。他只是看 —— 第三年前他看过一眼，那时候他还没学会怎么看。\n\n"
        "第七页，第七行。墨迹右上角有一处极细的顿笔，像是写的人在半途停了一下。\n\n"
        "他忽然想起了断雪刀上的那道补裂。同一处手艺：补的人不追求看不出来，"
        "追求的是「补过」，而且要让人看得见什么时候停的。\n\n"
        "「星霜诀。」他念出这三个字的时候，窗外的雾正好散了一线。\n\n"
        "（本章为程序自带的示例正文，不是你的作品。）"
    )


def _sample_map(ids: dict[str, str]) -> dict:
    """一张图：四个点位 + 一块区域。点位挂到实体上，点它就能跳过去。"""
    def pin(pid: str, entity: str, label: str, x: float, y: float, note: str = "") -> dict:
        return {"id": pid, "entity_id": ids.get(entity) or None, "label": label,
                "x": x, "y": y, "kind": "city", "note": note}

    return {
        "schema": 2,
        "maps": {
            "sample-main": {
                "title": "雾港与中州",
                "parent": None,
                "level": "总图",
                "note": "示例地图：四个点位 + 一块区域。拖动坐标、改颜色、加区域都可以。",
                "pins": [
                    pin("p-luoxia", "落霞城", "落霞城", 0.62, 0.30, "都城"),
                    pin("p-beiping", "北屏关", "北屏关", 0.50, 0.12, "北面门户，三年前封道"),
                    pin("p-wugang", "雾港", "雾港", 0.80, 0.62, "镖局所在地"),
                    pin("p-qingwu", "青芜海", "青芜海", 0.90, 0.50, "终年多雾"),
                ],
                "regions": [
                    {"id": "r-zhongzhou", "name": "中州", "entity_id": ids.get("中州") or None,
                     "points": [[0.30, 0.10], [0.72, 0.10], [0.72, 0.48], [0.30, 0.48]],
                     "fill": "#c2703a", "opacity": 0.18},
                ],
            },
        },
    }


def build(book_id: str, title: str = "", author: str = "示例") -> dict:
    """生成一本示例书。已存在同名书则**拒绝**（不覆盖、不合并）。

    返回 `{book_id, title, entities, chapters, docs, maps}` —— 界面拿它报「生成了什么」。
    """
    bid = (book_id or "").strip() or DEFAULT_ID
    try:
        root = paths.ensure_book_root(bid)
    except ValueError as exc:
        raise ValueError(str(exc)) from exc
    if root.exists():
        raise ValueError(f"书目「{bid}」已存在，换个名字或先删掉它")

    ent_mod.create_book(bid, title or bid, author=author, genre="玄幻")
    # 打上「这是示例」的印记 —— 界面据此给出「整本删掉」的入口。
    # 只加这两个键，不把默认值固化进文件。
    cfg = _read_cfg_raw(bid)
    cfg[SAMPLE_FLAG] = True
    cfg["note"] = "程序自带的示例书，各视图都有内容。看够了随时整本删掉。"
    _write_cfg_raw(bid, cfg)

    # ---- 实体 ----
    ids: dict[str, str] = {}
    seq: dict[str, int] = {}
    created = 0
    for spec in _SAMPLE_ENTITIES:
        tkey = spec["type"]
        seq[tkey] = seq.get(tkey, 0) + 1
        # ID 前缀跟类型册对齐（自定义类型也认），名字与 ID 解耦这条规矩照旧
        eid = f"{custom_types.prefix_for(bid, tkey)}-{seq[tkey]:04d}"
        body = {
            "摘要": spec.get("summary", ""),
            "属性": spec.get("attrs") or [],
            "出场记录": spec.get("appearances") or [],
            "关联": spec.get("links") or [],
            "待补充": [],
        }
        ent = Entity(
            id=eid,
            book_id=bid, type=tkey, name=spec["name"],
            aliases=list(spec.get("aliases") or []),
            tags=list(spec.get("tags") or []),
            first_appear=spec.get("first_appear"),
            methodologies=list(spec.get("methodologies") or []),
            # 出处标「sample」—— 让人一眼看出这些不是从正文里抽出来的
            provenance={"method": "sample", "sources": []},
            body=body,
        )
        ent_mod.save_entity_file(ent)
        ids[spec["name"]] = eid
        created += 1

    # ---- 章节 ----
    ch_count = 0
    for no, ctitle in ((1, "雾里的最后一趟货"), (2, "落霞城，左手边的茶碗"), (3, "第七页第七行")):
        ch_mod.save_chapter(bid, ch_mod.Chapter(
            chapter_no=no, title=ctitle, volume="第一卷", source_file="（示例）",
            text=_chapter_text(no)))
        ch_count += 1

    # ---- 世界观档案 ----
    _write_doc(bid, "worldview", _WORLDVIEW)
    _write_doc(bid, "chronology", "# 纪年表\n\n" + _table(
        ["时间", "事件", "关联", "备注"], _CHRONOLOGY))
    _write_doc(bid, "geography", "# 地理志\n\n" + _table(
        ["地名", "所属", "类型", "备注"], _GEOGRAPHY))
    _write_doc(bid, "foreshadow", "# 伏笔看板\n\n" + _table(
        ["伏笔", "埋设章节", "预计回收", "状态", "备注"], _FORESHADOW))
    _write_doc(bid, "plot", "# 剧情线\n\n" + _table(
        ["卷", "章节", "事件", "状态", "备注"], _PLOT))
    _write_doc(bid, "rules", "# 规则与边界\n\n" + _table(
        ["规则", "内容", "边界条件", "出处"], _RULES))

    # ---- 地图（复用地图接口的清洗与落盘，别在这里另写一套格式） ----
    try:
        doc = maps_api._clean_doc(_sample_map(ids))
        maps_api._write_doc(bid, doc)
        map_count = len(doc["maps"])
    except Exception as exc:  # 地图生成失败不该让整本书报废
        log.warning("示例书地图生成失败（其余内容不受影响）：%s", exc)
        map_count = 0

    # ---- 索引 ----
    store.rebuild_book(bid)
    log.info("示例书已生成：%s（%s 条实体 / %s 章 / %s 张图）", bid, created, ch_count, map_count)
    return {
        "book_id": bid,
        "title": title or bid,
        "entities": created,
        "chapters": ch_count,
        "docs": 6,
        "maps": map_count,
    }


def is_sample(book_id: str) -> bool:
    return bool(_read_cfg_raw(book_id).get(SAMPLE_FLAG))


# --------------------------------------------------------------------------
# 接口
# --------------------------------------------------------------------------

@router.get("/sample-book/status")
def api_sample_status() -> dict:
    """界面上先问一句：库里有没有示例书？默认名字能不能用？"""
    books = ent_mod.list_books()
    samples = [b for b in books if is_sample(b["book_id"])]
    return {
        "default_id": DEFAULT_ID,
        "default_title": "雾港纪事（示例）",
        "taken": [b["book_id"] for b in books],
        "samples": samples,
    }


@router.post("/sample-book", status_code=201)
def api_make_sample(payload: dict = Body(default={})) -> dict:
    """生成示例书。**只写新建的那本书**，不碰任何已有书目与正文。"""
    book_id = str(payload.get("book_id") or "").strip() or DEFAULT_ID
    title = str(payload.get("title") or "").strip()
    try:
        return build(book_id, title)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
