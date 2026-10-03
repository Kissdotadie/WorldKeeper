"""不一致体检 —— 五类「只报不改」的一致性检查（P11-7️⃣②）。

## 它和「实体体检」的区别

实体体检（`app/audit.py`）看的是**单个名字像不像专名**；这里看的是**几处记录之间
对不对得上**。前者一条实体一条结论，后者必然牵出至少两处 —— 所以每条结论都带
**双方证据 + 出处**，否则人没法核。

## 只报不改

跟实体体检同一个原则：**判定只是建议**。这里一行文件都不动，也一行不动正文 ——
改不改、怎么改，人说了算。想改的时候手边的证据已经给全了。

## 与技能中心「设定矛盾检查」共用同一套规则

技能中心那张卡是让 AI 读正文找矛盾，这里是纯规则扫档案。两者能共用的只有
**词表**：性质（时间线 / 人物设定 / 地理 / 组织 / 数值 / 称谓 / 出处 / 伏笔）
与严重度（高 / 中 / 低）。那两串就定义在本文件顶部的 `NATURES` / `SEVERITIES`，
`app/skills.py` 生成提示词时**直接引用**，改一处两边一起变 ——
不这么做，迟早会出现「面板说时间线、提示词说时间性」这种漂移。

## 严重度怎么定

| 级别 | 判据 | 例子 |
|------|------|------|
| 高 | 会**指错目标**的：双链/搜索解析到错的人、从属关系绕成死圈、引用的章节根本不存在 | 称谓冲撞、地理环、出处失效 |
| 中 | 两处记录互相矛盾，但还不会指错 | 首现与出场记录对不上、回收章早于埋设章 |
| 低 | 只是记法不规范 | 埋设章节写不成章号 |

## 覆盖范围要如实说

纯规则做不了语义：**「同一时间点挂了两件互斥的事」这种要读懂剧情才能判**，
本模块不假装能做。所以：

- 只做「能从记录形态上判定对不上」的部分；
- 返回里带 `notes`，逐类说明**这类检查到底查了什么**、以及**哪些留给 AI**。
  界面把 notes 摆出来，免得人以为「体检没报 = 全书没问题」。
"""

from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path

from . import chapters as ch_mod
from . import entities as ent_mod
from . import paths, store
from .logging_setup import get_logger

log = get_logger(__name__)

# --------------------------------------------------------------------------
# 词表（技能中心共用）
# --------------------------------------------------------------------------

#: 矛盾的性质分类。`app/skills.py` 的「设定矛盾检查」提示词直接引用这里生成选项，
#: 所以**不要在这里随手加删** —— 那边跟着变，AI 的输出口径也跟着变。
NATURES = ("时间线", "人物设定", "地理", "组织", "数值", "称谓", "出处", "伏笔")

#: 严重度。规则层与 AI 层共用同一套字面，人的阅读习惯才统一。
SEVERITIES = ("高", "中", "低")

#: 五类检查的登记表。界面按这个顺序分组，`notes` 逐类说明「查了什么 / 没查什么」。
CHECKS: list[dict] = [
    {
        "id": "timeline",
        "name": "时间线冲突",
        "nature": "时间线",
        "covers": "实体的「首次出场」与「出场记录」里的章号对不上；纪年表的时间倒着走。",
        "leaves": "「同一时间点挂了两件互斥的事」要读懂剧情才能判 —— 留给技能中心的 AI 检查。",
    },
    {
        "id": "foreshadow",
        "name": "伏笔状态断链",
        "nature": "伏笔",
        "covers": "伏笔看板里：标了已回收却没说在哪一章收、回收章早于埋设章、回收章或埋设章不存在。",
        "leaves": "「这条伏笔其实没回收」属于剧情判断 —— 规则只知道表格怎么写的。",
    },
    {
        "id": "naming",
        "name": "称谓不一致",
        "nature": "称谓",
        "covers": "同一个称呼被两个以上实体共用（包括别名撞上别家的主名）—— 双链与搜索会解析到错的人。",
        "leaves": "「正文里新出现的叫法还没登记」要靠抽取发现 —— 那是技能中心与抽取器的事。",
    },
    {
        "id": "geo",
        "name": "地理从属环",
        "nature": "地理",
        "covers": "地理志的「所属」列、以及地点实体属性里的「大纲路径」，从属链绕成环或指向不存在的上级。",
        "leaves": "「两地距离写反了」这类数值问题不在本类。",
    },
    {
        "id": "provenance",
        "name": "出处失效",
        "nature": "出处",
        "covers": "档案的出处、出场记录、出没记录里引用的章节 / 段落已经不存在。",
        "leaves": "出处记得对不对（内容是否真在那一章）属于复核，规则看不出语义。",
    },
]

