"""思维导图大纲 → 带「角色初判」的结构树。

## 为什么需要「角色」

作者的思维导图里，一个节点的子节点混着两种东西：

- **子级**：「A国 → 首都」这种层级；
- **描述**：「A国 → 旧世界最大的海洋国」这种补充说明。

实测源文件（663 个节点）里这两类**结构完全同构**：都是 child node，
零个 `<richcontent TYPE="NOTE">`。长度也不足以区分 ——
「旧世界最大的海洋国」只有 9 个字，却是彻头彻尾的描述。

所以这里只做**启发式初判**，把建议连同「为什么这么判」一起交出去，
由用户在前端逐条确认 —— 与铁律 1「只产待确认变更清单，人工确认才落盘」
是同一条规矩。判错了不丢数据，只是多一次点击。

## 一条重要的结构性结论

`有子节点的必然是「子级」`（描述不会再往下挂东西），于是
**只有叶子节点需要判角色**。规则集因此小得多，也稳得多。

## 两个来源的差别

- `.mm`（FreeMind/Freeplane）是思维导图的**源文件**，一个节点的多行文本
  用 `<br>` 真换行存着：`旧历<br>（主流人类文明<br>自决为世界中心）`。
  于是「首行 = 节点名，其余行 = 描述」是个**极强的信号**。
- `.docx` 是导出产物，`<br>` 在导出时被**抹掉直接拼接**，变成
  `旧历（主流人类文明自决为世界中心）`。信息已经损失了，只能靠括号剥离
  与长度/标点兜底。有 `.mm` 时导 `.mm` 更准，前端会提示这一点。
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from pathlib import Path
from xml.etree import ElementTree as ET

from . import docx as docx_parser

#: 一个节点被当成「描述」的长度门槛（超过基本可以确定是成句的说明）
DESC_LEN = 45
#: 短名词的上限 —— 这个长度以内、又不带标点，倾向当作真节点
NODE_LEN = 18
#: 同组传染时，一组叶子的数量上限。超过这个数基本是分类列表，不是「一组说明」
GROUP_MAX = 12

#: 分节/清单前缀（`@某个环节`、`1.`、`①`、`一、`）—— 是描述内部的组织方式
_SECTION_RE = re.compile(r"^\s*(?:[@#]|[①-⑳]|\d{1,2}[.、)）]|[一二三四五六七八九十]{1,3}[、.])")
#: 成句标点
_SENTENCE_RE = re.compile(r"[。；;：:]")
#: 句子式的开头（介词 / 副词 / 连词）—— 名词性节点名不会这么起头
_CLAUSE_HEAD_RE = re.compile(
    r"^(?:以|从|由|把|将|对|向|往|在|为|依|随|经|据|因|让|使|当|若|如|除|被|不|没|已|正|还|也|都|就|才|更|最)"
)
#: `X为Y` / `X是Y` / `X指Y` —— 判定句，不是名词
_PREDICATE_RE = re.compile(r"^.{1,8}(?:是|为|指|即|等于).{1,20}$")
#: `以…为单位` / `以…为名` 这类介词框架
_FRAME_RE = re.compile(r"^以.{1,20}为")
#: 括号里的补充说明（中文全角 / 半角 / 书名号外）
_PAREN_RE = re.compile(r"[（(][^（()）]{1,60}[)）]")

#: 控制字符与零宽字符 —— 稿子里常见，留着会让节点名看着「有脏东西」
_JUNK_RE = re.compile(r"[\u200b-\u200f\u2028\u2029\ufeff\x00-\x08\x0b\x0c\x0e-\x1f]")


def clean_text(raw: str | None) -> str:
    """还原一个节点的文本。

    `.mm` 里的文本是**双层转义**的 HTML（`&amp;lt;br&amp;gt;` 表示字面
    `<br>`），所以要反复 unescape；`<br>` / `</div>` 是**排版换行**，
    要还原成换行符而不是删掉 —— 它们是「首行是节点名」这条规则的依据。
    """
    if not raw:
        return ""
    s = raw
    for _ in range(4):  # 双层甚至三层转义都还原掉
        nxt = html.unescape(s)
        if nxt == s:
            break
        s = nxt
    s = re.sub(r"<\s*br\s*/?\s*>", "\n", s, flags=re.I)
    s = re.sub(r"<\s*/?\s*(?:div|p|li|tr)\b[^>]*>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]{0,300}?>", "", s)  # 其余标签（span 带 style 等）直接剥掉
    s = _JUNK_RE.sub("", s)
    s = re.sub(r"[ \t\u3000]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def split_head(text: str) -> tuple[str, str]:
    """把一段文本拆成 (节点名, 描述)。

    依据两条：
    1. **换行**（`.mm` 有）—— 首行是名字，其余是细节；
    2. **括号补充** —— `A国(世界强国)` 里括号是定性，不是名字的一部分。

    名字为空的极端情况（整个节点都是括号）退回用全文当名字，
    免得建出一个没有名字的节点。
    """
    head = ""
    rest: list[str] = []
    lines = [ln.strip() for ln in text.split("\n")]
    for i, ln in enumerate(lines):
        if not ln:
            continue
        if i == 0:
            head = ln
        else:
            rest.append(ln)

    # 首行里的括注也算描述的一部分
    m = _PAREN_RE.search(head)
    if m and not is_pure_paren(head):
        inner = m.group(0)
        head = (head[: m.start()] + head[m.end():]).strip()
        rest.insert(0, inner)

    if not head:
        head = text.strip()
        rest = []

    head = head.strip(" \t·•|")
    return head or text.strip(), "\n".join(r for r in rest if r).strip()


def is_pure_paren(text: str) -> bool:
    """整段就是一个括号（`(地穿甲)`）—— 它本身就是名字的一部分，别剥。"""
    t = text.strip()
    return bool(t) and t.startswith(("(", "（")) and t.endswith((")", "）")) and t.count("(") + t.count("（") == 1


# --------------------------------------------------------------------------
# 角色初判
# --------------------------------------------------------------------------

@dataclass
class Verdict:
    role: str  # 'node' | 'desc'
    score: float
    reason: str


def judge_leaf(text: str, parent_name: str = "", has_inline_desc: bool = False) -> Verdict:
    """判一个**叶子**节点是「子级」还是「描述」。

    ## 为什么不能只看长度

    原始数据里「旧世界最大的海洋国」只有 9 个字，却是十足的描述；
    而「猎枪」「手枪」只有 2 个字，却是实打实的子级。单看长度必错。

    ## 所以看「叙述性证据」

    把每种特征折算成证据分，够了就判描述。三条主线：

    1. **以父节点名开头** —— `A国` 下面的 `A国开始在煤炭资源丰富的两极地区建立城市`，
       主语就是父节点，它在说父节点自己，不可能是下级；
    2. **句子的形态** —— 有逗号且够长、`以…为…` 框架、`X为Y` 判定句、
       以介词/副词起头（名词不会这么开头）；
    3. **反向证据** —— 短、无标点、纯名词并列（`飞机，火箭炮等`），压回子级。

    只有叶子会走到这里：有子节点的必然是结构节点。
    """
    t = text.strip()
    n = len(t)
    if not n:
        return Verdict("node", 0.0, "空文本")

    ev = 0.0
    reasons: list[str] = []

    # ---- 正向：叙述性证据 ----
    pn = parent_name.strip("（()） \t·")
    if len(pn) >= 2 and t.startswith(pn):
        ev += 2.0
        reasons.append(f"以父节点「{pn}」开头，说的是它自己")
    elif len(pn) >= 3 and t.startswith(pn[:3]) and n > len(pn) + 6:
        ev += 0.9
        reasons.append(f"与父节点「{pn}」同起头")

    if n > DESC_LEN:
        ev += 1.6
        reasons.append(f"{n} 字，是一整段说明")
    elif n > 30:
        ev += 1.0
        reasons.append(f"{n} 字，偏长")

    if "，" in t and n >= 10:
        ev += 1.0
        reasons.append("含逗号的成句")
    if n >= 20 and _SENTENCE_RE.search(t):
        ev += 1.0
        reasons.append("含句末标点且够长")

    if _FRAME_RE.match(t) and n >= 10:
        ev += 1.0
        reasons.append("「以…为…」句式")
    if n >= 12 and _CLAUSE_HEAD_RE.match(t):
        ev += 0.8
        reasons.append("以介词/副词起头，像句子")

    short_predicate = 0 < n <= 14 and _PREDICATE_RE.match(t) and "，" not in t
    if short_predicate:
        ev += 1.0
        reasons.append("「X是Y」判定句")

    if n >= 12 and _SECTION_RE.match(t) and (t.count("，") + t.count(" ") >= 2):
        ev += 0.6
        reasons.append("内部有分节编号")

    # ---- 反向：名词性证据 ----
    no_punct = not re.search(r"[，。；：、/\\|]", t)
    if n <= 10 and no_punct and not short_predicate:
        ev -= 1.0
        reasons.append("短名词，无标点")
    elif n <= NODE_LEN and no_punct and not short_predicate:
        ev -= 0.5
        reasons.append("名词性短句")

    if n <= 20 and ("、" in t or "/" in t) and "，" not in t:
        ev -= 0.6
        reasons.append("顿号/斜杠并列的名词串")

    if has_inline_desc:
        # `上尉军衔 / 三枚菱形盾徽 / 盾徽上有十字徽记` —— 首行是名字，
        # 余下行是它的说明。这是**典型的节点**（名字 + 注记），不是描述。
        ev -= 0.5
        reasons.append("首行是名字，其余是注记")

    role = "desc" if ev >= 1.0 else "node"
    if not reasons:
        reasons.append("无显著特征")
    return Verdict(role, round(ev, 2), "；".join(reasons))


def _propagate_group(parent: ParsedNode) -> None:
    """同组一致性：一批并列的叶子，若已有多数被判描述，剩下的跟着走。

    为什么需要：`A国` 底下并排着
        `A国开始在煤炭资源丰富的两极地区建立城市`（以父名开头，铁证）
        `旧世界最大的海洋国`（9 字，孤立看就是名词）
    两条在讲同一件事（都是在说 A国 是个什么样的国家），
    孤立判第二条必错 —— 只有看兄弟才知道它也是描述。

    三道闸，防止把一个**大分类列表**误当成「一组说明」：
    组内叶子不能超过 `GROUP_MAX`，描述必须占半数、且至少 2 条。
    「军衔 / 士兵 / 哲学」这种十几条平铺的分类，永远不该被整组降级。
    """
    leaves = [c for c in parent.children if not c.children]
    descs = [c for c in leaves if c.role == "desc"]
    if len(leaves) < 2 or len(leaves) > GROUP_MAX or len(descs) < 2:
        return
    if len(descs) * 2 < len(leaves):
        return
    for c in leaves:
        if c.role != "desc":
            c.role = "desc"
            c.reason = f"{c.reason}；与同组说明并列"


# --------------------------------------------------------------------------
# 解析：docx / mm
# --------------------------------------------------------------------------

@dataclass
class RawNode:
    text: str
    level: int
    children: list["RawNode"] = field(default_factory=list)


@dataclass
class ParsedNode:
    """交出去的一个节点。`head` 是节点名，`desc` 是识别出的描述文本。"""

    head: str
    desc: str = ""
    role: str = "node"
    score: float = 0.0
    reason: str = ""
    children: list["ParsedNode"] = field(default_factory=list)


def _build_forest(items: list[tuple[str, int]]) -> list[RawNode]:
    """(文本, 层级) 序列 → 森林。层级跳跃（0 直接到 3）按「挂到最近的上层」处理。"""
    roots: list[RawNode] = []
    stack: list[RawNode] = []
    for text, level in items:
        node = RawNode(text=text, level=level)
        while stack and stack[-1].level >= level:
            stack.pop()
        if stack:
            stack[-1].children.append(node)
        else:
            roots.append(node)
        stack.append(node)
    return roots


def _classify_forest(roots: list[RawNode], parent_head: str = "") -> list[ParsedNode]:
    out: list[ParsedNode] = []
    for rn in roots:
        raw_lines = [ln for ln in rn.text.split("\n") if ln.strip()]
        head, desc_inline = split_head(rn.text)
        node = ParsedNode(head=head, desc=desc_inline)
        multi_line = len(raw_lines) > 1

        if rn.children:
            # 有子级 → 必然是结构节点（描述不会往下挂东西）。
            # 这条把「判角色」的规模砍掉了一大半：只有叶子需要判。
            node.role = "node"
            node.reason = f"挂有 {len(rn.children)} 个子级"
            node.children = _classify_forest(rn.children, head)
        else:
            verdict = judge_leaf(head, parent_head, has_inline_desc=bool(desc_inline))
            if desc_inline and multi_line and verdict.role == "desc":
                # 首行已经拆出名字了，还说它整条是描述 —— 多半是把
                # 「名字 + 注记」误当成了句子。降级回节点，保留注记。
                verdict = Verdict("node", verdict.score - 0.6, "首行是节点名，其余行是注记")
            node.role = verdict.role
            node.score = verdict.score
            node.reason = verdict.reason

    # 组级一致性要**自底向上**：先让子级各自判完，再回头看这一组像不像
    # 一批并列的说明。递归顺序保证了这一点。
        if node.children:
            _propagate_group(node)
        out.append(node)
    return out


def _propagate_roots(items: list[ParsedNode]) -> list[ParsedNode]:
    """顶层（虚拟根的直接孩子）也当一组看待 —— 根节点底下常常并排挂着几条说明。"""
    _propagate_group(ParsedNode(head="", children=items))
    return items


def parse_docx(path: str | Path) -> tuple[list[ParsedNode], dict]:
    """`.docx` 大纲：层级来自多级列表 `ilvl`（标题样式也认）。

    ## 一个必须处理的导出陷阱

    思维导图软件导出 Word 时，**中心主题不参与编号**，只有一级分支才从
    `ilvl=0` 起。于是一份「旧世界 → 旧历 / 军衔 / 士兵 / …」的导图，
    导出来会变成**平铺的 39 个 ilvl=0**，除非把开头那条不编号的中心主题
    认出来当根 —— 否则整棵树会被拆成 39 个孤儿，传染式判定还会跟着误伤根节点。

    所以：文档开头的裸段落 = 总标题，其后所有列表层级整体 +1 挂到它底下。
    """
    doc = docx_parser.read_docx(path)
    raw: list[tuple[str, int | None, bool]] = []
    for p in doc.paragraphs:
        text = clean_text(p.text)
        if text:
            raw.append((text, p.level, p.is_heading))
    if not raw:
        return [], {"paragraphs": 0}

    title: str | None = None
    offset = 0
    if raw[0][1] is None and not raw[0][2] and len(raw) > 1:
        title, raw = raw[0][0], raw[1:]
        offset = 1

    items: list[tuple[str, int]] = []
    h_level = offset  # Heading 样式没有 ilvl 时，用出现顺序退化成层级
    for text, lv, head in raw:
        if lv is not None:
            items.append((text, lv + offset))
        elif head:
            items.append((text, h_level))
            h_level += 1
        else:
            # 裸段落（既非列表也非标题）：是上一条的续行，用 -1 表示「贴上去」
            items.append((text, -1))

    if not any(lv >= 0 for _, lv in items):
        items = [(t, offset) for t, _ in items]
    items = _drop_negative(items)
    if title:
        items.insert(0, (title, 0))
    roots = _build_forest(items)
    return _propagate_roots(_classify_forest(roots)), {"paragraphs": len(raw)}


def _drop_negative(items: list[tuple[str, int]]) -> list[tuple[str, int]]:
    """裸段落（level=-1）拼到上一条上 —— 它是同一条的续行，不是新节点。

    这在导出的 docx 里很常见：一个节点的长文本被拆成了多个段落。
    """
    out: list[tuple[str, int]] = []
    for text, lv in items:
        if lv < 0 and out:
            prev_text, prev_lv = out[-1]
            out[-1] = (prev_text + text, prev_lv)
        else:
            out.append((text, max(lv, 0)))
    return out


def parse_mm(path: str | Path) -> tuple[list[ParsedNode], dict]:
    """FreeMind / Freeplane `.mm`：节点嵌套就是层级，无损。"""
    try:
        tree = ET.parse(str(path))
    except ET.ParseError as exc:
        raise docx_parser.DocxError(f"{Path(path).name} 不是有效的思维导图 XML：{exc}") from exc
    root = tree.getroot()

    def conv(el: ET.Element) -> RawNode | None:
        parent_el = None
        # map 的直属 node 是画布的虚拟根（TEXT 通常为空），要跳过它
        text = clean_text(el.get("TEXT"))
        kids = [k for k in (conv(c) for c in el.findall("node")) if k is not None]
        if not text and len(kids) == 1:
            return kids[0]  # 虚拟根：把唯一的孩子提上来当真根
        if not text and not kids:
            return None
        return RawNode(text=text or "（未命名）", level=0, children=kids)

    tops = [n for n in (conv(c) for c in root.findall("node")) if n is not None]
    return _propagate_roots(_classify_forest(tops)), {"maps": 1}


#: 导入允许的扩展名
OUTLINE_EXTS = (".docx", ".mm", ".txt", ".md", ".markdown")


def parse_any(path: str | Path) -> tuple[list[ParsedNode], dict]:
    """按扩展名分派。`.mm` 优先推荐（无损），`.docx` 也能用。"""
    suffix = Path(path).suffix.lower()
    if suffix == ".mm":
        return parse_mm(path)
    if suffix in docx_parser.DOCX_EXTS:
        return parse_docx(path)
    if suffix in docx_parser.TEXT_EXTS:
        doc = docx_parser.read_text_file(path)
        items = [(clean_text(p.text), 0 if p.level is None else p.level) for p in doc.paragraphs]
        # 纯文本没有层级信息：按缩进猜一层
        items = [(t, len(t) - len(t.lstrip())) for t, _ in items]
        return _propagate_roots(_classify_forest(_build_forest(items))), {"paragraphs": len(items)}
    raise docx_parser.DocxError(f"不支持的格式：{suffix or '(无扩展名)'}；请用 .mm / .docx / .txt / .md")


# --------------------------------------------------------------------------
# 输出
# --------------------------------------------------------------------------

def to_payload(roots: list[ParsedNode], meta: dict, name: str) -> dict:
    """给前端的 JSON。节点带一个稳定 id（路径式），前端拿它做 key 与勾选。"""
    stats = {"total": 0, "nodes": 0, "descs": 0, "max_depth": 0}

    def conv(n: ParsedNode, path: str, depth: int) -> dict:
        stats["total"] += 1
        stats["max_depth"] = max(stats["max_depth"], depth)
        if n.role == "desc":
            stats["descs"] += 1
        else:
            stats["nodes"] += 1
        return {
            "id": path,
            "head": n.head,
            "desc": n.desc,
            "role": n.role,
            "score": n.score,
            "reason": n.reason,
            "children": [conv(c, f"{path}.{i}", depth + 1) for i, c in enumerate(n.children)],
        }

    items = [conv(r, str(i), 0) for i, r in enumerate(roots)]
    kind = {".mm": "mm", ".docx": "docx"}.get(Path(name).suffix.lower(), "text")
    return {
        "source": {"name": name, "kind": kind, "exact": kind == "mm", **meta},
        "items": items,
        "stats": stats,
    }
