"""AI 技能卡 —— 提示词模板库。

**定位**：把常见「读正文」的用法做成一张张卡。每张卡 = 名字 + 适用场景 +
一段提示词模板。选中章节 → 跑一次 → 拿到分析结果。

**这条线只读不写**（项目第一铁律）：技能卡产出的是分析、清单、梳理，
绝不生成、续写、润色、改写正文任何一个字。每张内置模板里都写死了这条。

**存储**（markdown 唯一真源）：一卡一文件，`data/skills/<id>.md`
    ---
    id: rel-chart
    name: 人物关系梳理
    scene: 想知道谁和谁产生了交集
    placeholders: [chapter_text, focus]
    schema_version: 1
    ---
    （正文 = 提示词模板）

内置卡写在代码里（`BUILTIN_SKILLS`），不落盘、不可删，只能「复制为自定义」
再改 —— 免得哪天误删了还得改代码找回来。

模板占位符（运行时统一替换）：
    {chapter_text}    选中章节的正文（拼好、带章标题）
    {chapter_titles}  选中章节的标题清单
    {entity_roster}   库里已有实体名录（帮 AI 对齐叫法、少报已有的）
    {focus}           这次运行的补充要求（用户在界面上填）
"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

import frontmatter
import yaml

from . import paths
from .consistency import NATURES, SEVERITIES
from .logging_setup import get_logger

log = get_logger(__name__)

SCHEMA_VERSION = 1

#: 一次运行塞给 AI 的正文字数上限 —— 超了截断并告知（省钱，也避免超长请求）
MAX_CHARS = 24000

#: 卡 id / 文件名规则
_VALID_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")

#: 「设定矛盾检查」那张卡的输出口径 —— **直接取自身份校验模块的词表**。
#: 两边各写一份是这类功能最容易漂的地方：面板报「时间线」、提示词让 AI 报「时间性」，
#: 人就没法把两边的结论对着看了。改词表请去 `app/consistency.py`。
_NATURE_OPTIONS = " / ".join(NATURES)
_SEVERITY_OPTIONS = " / ".join(SEVERITIES)


# --------------------------------------------------------------------------
# 内置技能卡
#
# 共同约束（写进每张模板）：只读正文、不产出正文、结论尽量可核对。
# --------------------------------------------------------------------------

_READONLY_RULE = "你只阅读并分析正文，绝不续写、改写、润色正文里的任何一个字。"

BUILTIN_SKILLS: list[dict] = [
    {
        "id": "alias-dict",
        "name": "称谓与别名词典",
        "scene": "同一人物有好几种叫法（小名 / 绰号 / 官称），抽出来的实体对不上号",
        "placeholders": ["chapter_text", "focus"],
        "template": f"""你是小说设定整理助手。{_READONLY_RULE}

下面是一批章节正文。请找出**同一个人 / 同一个事物被用了多种叫法**的情况，
整理成「标准名 → 别名列表」的对照表。

## 正文
{{chapter_text}}

## 输出要求
用 Markdown 表格输出，列：标准名 | 别名 / 其他叫法 | 依据（原文短句） | 置信度（高/中/低）

规则：
- 只在正文里确实能找到证据时才列；拿不准的置信度标「低」
- 官称（陛下 / 队长）与泛称（那个人）不算别名，除非正文明确指向具体某人
- 不要脑补正文里没有的关系
{{focus}}""",
    },
    {
        "id": "rel-chart",
        "name": "人物关系梳理",
        "scene": "读完几章，想知道这一段里谁和谁产生了交集、关系怎么变了",
        "placeholders": ["chapter_text", "entity_roster", "focus"],
        "template": f"""你是小说设定整理助手。{_READONLY_RULE}

下面是一批章节正文。请梳理其中出现的人物之间的**关系与互动**。

## 已有实体（叫法尽量与这里对齐）
{{entity_roster}}

## 正文
{{chapter_text}}