CHECK_BY_ID = {c["id"]: c for c in CHECKS}

#: 每类最多列多少条 —— 上千条摆在页面上等于没报。超出的计数照样给。
MAX_PER_CHECK = 120

#: 证据里最多列几个实体（一条结论牵出一百个实体的情况真实存在，比如整章被删）
MAX_EVIDENCE_ENTITIES = 12


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------

def _ch_no(value) -> int | None:
    """从「第11章」「11」「十一章」里抠出章号。抠不出返回 None（**不要猜**）。"""
    s = str(value or "").strip()
    if not s:
        return None
    m = re.search(r"\d+", s)
    if m:
        return int(m.group())
    # 纯中文数字（「第十一章」剥掉「第」「章」之后）
    return ch_mod.cn_to_int(re.sub(r"[第章回节]", "", s))


def _table(path: Path) -> tuple[list[str], list[list[str]]]:
    """抠出 Markdown 里的第一张表。文件不存在或没有表都返回空 —— 不报错。

    有意不复用 `app/api/docs.py` 里的同名函数：那是 API 层的东西，
    核心模块反向依赖 API 层会绕出循环导入。
    """
    if not path.is_file():
        return [], []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return [], []
    rows: list[list[str]] = []
    for line in (text or "").splitlines():
        s = line.strip()
        if not s.startswith("|"):
            if rows:
                break  # 表格结束
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if cells and all(not c or set(c) <= set("-: ") for c in cells):
            continue  # |---|---| 分隔行
        rows.append(cells)
    if not rows:
        return [], []
    return rows[0], rows[1:]


def _cell(row: list[str], idx: int) -> str:
    return row[idx].strip() if idx < len(row) else ""


def _item(check: str, severity: str, title: str, detail: str,
          evidence: list[dict], entities: list[dict] | None = None,
          doc: str | None = None, key: str = "") -> dict:
    """拼一条结论。`evidence` 里每项是 `{label, text?, entity_id?, doc?}`。"""
    return {
        "id": f"{check}:{key}" if key else f"{check}:{len(title)}:{hash(title) & 0xFFFF:04x}",
        "check": check,
        "check_name": CHECK_BY_ID[check]["name"],
        "nature": CHECK_BY_ID[check]["nature"],
        "severity": severity,
        "title": title,
        "detail": detail,
        "evidence": evidence,
        "entities": entities or [],
        "doc": doc,
    }


def _ent_ref(row: dict) -> dict:
    return {"entity_id": row.get("id") or "", "name": row.get("name") or "",
            "type": row.get("type") or ""}


def _doc_ref(name: str, label: str, text: str = "") -> dict:
    return {"label": label, "doc": name, "text": text}


# --------------------------------------------------------------------------
# 一、时间线冲突
# --------------------------------------------------------------------------

