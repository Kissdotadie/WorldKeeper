"""实体体检 —— 扫一本书，挑出「名字不像专名」的实体。

规则抽取难免把「低头」「赶紧」「为什么」这类非名词性片段捞成实体，
攒到几百条之后人工一条条翻是翻不完的。这里用 `parsers.lint` 的统一判定
过一遍，把可疑的排好序交给人**勾选** —— 判定只是建议，删不删由人定。

只读：本模块不碰任何文件。删除由 API 层在人工确认后走带快照的路径。
"""

from __future__ import annotations

from . import store
from .parsers.lint import judge_name

#: 先「确定是垃圾」，再「像垃圾」——同档里按名字排，方便肉眼扫
_ORDER = {"high": 0, "mid": 1}

#: 粘着检测的剥皮宽度：候选名比已知名多出的字数上限。
#: 「下芭芭拉」「真卡特」多 1 字，「带着卡特」「妄议卡特」多 2 字；
#: 超过 2 字的差异更可能是另一条正经实体（「斯坦因」vs「斯坦因学院」），
#: 宁可放过交给别处，不在这乱标。
_GLUE_MAX = 2

#: 剥头时，剥下来的 1 字必须是这类「上下文字」才算粘着——
#: 这些字几乎不参与构名（对照：「斯」「迈」「李」都参与，所以
#: 斯纳罗尔 / 迈克尔 / 强尼李 不会被误伤）。没有「老」「阿」：
#: 老吉玛、阿福是正经小名。
_GLUE_HEAD_1 = set("下真时么官长才便就也都还又")

#: 剥头时，剥下来的 2 字必须是这类动词 / 衔接语才算粘着（P10 实测样本）。
_GLUE_HEAD_2 = (
    "带着", "看向", "望着", "盯着", "然后", "认识", "妄议", "连忙", "连连",
    "回头", "转身", "跟着", "拉着", "提到", "提起", "指着", "冲着", "朝着",
    "对着", "想起", "说到", "见到", "见过", "告诉", "通知", "交给", "让给",
    "护着", "扶着", "拽着", "冲向", "指向", "面对", "找到", "叫住", "拦住",
)

#: 剥尾时，剥下来的 1 字必须是说话动词才算粘着（「总长回」「女仆恭」「崔佛呵」）。
#: 没有「笑」「叫」—— 张笑这类名字末字是「笑」完全正常。
_GLUE_TAIL_1 = set("回恭呵说喊答问道骂")


def _known_names(rows: list[dict]) -> set[str]:
    """收集全库已确认的名字与别名，作为「真名白名单」。

    有别名就用别名：小名 / 昵称（裴渊 ↔ 小裴子）都是作者亲口认过的，
    粘着检测拿它们当基准，比只用正式名准得多。
    """
    names: set[str] = set()
    for e in rows:
        n = (e.get("name") or "").strip()
        if n:
            names.add(n)
        for a in e.get("aliases") or []:
            a = (a or "").strip()
            if a:
                names.add(a)
    return names


def _glued_onto(name: str, known: set[str]) -> str | None:
    """判断 name 是否是「上下文 + 已知名」被粘着切下来的碎片。

    先剥头再剥尾；剥完剩下的必须**精确**等于某个已知名，而且剥下来的
    那部分本身得像上下文（虚词 / 动词 / 说话动词，见 _GLUE_* 表）——
    剥下来的是正常构名字（斯、迈、元帅、群岛）就不是碎片，是另一条
    正经实体，不能碰。
    """
    if not known:
        return None
    n = len(name)
    for cut in range(1, _GLUE_MAX + 1):
        if n > cut + 1:
            base = name[cut:]
            if base in known:
                head = name[:cut]
                if (cut == 1 and head in _GLUE_HEAD_1) or (
                        cut == 2 and head in _GLUE_HEAD_2):
                    return base
        if n > cut + 1:
            base = name[:-cut]
            if base in known:
                tail = name[n - cut:]
                if cut == 1 and tail in _GLUE_TAIL_1:
                    return base
    return None


def scan(book_id: str) -> dict:
    """以**索引**为底扫一遍，返回可勾选的清单。

    走索引而不是逐个读文件：几千条实体也就是一次查询的工夫。
    代价是索引过期时结果不全 —— 所以返回里带上 `total`，页面拿它和
    「体检条数」对照就能看出索引是不是旧的。
    """
    rows = store.list_entities(book_id)
    known = _known_names(rows)
    items: list[dict] = []
    high = mid = 0
    for e in rows:
        name = e.get("name", "")
        type_key = e.get("type") or ""
        # 判定分类型：人名的形态规则套到机构名上是成片误伤（圣裁决所 / 钟楼酒吧 /
        # 别动队 / 对内情报司），所以把类型传进去，各按各的标准判。
        verdict = judge_name(name, type_key=type_key)
        if verdict["ok"]:
            # 形态上像专名，再查一层：是不是「上下文 + 真名」被粘着切下来的
            # （下芭芭拉 / 时阿达西 / 带着卡特 / 总长回 / 女仆恭）。
            base = _glued_onto(name, known)
            if base:
                items.append(
                    {
                        "id": e["id"],
                        "name": name,
                        "type": e["type"],
                        "kind": "glued",
                        "reason": f"剥掉粘着的字后是已有实体「{base}」—— 上下文和人名被粘在一起切下来了",
                        "severity": "mid",
                    }
                )
                mid += 1
            continue
        sev = verdict["severity"] or "mid"
        if sev == "high":
            high += 1
        else:
            mid += 1
        items.append(
            {
                "id": e["id"],
                "name": name,
                "type": e["type"],
                "kind": verdict["kind"],
                "reason": verdict["reason"],
                "severity": sev,
            }
        )
    items.sort(key=lambda x: (_ORDER.get(x["severity"], 9), x["name"]))
    return {
        "book_id": book_id,
        "total": len(rows),
        "flagged": len(items),
        "high": high,
        "mid": mid,
        "items": items,
    }