## 输出要求
1. 先给一张关系表：人物 A | 关系 | 人物 B | 依据（原文短句） | 本段是否有变化
2. 再列「本段新登场且不在已有实体里的角色」，各附一句话身份 + 原文依据

规则：
- 关系要具体（上下级 / 师徒 / 血亲 / 同盟 / 敌对 / 雇佣），不要笼统写「认识」
- 每条都要有原文短句作依据，原文里没有的不要写
{{focus}}""",
    },
    {
        "id": "world-build",
        "name": "世界观设定抽取",
        "scene": "把这几章里的地理、势力、制度、技术、器物等设定条目挖出来",
        "placeholders": ["chapter_text", "entity_roster", "focus"],
        "template": f"""你是小说设定整理助手。{_READONLY_RULE}

下面是一批章节正文。请抽取其中的**世界观设定条目**。

## 已有实体（已在库里的不要重复报）
{{entity_roster}}

## 正文
{{chapter_text}}

## 输出要求
用 Markdown 表格输出，列：名称 | 类别（地理/势力/组织/器物/概念/境界） | 一句话说明 | 原文依据

规则：
- 只报**已有实体里没有的**新条目；已有的有新信息，另起一行写「补充：」
- 拿不准类别就写「概念」；拿不准是不是正经设定就不要报（宁缺毋滥）
- 依据必须是正文里原样存在的句子
{{focus}}""",
    },
    {
        "id": "foreshadow-hunt",
        "name": "伏笔与线索挖掘",
        "scene": "读的时候总觉得埋了什么，回头又找不着在哪一章",
        "placeholders": ["chapter_text", "focus"],
        "template": f"""你是小说设定整理助手。{_READONLY_RULE}

下面是一批章节正文。请找出其中**像是伏笔 / 悬念 / 前后呼应**的地方。

## 正文
{{chapter_text}}

## 输出要求
用 Markdown 表格输出，列：线索内容 | 章号 | 埋点原文 | 它可能在为什么铺垫（你的推测） | 把握（高/中/低）

规则：
- 只列有具体原文支撑的；「把握」要诚实，推测就是推测
- 已经在本批正文里回收了的伏笔，另起一行注明「已回收」
- 不要为了凑数硬找
{{focus}}""",
    },
    {
        "id": "chapter-digest",
        "name": "章节摘要",
        "scene": "隔了一阵回来写，想快速回忆这几章讲了什么",
        "placeholders": ["chapter_text", "chapter_titles", "focus"],
        "template": f"""你是小说设定整理助手。{_READONLY_RULE}

下面是一批章节正文。请为**每一章**写一段摘要。

## 本次涉及的章节
{{chapter_titles}}

## 正文
{{chapter_text}}

## 输出要求
逐章输出，格式：
### 第 N 章《标题》
- **一句话**：整章在讲什么
- **要点**：3~5 条要点（谁做了什么、推动了什么）
- **本段涉及的人物 / 地点**：用顿号分隔

规则：
- 只概括，不评价好坏，不续写后续
- 要点按正文顺序排
{{focus}}""",
    },
    {
        "id": "continuity-check",
        "name": "设定矛盾检查",
        "scene": "写到后面怕跟前面设定对不上，让 AI 先替你把疑点列出来",
        "placeholders": ["chapter_text", "entity_roster", "focus"],
        "template": f"""你是小说设定校对助手。{_READONLY_RULE}

下面是一批章节正文。请检查其中**可能前后不一致**的地方。

## 已有实体（含库里的既有描述）
{{entity_roster}}

## 正文
{{chapter_text}}

## 输出要求
用 Markdown 表格输出，列：疑点 | 说法 A（章号 + 原文） | 说法 B（章号 + 原文） | 性质 | 严重度

- 性质**只能**从这几类里挑：{_NATURE_OPTIONS}
- 严重度**只能**填：{_SEVERITY_OPTIONS}