def check_timeline(book_id: str, rows: list[dict], ch_nos: set[int]) -> tuple[list[dict], dict]:
    """首现章 vs 出场记录里的最早章。"""
    items: list[dict] = []
    # 出场记录（索引里的 appearances 表）一次取全，避免逐条查
    with store.connect() as conn:
        ap: dict[str, list[int]] = defaultdict(list)
        for x in conn.execute(
            "SELECT entity_id, chapter FROM appearances WHERE book_id=?", (book_id,)
        ):
            n = _ch_no(x["chapter"])
            if n:
                ap[x["entity_id"]].append(n)

    skipped_no_first = 0
    for r in rows:
        fa = _ch_no(r.get("first_appear"))
        chapters = sorted(set(ap.get(r["id"]) or []))
        if not chapters:
            continue
        if fa is None:
            # 没写首现就没法比 —— 不算冲突，但记个数，界面能说「有多少条没得比」
            skipped_no_first += 1
            continue
        earliest = chapters[0]
        if earliest >= fa:
            continue
        items.append(
            _item(
                "timeline", "mid",
                f"「{r['name']}」出场记录里有第 {earliest} 章，但首次出场标的是第 {fa} 章",
                "两处必有一处是错的：要么首现章写晚了，要么出场记录里混进了别的章。"
                "时间线视图按首现章排位，这里对不上就会把它排到不该在的位置。",
                [
                    {"label": "首次出场（档案 frontmatter）", "text": f"第 {fa} 章",
                     "entity_id": r["id"]},
                    {"label": "出场记录（正文小节）", "text": "第 " + "、".join(str(c) for c in chapters[:8])
                     + ("…" if len(chapters) > 8 else "") + " 章", "entity_id": r["id"]},
                ],
                [_ent_ref(r)],
                key=r["id"],
            )
        )
    return items, {"compared": len(rows), "no_first_appear": skipped_no_first}


def check_chronology(book_id: str) -> list[dict]:
    """纪年表的时间倒着走 —— 顺序与时间对不上，多半是插行插错位置了。"""
    head, rows = _table(paths.world_dir(book_id) / "chronology.md")
    if not rows:
        return []
    seq: list[tuple[int, int, str]] = []  # (行号, 年份, 原文)
    for i, row in enumerate(rows):
        raw = _cell(row, 0)
        if not raw:
            continue
        m = re.search(r"(\d{1,4})", raw)
        if not m:
            continue
        seq.append((i, int(m.group(1)), raw))
    items: list[dict] = []
    for a, b in zip(seq, seq[1:]):
        if b[1] < a[1]:
            items.append(
                _item(
                    "timeline", "mid",
                    f"纪年表的时间倒着走：第 {a[0] + 2} 行是「{a[2]}」，下一行是「{b[2]}」",
                    "表格顺序通常就是时间顺序。倒着走要么是行插错了位置，要么是年份写错了。",
                    [_doc_ref("chronology", f"纪年表第 {a[0] + 2} 行", a[2]),
                     _doc_ref("chronology", f"纪年表第 {b[0] + 2} 行", b[2])],
                    doc="chronology",
                    key=f"{a[0]}-{b[0]}",
                )
            )
            break  # 一处足以说明这张表乱了，别刷屏
    return items


# --------------------------------------------------------------------------
# 二、伏笔状态断链
# --------------------------------------------------------------------------

_DONE_WORDS = ("已回收", "已收", "回收了", "已填", "已解", "已揭")


