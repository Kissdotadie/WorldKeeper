"""提示词管理：模板存数据目录、版本化、可回滚。

布局（data/ai/prompts/）：
    extraction/
        current.md        —— 当前生效的模板
        meta.json         —— {"version": 3, "updated_at": "..."}
        versions/v001.md  —— 每次保存都留一份，回滚只是把旧版本复制成新的 current

改提示词不用改代码；某章不满意可单独重跑（换版本号缓存键自动失效）。
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from pathlib import Path

from .. import paths

# --------------------------------------------------------------------------
# 内置默认模板
#
# 设计要点（记忆里的工程铁律）：
# - 附**已有实体名录**，AI 只报新增与变更（既准又省钱）
# - 强制结构化 JSON 输出
# - 每条结论必须带原文依据（出处永不丢失）
# --------------------------------------------------------------------------

DEFAULT_EXTRACTION_PROMPT = """你是小说世界观知识库的**信息抽取员**。你只读正文、抽取信息，**绝不续写或改写正文**。

下面是一部小说的章节正文和知识库现状。请找出正文中出现的**新知识**：

## 已有实体名录（这些不要重复上报）
{entity_roster}

## 已有方法论（哲学观/主义/戒律）
{methodology_roster}

## 待分析的正文（第 {chapter_no} 章《{title}》）
{chapter_text}

## 输出要求
只输出一个 JSON 对象（不要 markdown 代码围栏、不要解释），结构如下：
{{
  "entities": [
    {{
      "name": "实体名（人名/地名/势力/组织/物品/概念/境界）",
      "type": "character|location|faction|organization|item|concept|realm 之一",
      "summary": "一句话概括（30 字内）",
      "aliases": ["别名"],
      "methodologies": ["信奉的方法论，没有就不填"],
      "evidence": "支撑这条结论的原文句子（原样摘录）"
    }}
  ],
  "changes": [
    {{
      "name": "已有名录中的实体名",
      "field": "变化的是什么（如 身份/状态/关系）",
      "detail": "变成了什么",
      "evidence": "原文句子"
    }}
  ],
  "foreshadow": [
    {{
      "content": "埋下的伏笔是什么",
      "evidence": "原文句子"
    }}
  ]
}}

规则：
- entities 只报**名录里没有的**新实体；名录里已有的实体有新变化，写进 changes
- 拿不准类型就用 concept；拿不准是不是实体就不报（宁缺毋滥）
- evidence 必须是正文里**原样存在**的句子，不许改写
- 没有新发现就返回空数组，不要硬凑
"""

KNOWN_PROMPTS: dict[str, dict] = {
    "extraction": {
        "label": "章节信息抽取",
        "default": DEFAULT_EXTRACTION_PROMPT,
        "placeholders": ["entity_roster", "methodology_roster", "chapter_no", "title", "chapter_text"],
    },
}

_VALID_NAME = re.compile(r"^[a-z0-9_-]{1,40}$")


def _check_name(name: str) -> str:
    if not _VALID_NAME.match(name or ""):
        raise ValueError(f"提示词名不合法：{name!r}")
    return name


def _dir(name: str) -> Path:
    return paths.ai_prompts_dir() / _check_name(name)


def _meta_path(name: str) -> Path:
    return _dir(name) / "meta.json"


def _read_meta(name: str) -> dict:
    p = _meta_path(name)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"version": 0, "updated_at": ""}


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def ensure_prompt(name: str) -> dict:
    """首次访问时把内置模板落成 v1。"""
    _check_name(name)
    spec = KNOWN_PROMPTS.get(name)
    if spec is None:
        raise KeyError(name)
    d = _dir(name)
    cur = d / "current.md"
    if not cur.exists():
        (d / "versions").mkdir(parents=True, exist_ok=True)
        content = spec["default"]
        cur.write_text(content, encoding="utf-8")
        (d / "versions" / "v001.md").write_text(content, encoding="utf-8")
        _meta_path(name).write_text(
            json.dumps({"version": 1, "updated_at": _now(), "builtin": True},
                       ensure_ascii=False, indent=2),
            encoding="utf-8")
    return get_prompt(name)


def get_prompt(name: str) -> dict:
    spec = KNOWN_PROMPTS.get(_check_name(name))
    if spec is None:
        raise KeyError(name)
    cur = _dir(name) / "current.md"
    if not cur.exists():
        return ensure_prompt(name)
    meta = _read_meta(name)
    content = cur.read_text(encoding="utf-8")
    return {
        "name": name,
        "label": spec["label"],
        "content": content,
        "version": int(meta.get("version") or 0),
        "updated_at": meta.get("updated_at", ""),
        "is_default": content == spec["default"],
        "placeholders": spec["placeholders"],
        "sha1": hashlib.sha1(content.encode("utf-8")).hexdigest()[:10],
    }


def list_prompts() -> list[dict]:
    out = []
    for name in KNOWN_PROMPTS:
        p = get_prompt(name)
        out.append({k: p[k] for k in ("name", "label", "version", "updated_at", "is_default", "sha1")})
    return out


def save_prompt(name: str, content: str) -> dict:
    """保存 = 新版本。旧版本永远在 versions/ 里，可回滚。"""
    spec = KNOWN_PROMPTS.get(_check_name(name))
    if spec is None:
        raise KeyError(name)
    if not (content or "").strip():
        raise ValueError("提示词不能是空的")
    missing = [ph for ph in spec["placeholders"] if "{" + ph + "}" not in content]
    if missing:
        raise ValueError(f"模板缺占位符：{', '.join('{' + m + '}' for m in missing)}")

    ensure_prompt(name)
    meta = _read_meta(name)
    version = int(meta.get("version") or 0) + 1
    d = _dir(name)
    (d / "current.md").write_text(content, encoding="utf-8")
    (d / "versions" / f"v{version:03d}.md").write_text(content, encoding="utf-8")
    _meta_path(name).write_text(
        json.dumps({"version": version, "updated_at": _now(), "builtin": False},
                   ensure_ascii=False, indent=2),
        encoding="utf-8")
    return get_prompt(name)


def list_versions(name: str) -> list[dict]:
    ensure_prompt(name)
    current = int(_read_meta(name).get("version") or 0)
    out = []
    for p in sorted((_dir(name) / "versions").glob("v*.md")):
        content = p.read_text(encoding="utf-8")
        try:
            ver = int(p.stem[1:])
        except ValueError:
            continue
        out.append({
            "version": ver,
            "is_current": ver == current,
            "size": len(content),
            "sha1": hashlib.sha1(content.encode("utf-8")).hexdigest()[:10],
            "preview": content[:80].replace("\n", " "),
        })
    return sorted(out, key=lambda x: x["version"], reverse=True)


def rollback(name: str, version: int) -> dict:
    """回滚 = 把旧版本复制成一个**新的** current（历史不改写）。"""
    ensure_prompt(name)
    src = _dir(name) / "versions" / f"v{int(version):03d}.md"
    if not src.exists():
        raise KeyError(f"没有版本 v{version:03d}")
    return save_prompt(name, src.read_text(encoding="utf-8"))