规则：
- 只报**真的对不上**的；同一件事的正常展开不算矛盾
- 一定要给两边的原文，不能只给结论
- 没找出矛盾就如实说「本批未发现明显冲突」，不要硬凑
- 后台的「不一致体检」面板用的是同一套性质与严重度口径 —— 你报的结论
  要和它摆在一起看，所以口径必须一致
{{focus}}""",
    },
]

BUILTIN_MAP = {s["id"]: s for s in BUILTIN_SKILLS}

#: 用户补充要求的统一收尾位置 —— 空则整行消失
_FOCUS_EMPTY = {"focus": ""}


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _skills_dir() -> Path:
    d = paths.skills_dir()
    d.mkdir(parents=True, exist_ok=True)
    return d


def _path(skill_id: str) -> Path:
    sid = (skill_id or "").strip()
    if not _VALID_ID.match(sid):
        raise ValueError(f"技能卡 id 不合法（只允许小写字母/数字/下划线/连字符）：{skill_id!r}")
    if sid in BUILTIN_MAP:
        raise ValueError(f"「{sid}」是内置技能卡的 id，换一个")
    return _skills_dir() / f"{sid}.md"


def _slug(name: str) -> str:
    """从中文名字挤出一个可读的 id：拼音不做，取英文/数字，实在没有就用时间戳。"""
    ascii_part = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return (ascii_part or "skill")[:32]


# --------------------------------------------------------------------------
# 读
# --------------------------------------------------------------------------

def _load_custom(path: Path) -> dict | None:
    try:
        post = frontmatter.load(str(path))
    except Exception as exc:  # 坏文件不该让整个列表挂掉
        log.warning("技能卡读取失败 %s：%s", path.name, exc)
        return None
    meta = dict(post.metadata or {})
    sid = str(meta.get("id") or path.stem)
    if sid in BUILTIN_MAP:
        return None
    return {
        "id": sid,
        "name": str(meta.get("name") or sid),
        "scene": str(meta.get("scene") or ""),
        "placeholders": list(meta.get("placeholders") or ["chapter_text", "focus"]),
        "template": post.content,
        "builtin": False,
        "updated_at": str(meta.get("updated_at") or ""),
    }


def list_skills() -> dict:
    """内置在前、自定义在后（按更新时间倒序）。"""
    items = [dict(s, builtin=True, updated_at="") for s in BUILTIN_SKILLS]
    custom: list[dict] = []
    for p in sorted(_skills_dir().glob("*.md")):
        card = _load_custom(p)
        if card:
            custom.append(card)
    custom.sort(key=lambda c: c.get("updated_at") or "", reverse=True)
    items.extend(custom)
    for it in items:
        it.pop("template", None)  # 列表不带正文（省流量），要看用详情
    return {
        "items": items,
        "builtin": len(BUILTIN_SKILLS),
        "custom": len(custom),
        "readonly_notice": "技能卡只做「读」：产出分析、清单、梳理，不改正文一个字。",
    }


def get_skill(skill_id: str) -> dict:
    sid = (skill_id or "").strip()
    if sid in BUILTIN_MAP:
        return dict(BUILTIN_MAP[sid], builtin=True, updated_at="")
    p = _skills_dir() / f"{sid}.md"
    if not p.exists():
        raise KeyError(sid)
    card = _load_custom(p)
    if not card:
        raise KeyError(sid)
    return card


# --------------------------------------------------------------------------
# 写
# --------------------------------------------------------------------------

def _render_card(card: dict) -> str:
    fm = {
        "id": card["id"],
        "name": card["name"],
        "scene": card.get("scene") or "",
        "placeholders": card.get("placeholders") or ["chapter_text", "focus"],
        "schema_version": SCHEMA_VERSION,
        "updated_at": card.get("updated_at") or _now(),
    }
    head = yaml.safe_dump(fm, allow_unicode=True, sort_keys=False, default_flow_style=False)
    return f"---\n{head}---\n\n{(card.get('template') or '').strip()}\n"


def _write(card: dict) -> dict:
    p = _path(card["id"])
    p.write_text(_render_card(card), encoding="utf-8")
    return get_skill(card["id"])


def create_skill(name: str, template: str, *, scene: str = "", skill_id: str | None = None,
                 placeholders: list[str] | None = None) -> dict:
    name = (name or "").strip()
    template = (template or "").strip()
    if not name:
        raise ValueError("给技能卡起个名字")
    if not template:
        raise ValueError("提示词模板不能是空的")
    if "{chapter_text}" not in template:
        raise ValueError("模板里必须留 {chapter_text} —— 不然不知道让 AI 读哪段正文")
    sid = (skill_id or "").strip() or _slug(name)
    base, n = sid, 2
    while (paths.skills_dir() / f"{base}.md").exists():
        base, n = f"{sid}-{n}", n + 1
    card = {
        "id": base,
        "name": name,
        "scene": scene.strip(),
        "template": template,
        "placeholders": placeholders or ["chapter_text", "focus"],
        "updated_at": _now(),
    }
    return _write(card)


def update_skill(skill_id: str, patch: dict) -> dict:
    if (skill_id or "") in BUILTIN_MAP:
        raise PermissionError("内置技能卡不能改 —— 先「复制为自定义」再改，改完原卡还在")
    cur = get_skill(skill_id)
    template = (patch.get("template") if patch.get("template") is not None
                else cur["template"])
    if "{chapter_text}" not in (template or ""):
        raise ValueError("模板里必须留着 {chapter_text}")
    cur.update({
        "name": (patch.get("name") or cur["name"]).strip(),
        "scene": (patch.get("scene") if patch.get("scene") is not None else cur.get("scene", "")).strip(),
        "template": template.strip(),
        "updated_at": _now(),
    })
    return _write(cur)


def delete_skill(skill_id: str) -> dict:
    if (skill_id or "") in BUILTIN_MAP:
        raise PermissionError("内置技能卡不能删（免得误删了得改代码找回来）")
    p = _skills_dir() / f"{(skill_id or '').strip()}.md"
    if not p.exists():
        raise KeyError(skill_id)
    p.unlink()
    return {"deleted": skill_id}


def clone_skill(skill_id: str, new_name: str | None = None) -> dict:
    """内置卡复制成自定义卡 —— 想改内置卡的正确姿势。"""
    src = get_skill(skill_id)
    name = (new_name or f"{src['name']}（副本）").strip()
    return create_skill(name, src["template"], scene=src.get("scene", ""),
                        placeholders=src.get("placeholders"))


# --------------------------------------------------------------------------
# 运行
# --------------------------------------------------------------------------

def render_prompt(card: dict, *, chapter_text: str, chapter_titles: str,
                  entity_roster: str, focus: str = "") -> str:
    """把模板里的占位符替换掉。没给的占位符留原样会被看出来，所以统一兜底成空。"""
    out = card["template"]
    values = {
        "chapter_text": chapter_text,
        "chapter_titles": chapter_titles,
        "entity_roster": entity_roster,
        "focus": (f"\n## 本次的补充要求\n{focus.strip()}" if (focus or "").strip() else ""),
    }
    for key, val in values.items():
        out = out.replace("{" + key + "}", val)
    return out


def assemble_chapters(chapters: list[dict]) -> tuple[str, str, bool]:
    """把章节拼成一段正文。返回 (正文, 标题清单, 是否被截断)。

    超长就截断 —— 与其发一个几万字的请求，不如让作者自己缩小范围。
    """
    titles = "、".join(f"第{c['chapter_no']}章《{c.get('title') or ''}》" for c in chapters)
    parts: list[str] = []
    total = 0
    truncated = False
    for c in chapters:
        head = f"\n\n===== 第{c['chapter_no']}章 {c.get('title') or ''} =====\n"
        body = c.get("text") or ""
        if total + len(head) + len(body) > MAX_CHARS:
            room = MAX_CHARS - total - len(head)
            if room > 200:
                parts.append(head + body[:room] + "\n…（本章因篇幅被截断）")
            truncated = True
            break
        parts.append(head + body)
        total += len(head) + len(body)
    return "".join(parts).strip(), titles, truncated