def check_foreshadow(book_id: str, ch_nos: set[int]) -> tuple[list[dict], dict]:
    head, rows = _table(paths.world_dir(book_id) / "foreshadow.md")
    if not rows:
        return [], {"rows": 0}
    # 列名可能被作者改过，按表头找位置，找不到再退回默认顺序
    idx = {name: i for i, name in enumerate(head or [])}

    def col(*names: str, default: int) -> int:
        for n in names:
            if n in idx:
                return idx[n]
        return default

    c_plant = col("埋设章节", "埋设", "埋设章", default=1)
    c_due = col("预计回收", "回收章节", "回收", "预计回收章", default=2)
    c_state = col("状态", default=3)
    c_text = col("伏笔", "内容", "名称", default=0)

    items: list[dict] = []
    for i, row in enumerate(rows):
        text = _cell(row, c_text)
        plant_raw = _cell(row, c_plant)
        due_raw = _cell(row, c_due)
        state = _cell(row, c_state)
        label = f"伏笔看板第 {i + 2} 行"
        planted = _ch_no(plant_raw)
        due = _ch_no(due_raw)
        done = any(w in state for w in _DONE_WORDS)
        short = (text[:24] + "…") if len(text) > 24 else (text or "（没写内容）")
        key = f"r{i + 2}"

        if plant_raw and planted is None:
            items.append(_item(
                "foreshadow", "low",
                f"{label}的「埋设章节」看不懂：{plant_raw}",
                "这一列该写第几章。写不成章号，后面「回收章早于埋设章」这类检查就全做不了。",
                [_doc_ref("foreshadow", label, f"{short}｜埋设章节：{plant_raw}")],
                doc="foreshadow", key=key + "a"))
            continue

        if done:
            if due is None:
                items.append(_item(
                    "foreshadow", "mid",
                    f"{label}标了「{state}」，却没说在哪一章收的",
                    "回收是伏笔的终点，没写章号就等于没记终点 —— 以后没法核，也没法从看板上真正划掉。"
                    "把回收章号填上（或把状态改回未回收）。",
                    [_doc_ref("foreshadow", label, f"{short}｜状态：{state}｜预计回收：{due_raw or '（空）'}")],
                    doc="foreshadow", key=key + "b"))
                continue
            if planted is not None and due < planted:
                items.append(_item(
                    "foreshadow", "mid",
                    f"{label}的回收章（第 {due} 章）早于埋设章（第 {planted} 章）",
                    "先收再埋，顺序反了。两个章号里至少有一个是错的。",
                    [_doc_ref("foreshadow", label, f"埋设：第 {planted} 章｜回收：第 {due} 章｜{short}")],
                    doc="foreshadow", key=key + "c"))
                continue

        # 章号存在性：埋设章与回收章都得真在库里（库里根本没有章节时跳过，别整表报错）
        if ch_nos:
            if planted is not None and planted not in ch_nos:
                items.append(_item(
                    "foreshadow", "mid",
                    f"{label}的埋设章节（第 {planted} 章）不在库里",
                    "这一章可能被删了、或还没导入。悬着的引用以后核对时会指空。",
                    [_doc_ref("foreshadow", label, f"{short}｜埋设章节：{plant_raw}")],
                    doc="foreshadow", key=key + "d"))
                continue
            if done and due is not None and due not in ch_nos:
                items.append(_item(
                    "foreshadow", "high",
                    f"{label}标了「{state}」，但回收章（第 {due} 章）不存在",
                    "标成已回收、回收的那一章却不在库里 —— 这条伏笔等于凭空消失了，"
                    "以后谁也不会再回头看它。",
                    [_doc_ref("foreshadow", label,
                              f"{short}｜状态：{state}｜预计回收：第 {due} 章")],
                    doc="foreshadow", key=key + "e"))
                continue
            if not done and due is not None and due < max(ch_nos):
                # 已过回收章却还没收 —— 不是记录矛盾，是进度提醒，标低
                items.append(_item(
                    "foreshadow", "low",
                    f"{label}预计在第 {due} 章回收，现在已经写到第 {max(ch_nos)} 章了",
                    "不是记录对不上，是提醒：这条该收了，或者把预计回收章往后挪。",
                    [_doc_ref("foreshadow", label, f"{short}｜预计回收：第 {due} 章｜状态：{state or '未填'}")],
                    doc="foreshadow", key=key + "f"))
    return items, {"rows": len(rows)}


# --------------------------------------------------------------------------
# 三、称谓不一致
# --------------------------------------------------------------------------

def check_naming(rows: list[dict]) -> tuple[list[dict], dict]:
    name_owner: dict[str, set[str]] = defaultdict(set)
    alias_owner: dict[str, set[str]] = defaultdict(set)
    by_id: dict[str, dict] = {}
    for r in rows:
        by_id[r["id"]] = r
        n = (r.get("name") or "").strip()
        if n:
            name_owner[n].add(r["id"])
        for a in r.get("aliases") or []:
            a = (a or "").strip()
            if a:
                alias_owner[a].add(r["id"])

    items: list[dict] = []

    # ① 同一称呼被两个以上实体登记为别名
    for alias, owners in sorted(alias_owner.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        if len(owners) < 2:
            continue
        ents = [by_id[i] for i in sorted(owners) if i in by_id]
        items.append(_item(
            "naming", "high",
            f"「{alias}」被 {len(ents)} 个实体共用为别名",
            "双链与搜索按名字找实体，一个称呼挂在几个人身上就会「指错人」——"
            "而且解析出来的还很可能是另一个，静悄悄地错。要么把别名收回给其中一个人，"
            "要么把两个实体合并（合并会把别名与双链一起并过去）。",
            [{"label": f"#{k + 1}", "entity_id": e["id"], "text": e["name"]}
             for k, e in enumerate(ents[:MAX_EVIDENCE_ENTITIES])],
            [{"entity_id": e["id"], "name": e["name"], "type": e.get("type") or ""} for e in ents],
            key=f"alias:{alias}",
        ))

    # ② 某人的别名撞上另一人的**主名** —— 比①更硬：主名一定在库里存在
    for alias, owners in sorted(alias_owner.items()):
        if alias not in name_owner:
            continue
        real = name_owner[alias]
        clash = owners - real
        if not clash:
            continue
        ents = [by_id[i] for i in sorted(clash) if i in by_id]
        reals = [by_id[i] for i in sorted(real) if i in by_id]
        items.append(_item(
            "naming", "high",
            f"「{alias}」既是实体「{reals[0]['name'] if reals else '?'}」的主名，又是"
            f"{'、'.join(e['name'] for e in ents)} 的别名",
            "主名是双链的首选目标，别名也会命中 —— 同一个称呼落在两处，"
            "解析成谁取决于谁先被查到。把别名从后者身上去掉，或者合并。",
            [{"label": "主名属于", "entity_id": e["id"], "text": e["name"]} for e in reals]
            + [{"label": "别名属于", "entity_id": e["id"], "text": e["name"]} for e in ents],
            [{"entity_id": e["id"], "name": e["name"], "type": e.get("type") or ""}
             for e in (reals + ents)],
            key=f"shadow:{alias}",
        ))

    # ③ 两个实体同名 —— 文件会落到同一个路径（后者变 xxx-2.md），人眼看不出区别
    for name, owners in sorted(name_owner.items()):
        if len(owners) < 2:
            continue
        ents = [by_id[i] for i in sorted(owners) if i in by_id]
        items.append(_item(
            "naming", "high",
            f"{len(ents)} 个实体同名，都叫「{name}」",
            "实体 ID 不同，但显示名一样 —— 界面上分不清哪张卡是哪一个，"
            "双链也只能落到其中一个。要么合并，要么给其中一个改名。",
            [{"label": f"#{k + 1}", "entity_id": e["id"], "text": f"{e['name']}（{e['id']}）"}
             for k, e in enumerate(ents[:MAX_EVIDENCE_ENTITIES])],
            [{"entity_id": e["id"], "name": e["name"], "type": e.get("type") or ""} for e in ents],
            key=f"dup:{name}",
        ))
    return items, {"names": len(name_owner), "aliases": len(alias_owner)}


# --------------------------------------------------------------------------
# 四、地理从属环
# --------------------------------------------------------------------------

def _walk_cycles(parent: dict[str, str]) -> list[list[str]]:
    """找出所有环。返回每个环的节点序列（含首尾相接的那个节点）。

    用「每个节点单独走一遍、最多走 30 步」的笨办法：从属链本来就很浅
    （超过 5 层已经不合常理），而笨办法不会因为共享子链而漏报。
    """
    found: list[list[str]] = []
    seen_sets: set[frozenset[str]] = set()
    for start in parent:
        path = [start]
        cur = parent.get(start)
        steps = 0
        while cur and steps < 30:
            if cur in path:
                ring = path[path.index(cur):]
                key = frozenset(ring)
                if key not in seen_sets:
                    seen_sets.add(key)
                    found.append([*ring, cur])
                break
            path.append(cur)
            cur = parent.get(cur)
            steps += 1
    return found


def check_geo(book_id: str, rows: list[dict]) -> tuple[list[dict], dict]:
    items: list[dict] = []
    sources: list[tuple[str, str, dict[str, str]]] = []  # (标签, doc 名, 父表)

    # 源 A：地理志的「所属」列（人显式写的）
    head, trows = _table(paths.world_dir(book_id) / "geography.md")
    if trows:
        idx = {n: i for i, n in enumerate(head or [])}
        c_name = idx.get("地名", 0)
        c_parent = idx.get("所属", 1)
        parent: dict[str, str] = {}
        for row in trows:
            me, up = _cell(row, c_name), _cell(row, c_parent)
            if me and up and up not in ("—", "-", "无", "独立", "/", ""):
                parent[me] = up
        if parent:
            sources.append(("地理志的「所属」列", "geography", parent))

    # 源 B：地点实体属性里的「大纲路径」，倒数第二段就是上级
    path_parent: dict[str, str] = {}
    known_names = {(r.get("name") or "").strip() for r in rows}
    for r in rows:
        if r.get("type") != "location":
            continue
        fp = r.get("file_path")
        if not fp:
            continue
        # 走索引里存的路径，避免为了这一个字段把全书文件读一遍
        try:
            value = _location_outline_path(Path(fp))
        except OSError:
            value = ""
        if not value:
            continue
        segs = [s.strip() for s in value.split("/") if s.strip()]
        # 「大纲路径」的首段是顶级分栏名（地理 / 人物 / 势力…），不是上级。
        # 所以至少要有三段才有上级：`地理 / 中州 / 落霞城` 的上级是中州，
        # 而 `地理 / 中州` 里根本没有上级 —— 把它当成「属于地理」是假报。
        if len(segs) < 3:
            continue
        me = segs[-1]
        up = segs[-2]
        nm = (r.get("name") or "").strip()
        if me and up and me != up and nm:
            path_parent[nm] = up
    if path_parent:
        sources.append(("地点属性里的「大纲路径」", "", path_parent))

    for label, doc, parent in sources:
        for ring in _walk_cycles(parent):
            chain = " → ".join(ring)
            items.append(_item(
                "geo", "high",
                f"从属关系绕成了环：{chain}",
                "顺着「属于谁」往上找永远出不了这个圈 —— 地图打层级、面包屑、归属筛选用到它时"
                "要么死循环要么随便挑一个断掉。把其中一环改对即可。",
                [_doc_ref(doc, label, f"{ring[-2]} 属于 {ring[-1]}") if doc
                 else {"label": label, "text": chain, "entity_id": _find_id(rows, ring[0])}],
                [{"entity_id": _find_id(rows, n), "name": n, "type": "location"} for n in dict.fromkeys(ring)],
                doc=doc or None,
                key="ring:" + "|".join(ring),
            ))

        # 上级指向一个谁都不是的名字 —— 只对**人显式写下的**地理志报，
        # 「大纲路径」里出现的是目录名（地理 / 海洋 / 新世界…），报出来全是噪音
        if not trows:
            continue
        for me, up in sorted(parent.items()):
            if me == up:
                continue
            if up in parent or up in known_names:
                continue
            items.append(_item(
                "geo", "mid",
                f"「{me}」的上级「{up}」在库里找不到对得上的实体或条目",
                "地理志里写了从属关系，但那个上级既不是地理志里的地名，也不是一个地点实体 ——"
                "要么漏建了，要么名字写得不一样。",
                [_doc_ref("geography", "地理志", f"{me} 属于 {up}")],
                [{"entity_id": _find_id(rows, me), "name": me, "type": "location"}],
                doc="geography",
                key=f"dangling:{me}",
            ))
    return items, {"sources": len(sources)}


def _find_id(rows: list[dict], name: str) -> str:
    for r in rows:
        if (r.get("name") or "").strip() == name:
            return r["id"]
    return ""


def _location_outline_path(fp: Path) -> str:
    """只读文件头几行，把「大纲路径」抠出来 —— 不解析整份文档。

    地点实体上千个，为这一个字段把每个文件都做一次 frontmatter + 正文解析
    要 1.3 秒；而这一行总在属性表里、位置靠前，扫前 4KB 就够。
    """
    try:
        with open(fp, "r", encoding="utf-8", errors="replace") as f:
            chunk = f.read(4096)
    except OSError:
        return ""
    m = re.search(r"^\|\s*大纲路径\s*\|\s*(.+?)\s*\|\s*$", chunk, re.MULTILINE)
    return m.group(1).strip() if m else ""


# --------------------------------------------------------------------------
# 五、出处失效
# --------------------------------------------------------------------------

def check_provenance(book_id: str, rows: list[dict], ch_nos: set[int],
                     para_counts: dict[int, int]) -> tuple[list[dict], dict]:
    """档案里引用的章节 / 段落是否还在。

    按「哪个章号失效」聚合 —— 一章被删，牵出的是上千条实体，
    逐条报等于刷屏；报「第 40 章没了，牵连 312 条实体」才有用。
    """
    if not ch_nos:
        return [], {"entities": 0, "refs": 0}

    ents = ent_mod.load_all_entities(book_id)
    by_id = {r["id"]: r for r in rows}
    missing: dict[int, list[dict]] = defaultdict(list)      # 章号 -> 实体
    bad_para: dict[int, list[tuple[dict, int, int]]] = defaultdict(list)  # 章号 -> (实体, para, 实际段数)
    refs = 0

    for e in ents:
        ref = {"entity_id": e.id, "name": e.name, "type": e.type}
        seen: set[tuple[int, int | None]] = set()
        for s in e.provenance.get("sources") or []:
            if not isinstance(s, dict):
                continue
            n = s.get("chapter_no")
            if n is None:
                continue
            try:
                n = int(n)
            except (TypeError, ValueError):
                continue
            refs += 1
            para = s.get("para")
            try:
                para = int(para) if para is not None else None
            except (TypeError, ValueError):
                para = None
            if (n, para) in seen:      # 同一出处记了两遍是「重复」不是「失效」
                continue
            seen.add((n, para))
            if n not in ch_nos:
                if ref not in missing[n]:
                    missing[n].append(ref)
                continue
            if para is not None and n in para_counts and para >= para_counts[n]:
                bad_para[n].append((ref, para, para_counts[n]))

    # 出场记录引用的章 —— 名字从已经取到的索引行里拿，别再逐个开连接
    with store.connect() as conn:
        for x in conn.execute(
            "SELECT entity_id, chapter FROM appearances WHERE book_id=?", (book_id,)
        ):
            n = _ch_no(x["chapter"])
            if n is None or n in ch_nos:
                continue
            base = by_id.get(x["entity_id"]) or {}
            ref = {"entity_id": x["entity_id"],
                   "name": base.get("name") or x["entity_id"],
                   "type": base.get("type") or ""}
            if ref not in missing[n]:
                missing[n].append(ref)

    items: list[dict] = []
    for n, affected in sorted(missing.items()):
        items.append(_item(
            "provenance", "mid",
            f"第 {n} 章不在库里，但还有 {len(affected)} 条记录指着它",
            "这一章被删了或还没导入。指着它的出处 / 出场记录现在指空 ——"
            "人不该因此删掉这些实体（缺失的章可能只是还没导入），但心里得有数。",
            [{"label": "受影响的实体", "entity_id": a["entity_id"], "text": a["name"]}
             for a in affected[:MAX_EVIDENCE_ENTITIES]],
            affected,
            key=f"chap:{n}",
        ))
    for n, seq in sorted(bad_para.items()):
        real = seq[0][2]
        items.append(_item(
            "provenance", "low",
            f"第 {n} 章只有 {real} 段，但有 {len(seq)} 条出处指向更靠后的段落",
            "多半是正文后来又增删过段落。段落号失效只影响「回调原文看证据」这一步，"
            "不影响实体本身。",
            [{"label": f"第 {a['name']} 条出处", "entity_id": a["entity_id"],
              "text": f"第 {p + 1} 段（实际只有 {real} 段）"} for a, p, _ in seq[:MAX_EVIDENCE_ENTITIES]],
            [a for a, _, _ in seq],
            key=f"para:{n}",
        ))
    return items, {"entities": len(ents), "refs": refs}


# --------------------------------------------------------------------------
# 汇总
# --------------------------------------------------------------------------

def scan(book_id: str, *, deep: bool = True) -> dict:
    """把五类检查跑一遍。**只读**，不动任何文件，也不碰正文。

    `deep=False` 只跑不读实体文件的那些（时间线 / 伏笔 / 称谓 / 地理），
    给「想先看一眼」的场景用；`deep=True` 会读一遍全部档案来查出处（大书约 1~3 秒）。
    """
    rows = store.list_entities(book_id)
    chs = ch_mod.list_chapters(book_id)
    ch_nos = {c.chapter_no for c in chs if c.chapter_no}
    para_counts = {
        c.chapter_no: len([p for p in re.split(r"\n\s*\n", c.text or "") if p.strip()])
        for c in chs if c.chapter_no
    }

    per_check: dict[str, dict] = {}
    all_items: list[dict] = []
    meta: dict[str, dict] = {}

    def run(cid: str, items: list[dict], extra: dict | None = None) -> None:
        extra = extra or {}
        omitted = max(0, len(items) - MAX_PER_CHECK)
        kept = items[:MAX_PER_CHECK]
        sev = {s: 0 for s in ("high", "mid", "low")}
        for it in items:
            sev[it["severity"]] = sev.get(it["severity"], 0) + 1
        per_check[cid] = {
            "id": cid, "name": CHECK_BY_ID[cid]["name"], "nature": CHECK_BY_ID[cid]["nature"],
            "covers": CHECK_BY_ID[cid]["covers"], "leaves": CHECK_BY_ID[cid]["leaves"],
            "total": len(items), "omitted": omitted, "severity": sev,
            "items": kept, **extra,
        }
        all_items.extend(kept)

    tl, tlm = check_timeline(book_id, rows, ch_nos)
    tl += check_chronology(book_id)
    run("timeline", tl, {"compared": tlm["compared"], "no_first_appear": tlm["no_first_appear"]})

    fs, fsm = check_foreshadow(book_id, ch_nos)
    run("foreshadow", fs, {"doc_rows": fsm["rows"]})

    nm, nmm = check_naming(rows)
    run("naming", nm, nmm)

    geo, gm = check_geo(book_id, rows)
    run("geo", geo, gm)

    if deep:
        pv, pvm = check_provenance(book_id, rows, ch_nos, para_counts)
        run("provenance", pv, pvm)
    else:
        run("provenance", [], {"skipped": True})

    order = {"high": 0, "mid": 1, "low": 2}
    all_items.sort(key=lambda x: (order.get(x["severity"], 9),
                                 [c["id"] for c in CHECKS].index(x["check"]), x["title"]))

    total = sum(v["total"] for v in per_check.values())
    sev_total = {s: sum(v["severity"].get(s, 0) for v in per_check.values())
                 for s in ("high", "mid", "low")}
    return {
        "book_id": book_id,
        "checked_entities": len(rows),
        "checked_chapters": len(chs),
        "deep": deep,
        "total": total,
        "severity": sev_total,
        "clean": total == 0,
        "checks": [per_check[c["id"]] for c in CHECKS],
        "items": all_items,
        "natures": list(NATURES),
        "severities": list(SEVERITIES),
        "generated_at": _now(),
    }


def _now() -> str:
    from datetime import datetime
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")
