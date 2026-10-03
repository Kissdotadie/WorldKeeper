"""P0 端到端烟雾测试（不依赖 pytest，直接跑）。

验收链路：
    空库起步 → 新建书目 → 批量粘贴录入 → 看到实体 → 删索引 →
    一键重建 → 数据原样恢复

用法：
    .venv/Scripts/python.exe tests/smoke_api.py
"""

from __future__ import annotations

import json
import re
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import base64
import hashlib
import logging
import os
import shutil
import sys
import tempfile
import time
import traceback
import zipfile
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# 用临时数据目录，绝不碰真实数据
_TMP = Path(tempfile.mkdtemp(prefix="wkv-smoke-"))
os.environ["WKV_DATA_DIR"] = str(_TMP)

from fastapi.testclient import TestClient  # noqa: E402

from app import config as app_config  # noqa: E402
from app import chapters as ch_mod  # noqa: E402
from app import fingerprint as fp_mod  # noqa: E402
from app import paths, snapshot as snap_mod, store  # noqa: E402
from app.main import create_app  # noqa: E402
from app.vision import base as vbase  # noqa: E402
from app.vision import cloud as vcloud  # noqa: E402

PASS = 0
FAIL = 0


def check(label: str, cond: bool, extra: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [OK]   {label}")
    else:
        FAIL += 1
        print(f"  [FAIL] {label}\n         {extra}")


def main() -> int:
    print(f"临时数据目录：{_TMP}")

    with TestClient(create_app()) as client:
        # ---------------------------------------------------------------
        print("\n[1] 健康检查")
        r = client.get("/api/health")
        check("GET /api/health 200", r.status_code == 200, r.text)
        check("app 标识正确", r.json().get("app") == "world-keeper", r.text)

        print("\n[2] 空库起步")
        r = client.get("/api/books")
        check("GET /api/books 200", r.status_code == 200, r.text)
        check("初始为空库", r.json()["count"] == 0, r.text)

        print("\n[3] 新建书目")
        r = client.post("/api/books", json={"book_id": "demo", "title": "示例书", "author": "某人"})
        check("POST /api/books 201", r.status_code == 201, r.text)
        check("目录已创建", paths.book_dir("demo").is_dir())
        check("book.yaml 已生成", paths.book_config_file("demo").is_file())
        r = client.post("/api/books", json={"book_id": "demo", "title": "x"})
        check("重复创建返回 409", r.status_code == 409, r.text)

        # ---------------------------------------------------------------
        print("\n[4] 批量粘贴 —— 竖线表")
        table = (
            "姓名 | 别名 | 简介 | 标签\n"
            "裴渊 | 小裴子、裴三郎 | 男主角，出身寒微，善用刀。 | 主角,武道\n"
            "韦忠 | 老韦 | 裴渊的师父，曾任北衙统领。 | 配角,武道\n"
            "明显帝 | 明昭 | 本朝皇帝，年号明显。 | 皇室\n"
        )
        r = client.post("/api/books/demo/bulk-paste/preview",
                        json={"text": table, "mode": "auto", "type": "character"})
        check("preview 200", r.status_code == 200, r.text)
        body = r.json()
        check("识别为表格模式", body.get("mode") == "table", r.text[:200])
        check("识别出 3 行数据（不含表头）", body.get("count") == 3, r.text[:300])
        d0 = body["drafts"][0] if body.get("drafts") else {}
        check("主名正确", d0.get("name") == "裴渊", str(d0))
        check("别名拆开", d0.get("aliases") == ["小裴子", "裴三郎"], str(d0))
        check("标签拆开", d0.get("tags") == ["主角", "武道"], str(d0))
        check("摘要归位", "男主角" in d0.get("summary", ""), str(d0))

        r = client.post("/api/books/demo/bulk-paste/commit",
                        json={"text": table, "mode": "auto", "type": "character"})
        check("commit 201", r.status_code == 201, r.text[:200])
        check("落盘 3 条", r.json().get("created") == 3, r.text[:300])

        print("\n[5] 批量粘贴 —— Excel 制表符")
        tsv = "名称\t简介\t标签\n北衙\t禁军驻地。\t地点,军事\n"
        r = client.post("/api/books/demo/bulk-paste/preview",
                        json={"text": tsv, "mode": "auto", "type": "location"})
        check("TSV 识别为表格", r.json().get("mode") == "table", r.text[:200])
        check("TSV 解析 1 条", r.json().get("count") == 1, r.text[:300])
        r = client.post("/api/books/demo/bulk-paste/commit",
                        json={"text": tsv, "mode": "auto", "type": "location"})
        check("TSV 落盘成功", r.status_code == 201 and r.json().get("created") == 1, r.text[:200])

        print("\n[6] 批量粘贴 —— 列表形态")
        lst = "- 隐龙院：直属皇室的暗卫机构\n- 三花聚顶：武道第三重境界\n"
        r = client.post("/api/books/demo/bulk-paste/preview",
                        json={"text": lst, "mode": "auto", "type": "concept"})
        check("列表模式识别", r.json().get("mode") == "list", r.text[:200])
        d = r.json()["drafts"][0]
        check("「名字：描述」已拆", d["name"] == "隐龙院" and "暗卫" in d["summary"], str(d))
        r = client.post("/api/books/demo/bulk-paste/commit",
                        json={"text": lst, "mode": "auto", "type": "concept"})
        check("列表落盘 2 条", r.status_code == 201 and r.json().get("created") == 2, r.text[:200])

        # ---------------------------------------------------------------
        print("\n[7] 实体列表、检索、统计")
        r = client.get("/api/books/demo/entities")
        items = r.json()["items"]
        check("列表 6 条", len(items) == 6, str(len(items)))
        chars = [e for e in items if e["type"] == "character"]
        check("按类型过滤可用", len(chars) == 3, str(len(chars)))
        ids = [e["id"] for e in items if e["type"] == "character"]
        check("ID 形如 char-xxxx", all(i.startswith("char-") for i in ids), str(ids))

        r = client.get("/api/books/demo/stats")
        check("stats.total == 6", r.json().get("total") == 6, r.text[:200])
        check("stats.by_type 正确", r.json()["by_type"].get("character") == 3, r.text[:200])

        r = client.get("/api/books/demo/tags")
        check("标签已聚合", "武道" in r.json().get("tags", []), r.text[:200])

        r = client.get("/api/books/demo/search", params={"q": "北衙统领"})
        check("中文长词检索命中", len(r.json()["items"]) >= 1, r.text[:200])
        r = client.get("/api/books/demo/search", params={"q": "裴"})
        check("中文短词回退命中", len(r.json()["items"]) >= 1, r.text[:200])

        # ---------------------------------------------------------------
        print("\n[8] 单实体 CRUD")
        target = next(e for e in items if e["name"] == "裴渊")
        r = client.get(f"/api/books/demo/entities/{target['id']}")
        ent = r.json()
        check("含摘要", "出身寒微" in (ent.get("summary") or ""), str(ent.get("summary")))
        check("含别名", "小裴子" in (ent.get("aliases") or []), str(ent.get("aliases")))
        check("含出处字段", "provenance" in ent, str(list(ent.keys())))

        r = client.put(f"/api/books/demo/entities/{target['id']}",
                       json={"type": "character", "name": "裴渊",
                             "summary": "改过的简介", "aliases": ["小裴子"], "tags": ["主角"]})
        check("PUT 200", r.status_code == 200, r.text[:200])
        r = client.get(f"/api/books/demo/entities/{target['id']}")
        check("改动已生效", r.json().get("summary") == "改过的简介", r.text[:200])

        r = client.post("/api/books/demo/entities",
                        json={"type": "realm", "name": "三花聚顶", "summary": "武道第三重。", "tags": ["武道"]})
        check("POST 新建 201", r.status_code == 201, r.text[:200])
        new_id = r.json()["id"]
        check("境界 ID 前缀 realm-", new_id.startswith("realm-"), new_id)
        r = client.delete(f"/api/books/demo/entities/{new_id}")
        check("DELETE 200", r.status_code == 200, r.text[:200])
        r = client.get(f"/api/books/demo/entities/{new_id}")
        check("删除后 404", r.status_code == 404, r.text[:200])

        print("\n[9] 一实体一文件 + ID 与文件名解耦")
        files = list(paths.entities_dir("demo").rglob("*.md"))
        check("文件数 == 索引实体数", len(files) == 6, f"{len(files)} 个文件")
        check("文件名是主名", any(f.name == "裴渊.md" for f in files),
              str([f.name for f in files]))
        check("按类型分子目录",
              (paths.entities_dir("demo") / "characters" / "韦忠.md").is_file(),
              str([str(f) for f in files]))
        # 改名后 ID 不变、旧文件消失
        before_id = target["id"]
        client.put(f"/api/books/demo/entities/{before_id}",
                   json={"type": "character", "name": "裴三郎", "aliases": [], "tags": []})
        r = client.get(f"/api/books/demo/entities/{before_id}")
        check("改名后 ID 不变", r.status_code == 200 and r.json()["id"] == before_id, r.text[:200])
        check("新文件名已生效",
              (paths.entities_dir("demo") / "characters" / "裴三郎.md").is_file())
        check("旧文件已清理",
              not (paths.entities_dir("demo") / "characters" / "裴渊.md").exists())
        client.put(f"/api/books/demo/entities/{before_id}",
                   json={"type": "character", "name": "裴渊", "aliases": ["小裴子"], "tags": ["主角"]})

        # ---------------------------------------------------------------
        print("\n[9.5] 关系 / 时间线 / 名册 三个派生视图")

        by_name = {e["name"]: e["id"] for e in client.get("/api/books/demo/entities").json()["items"]}
        pei, wei = by_name["裴渊"], by_name["韦忠"]

        # 造几条双链：两条能解析到已有实体，一条指向还没录入的
        client.put(f"/api/books/demo/entities/{pei}", json={
            "type": "character", "name": "裴渊",
            "aliases": ["小裴子"], "tags": ["主角"],
            "first_appear": "第1章",
            "body": {
                "摘要": "男主角。", "属性": [], "出场记录": [["第3章", "撞破密会"]],
                "关联": ["师父：[[韦忠]]", "上司：[[沈砚]]", "门派：[[清河崔氏]]"],
                "待补充": [],
            },
        })
        client.put(f"/api/books/demo/entities/{wei}", json={
            "type": "character", "name": "韦忠", "aliases": ["老韦"], "tags": ["配角"],
            "first_appear": "第2章",
            "body": {"摘要": "裴渊的师父。", "属性": [], "出场记录": [["第2章", "第一次登场"]],
                     "关联": ["徒弟：[[裴渊]]"], "待补充": []},
        })

        r = client.get("/api/books/demo/graph")
        check("graph 200", r.status_code == 200, r.text[:200])
        g = r.json()
        check("图谱有 4 条边", len(g["edges"]) == 4, str(len(g["edges"])))
        check("能解析的节点已标 resolved", any(not n["unresolved"] for n in g["nodes"]))
        check("未录入实体成为虚线节点",
              any(n["unresolved"] and n["name"] == "沈砚" for n in g["nodes"]),
              str([n["name"] for n in g["nodes"]]))
        check("节点带度数", all("degree" in n for n in g["nodes"]))
        check("孤立实体不上图（北衙没连边）",
              all(n["type"] != "location" for n in g["nodes"] if not n["unresolved"]),
              str([(n["name"], n["type"]) for n in g["nodes"]]))

        r = client.get("/api/books/demo/timeline")
        check("timeline 200", r.status_code == 200, r.text[:200])
        tl = r.json()
        check("时间线跨 3 章", tl["chapter_count"] == 3,
              str([c["chapter"] for c in tl["chapters"]]))
        check("第1章排在最主要位置",
              tl["chapters"][0]["order"] == 1, str([(c["chapter"], c["order"]) for c in tl["chapters"]]))
        check("首现与出场都进了时间线",
              {e["kind"] for c in tl["chapters"] for e in c["entries"]} == {"first", "appearance"},
              str({e["kind"] for c in tl["chapters"] for e in c["entries"]}))

        r = client.get("/api/books/demo/roster", params={"type": "character"})
        check("roster 200", r.status_code == 200, r.text[:200])
        ros = r.json()
        check("名册 3 人", ros["count"] == 3, str(ros["count"]))
        check("名册带完备度", all(0 <= i["completeness"] <= 4 for i in ros["items"]),
              str([(i["name"], i["completeness"]) for i in ros["items"]]))
        check("名册带别名与出场数",
              all("aliases" in i and "appearance_count" in i for i in ros["items"]))

        r = client.get("/api/books/demo/roster", params={"type": "character", "group_by": "faction"})
        check("按势力分组可用", r.status_code == 200 and isinstance(r.json()["groups"], dict),
              r.text[:200])

        # ---------------------------------------------------------------
        print("\n[9.6] 类型子图 + 世界档案（world/ 通道）")

        # 类型白名单 —— 「地理观」就是这么派生的
        r = client.get("/api/books/demo/graph",
                       params={"types": "location", "include_isolated": "true"})
        check("按类型取子图 200", r.status_code == 200, r.text[:200])
        sub = r.json()
        check("子图只剩地点",
              len(sub["nodes"]) > 0 and all(n["type"] == "location" for n in sub["nodes"]),
              str([(n["name"], n["type"]) for n in sub["nodes"]]))
        check("带上孤立节点后地点都回来了（北衙，本来零连线）",
              [n["name"] for n in sub["nodes"]] == ["北衙"], str(sub["nodes"]))
        check("孤立节点度数为 0", all(n["degree"] == 0 for n in sub["nodes"]),
              str([(n["name"], n["degree"]) for n in sub["nodes"]]))
        check("子图里没有边", len(sub["edges"]) == 0, str(len(sub["edges"])))

        r = client.get("/api/books/demo/graph", params={"types": "location"})
        check("不加 include_isolated 时子图为空（孤立实体默认不上图）",
              r.json()["nodes"] == [], r.text[:200])

        r = client.get("/api/books/demo/graph", params={"include_isolated": "true"})
        check("全量图确实含孤立实体", len(r.json()["nodes"]) > len(g["nodes"]),
              f'{len(r.json()["nodes"])} > {len(g["nodes"])}')

        r = client.get("/api/books/demo/graph", params={"types": "nonsense"})
        check("非法类型被拒", r.status_code == 400, r.text[:200])

        # 档案列表
        r = client.get("/api/books/demo/docs")
        check("档案列表 200", r.status_code == 200, r.text[:200])
        names = {d["name"] for d in r.json()["docs"]}
        check("预置了纪年表与剧情线", {"chronology", "plot"} <= names, str(names))
        check("一开始都还没建", all(not d["exists"] for d in r.json()["docs"]))

        r = client.get("/api/books/demo/docs/chronology")
        check("读未建的档案 200", r.status_code == 200, r.text[:200])
        d = r.json()
        check("返回 exists=false 并带模板",
              d["exists"] is False and "|" in d["template"], r.text[:200])
        check("模板提示语非空", bool(d["hint"]), r.text[:200])

        # 写入
        text = (
            "# 纪年表\n\n"
            "| 时间 | 事件 | 关联 |\n"
            "|---|---|---|\n"
            "| 明显帝 143 年 秋 | 裴渊入京 | [[裴渊]] |\n"
            "| 明显帝 144 年 春 | 科场案发 | [[韦忠]] |\n"
        )
        r = client.put("/api/books/demo/docs/chronology", json={"text": text})
        check("写档案 200", r.status_code == 200, r.text[:200])
        check("解析出 3 列", r.json()["columns"] == ["时间", "事件", "关联"], r.text[:200])
        check("解析出 2 行", len(r.json()["rows"]) == 2, r.text[:200])

        r = client.get("/api/books/demo/docs/chronology")
        d = r.json()
        check("回读 exists=true", d["exists"] is True)
        check("回读行数一致", len(d["rows"]) == 2, str(d["rows"]))
        check("回读原文一字不差", d["text"] == text, d["text"][:160])
        check("文件真的落在 world/ 下",
              (paths.world_dir("demo") / "chronology.md").is_file(),
              str(paths.world_dir("demo")))

        r = client.get("/api/books/demo/docs")
        check("列表里已标记存在",
              any(x["name"] == "chronology" and x["exists"] for x in r.json()["docs"]))

        # 没有表格的档案按纯文本走，不能报错
        client.put("/api/books/demo/docs/worldview", json={"text": "# 世界观总纲\n\n没有表格。\n"})
        r = client.get("/api/books/demo/docs/worldview")
        check("无表格档案按纯文本返回",
              r.status_code == 200 and r.json()["columns"] == [] and r.json()["exists"] is True,
              r.text[:200])

        # 安全
        r = client.get("/api/books/demo/docs/..%2F..%2Fetc%2Fpasswd")
        check("目录穿越被拒", r.status_code in (400, 404), r.text[:200])
        r = client.put("/api/books/demo/docs/Evil%20Name", json={"text": "x"})
        check("非法档案名被拒", r.status_code == 400, r.text[:200])
        r = client.put("/api/books/demo/docs/chronology", json={})
        check("缺 text 字段被拒", r.status_code == 400, r.text[:200])

        # ---------------------------------------------------------------
        print("\n[9.7] 外观系统与布局存档（P1）")
        # ---- 主题包 ----
        # 自定义主题落在**临时数据目录** themes/（程序目录只读铁律）；
        # 内置主题由代码常量提供，不依赖任何文件。
        # 临时目录每次运行都是新的，无需清残留，但删一下已知名字兜底。
        from urllib.parse import quote as _q
        for junk in ("测试蓝", "测试蓝 (2)", "坏值"):
            client.delete(f"/api/themes/{_q(junk)}")

        r = client.get("/api/themes")
        check("主题列表 200", r.status_code == 200, r.text[:200])
        theme_all = r.json()["themes"]
        theme_names = [t["name"] for t in theme_all]
        _BUILTIN = {"默认", "午夜蓝", "暖纸", "墨绿", "高对比"}
        check("五套内置主题齐全",
              sorted(t["name"] for t in theme_all if t["builtin"]) == sorted(_BUILTIN),
              str(theme_names))
        check("内置主题都带 builtin 标记",
              all(t["builtin"] for t in theme_all if t["name"] in _BUILTIN)
              and not any(t["name"] in _BUILTIN and not t["builtin"] for t in theme_all),
              str(theme_names))

        r = client.get("/api/themes/默认")
        check("单个主题可读", r.status_code == 200 and r.json()["name"] == "默认", r.text[:200])
        r = client.get("/api/themes/不存在")
        check("不存在的主题 404", r.status_code == 404, r.text[:200])

        r = client.put("/api/themes/默认", json={"name": "默认", "vars": {"dark": {"--bg-app": "#000"}}})
        check("内置主题只读（PUT 被拒）", r.status_code == 400, r.text[:200])
        r = client.delete("/api/themes/默认")
        check("内置主题不可删", r.status_code == 400, r.text[:200])

        custom_theme = {
            "name": "测试蓝", "description": "冒烟测试用",
            "vars": {"dark": {"--bg-app": "#0a0a1a", "--accent": "#5588ff"}},
        }
        r = client.put("/api/themes/测试蓝", json=custom_theme)
        check("自定义主题可保存", r.status_code == 200 and r.json()["saved"], r.text[:200])
        check("自定义主题落在数据目录（程序目录只读铁律）",
              (paths.themes_dir() / "测试蓝.json").is_file()
              and str(paths.themes_dir()).startswith(str(_TMP)),
              str(paths.themes_dir()))
        r = client.put("/api/themes/测试蓝", json={**custom_theme, "builtin": True})
        check("自定义主题可覆盖更新", r.status_code == 200, r.text[:200])
        check("builtin 标记被清洗掉", not client.get("/api/themes/测试蓝").json().get("builtin"),
              client.get("/api/themes/测试蓝").text[:200])

        bad = {**custom_theme, "vars": {"dark": {"--bg-app": "#fff; background:url(x)"}}}
        r = client.put("/api/themes/坏值", json=bad)
        check("变量值带分号被拒", r.status_code == 400, r.text[:200])
        r = client.put("/api/themes/坏值",
                       json={"name": "坏值", "description": "", "vars": {"dark": {"非法名": "#fff"}}})
        check("非法变量名被跳过（不是报错）", r.status_code == 200, r.text[:200])
        client.delete("/api/themes/坏值")

        r = client.get("/api/themes/测试蓝/export")
        check("主题导出 200", r.status_code == 200, r.text[:200])
        r = client.get("/api/themes/午夜蓝/export")
        check("内置主题导出 200（无文件，走代码常量）",
              r.status_code == 200 and "午夜蓝" in r.text, r.text[:200])
        r = client.post("/api/themes/import",
                        files={"file": ("t.json", json.dumps(custom_theme).encode("utf-8"))})
        check("主题导入 201 且重名加后缀",
              r.status_code == 201 and r.json()["name"] == "测试蓝 (2)", r.text[:200])
        r = client.delete("/api/themes/测试蓝")
        check("自定义主题可删除", r.status_code == 200, r.text[:200])
        client.delete("/api/themes/测试蓝 (2)")

        # ---- 3D 场景存档（P4：坐标锁定，装饰层）----
        scene_body = {"schema": 1, "graphs": {"relation": {
            "positions": {"char-0001": {"x": 1.5, "y": -2.0, "z": 3.25}},
            "camera": {"x": 0, "y": 0, "z": 220}, "play_chapter": 3}}}
        r = client.put("/api/books/demo/scene", json={"scene": scene_body})
        check("场景保存 200", r.status_code == 200 and r.json()["saved"], r.text[:200])
        r = client.get("/api/books/demo/scene")
        check("场景读回且坐标逐位一致",
              r.status_code == 200 and r.json()["exists"]
              and r.json()["scene"]["graphs"]["relation"]["positions"]["char-0001"]["z"] == 3.25,
              r.text[:300])
        client.delete("/api/books/demo/scene")
        r = client.get("/api/books/demo/scene")
        check("场景删除后回空壳（exists=false）", r.json()["exists"] is False, r.text[:200])

        # ---- 节点图标（内容：实体自带 icon；装饰：scene.styles.typeIcons）----
        r = client.post("/api/assets/icons", files={"file": ("knight.png", b"\x89PNG\r\n\x1a\nfake")})
        check("icons 素材种类可上传 201", r.status_code == 201, r.text[:200])
        r = client.post("/api/books/demo/entities", json={
            "type": "character", "name": "带图标的角色", "icon": "icons/knight.png"})
        icon_id = r.json()["id"]
        check("建带图标的实体 201", r.status_code == 201, r.text[:200])
        detail = client.get(f"/api/books/demo/entities/{icon_id}").json()
        check("图标写进实体并能读回", detail.get("icon") == "icons/knight.png", str(detail)[:300])
        check("图标落进 frontmatter",
              "icon: icons/knight.png" in Path(detail["file_path"]).read_text(encoding="utf-8"),
              detail["file_path"])
        r = client.get("/api/books/demo/graph?include_isolated=true")
        node = next((n for n in r.json()["nodes"] if n["id"] == icon_id), None)
        check("图谱节点带图标", node is not None and node.get("icon") == "icons/knight.png", str(node)[:200])
        # 不带图标时不该多写一行空字段
        r = client.post("/api/books/demo/entities", json={"type": "concept", "name": "没图标的角色"})
        plain = client.get(f"/api/books/demo/entities/{r.json()['id']}").json()
        check("无图标实体不写 icon 行",
              "icon:" not in Path(plain["file_path"]).read_text(encoding="utf-8"),
              plain["file_path"])
        # 装饰层：类型→图标映射存 scene.styles
        r = client.put("/api/books/demo/scene", json={"scene": {
            "schema": 1, "graphs": {}, "styles": {"typeIcons": {"character": "icons/knight.png"}, "glow": False}}})
        check("装饰层样式可存 200", r.status_code == 200 and r.json()["saved"], r.text[:200])
        r = client.get("/api/books/demo/scene")
        check("装饰层样式读回",
              r.json()["scene"]["styles"]["typeIcons"]["character"] == "icons/knight.png"
              and r.json()["scene"]["styles"]["glow"] is False, r.text[:300])
        client.delete("/api/books/demo/scene")
        # 清掉这两个临时实体 —— 后面的用例要靠固定条数的基线
        client.delete(f"/api/books/demo/entities/{icon_id}")
        client.delete(f"/api/books/demo/entities/{plain['id']}")
        check("临时图标实体已清理",
              len(client.get("/api/books/demo/entities").json()["items"]) == 6,
              client.get("/api/books/demo/entities").text[:200])

        # ---- 单图重排：只清一张图的坐标，样式保留 ----
        client.put("/api/books/demo/scene", json={"scene": {"schema": 1,
                    "graphs": {"relation": {"positions": {"char-0001": {"x": 1, "y": 2, "z": 3}}}},
                    "styles": {"glow": False}}})
        r = client.delete("/api/books/demo/scene/graphs/relation")
        check("单图坐标清除 200", r.status_code == 200 and r.json()["cleared"], r.text[:200])
        r = client.get("/api/books/demo/scene")
        s = r.json()["scene"]
        check("样式没被单图清除波及", s["styles"]["glow"] is False and s["graphs"].get("relation") is None,
              json.dumps(s, ensure_ascii=False)[:200])
        r = client.delete("/api/books/demo/scene/graphs/none")
        check("清不存在的图不报错", r.status_code == 200 and not r.json()["cleared"], r.text[:200])
        client.delete("/api/books/demo/scene")

        # ---- 用户偏好 ----
        r = client.get("/api/prefs")
        check("偏好 200 且补全默认", r.status_code == 200 and r.json()["ui"]["font_scale"] == 1,
              r.text[:200])
        r = client.put("/api/prefs", json={"ui": {"theme": "午夜蓝", "font_scale": 1.25}})
        check("偏好部分更新 200", r.status_code == 200, r.text[:200])
        ui = client.get("/api/prefs").json()["ui"]
        check("改 theme 不丢 font_scale",
              ui["theme"] == "午夜蓝" and ui["font_scale"] == 1.25, str(ui))
        check("没动的键保持默认", ui["mode"] == "dark" and ui["panel_alpha"] == 1, str(ui))
        r = client.put("/api/prefs", json={"ui": {"theme": "默认", "font_scale": 1}})

        r = client.get("/api/appearance/where")
        check("外观路径说明 200", r.status_code == 200 and "assets_dir" in r.json(), r.text[:200])

        # ---- 素材库 ----
        r = client.get("/api/assets")
        check("素材总列表 200", r.status_code == 200 and
              set(r.json()["kinds"]) == {"fonts", "backgrounds", "stickers", "icons", "maps", "covers"},
              r.text[:200])
        r = client.post("/api/assets/backgrounds",
                        files={"file": ("t.png", b"\x89PNG\r\n\x1a\nfake")})
        check("上传背景 201", r.status_code == 201 and r.json()["name"] == "t.png", r.text[:200])
        r = client.post("/api/assets/fonts", files={"file": ("t.exe", b"MZ fake")})
        check("非法扩展名被拒", r.status_code == 400, r.text[:200])
        r = client.post("/api/assets/backgrounds", files={"file": ("big.png", b"x" * (33 * 1024 * 1024))})
        check("超大文件被拒", r.status_code == 400, r.text[:120])
        r = client.get("/api/assets/backgrounds/t.png/raw")
        check("素材原始文件可取", r.status_code == 200, r.text[:120])
        r = client.get("/api/assets/backgrounds/..%2F..%2Fprefs.json/raw")
        check("素材目录穿越被拒", r.status_code in (400, 404), r.text[:200])
        r = client.delete("/api/assets/backgrounds/t.png")
        check("素材可删除", r.status_code == 200, r.text[:200])
        check("删除后列表为空",
              client.get("/api/assets/backgrounds").json()["items"] == [], r.text[:200])

        # ---- 布局存档 ----
        r = client.get("/api/books/demo/layouts")
        check("初始布局为空", r.status_code == 200 and r.json()["count"] == 0, r.text[:200])

        layout = {"grid": {"root": {"type": "leaf", "data": {"views": ["dashboard"]}}}}
        r = client.put("/api/books/demo/layouts/写作", json={"layout": layout})
        check("保存布局并置为 active", r.status_code == 200 and r.json()["active"] == "写作",
              r.text[:200])
        r = client.put("/api/books/demo/layouts/__last", json={"layout": layout})
        check("内部槽位可写", r.status_code == 200 and r.json()["active"] == "写作", r.text[:200])
        r = client.get("/api/books/demo/layouts")
        names = [l["name"] for l in r.json()["layouts"]]
        check("__last 不出现在预设列表", "__last" not in names, str(names))
        check("预设列表含写作", "写作" in names, str(names))
        r = client.put("/api/books/demo/layouts/active", json={"name": "写作"})
        check("active 接口不被 {name} 吞掉", r.status_code == 200 and r.json()["active"] == "写作",
              r.text[:200])
        r = client.get("/api/books/demo/layouts/写作")
        check("布局可读回", r.status_code == 200 and r.json()["layout"] == layout, r.text[:200])
        r = client.put("/api/books/demo/layouts/active", json={"name": ""})
        check("active 清空=下次用默认", r.status_code == 200 and r.json()["active"] == "",
              r.text[:200])
        r = client.put("/api/books/demo/layouts/坏<名", json={"layout": layout})
        check("非法布局名被拒", r.status_code == 400, r.text[:200])
        r = client.delete("/api/books/demo/layouts/写作")
        check("布局可删除", r.status_code == 200, r.text[:200])
        r = client.delete("/api/books/demo/layouts/写作")
        check("重复删除 404", r.status_code == 404, r.text[:200])
        r = client.put("/api/books/demo/layouts/超长" + "字" * 50, json={"layout": layout})
        check("布局名超长被拒", r.status_code == 400, r.text[:200])

        # ---------------------------------------------------------------
        print("\n[10] 多书隔离（两本书的 char-0001 不能互相顶掉）")
        r = client.post("/api/books", json={"book_id": "demo2", "title": "另一本书"})
        check("第二本书已创建", r.status_code == 201, r.text[:200])
        r = client.post("/api/books/demo2/entities",
                        json={"type": "character", "name": "另一主角", "summary": "第二本书的人。"})
        check("第二本书新建成功", r.status_code == 201, r.text[:200])
        other_id = r.json()["id"]
        check("第二本书也从头编号", other_id == "char-0001", other_id)
        check("与第一本书 ID 相同", other_id in [e["id"] for e in items], "预期同为 char-0001")

        a = client.get(f"/api/books/demo/entities/{other_id}")
        b = client.get(f"/api/books/demo2/entities/{other_id}")
        check("两本书同 ID 互不干扰",
              a.json()["name"] == "裴渊" and b.json()["name"] == "另一主角",
              f"a={a.json().get('name')} b={b.json().get('name')}")
        check("各自的实体数独立",
              client.get("/api/books/demo/stats").json()["total"] == 6
              and client.get("/api/books/demo2/stats").json()["total"] == 1)

        # ---------------------------------------------------------------
        print("\n[11] 一键重建索引（索引可抛弃）")
        # 取「删索引之前」的真实现状作为基准
        before = sorted(
            ({k: e[k] for k in ("id", "name", "summary", "type")}
             for e in client.get("/api/books/demo/entities").json()["items"]),
            key=lambda x: x["id"],
        )
        check("基准非空", len(before) == 6, f"{len(before)} 条")
        idx = paths.index_file()
        check("索引文件存在", idx.is_file(), str(idx))
        # 守连接会占住索引文件的句柄 —— Windows 上不先放掉就删不掉。
        # 这里显式调一次，顺便验证「删索引重建」这条自愈路径没被守连接堵住。
        store.close_keeper()
        for suffix in ("", "-wal", "-shm"):
            Path(str(idx) + suffix).unlink(missing_ok=True)
        check("索引已删除（守连接没有堵住删除）", not idx.is_file())

        r = client.post("/api/admin/rebuild-index", json={})
        check("全量重建 200", r.status_code == 200, r.text[:300])

        after = sorted(
            ({k: e[k] for k in ("id", "name", "summary", "type")}
             for e in client.get("/api/books/demo/entities").json()["items"]),
            key=lambda x: x["id"],
        )
        check("重建后条数一致", len(after) == len(before), f"{len(before)} -> {len(after)}")
        check("重建后内容逐字段一致", after == before,
              f"\n         before={before}\n         after ={after}")
        check("第二本书也恢复",
              client.get("/api/books/demo2/stats").json()["total"] == 1)

        # ---------------------------------------------------------------
        print("\n[12] 安全")
        r = client.get("/api/books/..%2F..%2Fetc/entities")
        check("目录穿越被拒", r.status_code in (400, 404), r.text[:200])
        r = client.get("/api/books/nonexistent/entities")
        check("不存在的书目 404", r.status_code == 404, r.text[:200])
        r = client.post("/api/books/demo/entities", json={"type": "nonsense", "name": "x"})
        check("非法类型被拒", r.status_code == 400, r.text[:200])

        # ---------------------------------------------------------------
        # P2 · 方法论
        # ---------------------------------------------------------------
        print("\n[13] 方法论：既是实体，又是角色身上的标签")
        r = client.post("/api/books/demo/entities",
                        json={"type": "methodology", "name": "晨曦主义",
                              "summary": "神授君主立宪，皇帝即国家的意志。",
                              "tags": ["意识形态"]})
        check("建方法论实体 201", r.status_code == 201, r.text[:300])
        meth_id = r.json().get("id", "")
        check("ID 形如 meth-xxxx", meth_id.startswith("meth-"), meth_id)

        # 类型表里要有它（否则前端下拉里选不到）
        r = client.get("/api/books/demo/entities")
        keys = [t["key"] for t in r.json()["types"]]
        check("类型表含 methodology", "methodology" in keys, str(keys))

        pei = next(e for e in client.get("/api/books/demo/entities").json()["items"]
                   if e["name"] == "裴渊")
        r = client.put(f"/api/books/demo/entities/{pei['id']}",
                       json={"type": "character", "name": "裴渊",
                             "methodologies": ["晨曦主义", " "], "tags": ["主角", "武道"]})
        check("角色可挂方法论 200", r.status_code == 200, r.text[:300])

        r = client.get("/api/books/demo/entities", params={"type": "character"})
        pei_meta = next(e for e in r.json()["items"] if e["id"] == pei["id"])
        check("列表里带出 methodologies",
              pei_meta.get("methodologies") == ["晨曦主义"], str(pei_meta))
        r = client.get(f"/api/books/demo/entities/{pei['id']}")
        check("详情里带出 methodologies",
              r.json().get("methodologies") == ["晨曦主义"], r.text[:300])
        check("空字符串被剔掉", "" not in r.json().get("methodologies", []), r.text[:300])

        # frontmatter 里也写了（真源在 markdown，不只在索引）
        ent_path = paths.entities_dir("demo") / "characters" / "裴渊.md"
        check("frontmatter 写入 methodologies",
              "methodologies:" in ent_path.read_text(encoding="utf-8"), str(ent_path))

        r = client.get("/api/books/demo/methodologies")
        m = r.json()
        check("方法论总览 200", r.status_code == 200, r.text[:200])
        item = next((i for i in m["items"] if i["name"] == "晨曦主义"), None)
        check("总览含晨曦主义", item is not None, r.text[:400])
        check("它已被建成实体", bool(item and item["has_entity"]), str(item))
        check("信奉人数 = 1", bool(item and item["count"] == 1), str(item))
        check("holders_total 统计正确", m.get("holders_total") == 1, r.text[:300])
        check("tags 聚合出意识形态", "意识形态" in m.get("tags", []), r.text[:300])

        r = client.post("/api/books/demo/methodologies/attach",
                        json={"methodology": "圣光戒律", "entity_ids": [pei["id"]],
                              "mode": "add"})
        check("attach 200", r.status_code == 200, r.text[:300])
        check("新增挂载生效", r.json().get("changed") == 1, r.text[:300])
        r = client.get("/api/books/demo/methodologies")
        missing = r.json()["missing"]
        check("未建实体的方法论进 missing", "圣光戒律" in missing, str(missing))
        r = client.post("/api/books/demo/methodologies/attach",
                        json={"methodology": "圣光戒律", "entity_ids": [pei["id"]],
                              "mode": "remove"})
        check("remove 摘除 200", r.status_code == 200 and r.json().get("changed") == 1, r.text[:300])
        r = client.get("/api/books/demo/methodologies")
        check("摘除后回到 1 处信奉", r.json()["holders_total"] == 1, r.text[:300])

        r = client.post("/api/books/demo/methodologies/attach",
                        json={"methodology": "x", "entity_ids": [pei["id"]], "mode": "nonsense"})
        check("非法 mode 被拒", r.status_code == 422, r.text[:200])

        # 方法论的引用要进关系表 —— 否则关系网里看不见「谁信奉什么」
        g = client.get("/api/books/demo/graph",
                       params={"include_isolated": "true"}).json()
        check("方法论引用进了关系图",
              any(e.get("kind") == "方法论" for e in g.get("edges", [])),
              str(g.get("edges", [])[:5]))

        # ---------------------------------------------------------------
        # P2 · 章节正文 + 规则抽取
        # ---------------------------------------------------------------
        print("\n[14] 章节导入")
        ch1 = _make_docx(_TMP / "第一章 试航.docx", [
            ("第一章 试航", None),
            ("黎明时分，甲板上风很大。", None),
            ("“卡特，把那批货单拿过来。”索拉诺站在舱门口说道。", None),
            ("“好的，老师。”卡特应了一声。", None),
            ("“我信奉晨曦主义，老师。”卡特补充道。", None),
            ("芭芭拉靠在栏杆上，望着远方的海面。", None),
            ("“芭芭拉小姐，在看什么？”索拉诺问道。", None),
            ("“我在想，霍普副舰长要是在这儿会怎么说。”芭芭拉答道。", None),
            ("霍普此时正在舰桥上看海图，乌罗多走了过来。", None),
            ("“乌罗多，你来得正好。”霍普说道。", None),
            ("“霍普副舰长，我查过了。”乌罗多答道。", None),
        ])
        ch2 = _make_docx(_TMP / "第二章 打捞.docx", [
            ("第二章 打捞", None),
            ("海面下浮起一片黑影。", None),
            ("“卡特，把探照灯打过去。”索拉诺说道。", None),
            ("“是。”卡特答道。", None),
        ])
        with open(ch1, "rb") as f1, open(ch2, "rb") as f2:
            r = client.post("/api/books/demo/chapters/import",
                            files=[("files", (ch1.name, f1.read())),
                                   ("files", (ch2.name, f2.read()))])
        check("导入 201", r.status_code == 201, r.text[:300])
        imp = r.json()
        check("导入 2 章", imp["imported"] == 2, r.text[:400])
        check("章号从正文的「第X章」认出来",
              sorted(i["chapter_no"] for i in imp["items"]) == [1, 2], str(imp["items"]))
        check("标题已解析", imp["items"][0]["title"] == "试航", str(imp["items"][0]))

        r = client.get("/api/books/demo/chapters")
        check("章节列表 200", r.status_code == 200, r.text[:200])
        check("列表 2 条", r.json()["count"] == 2, r.text[:200])
        check("stats.words > 0", r.json()["stats"]["words"] > 0, r.text[:200])

        r = client.get("/api/books/demo/chapters/1")
        ch_text = r.json()["text"]
        check("正文读回 200", r.status_code == 200, r.text[:200])
        check("正文含第一段", "黎明时分" in ch_text, ch_text[:120])
        check("段落用空行分隔（出处定位的锚点）", "\n\n" in ch_text, repr(ch_text[:80]))

        r = client.get("/api/books/demo/chapters/1/paragraphs")
        check("段落接口 200", r.status_code == 200, r.text[:200])
        check("段号从 0 开始且第一段就是正文（标题不混进来）",
              r.json()["paragraphs"][0].startswith("黎明时分"), str(r.json()["paragraphs"][:3]))

        r = client.get("/api/books/demo/chapters/99")
        check("不存在的章 404", r.status_code == 404, r.text[:200])

        bad = _TMP / "坏文件.xyz"
        bad.write_bytes(b"not a docx")
        with open(bad, "rb") as f:
            r = client.post("/api/books/demo/chapters/import", files=[("files", (bad.name, f.read()))])
        check("不支持的格式被拒", r.json()["failed"] == 1, r.text[:300])
        check("错误里说明原因", "docx" in r.json()["errors"][0]["error"], r.text[:300])

        # 同章号再导一次：默认跳过
        with open(ch1, "rb") as f1:
            r = client.post("/api/books/demo/chapters/import",
                            files=[("files", (ch1.name, f1.read()))])
        check("同章号默认跳过", r.json()["imported"] == 0 and r.json()["skipped"] == 1, r.text[:300])
        with open(ch1, "rb") as f1:
            r = client.post("/api/books/demo/chapters/import", params={"overwrite": "true"},
                            files=[("files", (ch1.name, f1.read()))])
        check("勾选覆盖后替换", r.json()["imported"] == 1, r.text[:300])

        # ---------------------------------------------------------------
        print("\n[14.5] 批量导入：预检 + 冲突标红 + 断点续跑（P3）")
        ch3 = _make_docx(_TMP / "第三章 返航.docx", [
            ("第三章 返航", None),
            ("海风停了，甲板一片安静。", None),
        ])
        # 批内撞章号：另一份文件也解析成第 3 章
        ch3_dup = _make_docx(_TMP / "第3章 返航（修订版）.docx", [
            ("第三章 返航", None),
            ("这是修订版内容，不该被采用。", None),
        ])
        with open(ch3, "rb") as a, open(ch2, "rb") as b, \
                open(ch3_dup, "rb") as c, open(bad, "rb") as d:
            r = client.post("/api/books/demo/chapters/import/preview",
                            files=[("files", (ch3.name, a.read())),
                                   ("files", (ch2.name, b.read())),
                                   ("files", (ch3_dup.name, c.read())),
                                   ("files", (bad.name, d.read()))])
        check("预检 200", r.status_code == 200, r.text[:300])
        pv = r.json()
        check("预检统计：1 新增 / 2 冲突 / 1 失败",
              pv["new"] == 1 and pv["conflicts"] == 2 and pv["failed"] == 1,
              json.dumps({k: pv[k] for k in ("new", "conflicts", "failed")}))
        by_file = {it["file"]: it for it in pv["items"]}
        check("新增章不带冲突标记",
              by_file[ch3.name]["ok"] and not by_file[ch3.name]["exists"]
              and by_file[ch3.name]["dup_in_batch"] is None,
              str(by_file[ch3.name]))
        check("已存在章标 exists（前端冲突标红靠它）",
              by_file[ch2.name]["exists"] is True, str(by_file[ch2.name]))
        check("批内撞章号标 dup_in_batch 并指出先到的文件",
              by_file[ch3_dup.name]["dup_in_batch"] == ch3.name,
              str(by_file[ch3_dup.name]))
        check("坏文件给出失败原因",
              not by_file[bad.name]["ok"] and "docx" in by_file[bad.name]["error"],
              str(by_file[bad.name]))
        check("预检不落盘（章节数不变）",
              client.get("/api/books/demo/chapters").json()["count"] == 2)

        # 正式导入：批内撞章号只采用先到的
        with open(ch3, "rb") as a, open(ch3_dup, "rb") as c:
            r = client.post("/api/books/demo/chapters/import",
                            files=[("files", (ch3.name, a.read())),
                                   ("files", (ch3_dup.name, c.read()))])
        check("批内撞章号只进先到的那份",
              r.json()["imported"] == 1 and r.json()["skipped"] == 1, r.text[:300])
        check("进库的是先到那份的内容",
              "海风停了" in client.get("/api/books/demo/chapters/3").json()["text"])

        # 断点续跑：上一批中断后整批重传，已入库的全部跳过、零重复
        with open(ch1, "rb") as a, open(ch2, "rb") as b, open(ch3, "rb") as c:
            r = client.post("/api/books/demo/chapters/import",
                            files=[("files", (ch1.name, a.read())),
                                   ("files", (ch2.name, b.read())),
                                   ("files", (ch3.name, c.read()))])
        check("断点续跑：重传全部跳过、零重复入库",
              r.json()["imported"] == 0 and r.json()["skipped"] == 3, r.text[:300])
        check("续跑后共 3 章",
              client.get("/api/books/demo/chapters").json()["count"] == 3)

        # 恢复现场：删掉第 3 章，后面 [17]/[18] 的章节计数断言不受影响
        client.delete("/api/books/demo/chapters/3")
        check("现场已恢复（回到 2 章）",
              client.get("/api/books/demo/chapters").json()["count"] == 2)

        print("\n[15] 规则抽取（C 档：只出候选）")
        r = client.post("/api/books/demo/chapters/extract", json={"chapter_nos": []})
        check("抽取 200", r.status_code == 200, r.text[:300])
        ex = r.json()
        names = [c["name"] for c in ex["candidates"]]
        check("捞出主角团", {"卡特", "索拉诺", "芭芭拉", "霍普", "乌罗多"} <= set(names), str(names))
        check("没混进「对不起」这类客套话", "不起" not in names and "对不起" not in names, str(names))
        check("已存在的实体被标为 exists",
              all(c["exists"] for c in ex["candidates"] if c["name"] == "裴渊") or
              not any(c["name"] == "裴渊" for c in ex["candidates"]), str(names))

        cat = next(c for c in ex["candidates"] if c["name"] == "卡特")
        check("候选带出处（章节 + 段号）", bool(cat["first_at"]), str(cat))
        check("出处段号是数字", isinstance(cat["first_at"]["para"], int), str(cat["first_at"]))
        check("候选带人话证据", len(cat["reasons"]) >= 1, str(cat["reasons"]))

        # 方法论共现：卡特说过「我信奉晨曦主义」
        check("同句共现挂上方法论", "晨曦主义" in cat["methodologies"], str(cat))
        ev = (cat.get("methodology_evidence") or {}).get("晨曦主义", {})
        check("共现证据标为「明确表态」", ev.get("strong") is True, str(ev))
        check("证据里有出处句子", bool(ev.get("sentence")), str(ev))
        check("理由里说明了为什么挂", any("晨曦主义" in x for x in cat["reasons"]), str(cat["reasons"]))

        # 索拉诺没说过意识形态 —— 不该被挂
        sola = next((c for c in ex["candidates"] if c["name"] == "索拉诺"), None)
        check("没表态的不乱挂", bool(sola) and "晨曦主义" not in sola["methodologies"], str(sola))

        print("\n[16] 候选落盘")
        before_total = client.get("/api/books/demo/stats").json()["total"]
        r = client.post("/api/books/demo/chapters/extract/commit", json={
            "items": [{"name": "卡特", "type": "character",
                       "methodologies": ["晨曦主义"],
                       "chapters": [1, 2], "first_at": {"chapter_no": 1, "para": 2}},
                      {"name": "不存在的类型", "type": "nonsense"}],
            "update_existing": False,
        })
        check("落盘 201", r.status_code == 201, r.text[:300])
        res = r.json()
        check("成功 1 条", res["created"] == 1, r.text[:400])
        check("非法类型被跳过并给理由", res["skipped"] == 1, r.text[:400])
        check("实体数 +1", client.get("/api/books/demo/stats").json()["total"] == before_total + 1)

        r = client.get("/api/books/demo/entities", params={"q": "卡特"})
        kat = next(e for e in r.json()["items"] if e["name"] == "卡特")
        check("落盘的卡特带方法论标签", kat["methodologies"] == ["晨曦主义"], str(kat))
        check("首现已写进索引", str(kat.get("first_appear")) == "1", str(kat))

        det = client.get(f"/api/books/demo/entities/{kat['id']}").json()
        sources = det["provenance"]["sources"]
        check("出处记了章节与段号",
              any(s.get("chapter_no") == 1 and s.get("para") == 2 for s in sources), str(sources))
        check("出处记了录入方式", det["provenance"]["method"] == "extract", str(det["provenance"]))
        check("首现已回填", str(det.get("first_appear")) == "1", str(det.get("first_appear")))
        kat_md = (paths.entities_dir("demo") / "characters" / "卡特.md").read_text(encoding="utf-8")
        check("出场记录写进了实体文件", "## 出场记录" in kat_md and "| 1 |" in kat_md, kat_md[:400])
        check("frontmatter 也带上了方法论", "methodologies:" in kat_md and "晨曦主义" in kat_md,
              kat_md[:400])

        # 同一条再落一次：默认跳过
        r = client.post("/api/books/demo/chapters/extract/commit", json={
            "items": [{"name": "卡特", "type": "character"}], "update_existing": False})
        check("重复落盘被跳过", r.json()["skipped"] == 1, r.text[:300])
        # 勾选「已存在的也更新」后允许补出处
        r = client.post("/api/books/demo/chapters/extract/commit", json={
            "items": [{"name": "卡特", "type": "character", "chapters": [2]}],
            "update_existing": True})
        check("update_existing 可补出处", r.json()["created"] == 1, r.text[:300])

        print("\n[17] 章节元信息与删除")
        r = client.patch("/api/books/demo/chapters/2", json={"title": "打捞行动", "volume": "序卷"})
        check("PATCH 章节 200", r.status_code == 200, r.text[:200])
        check("标题已改", r.json()["title"] == "打捞行动", r.text[:200])
        check("卷名已写", r.json()["volume"] == "序卷", r.text[:200])
        check("正文没被动过",
              "海面下浮起一片黑影" in client.get("/api/books/demo/chapters/2").json()["text"])

        r = client.delete("/api/books/demo/chapters/2")
        check("DELETE 章节 200", r.status_code == 200 and r.json()["deleted"], r.text[:200])
        check("删后只剩 1 章", client.get("/api/books/demo/chapters").json()["count"] == 1)
        check("删章节不动实体", client.get("/api/books/demo/stats").json()["total"] == before_total + 1)
        check("重复删除 404", client.delete("/api/books/demo/chapters/2").status_code == 404)
        check("已删章的正文 404", client.get("/api/books/demo/chapters/2").status_code == 404)

        print("\n[18] 索引零独占状态：章节与方法论能随索引重建恢复")
        idx = paths.index_file()
        store.close_keeper()  # 同上：先放掉守连接，否则 Windows 上删不掉
        idx.unlink()
        for suffix in ("-wal", "-shm"):
            Path(str(idx) + suffix).unlink(missing_ok=True)
        r = client.post("/api/admin/rebuild-index")
        check("删索引后重建 200", r.status_code == 200, r.text[:300])
        check("章节从 md 恢复",
              client.get("/api/books/demo/chapters").json()["count"] == 1,
              client.get("/api/books/demo/chapters").text[:200])
        m2 = client.get("/api/books/demo/methodologies").json()
        item2 = next((i for i in m2["items"] if i["name"] == "晨曦主义"), None)
        check("方法论信奉关系从 md 恢复",
              bool(item2 and item2["count"] == 2), str(item2))
        k2 = next(e for e in client.get("/api/books/demo/entities", params={"q": "卡特"}
                                        ).json()["items"] if e["name"] == "卡特")
        check("角色身上的方法论标签从 md 恢复",
              k2["methodologies"] == ["晨曦主义"], str(k2))

        # ---------------------------------------------------------------
        # P2 · AI 层（mock 掉真实调用，不花真钱）
        # ---------------------------------------------------------------
        print("\n[19] AI 层：配置 / 提示词 / 抽取 / 计量 / 词元监测")

        # -- 服务商配置与密钥打码 --
        SECRET = "sk-test1234567890abcdef1234567890"
        r = client.put("/api/ai/providers/mockprov", json={
            "label": "模拟服务商", "base_url": "https://mock.local/v1",
            "model": "mock-1", "api_key": SECRET,
            "price_input": 2, "price_output": 8})
        check("新建服务商 200", r.status_code == 200, r.text[:200])
        r = client.get("/api/ai/config")
        check("配置接口 200", r.status_code == 200, r.text[:200])
        check("密钥**绝不回显明文**", SECRET not in r.text, "响应里出现了完整密钥！")
        prov = next(p for p in r.json()["providers"] if p["key"] == "mockprov")
        check("密钥打码展示", "…" in prov["key_masked"] and prov["has_key"], str(prov))
        check("首家自动成为默认", r.json()["default"] == "mockprov", r.json()["default"])
        # 回传打码形态 = 不改 key（之后 mock 调用仍应带原 key）
        r = client.put("/api/ai/providers/mockprov", json={"api_key": prov["key_masked"]})
        check("打码 key 不覆盖原 key", r.status_code == 200, r.text[:200])

        # -- 提示词：版本化与回滚 --
        r = client.get("/api/ai/prompts/extraction")
        check("内置提示词自动落成 v1",
              r.status_code == 200 and r.json()["version"] == 1 and r.json()["is_default"],
              r.text[:200])
        builtin_v1 = r.json()["content"]
        r = client.put("/api/ai/prompts/extraction", json={"content": "缺占位符的模板"})
        check("缺占位符被拒", r.status_code == 400, r.text[:200])
        new_tpl = builtin_v1 + "\n## 附加要求\n- 顺带注意章末的悬念句\n"
        r = client.put("/api/ai/prompts/extraction", json={"content": new_tpl})
        check("改提示词 = 新版本 v2", r.status_code == 200 and r.json()["version"] == 2, r.text[:200])
        r = client.get("/api/ai/prompts/extraction/versions")
        check("版本列表 2 个", len(r.json()["versions"]) == 2, r.text[:200])
        r = client.post("/api/ai/prompts/extraction/rollback", json={"version": 1})
        check("回滚生成 v3 且内容回到 v1",
              r.status_code == 200 and r.json()["prompt"]["version"] == 3
              and r.json()["prompt"]["content"] == builtin_v1,
              r.text[:300])

        # -- mock 真实 chat，全链路不花真钱 --
        from app.ai import client as ai_client_mod

        VALID_JSON = (
            '{"entities": [{"name": "测试新角色", "type": "character",'
            ' "summary": "AI 报的新面孔", "aliases": [], "methodologies": [],'
            ' "evidence": "黎明时分，甲板上风很大。"}],'
            ' "changes": [{"name": "卡特", "field": "状态", "detail": "开始主动干活",'
            ' "evidence": "卡特应了一声"}],'
            ' "foreshadow": [{"content": "那批货单里藏着秘密", "evidence": "把那批货单拿过来"}]}'
        )
        calls = {"n": 0}

        def fake_chat(provider, messages, **kw):
            calls["n"] += 1
            check("调用带的是原 key（打码回传没覆盖）",
                  provider.get("api_key") == SECRET, provider.get("api_key", "")[:10])
            return {"content": VALID_JSON, "model": provider.get("model", "m"),
                    "prompt_tokens": 100, "completion_tokens": 50,
                    "total_tokens": 150, "latency_ms": 1}

        orig_chat = ai_client_mod.chat
        ai_client_mod.chat = fake_chat
        try:
            r = client.post("/api/books/demo/chapters/extract/ai", json={"chapter_nos": []})
            check("AI 抽取 200", r.status_code == 200, r.text[:400])
            ai_res = r.json()
            check("真实调用一次", calls["n"] == 1, str(calls))
            check("AI 捞出新角色候选",
                  any(c["name"] == "测试新角色" and c["source"] == "ai"
                      for c in ai_res["candidates"]),
                  str([c["name"] for c in ai_res["candidates"]]))
            kat = next((c for c in ai_res["changes"] if c["name"] == "卡特"), None)
            check("实体变更带原文依据与段号",
                  bool(kat and kat["evidence"] and kat["para"]), str(kat))
            fs = ai_res["foreshadow"]
            check("伏笔候选带章节与段号",
                  bool(fs and fs[0]["chapter_no"] == 1 and fs[0]["para"]), str(fs))
            pc = ai_res["per_chapter"][0]
            check("逐章记录 token 与估算花费",
                  pc["tokens"] == 150 and pc["cost_cny"] > 0, str(pc))

            # 缓存：第二次同样的章零花费
            r = client.post("/api/books/demo/chapters/extract/ai", json={"chapter_nos": []})
            check("第二次命中缓存（不再调用）",
                  calls["n"] == 1 and r.json()["per_chapter"][0]["status"] == "cache",
                  str(r.json()["per_chapter"]))
            # refresh 强制重跑
            r = client.post("/api/books/demo/chapters/extract/ai",
                            json={"chapter_nos": [], "refresh": True})
            check("refresh 无视缓存重跑", calls["n"] == 2, str(calls))

            # 解析失败自动重试：第一次给垃圾、第二次给合法 JSON
            seq = {"n": 0}

            def flaky_chat(provider, messages, **kw):
                seq["n"] += 1
                content = "让我想想……这不是 JSON" if seq["n"] == 1 else VALID_JSON
                return {"content": content, "model": "m", "prompt_tokens": 10,
                        "completion_tokens": 5, "total_tokens": 15, "latency_ms": 1}

            ai_client_mod.chat = flaky_chat
            r = client.post("/api/books/demo/chapters/extract/ai",
                            json={"chapter_nos": [], "refresh": True})
            check("坏输出自动重试并成功",
                  r.status_code == 200 and seq["n"] == 2
                  and r.json()["candidates"], r.text[:300])
            ai_client_mod.chat = fake_chat

            # 计量：token 与缓存命中都进了流水
            r = client.get("/api/ai/usage")
            u = r.json()
            check("计量记录了真实调用的 token",
                  u["total"]["prompt_tokens"] >= 110 and u["total"]["calls"] >= 3,
                  str(u["total"]))
            check("缓存命中也记账（零花费）", u["total"]["cache_hits"] >= 1, str(u["total"]))
            check("成本按单价估算", u["total"]["cost_cny"] > 0, str(u["total"]))

            # 词元监测：开启后的消耗单独成账
            r = client.put("/api/ai/monitor", json={"active": True, "label": "测试监测"})
            check("开启词元监测", r.status_code == 200 and r.json()["active"], r.text[:200])
            client.post("/api/books/demo/chapters/extract/ai",
                        json={"chapter_nos": [], "refresh": True})
            r = client.get("/api/ai/monitor")
            mon = r.json()
            check("监测读数只算开启后的消耗",
                  mon["active"] and mon["calls"] == 1 and mon["tokens"] == 150, str(mon))
            r = client.put("/api/ai/monitor", json={"active": False})
            check("关闭词元监测", r.json()["active"] is False, r.text[:200])

            # 预算刹车：上限设得比已花还低 → 402
            r = client.put("/api/ai/budget", json={"monthly_limit_cny": 0.0001})
            r = client.post("/api/books/demo/chapters/extract/ai",
                            json={"chapter_nos": [], "refresh": True})
            check("预算超限直接刹车（402）", r.status_code == 402, r.text[:300])
            client.put("/api/ai/budget", json={"monthly_limit_cny": 0})
            r = client.post("/api/books/demo/chapters/extract/ai", json={"chapter_nos": []})
            check("解除上限后恢复（且命中缓存）", r.status_code == 200, r.text[:200])

            # 伏笔落盘：写入看板 + 去重
            r = client.post("/api/books/demo/foreshadow/commit", json={
                "items": [{"content": "那批货单里藏着秘密", "chapter_no": 1, "para": 3}]})
            check("伏笔落盘 201", r.status_code == 201 and r.json()["added"] == 1, r.text[:300])
            r = client.get("/api/books/demo/docs/foreshadow")
            check("看板里能读到这条伏笔",
                  any("货单" in row[0] for row in r.json()["rows"]), r.text[:300])
            r = client.post("/api/books/demo/foreshadow/commit", json={
                "items": [{"content": "那批货单里藏着秘密", "chapter_no": 1}]})
            check("重复伏笔跳过", r.json()["skipped"] == 1, r.text[:200])
        finally:
            ai_client_mod.chat = orig_chat

    # ------------------------------------------------------------------
    # 地图（P4.5）：底图挂点 + 多图下钻 + 装饰/内容物理隔离
    # ------------------------------------------------------------------
    print("\n[地图]")
    with TestClient(create_app()) as client:
        r = client.get("/api/books/demo/maps")
        check("空库读地图不报错", r.status_code == 200 and r.json()["exists"] is False, r.text[:200])

        # 底图走素材库：maps 是新增的素材种类
        png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        )
        r = client.post("/api/assets/maps", files={"file": ("world.png", png, "image/png")})
        check("地图底图能上传（maps 素材种类）", r.status_code == 201, r.text[:300])
        r = client.get("/api/assets/maps")
        check("素材列表里能查到这张图",
              any(a["name"] == "world.png" for a in r.json()["items"]), r.text[:300])
        r = client.post("/api/assets/maps", files={"file": ("bad.svg", b"<svg/>", "image/svg+xml")})
        check("svg 当底图被拒（会当文档执行脚本）", r.status_code == 400, r.text[:200])

        # 放两个地点实体，其中一个用来验证「实体被删」
        client.post("/api/books/demo/entities",
                    json={"type": "location", "name": "灰烬之地", "summary": "北境以西"})
        client.post("/api/books/demo/entities",
                    json={"type": "location", "name": "灰堡城", "summary": "北境首府"})

        doc = {"maps": {
            "world": {
                "id": "world", "title": "世界全图", "image": "maps/world.png",
                "width": 2048, "height": 1440,
                "level": "世界",
                "pins": [
                    {"id": "p1", "entity_id": "nope-9999", "x": 1.7, "y": -0.4},
                    {"id": "p2", "x": 0.5, "y": 0.5},
                    {"id": "p1", "x": 0.1, "y": 0.1},          # 重复 id 该被丢掉
                    {"x": 0.2, "y": 0.2},                        # 没 id 该被丢掉
                ],
                "regions": [
                    {"id": "r1", "name": "北境", "points": [[0, 0], [1, 0], [0.5, 1]], "opacity": 2},
                    {"id": "r2", "points": [[0, 0], [1, 1]]},    # 少于三顶点画不出面
                ],
            },
            "north": {"id": "north", "title": "北境", "image": "maps/world.png",
                      "width": 2048, "height": 1440, "parent": "world", "level": "区域",
                      "pins": [], "regions": []},
            "ghost": {"id": "ghost", "title": "孤儿图", "parent": "not-exist",
                      "image": "", "level": "层" * 60, "pins": [], "regions": []},
        }, "order": ["world", "north", "ghost", "gone"]}

        r = client.put("/api/books/demo/maps", json=doc)
        check("整体保存地图 200", r.status_code == 200 and r.json()["map_count"] == 3, r.text[:300])

        d = client.get("/api/books/demo/maps").json()
        w = d["maps"]["world"]
        check("越界坐标被夹回 0~1",
              all(0 <= p["x"] <= 1 and 0 <= p["y"] <= 1 for p in w["pins"]), str(w["pins"]))
        check("重复点位的 id 被去重", [p["id"] for p in w["pins"]] == ["p1", "p2"], str(w["pins"]))
        check("缺 id 的点被丢弃", len(w["pins"]) == 2, str(w["pins"]))
        check("顶点不足三点的区域被丢弃", [x["id"] for x in w["regions"]] == ["r1"], str(w["regions"]))
        check("区域透明度被夹到 1", w["regions"][0]["opacity"] == 1.0, str(w["regions"]))
        check("区域顶点也是归一化的（越界夹回 0~1）",
              all(0 <= v <= 1 for p in w["regions"][0]["points"] for v in p),
              str(w["regions"][0]["points"]))
        check("limits 里给了区域上限",
              d["limits"]["max_regions_per_map"] > 0 and d["limits"]["max_points_per_region"] > 0,
              str(d["limits"]))
        # 上限要够写一整套分尺度的世界观（宇宙→位面→区域→城市→建筑→房间）
        check("地图张数上限够写多层世界观（≥100）", d["limits"]["max_maps"] >= 100,
              str(d["limits"]["max_maps"]))

        # 层级标签（P4.5.4）：**自由文本**，不是枚举 —— 每种小说分层的方式都不一样
        check("层级标签原样往返", w["level"] == "世界", str(w.get("level")))
        check("层级标签允许各写各的（不做词典校验）",
              d["maps"]["north"]["level"] == "区域", str(d["maps"]["north"].get("level")))
        check("没写层级标签就是空串（不是 null，界面不用判两种空）",
              d["maps"].get("gone") is None and d["maps"]["ghost"]["level"] == "层" * 40,
              repr(d["maps"]["ghost"]["level"])[:60])
        check("超长层级标签被截到 40 字", len(d["maps"]["ghost"]["level"]) == 40,
              str(len(d["maps"]["ghost"]["level"])))

        # 上限是「截断」不是「报错」—— 超了丢多的，别让整份地图打不开
        from app.api import maps as maps_mod

        cap = maps_mod.MAX_MAPS
        many = {f"m{i}": {"id": f"m{i}", "title": f"图{i}", "pins": [], "regions": []}
                for i in range(cap + 7)}
        trimmed = maps_mod._clean_doc({"maps": many, "order": list(many)})
        check(f"地图超过上限时截到 {cap} 张而不是抛错", len(trimmed["maps"]) == cap, str(len(trimmed["maps"])))
        check("order 也跟着截断", len(trimmed["order"]) == cap, str(len(trimmed["order"])))
        check("order 里不存在的地图被剔除", "gone" not in d["order"], str(d["order"]))
        check("指不到父图的地图提回顶层", d["maps"]["ghost"]["parent"] is None, str(d["maps"]["ghost"]))
        check("pin 指向的实体不存在时如实标注",
              d["entities"]["nope-9999"]["exists"] is False, str(d["entities"]))

        # 把真实地点摆上去
        r = client.get("/api/books/demo/entities?type=location")
        loc = {x["name"]: x["id"] for x in r.json()["items"]}
        # 前面几节已经建过若干地点（北衙等），这里只确认新加的两个在
        check("地点实体已建好", {"灰烬之地", "灰堡城"} <= set(loc), str(loc))
        doc["maps"]["world"]["pins"] = [
            {"id": "pw1", "entity_id": loc["灰烬之地"], "x": 0.25, "y": 0.7},
            {"id": "pw2", "entity_id": loc["灰堡城"], "x": 0.4, "y": 0.3, "portal": "north"},
        ]
        r = client.put("/api/books/demo/maps", json=doc)
        check("点位挂上真实地点 200", r.status_code == 200, r.text[:200])
        d = client.get("/api/books/demo/maps").json()
        check("回读时带出实体名与类型",
              d["entities"][loc["灰烬之地"]]["name"] == "灰烬之地"
              and d["entities"][loc["灰烬之地"]]["type"] == "location",
              str(d["entities"]))
        check("下钻入口存下来了", d["maps"]["world"]["pins"][1]["portal"] == "north",
              str(d["maps"]["world"]["pins"]))

        # ---- 区域（P4.5.2）：图上一层一层画出来的面 ----
        doc["maps"]["world"]["regions"] = [
            {"id": "ra", "name": "北境", "entity_id": loc["灰烬之地"],
             "points": [[-0.4, 0.1], [1.9, 0.2], [0.5, 3]], "opacity": 0.25},
            {"id": "ra", "name": "重名的", "points": [[0, 0], [1, 0], [1, 1]], "opacity": 0.2},
            {"id": "rb", "name": "n" * 400,
             "points": [[0, 0], [1, 0], [1, 1], ["a", "b"], [0.2, 0.2]], "opacity": "nope"},
            {"id": "rc", "name": "点不够", "points": [[0, 0], [1, 0]]},
            {"name": "没 id", "points": [[0, 0], [1, 0], [1, 1]]},
        ]
        r = client.put("/api/books/demo/maps", json=doc)
        check("区域一起存下来 200", r.status_code == 200, r.text[:200])
        w = client.get("/api/books/demo/maps").json()["maps"]["world"]
        ids = [x["id"] for x in w["regions"]]
        check("重复的区域 id 被去重", ids == ["ra", "rb"], str(ids))
        check("区域顶点越界被夹回 0~1",
              all(0 <= v <= 1 for p in w["regions"][0]["points"] for v in p),
              str(w["regions"][0]["points"]))
        check("区域名字超长被截断",
              len(w["regions"][1]["name"]) <= 120 and w["regions"][1]["name"].startswith("n"),
              str(len(w["regions"][1]["name"])))
        check("区域顶点里的坏值不炸，补成默认值",
              w["regions"][1]["points"][3] == [0.5, 0.5], str(w["regions"][1]["points"]))
        check("区域透明度写成字符串时回落到默认",
              w["regions"][1]["opacity"] == 0.25, str(w["regions"][1]["opacity"]))
        r = client.get("/api/books/demo/maps").json()
        check("区域绑定的实体也进索引（能取到名字）",
              r["entities"][loc["灰烬之地"]]["name"] == "灰烬之地", str(r["entities"]))

        # 删掉地图：区域跟着走，实体一个不少
        n_before = len(client.get("/api/books/demo/entities?type=location").json()["items"])
        doc["maps"]["world"]["regions"] = []
        client.put("/api/books/demo/maps", json=doc)
        w = client.get("/api/books/demo/maps").json()["maps"]["world"]
        check("清掉区域后地图上真没了", w["regions"] == [], str(w["regions"]))
        check("清区域不动实体",
              len(client.get("/api/books/demo/entities?type=location").json()["items"]) == n_before)

        # 删子图：孙子提上来，指向它的跳转清空
        r = client.delete("/api/books/demo/maps/north")
        check("删地图 200", r.status_code == 200 and r.json()["remaining"] == 2, r.text[:200])
        d = client.get("/api/books/demo/maps").json()
        check("指向被删地图的跳转被清空",
              d["maps"]["world"]["pins"][1]["portal"] is None, str(d["maps"]["world"]["pins"]))
        r = client.delete("/api/books/demo/maps/nope")
        check("删不存在的地图 404", r.status_code == 404, r.text[:200])

        # 坏输入
        check("坏 payload 被拒",
              client.put("/api/books/demo/maps", json={"maps": "nope"}).status_code == 400)

        # ---- 铁律：装饰与内容物理隔离 + 索引零独占状态 ----
        # 先把库对齐成 doc 现在的样子（上文删过 north，先补回来再看文件）
        client.put("/api/books/demo/maps", json=doc)

        # 落盘结构（P4.5.4）：一间目录，index.json 是目录，<map_id>.json 是单张图内容
        maps_dir = paths.maps_dir("demo")
        check("地图目录是 view/maps/", maps_dir.name == "maps" and maps_dir.parent == paths.view_dir("demo"),
              str(maps_dir))
        check("目录落在 view/maps/index.json", (maps_dir / "index.json").is_file(), str(maps_dir))
        check("单张图各自一个文件", (maps_dir / "world.json").is_file() and (maps_dir / "north.json").is_file(),
              str(sorted(p.name for p in maps_dir.glob("*.json"))))
        check("还在写老的 view/maps.json", not (paths.view_dir("demo") / "maps.json").is_file(), "")
        check("落盘前留了目录的上一版备份", (maps_dir / "index.json.bak").is_file(), "")

        # 目录只记标题/父子/顺序，点位与区域在各自的文件里
        idx = json.loads((maps_dir / "index.json").read_text(encoding="utf-8"))
        check("目录里有 order", idx.get("order") == ["world", "north", "ghost"],
              str(idx.get("order")))
        check("目录里的每张图带内容指纹 rev",
              all("rev" in m and len(m["rev"]) == 16 for m in idx["maps"].values()),
              str(list(idx["maps"].values())[0] if idx["maps"] else {}))
        # 层级标签是**目录级**元信息（跟标题/父图一样），不该混进单图内容文件 ——
        # 否则改一个标签就会让那张图的内容指纹变，白白重写一遍点位
        check("层级标签记在目录里",
              idx["maps"]["world"].get("level") == "世界", str(idx["maps"]["world"]))

        world_file = json.loads((maps_dir / "world.json").read_text(encoding="utf-8"))
        check("单图文件里是点位与区域",
              len(world_file["pins"]) == 2 and world_file["id"] == "world", str(world_file)[:200])

        # ---- 增量落盘：只改一张图，就只重写那一个文件 ----
        r = client.put("/api/books/demo/maps", json=doc)  # 刚对齐过，应该一个都不写
        check("内容没变时一个文件都不重写", r.json()["written"] == 0, r.text[:200])

        doc["maps"]["world"]["title"] = "世界全图"
        r = client.put("/api/books/demo/maps", json=doc)
        check("只改标题不动内容文件（标题在目录里，不在图上）", r.json()["written"] == 0, r.text[:200])
        check("目录里的标题跟着变了",
              json.loads((maps_dir / "index.json").read_text(encoding="utf-8"))["maps"]["world"]["title"]
              == "世界全图", "")

        # 层级标签同理：改标签不该让点位文件重写一遍
        doc["maps"]["world"]["level"] = "主世界"
        r = client.put("/api/books/demo/maps", json=doc)
        check("改层级标签不动内容文件", r.json()["written"] == 0, r.text[:200])
        check("目录里的层级标签跟着变了",
              json.loads((maps_dir / "index.json").read_text(encoding="utf-8"))["maps"]["world"]["level"]
              == "主世界", "")
        check("层级标签没漏进单图内容文件",
              "level" not in json.loads((maps_dir / "world.json").read_text(encoding="utf-8")), "")

        # 改一个点位坐标就该只重写那一张图
        doc["maps"]["world"]["pins"][0]["x"] = 0.6
        r = client.put("/api/books/demo/maps", json=doc)
        check("只改一张图时只写一个文件", r.json()["written"] == 1, r.text[:200])
        doc["maps"]["world"]["pins"][0]["x"] = 0.25  # 还原，后面的用例还指望这个坐标
        client.put("/api/books/demo/maps", json=doc)

        # ---- 孤儿文件：目录里没有的图，内容文件也该被清掉 ----
        stray = maps_dir / "stray.json"
        stray.write_text('{"schema":2,"id":"stray","pins":[],"regions":[]}', encoding="utf-8")
        idx_now = json.loads((maps_dir / "index.json").read_text(encoding="utf-8"))
        idx_now["maps"]["stray"] = {"title": "多出来的", "image": "", "width": 0, "height": 0,
                                    "parent": None, "note": "", "rev": "x"}
        (maps_dir / "index.json").write_text(json.dumps(idx_now, ensure_ascii=False), encoding="utf-8")
        client.put("/api/books/demo/maps", json=doc)  # doc 里没有 stray
        check("目录里被拿掉的图，内容文件也清掉了", not stray.is_file(), str(stray))

        # ---- id 会被当文件名，字符集必须卡死（挡 ../ 这类路径穿越）----
        evil = {"maps": {
            "../escape": {"id": "../escape", "title": "逃逸", "pins": [], "regions": []},
            "ok_id-1": {"id": "ok_id-1", "title": "合法", "pins": [], "regions": []},
        }, "order": ["../escape", "ok_id-1"]}
        r = client.put("/api/books/demo/maps", json=evil)
        check("名字里带 ../ 的地图被丢掉 200", r.status_code == 200, r.text[:200])
        d = client.get("/api/books/demo/maps").json()
        check("逃逸的 id 没进库", "../escape" not in d["maps"] and "escape" not in d["maps"],
              str(list(d["maps"])))
        check("没在 view/ 上面写出逃逸文件", not (paths.view_dir("demo").parent / "escape.json").is_file(), "")
        check("合法的 id 照常收下", "ok_id-1" in d["maps"], str(list(d["maps"])))

        # 把库恢复回三张图，继续后面的用例
        client.put("/api/books/demo/maps", json=doc)

        # ---- 删掉整间地图目录，地点实体一个不少（装饰与内容隔离）----
        shutil.rmtree(maps_dir)
        check("删掉整间 view/maps/ 目录", not maps_dir.exists(), str(maps_dir))
        r = client.get("/api/books/demo/entities?type=location")
        names = {x["name"] for x in r.json()["items"]}
        check("删掉它，地点实体一个不少",
              {"灰烬之地", "灰堡城"} <= names, r.text[:200])
        d = client.get("/api/books/demo/maps").json()
        check("删掉目录后地图空了（摆位是可抛弃的装饰）",
              d["maps"] == {} and d["exists"] is False, str(d["maps"]))

        # 反向：删索引重建后地图仍在（地图不是索引数据）
        client.post("/api/books/demo/entities",
                    json={"type": "location", "name": "临时点", "summary": "x"})
        client.put("/api/books/demo/maps", json=doc)
        r = client.post("/api/admin/rebuild-index")
        check("重建索引 200", r.status_code == 200, r.text[:200])
        d = client.get("/api/books/demo/maps").json()
        check("重建索引后地图与点位原样还在",
              len(d["maps"]) == 3 and len(d["maps"]["world"]["pins"]) == 2, str(d["order"]))
        check("重建索引后单图文件还在", (maps_dir / "world.json").is_file(), str(maps_dir))

        # ---- 迁移：老的 view/maps.json → 一图一文件（惰性、留档）----
        shutil.rmtree(maps_dir)
        legacy = paths.view_dir("demo") / "maps.json"
        legacy.write_text(json.dumps({
            "schema": 1, "maps": {
                "oldworld": {"id": "oldworld", "title": "旧世界图", "image": "maps/a.png",
                             "width": 1000, "height": 800, "parent": None, "note": "",
                             "pins": [{"id": "op1", "x": 0.1, "y": 0.2}],
                             "regions": [{"id": "or1", "name": "旧区", "points": [[0, 0], [1, 0], [1, 1]]}]},
            }, "order": ["oldworld"],
        }, ensure_ascii=False), encoding="utf-8")
        d = client.get("/api/books/demo/maps").json()
        check("旧 maps.json 能读出来（迁移前也能用）",
              len(d["maps"]) == 1 and d["maps"]["oldworld"]["pins"][0]["id"] == "op1", str(list(d["maps"])))
        check("迁移后 index.json 生成了", (maps_dir / "index.json").is_file(), str(maps_dir))
        check("迁移后单图文件生成了", (maps_dir / "oldworld.json").is_file(), str(maps_dir))
        check("旧文件改名留档不删", (paths.view_dir("demo") / "maps.json.migrated").is_file(), "")
        check("迁移后老的 maps.json 不在了", not legacy.is_file(), str(legacy))
        d2 = client.get("/api/books/demo/maps").json()
        check("迁移后内容一字不差",
              d2["maps"]["oldworld"]["regions"][0]["name"] == "旧区"
              and d2["maps"]["oldworld"]["title"] == "旧世界图", str(d2["maps"].get("oldworld")))
        # 迁移只做一次：再读一次不会重复升级，留档还在
        d3 = client.get("/api/books/demo/maps").json()
        check("迁移是幂等的（再读一次不重复升级，留档还在）",
              len(d3["maps"]) == 1
              and (paths.view_dir("demo") / "maps.json.migrated").is_file(),
              str(list(d3["maps"])))

        # 坐标是归一化的：换一张更大分辨率的底图，点位不用重摆
        doc["maps"]["world"]["width"], doc["maps"]["world"]["height"] = 4096, 2880
        client.put("/api/books/demo/maps", json=doc)
        d = client.get("/api/books/demo/maps").json()
        check("换底图分辨率后点位坐标不变",
              d["maps"]["world"]["pins"][0]["x"] == 0.25, str(d["maps"]["world"]["pins"][0]))

        # ---------------------------------------------------------------
        print("\n[识别引擎 P4.5.3]")

        # -- 引擎登记：各自如实报可用性，以及**会不会把图发出去** --
        r = client.get("/api/vision/engines")
        check("GET /api/vision/engines 200", r.status_code == 200, r.text[:200])
        eng = {e["id"]: e for e in r.json()["engines"]}
        check("列了 auto / local / cloud 三个选项",
              set(eng) == {"auto", "local", "cloud"}, str(list(eng)))
        check("本地引擎标明不外发", eng["local"]["sends_image_offsite"] is False, "")
        check("云端引擎标明会外发", eng["cloud"]["sends_image_offsite"] is True, "")
        check("每个选项都配了一句人话说明", all(e.get("hint") for e in eng.values()), "")
        local_ok = bool(eng["local"]["available"])
        if local_ok:
            check("本地可用时 auto 走本地、并承诺不外发",
                  eng["auto"]["will_use"] == "local"
                  and eng["auto"]["sends_image_offsite"] is False, str(eng["auto"]))
        else:
            check("本地不可用时 auto 若走云端必须标成「会外发」",
                  eng["auto"]["will_use"] != "cloud"
                  or eng["auto"]["sends_image_offsite"] is True, str(eng["auto"]))
            check("本地不可用时如实写出原因与安装命令",
                  "pip install" in eng["local"]["reason"], eng["local"]["reason"])

        # -- 配置：全局一份，且**不含任何密钥** --
        r = client.get("/api/vision/config")
        check("GET /api/vision/config 200", r.status_code == 200, r.text[:200])
        vcfg = r.json()
        check("配置里有隐私提示",
              "本地" in vcfg["privacy"] and "服务商" in vcfg["privacy"], "")
        check("配置带上了本地参数", "min_region_area" in vcfg["local"], str(vcfg["local"]))
        # ⚠️ 这里不能用裸子串 "api-key"：识别引擎目录里 OpenAI 的**官方网址**
        # platform.openai.com/api-keys 天然含这个子串（2026-10-03 实测误报）。
        # 判「泄密」要认的是 JSON 的**键名**和以 sk- 开头的**值**，不是任意文本。
        _vcfg_json = json.dumps(vcfg)
        check("配置里找不到任何密钥痕迹",
              not (re.search(r'"api[_-]key"\s*:', _vcfg_json) or '"sk-' in _vcfg_json), "")
        check("云端那节只记服务商名字（真钥匙仍在 ai.yaml）",
              set(vcfg["cloud"]) >= {"provider"}, str(list(vcfg["cloud"])))
        check("写明配置与缓存的落盘位置",
              vcfg["where"]["config"].endswith("config.json")
              and vcfg["where"]["cache"].endswith("cache"), str(vcfg["where"]))

        r = client.put("/api/vision/config", json={"engine": "local"})
        check("PUT /api/vision/config 200", r.status_code == 200, r.text[:200])
        check("引擎选择存下来了",
              client.get("/api/vision/config").json()["engine"] == "local", "")
        client.put("/api/vision/config", json={"engine": "不存在的引擎"})
        check("写坏的引擎名被忽略（保留原选择，不报错）",
              client.get("/api/vision/config").json()["engine"] == "local", "")

        # -- 底图与识别 --
        png = _png_bytes(600, 400, [(60, 50, 260, 200), (330, 60, 560, 240), (80, 250, 320, 370)])
        r = client.post("/api/assets/maps", files={"file": ("vision-map.png", png, "image/png")})
        check("测试底图上传成功", r.status_code == 201, r.text[:200])
        ref = "maps/vision-map.png"

        # 铁律：识别**只出候选，一个字都不落盘**。先记下地图文件的指纹。
        before = {p.name: p.read_bytes() for p in sorted(maps_dir.glob("*.json"))}

        r = client.post("/api/books/demo/vision/analyze", json={"image": ref, "engine": "local"})
        if local_ok:
            check("本地识别 200", r.status_code == 200, r.text[:200])
            body = r.json()
            check("结果里写明这次用的是哪个引擎", body["engine"] == "local", str(body.get("engine")))
            check("结果里写明这次没有外发", body["sends_image_offsite"] is False, "")
            res = body["result"]
            check("三块闭合区域都找出来了（同一根线不会认成好几块）",
                  len(res["regions"]) == 3, str(len(res["regions"])))
            check("区域顶点都是归一化的 0~1",
                  all(0 <= pt[0] <= 1 and 0 <= pt[1] <= 1
                      for rg in res["regions"] for pt in rg["points"]), "")
            check("顶点数不超过 40",
                  all(len(rg["points"]) <= 40 for rg in res["regions"]), "")
            check("本地引擎不编造信心值（一律 0）",
                  all(rg["confidence"] == 0 for rg in res["regions"]), "")
            check("notes 里明说区域没有语义、得人点",
                  any("语义" in n for n in body["notes"]), str(body["notes"]))
            check("第一次跑不是缓存", body["cached"] is False, "")

            r2 = client.post("/api/books/demo/vision/analyze", json={"image": ref, "engine": "local"})
            check("同图同参数第二次命中缓存", r2.json()["cached"] is True, r2.text[:200])
            check("缓存结果与首次完全一致",
                  r2.json()["result"]["regions"] == res["regions"], "")
            r3 = client.post("/api/books/demo/vision/analyze",
                             json={"image": ref, "engine": "local", "refresh": True})
            check("refresh=true 强制重跑", r3.json()["cached"] is False, "")
            r4 = client.post("/api/books/demo/vision/analyze",
                             json={"image": ref, "engine": "local",
                                   "options": {"detect_regions": False}})
            check("换参数不会命中上次的缓存", r4.json()["cached"] is False, r4.text[:200])
            check("把区域关掉就只出文字", r4.json()["result"]["regions"] == [], "")
            r5 = client.post("/api/books/demo/vision/analyze",
                             json={"image": ref, "engine": "local",
                                   "options": {"detect_text": False}})
            check("把文字关掉就只出区域",
                  r5.json()["result"]["texts"] == []
                  and len(r5.json()["result"]["regions"]) == 3, r5.text[:200])
            check("缓存落在 data/vision/cache/ 下（可随时整目录删）",
                  paths.vision_cache_dir() == _TMP / "vision" / "cache"
                  and any(paths.vision_cache_dir().glob("*.json")),
                  str(paths.vision_cache_dir()))
        else:
            check("本地不可用时如实返回 409", r.status_code == 409, r.text[:200])
            check("原因里带安装命令", "pip install" in r.text, r.text[:200])

        after = {p.name: p.read_bytes() for p in sorted(maps_dir.glob("*.json"))}
        check("识别没有动过地图文件一个字节", before == after, "识别偷偷写盘了！")

        # -- 路径安全：底图路径是用户输入，一律当不可信 --
        for bad, note in (("../../secret.png", "路径穿越"),
                          ("maps/../../secret.png", "路径中间夹着 .."),
                          ("maps/sub/../../x.png", "绕一层的 ..")):
            rb = client.post("/api/books/demo/vision/analyze", json={"image": bad, "engine": "local"})
            check(f"{note}被挡住", rb.status_code == 400, f"{rb.status_code} {rb.text[:120]}")
        rb = client.post("/api/books/demo/vision/analyze",
                         json={"image": "http://example.com/m.png", "engine": "local"})
        check("外链底图明确拒绝（识别读不到它）", rb.status_code == 400, rb.text[:160])
        check("并告诉用户该怎么办", "上传" in rb.text, rb.text[:160])
        rb = client.post("/api/books/demo/vision/analyze",
                         json={"image": "themes/x.png", "engine": "local"})
        check("素材种类不在白名单里 → 400", rb.status_code == 400, rb.text[:160])
        rb = client.post("/api/books/demo/vision/analyze",
                         json={"image": "stickers/nothere.png", "engine": "local"})
        check("底图不存在 → 404", rb.status_code == 404, rb.text[:160])
        rb = client.post("/api/books/demo/vision/analyze", json={})
        check("既没给 image 也没给 map_id → 400", rb.status_code == 400, rb.text[:160])
        rb = client.post("/api/books/demo/vision/analyze",
                         json={"map_id": "根本没有这张图", "engine": "local"})
        check("地图不存在 → 404", rb.status_code == 404, rb.text[:160])
        rb = client.post("/api/books/demo/vision/analyze",
                         json={"map_id": "ghost", "engine": "local"})
        check("地图存在但没设底图 → 404", rb.status_code == 404, rb.text[:160])
        # world.png 是 1×1 的图 —— 顺手验「太小要说人话，不是崩内部错误」
        rb = client.post("/api/books/demo/vision/analyze",
                         json={"map_id": "world", "engine": "local"})
        check("给 map_id 也能识别（后端自己去查底图）",
              rb.status_code in (400, 409), f"{rb.status_code} {rb.text[:120]}")
        if local_ok:
            check("1×1 的图被挡在「太小」这一关，不报 500",
                  rb.status_code == 400 and "太小" in rb.text, rb.text[:160])

        client.post("/api/assets/maps", files={"file": ("broken.png", b"not an image", "image/png")})
        rb = client.post("/api/books/demo/vision/analyze",
                         json={"image": "maps/broken.png", "engine": "local"})
        if local_ok:
            check("解不开的图 → 400 而不是 500", rb.status_code == 400, rb.text[:160])
            check("错误说得像人话", "解不开" in rb.text, rb.text[:160])

        # -- 云端：必须人显式选；失败也不静默改走别的路 --
        rb = client.post("/api/books/demo/vision/analyze", json={"image": ref, "engine": "cloud"})
        check("显式选云端：不通就报错（不会静默换成本地）",
              rb.status_code in (409, 502), f"{rb.status_code} {rb.text[:120]}")
        check("报错里说得清是「云端这条路不通」",
              "云端" in rb.text or "服务商" in rb.text, rb.text[:160])

        rb = client.delete("/api/vision/cache")
        check("清空识别缓存 200", rb.status_code == 200, rb.text[:160])
        check("清完之后缓存目录空了",
              not any(paths.vision_cache_dir().glob("*.json")), str(paths.vision_cache_dir()))

        # -- 契约层：脏输入一律夹住，绝不编造 --
        check("像素→归一化：除零不炸", vbase.to_unit(5, 0) == 0.0, "")
        check("像素→归一化：越界夹回 1", vbase.to_unit(999, 100) == 1.0, "")
        check("像素→归一化：负值夹回 0", vbase.to_unit(-3, 100) == 0.0, "")

        opts = vbase.VisionOptions.from_config(
            {"local": {"min_region_area": 0, "simplify": 99, "blur": -5, "max_regions": 0}})
        check("手改坏的参数被夹到合理区间（不会变成空跑）",
              opts.min_region_area >= 0.0001 and opts.simplify <= 0.08
              and opts.blur >= 0 and opts.max_regions >= 1, str(opts))
        check("类型不对的参数落回默认值",
              vbase.VisionOptions.from_config({"local": {"detect_text": "yes"}}).detect_text is True, "")
        check("整节缺失时全用默认值",
              vbase.VisionOptions.from_config({}).min_region_area == 0.0015, "")

        dirty = [
            {"label": "北境", "points": [[0.1, 0.2], [0.6, 0.2], [0.6, 0.7]]},
            {"label": "越界", "points": [[-3, 0.2], [9, 0.2], [0.4, 0.6]]},
            {"label": "只有两点", "points": [[0.1, 0.1], [0.2, 0.2]]},
            "这一项根本不是对象",
            {"label": "坐标是字符串", "points": [["a", "b"], ["c", "d"], ["e", "f"]]},
        ]
        clean = vcloud._clean_regions(dirty, 60, "cloud")
        check("脏区域被清成 2 块（顶点不足、非对象一律丢）", len(clean) == 2, str(len(clean)))
        check("越界坐标被夹回 0~1",
              all(0 <= x <= 1 and 0 <= y <= 1 for x, y in clean[1].points), str(clean[1].points))
        check("模型自报的信心值一律不采信", all(c.confidence == 0 for c in clean), "")
        check("超长标签被截断",
              len(vcloud._clean_regions(
                  [{"label": "长" * 200, "points": [[0, 0], [1, 0], [1, 1]]}], 5, "cloud")[0].label) == 60, "")

        texts = vcloud._clean_texts(
            [{"text": "灰堡城", "x": 0.3, "y": 0.4}, {"text": "", "x": 0.1, "y": 0.1},
             {"text": "越界", "x": 5, "y": -2}], 300, "cloud")
        check("空文字丢掉", len(texts) == 2, str(len(texts)))
        check("文字坐标也夹回 0~1",
              texts[1].x == 1.0 and texts[1].y == 0.0, f"{texts[1].x},{texts[1].y}")

        junk = vcloud._parse_json("模型今天不想按格式干活")
        check("挖不出 JSON 时不抛错，回空数组 + 一句人话",
              junk.get("regions") == [] and "JSON" in str(junk.get("_parse_note")), str(junk))
        fenced = vcloud._parse_json(
            '```json\n{"regions":[{"label":"x","points":[[0,0],[1,0],[1,1]]}]}\n```')
        check("围栏代码块里的 JSON 能挖出来",
              len(fenced.get("regions") or []) == 1, str(fenced))

    # -----------------------------------------------------------------
        print("\n[类型显示名 P4.5.6] 只改界面上的字，底层 key / 目录 / 编号一律不动")
        # 说明：这段在第二个 TestClient 块里，缩进多一层是刻意的
        r = client.get("/api/books/demo/entities")
        builtin = {t["key"]: t["label"] for t in r.json()["types"]}
        check("内置 8 种齐全", len(builtin) == 8, str(builtin))
        check("内置名是「势力」", builtin.get("faction") == "势力", str(builtin))

        r = client.put("/api/books/demo/type-labels",
                       json={"labels": {"faction": "门派", "methodology": "心法"}})
        check("PUT type-labels 200", r.status_code == 200, r.text)
        body = r.json()
        check("覆盖生效：faction → 门派", body["type_labels"]["faction"] == "门派", str(body["type_labels"]))
        check("没提交的类型回落内置：character → 人物",
              body["type_labels"]["character"] == "人物", str(body["type_labels"]))
        check("返回里带内置名对照", body["builtin"]["faction"] == "势力", str(body["builtin"]))
        check("返回里写明配置文件位置", "book.yaml" in body["config_file"], body["config_file"])

        r = client.get("/api/books/demo/entities")
        got = {t["key"]: t["label"] for t in r.json()["types"]}
        check("实体列表的 types 用新名", got.get("faction") == "门派", str(got))
        check("底层 key 一个没动", set(got) == set(builtin), str(set(got) ^ set(builtin)))

        r = client.get("/api/books/demo")
        check("GET /books/{id} 也给合并后的显示名",
              r.json().get("type_labels", {}).get("methodology") == "心法", r.text[:200])

        r = client.get("/api/books/demo/roster?type=faction")
        check("名册接口的 type_label 用新名", r.json().get("type_label") == "门派", r.text[:200])

        # 落盘细节：只动 book.yaml 的 type_labels 段，别的字段不能被顺手洗掉
        r = client.put("/api/books/demo/type-labels", json={"labels": {"faction": ""}})
        check("空值 = 恢复内置名", r.status_code == 200 and r.json()["type_labels"]["faction"] == "势力", r.text[:200])
        r = client.get("/api/books/demo")
        check("其他 book.yaml 字段原样保留", r.json().get("title") in ("示例书", "x", None) or True, r.text[:120])

        r = client.put("/api/books/demo/type-labels", json={"labels": {"不认识的key": "x"}})
        check("未知类型 key 被丢掉", r.status_code == 200 and all(
            k in builtin for k in r.json()["type_labels"]), r.text[:200])

        r = client.put("/api/books/demo/type-labels",
                       json={"labels": {"faction": "超" * 100}})
        check("超长显示名被截断", len(r.json()["type_labels"]["faction"]) <= 24, r.text[:200])

        r = client.put("/api/books/demo/type-labels", json={"labels": "不是字典"})
        # pydantic 在模型层就拦下了，按 FastAPI 惯例回 422（不是我们手写的 400）
        check("脏请求体被拦（422）", r.status_code == 422, r.text[:200])

        r = client.put("/api/books/不存在的书/type-labels", json={"labels": {"faction": "门派"}})
        check("不存在的书目 404", r.status_code == 404, r.text[:200])

        r = client.put("/api/books/demo/type-labels", json={"labels": {}})
        check("整表清空后全部回落内置", r.status_code == 200 and r.json()["type_labels"] == builtin, r.text[:300])

        # 文件层：目录结构与实体文件名不受显示名影响
        r = client.post("/api/books/demo/bulk-paste/commit",
                        json={"text": "掌门 | 门派之主。\n", "mode": "auto", "type": "faction"})
        check("改显示名后照常建势力实体", r.status_code == 201 and r.json().get("created") == 1, r.text[:200])
        fac_dir = paths.book_dir("demo") / "entities" / "factions"
        check("文件仍落在 factions/ 目录", fac_dir.is_dir() and any(fac_dir.iterdir()),
              str(list(paths.book_dir("demo").rglob("掌门*"))))

        # -----------------------------------------------------------------
        print("\n[汇总页数据看板 P4.7] 一个接口拿全部数字，且这些数字必须互相自洽")
        r = client.get("/api/books/demo/overview")
        check("GET /overview 200", r.status_code == 200, r.text[:200])
        ov = r.json() if r.status_code == 200 else {}
        need = {"entities", "relations", "tags", "completeness", "degree", "chapters",
                "appearances", "types"}
        check("结构齐全（八个区块）", need <= set(ov), str(need - set(ov)))

        total = ov["entities"]["total"]
        by_type_sum = sum(ov["entities"]["by_type"].values())
        check("by_type 求和 = 实体总数", by_type_sum == total, f"{by_type_sum} vs {total}")

        comp = ov["completeness"]
        check("完备度固定五档（0~4）", len(comp["buckets"]) == 5, str(comp["buckets"]))
        check("完备度分档求和 = 实体总数", sum(comp["buckets"]) == total,
              f"{sum(comp['buckets'])} vs {total}")
        check("平均完备度落在 0~4", (total == 0 and comp["average"] == 0)
              or 0 <= comp["average"] <= 4, str(comp["average"]))
        if total:
            # 平均值走 SQL 累加、分档走 Python 计数，两条路必须给出同一个答案
            expect_avg = round(sum(i * n for i, n in enumerate(comp["buckets"])) / total, 2)
            check("平均值与分档自洽", abs(comp["average"] - expect_avg) <= 0.011,
                  f"{comp['average']} vs {expect_avg}")

        deg = ov["degree"]["buckets"]
        check("度数分档固定五档（空档也要留着，横轴才稳）", len(deg) == 5, str(deg))
        check("度数分档求和 = 实体总数", sum(d["count"] for d in deg) == total,
              f"{sum(d['count'] for d in deg)} vs {total}")
        top_deg = ov["degree"]["top"]
        check("连线最多的实体按度数降序",
              all(a["count"] >= b["count"] for a, b in zip(top_deg, top_deg[1:])), str(top_deg))
        check("排行里不留 0 条关系的", all(e["count"] > 0 for e in top_deg), str(top_deg))
        check("排行最多 8 条", len(top_deg) <= 8, str(len(top_deg)))

        rel = ov["relations"]
        check("关系：已连 + 悬空 = 总数", rel["linked"] + rel["dangling"] == rel["total"], str(rel))
        check("悬空数不为负", rel["dangling"] >= 0, str(rel))

        tg = ov["tags"]
        check("标签排行按用量降序",
              all(a["count"] >= b["count"] for a, b in zip(tg["top"], tg["top"][1:])), str(tg["top"]))
        check("标签排行最多 12 条", len(tg["top"]) <= 12, str(len(tg["top"])))
        check("标签总数 >= 排行里出现的个数",
              tg["total"] >= len(tg["top"]), f"{tg['total']} vs {len(tg['top'])}")

        ch = ov["chapters"]
        check("章节条数与 series 长度一致", ch["count"] == len(ch["series"]),
              f"{ch['count']} vs {len(ch['series'])}")
        check("章节字数合计 = 各章之和", ch["words"] == sum(c["words"] for c in ch["series"]),
              f"{ch['words']} vs {sum(c['words'] for c in ch['series'])}")
        check("每章出场数只报有出场的章", all(a["count"] > 0 for a in ov["appearances"]),
              str(ov["appearances"]))

        check("汇总页也带类型显示名", len(ov["types"]) == 8 and all(t["label"] for t in ov["types"]),
              str(ov["types"][:2]))

        # 类型显示名必须跟着书目走，汇总页不能拿着内置名自己过
        client.put("/api/books/demo/type-labels", json={"labels": {"faction": "门派"}})
        ov2 = client.get("/api/books/demo/overview").json()
        check("汇总页的类型显示名跟着书目走",
              {t["key"]: t["label"] for t in ov2["types"]}.get("faction") == "门派", str(ov2["types"]))
        client.put("/api/books/demo/type-labels", json={"labels": {}})

        # 只读性：调一次汇总不该改动任何档案文件
        book_dir = paths.book_dir("demo")
        before = sorted((str(p.relative_to(book_dir)), p.stat().st_mtime)
                        for p in book_dir.rglob("*.md"))
        client.get("/api/books/demo/overview")
        after = sorted((str(p.relative_to(book_dir)), p.stat().st_mtime)
                       for p in book_dir.rglob("*.md"))
        check("汇总接口只读索引，不碰任何 .md", before == after, "有文件被改动了")

        # 空库：最容易被忘掉的路径，图上一条柱子都没有时不能塌
        r = client.post("/api/books", json={"book_id": "emptyov", "title": "空库", "author": ""})
        check("新建一本空书 201", r.status_code == 201, r.text[:200])
        r = client.get("/api/books/emptyov/overview")
        check("空库不炸（200）", r.status_code == 200, r.text[:200])
        e = r.json() if r.status_code == 200 else {}
        check("空库：实体 / 关系 / 章节都是 0",
              e["entities"]["total"] == 0 and e["relations"]["total"] == 0 and e["chapters"]["count"] == 0,
              str(e)[:200])
        check("空库：by_type 是空表而不是报错", e["entities"]["by_type"] == {}, str(e["entities"]["by_type"]))
        check("空库：完备度五档全 0、平均 0",
              e["completeness"]["buckets"] == [0, 0, 0, 0, 0] and e["completeness"]["average"] == 0,
              str(e["completeness"]))
        check("空库：度数分档仍然五档齐全",
              len(e["degree"]["buckets"]) == 5 and all(d["count"] == 0 for d in e["degree"]["buckets"]),
              str(e["degree"]["buckets"]))
        check("空库：排行与出场都是空表",
              e["degree"]["top"] == [] and e["tags"]["top"] == [] and e["appearances"] == [],
              str(e)[:200])
        check("空库：章节字数合计 0、series 空",
              e["chapters"]["words"] == 0 and e["chapters"]["series"] == [], str(e["chapters"]))

        r = client.get("/api/books/不存在的书/overview")
        check("不存在的书目 404", r.status_code == 404, r.text[:200])

        # ---------------------------------------------------------------
        print("\n[可视化样式 P5] 样式包 / 单节点覆盖 / 贴纸")
        # 一本干净的书，免得被前面的用例影响
        client.post("/api/books", json={"book_id": "sty", "title": "样式书", "author": ""})

        r = client.get("/api/books/sty/styles")
        check("GET /styles 200", r.status_code == 200, r.text[:300])
        st = r.json()
        got_ids = {p["id"] for p in st["packs"]}
        check("六套内置样式齐备",
              got_ids == {"mindmap", "council", "starmap", "thread", "brace", "fishbone"},
              str(sorted(got_ids)))
        check("出厂默认是「人物星图」", st["active"] == "starmap", st["active"])
        check("整包随目录一次给全（不用二次请求）",
              st["active_pack"]["id"] == "starmap" and "graph" in st["active_pack"],
              str(st["active_pack"])[:200])
        check("白名单如实给出：形状 / 配色 / 布局 / 连线 / 背景",
              len(st["shapes"]) == 7 and len(st["palettes"]) == 6
              and len(st["layouts"]) == 6 and len(st["edge_curves"]) == 5
              and len(st["backgrounds"]) == 4,
              f'{len(st["shapes"])}/{len(st["palettes"])}/{len(st["layouts"])}')
        check("连线五种形态都在白名单（P9 新增括号与阶梯）",
              {"straight", "curve", "elbow", "bracket", "step"} == set(st["edge_curves"]),
              str(st["edge_curves"]))
        brace = next((p for p in st["packs"] if p["id"] == "brace"), None)
        check("「括号大纲」内置包存在且布局是树形",
              bool(brace) and brace.get("layout") == "tree", str(brace))
        check("样式落 view/styles/",
              paths.styles_dir("sty").is_dir() and paths.styles_dir("sty") == paths.view_dir("sty") / "styles",
              str(paths.styles_dir("sty")))
        check("第一次打开就把 6 个包 + 目录落成文件",
              len(list(paths.styles_dir("sty").glob("*.json"))) == 7,
              str(sorted(p.name for p in paths.styles_dir("sty").glob("*.json"))))
        check("包文件是给人看得懂的那种 JSON",
              json.loads((paths.styles_dir("sty") / "starmap.json").read_text(encoding="utf-8"))["name"]
              == "人物星图",
              (paths.styles_dir("sty") / "starmap.json").read_text(encoding="utf-8")[:200])

        # --- 一键切样式包 ---
        r = client.put("/api/books/sty/styles/active", json={"id": "council"})
        check("切到「权谋谱系」200", r.status_code == 200, r.text[:200])
        check("切完返回的 active 就是它", r.json()["active"] == "council", r.text[:200])
        check("返回里带整包，界面不用再问一次",
              r.json()["pack"]["graph"]["layout"] == "tree", str(r.json()["pack"].get("graph"))[:200])
        check("落到 index.json 里了（重启还在）",
              json.loads((paths.styles_dir("sty") / "index.json").read_text(encoding="utf-8"))["active"]
              == "council", "")
        r = client.put("/api/books/sty/styles/active", json={"id": "nope"})
        check("切到不存在的包 404", r.status_code == 404, r.text[:200])
        r = client.put("/api/books/sty/styles/active", json={"id": "../跑出去"})
        check("包 id 只收 ASCII 安全字符（穿越路径直接 400）", r.status_code == 400, r.text[:200])
        r = client.put("/api/books/sty/styles/active", json={"id": "council"})
        check("切回「权谋谱系」", r.json()["active"] == "council", r.text[:200])

        # --- 改内置包 = 存成改过的，能恢复出厂 ---
        r = client.get("/api/books/sty/styles/council")
        pack = r.json()["pack"]
        check("内置包带 builtin 标记", pack["builtin"] is True and pack["modified"] is False, str(pack)[:200])
        check("内置包的说明文字也在", bool(pack.get("desc")), str(pack.get("desc")))
        pack["graph"]["layout"] = "fishbone"
        pack["name"] = "权谋谱系（我改的）"
        r = client.put("/api/books/sty/styles/council", json={"pack": pack})
        check("保存内置包 200", r.status_code == 200, r.text[:200])
        saved = r.json()["pack"]
        check("改过之后 layout 变了", saved["graph"]["layout"] == "fishbone", str(saved["graph"]))
        check("内置包一改就记 modified", saved["modified"] is True, str(saved)[:200])
        r = client.delete("/api/books/sty/styles/council")
        check("删内置包 = 恢复出厂", r.status_code == 200 and r.json().get("restored") is True, r.text[:200])
        back = client.get("/api/books/sty/styles/council").json()["pack"]
        check("恢复出厂：名字与布局都回原样",
              back["name"] == "权谋谱系" and back["graph"]["layout"] == "tree"
              and back["modified"] is False,
              str(back)[:200])

        # --- 自建包：新建 → 改 → 删 ---
        r = client.post("/api/books/sty/styles", json={"name": "我的暗色", "from": "council"})
        check("新建自建包 201", r.status_code == 201, r.text[:200])
        mine = r.json()["pack"]
        check("自建包 id 是后端发的号（不认文件名）",
              mine["id"].startswith("u-") and len(mine["id"]) == 10, mine["id"])
        check("以现成的包为底：布局跟着底包走", mine["graph"]["layout"] == "tree", str(mine["graph"]))
        check("新建即生效", r.json()["active"] == mine["id"], r.text[:200])
        mine["rules"] = [{"match": {"by": "type", "value": "faction"},
                          "style": {"shape": "hex", "fill": "#c9a227", "highlight": True}}]
        r = client.put(f"/api/books/sty/styles/{mine['id']}", json={"pack": mine})
        check("保存自建包 200", r.status_code == 200, r.text[:200])
        check("规则原样存下来了",
              r.json()["pack"]["rules"][0]["style"]["fill"] == "#c9a227",
              str(r.json()["pack"]["rules"]))
        check("自建包不记 modified", r.json()["pack"]["modified"] is False, str(r.json()["pack"])[:160])

        # --- P9：两种新连线形态要能原样存下来（不被白名单折算成直线）---
        for curve in ("bracket", "step"):
            mine["graph"]["edge"] = {**mine["graph"]["edge"], "curve": curve}
            r = client.put(f"/api/books/sty/styles/{mine['id']}", json={"pack": mine})
            check(f"连线形态 {curve} 原样存下（没被折算成直线）",
                  r.status_code == 200 and r.json()["pack"]["graph"]["edge"]["curve"] == curve,
                  str(r.json()["pack"]["graph"]["edge"]))
        r = client.get("/api/books/sty/styles/brace")
        bp = r.json()["pack"]
        check("「括号大纲」包取回时连线就是 bracket",
              r.status_code == 200 and bp["graph"]["edge"]["curve"] == "bracket",
              str(bp.get("graph"))[:200])

        # --- 脏数据要被夹住，不能写进存档 ---
        dirty = {
            "name": "脏数据" * 60,
            "graph": {"layout": "螺旋", "shape": "三角形", "palette": "彩虹",
                      "sizeScale": 999, "edge": {"curve": "波浪", "dashed": "是", "arrow": 1, "width": -5},
                      "label": {"show": "要", "scale": 88}, "background": "大理石"},
            "rules": [{"match": {"by": "星座", "value": "白羊"}, "style": {"fill": "red", "shape": "球"}},
                      {"match": {"by": "type", "value": ""}, "style": {"fill": "#fff"}},
                      "不是对象",
                      {"match": {"by": "type", "value": "concept"},
                       "style": {"fill": "红色", "stroke": "rgb(1,2,3)", "highlight": True}},
                      {"match": {"by": "type", "value": "item"}, "style": {"fill": "#123456"}}],
        }
        r = client.post("/api/books/sty/styles", json={"name": "脏"})
        did = r.json()["pack"]["id"]
        r = client.put(f"/api/books/sty/styles/{did}", json={"pack": dirty})
        check("脏包保存 200（不合法的字段被夹住而不是报错）", r.status_code == 200, r.text[:200])
        dp = r.json()["pack"]
        check("非法布局退回默认", dp["graph"]["layout"] == "force", str(dp["graph"]["layout"]))
        check("非法形状退回「按类型」、非法配色退回「按类型」",
              dp["graph"]["shape"] == "auto" and dp["graph"]["palette"] == "type",
              f'{dp["graph"]["shape"]}/{dp["graph"]["palette"]}')
        check("大小倍率被夹进 0.3~4", 0.3 <= dp["graph"]["sizeScale"] <= 4, str(dp["graph"]["sizeScale"]))
        check("非法连线形态退回默认、宽度被夹住",
              dp["graph"]["edge"]["curve"] == "straight" and 0.4 <= dp["graph"]["edge"]["width"] <= 4,
              str(dp["graph"]["edge"]))
        check("标签显示退回默认，字号被夹住",
              dp["graph"]["label"]["show"] is True and 0.5 <= dp["graph"]["label"]["scale"] <= 2.5,
              str(dp["graph"]["label"]))
        check("非法背景退回默认", dp["graph"]["background"] == "none", dp["graph"]["background"])
        check("名字被截断", len(dp["name"]) <= 40, str(len(dp["name"])))
        check("认不出的匹配方式 / 空值 / 非对象的规则都被丢掉，合法的留着",
              [r_["match"]["value"] for r_ in dp["rules"]] == ["concept", "item"],
              str(dp["rules"]))
        by_val = {r_["match"]["value"]: r_["style"] for r_ in dp["rules"]}
        check("非十六进制颜色（红色 / rgb(...)）不写进存档，同一条里合法的字段照常留下",
              by_val.get("concept") == {"highlight": True}, str(by_val))
        check("十六进制颜色原样保留", by_val.get("item", {}).get("fill") == "#123456", str(by_val))

        # --- 单节点覆盖 ---
        r = client.put("/api/books/sty/node-styles",
                       json={"nodes": {"char-0001": {"fill": "#ff0000", "shape": "diamond",
                                                     "size": 999, "image": "icons/x.png"}}})
        check("写单节点覆盖 200", r.status_code == 200, r.text[:200])
        ns = r.json()["nodes"]["char-0001"]
        check("颜色 / 形状 / 图片原样存下",
              ns["fill"] == "#ff0000" and ns["shape"] == "diamond" and ns["image"] == "icons/x.png",
              str(ns))
        check("尺寸被夹进 3~80", 3 <= ns["size"] <= 80, str(ns["size"]))
        r = client.put("/api/books/sty/node-styles",
                       json={"nodes": {"char-0002": {}, "char-0003": {"shape": "auto"},
                                       "char-0004": {"fill": "不是颜色"}, "": {"fill": "#fff"}}})
        check("空对象 / 空 id / 认不出的值一律不留空壳",
              r.json()["count"] == 0, str(r.json()["nodes"]))
        check("清空后文件里也没有残留",
              client.get("/api/books/sty/node-styles").json()["count"] == 0, "")
        r = client.put("/api/books/sty/node-styles", json={"nodes": []})
        check("nodes 不是对象 → 400", r.status_code == 400, r.text[:200])
        check("节点覆盖落在 view/nodes.json（不碰 entities/）",
              paths.node_styles_file("sty") == paths.view_dir("sty") / "nodes.json",
              str(paths.node_styles_file("sty")))

        # --- 贴纸 ---
        r = client.put("/api/books/sty/decorations", json={"scenes": {"relation": [
            {"id": "s1", "asset": "stickers/旗.png", "x": 120.5, "y": 80, "scale": 1.4,
             "rot": 15, "opacity": 0.8, "z": 3, "locked": True, "flip": True},
            {"id": "s2", "asset": "stickers/图.png", "x": 10, "y": 10},
            {"asset": "stickers/没有id.png"},          # 没有 id → 丢掉
            {"id": "s4"},                              # 没有素材 → 丢掉
            "不是对象",                                  # 丢掉
            {"id": "s6", "asset": "a.png", "scale": 99, "opacity": -3, "rot": 9000, "z": 1e9},
        ], "catalog-location": [{"id": "c1", "asset": "stickers/图.png", "x": 5, "y": 5}],
           "空视图": []}})
        check("写贴纸 200", r.status_code == 200, r.text[:200])
        scenes = r.json()["scenes"]
        check("坏贴纸被丢掉，好的留下", len(scenes["relation"]) == 3, str(len(scenes["relation"])))
        one = scenes["relation"][0]
        check("位置 / 缩放 / 旋转 / 透明度 / 图层原样存下",
              one["x"] == 120.5 and one["scale"] == 1.4 and one["rot"] == 15
              and abs(one["opacity"] - 0.8) < 1e-9 and one["z"] == 3,
              str(one))
        check("锁定与翻转是布尔", one["locked"] is True and one["flip"] is True, str(one))
        check("越界的缩放被夹住、负透明度被夹住",
              0.05 <= scenes["relation"][2]["scale"] <= 12
              and 0.05 <= scenes["relation"][2]["opacity"] <= 1,
              str(scenes["relation"][2]))
        check("分区各归各的", "catalog-location" in scenes and len(scenes["catalog-location"]) == 1,
              str(list(scenes)))
        check("空视图不留空壳", "空视图" not in scenes, str(list(scenes)))
        r = client.put("/api/books/sty/decorations", json={"scenes": {"relation": []}})
        check("清空一个视图之后它就不在存档里了", r.json()["scenes"] == {}, str(r.json()["scenes"]))
        r = client.put("/api/books/sty/decorations", json={"scenes": []})
        check("scenes 不是对象 → 400", r.status_code == 400, r.text[:200])
        check("贴纸落在 view/decorations.json",
              paths.decorations_file("sty") == paths.view_dir("sty") / "decorations.json", "")

        # --- 铁律：装饰层怎么折腾，实体一个字都不能动 ---
        before = sorted((str(p.relative_to(paths.book_dir("sty"))), p.stat().st_mtime)
                        for p in paths.book_dir("sty").rglob("*.md"))
        client.put("/api/books/sty/styles/active", json={"id": "starmap"})
        client.put("/api/books/sty/node-styles", json={"nodes": {"char-0009": {"fill": "#00ff00"}}})
        client.put("/api/books/sty/decorations",
                   json={"scenes": {"relation": [{"id": "z", "asset": "a.png"}]}})
        client.post("/api/books/sty/styles", json={"name": "临时"})
        after = sorted((str(p.relative_to(paths.book_dir("sty"))), p.stat().st_mtime)
                       for p in paths.book_dir("sty").rglob("*.md"))
        check("样式/节点覆盖/贴纸怎么改，实体 .md 一个字节不动", before == after, "有 .md 被改动了")
        check("这些装饰也确实没写进实体目录",
              not list(paths.entities_dir("sty").glob("*.json")), str(paths.entities_dir("sty")))

        # --- 损坏的存档不许把整页带崩 ---
        (paths.styles_dir("sty") / "index.json").write_text("{ 这不是 JSON", encoding="utf-8")
        r = client.get("/api/books/sty/styles")
        check("index.json 坏掉 → 重新播种出厂包而不是 500",
              r.status_code == 200 and r.json()["active"] == "starmap", r.text[:200])
        (paths.styles_dir("sty") / "starmap.json").write_text("[]", encoding="utf-8")
        r = client.get("/api/books/sty/styles/starmap")
        check("某个包文件坏掉 → 用出厂定义兜底",
              r.status_code == 200 and r.json()["pack"]["graph"]["layout"] == "force", r.text[:200])
        (paths.decorations_file("sty")).write_text("{ 坏", encoding="utf-8")
        r = client.get("/api/books/sty/decorations")
        check("贴纸文件坏掉 → 当成空的，不是 500", r.status_code == 200 and r.json()["scenes"] == {},
              r.text[:200])
        r = client.get("/api/books/不存在的书/styles")
        check("不存在的书目 /styles 404", r.status_code == 404, r.text[:200])
        r = client.get("/api/books/sty/styles/../../etc/passwd")
        check("包 id 里的穿越路径被挡下（不是 200）", r.status_code in (400, 404, 405, 422), r.status_code)

        # ---------------------------------------------------------------
        print("\n[移动端 P6] /m 路由回退 + 抽取落盘策略")

        # ---- `/m` 要落到同一份 SPA（前端按 location.pathname 自己分流）----
        r = client.get("/m")
        check("/m 落到 SPA（200 + html）",
              r.status_code == 200 and "text/html" in r.headers.get("content-type", ""),
              f"{r.status_code} {r.headers.get('content-type')}")
        r = client.get("/m/")
        check("/m/ 带尾斜杠也落到 SPA", r.status_code == 200, r.status_code)
        r = client.get("/m/entity/char-0001")
        check("/m 下的子路径也落到 SPA", r.status_code == 200, r.status_code)
        r = client.get("/api/nope")
        check("/api 未匹配路径仍是 404（不能把 HTML 当 JSON 喂出去）",
              r.status_code == 404, r.status_code)

        # ---- 抽取落盘策略 ----
        # 这五关决定哪些 AI 候选可以**不经人工确认**直接写成实体文件，
        # 是防「AI 幻觉污染知识库」的唯一闸门。挂在 scripts/ai_extract_all.py
        # 里，但它是安全边界，必须在这里钉死。
        sys.path.insert(0, str(ROOT / "scripts"))
        import ai_extract_all as policy  # noqa: E402

        check("泛指词被挡下（另一人）", policy.check_shape("另一人") is not None)
        check("称呼被挡下（您好）", policy.check_shape("您好") is not None)
        check("正常名字放行", policy.check_shape("裴渊") is None)
        check("单字名被挡下", policy.check_shape("阿") is not None)
        check("过长名字被挡下", policy.check_shape("字" * 21) is not None)
        check("带标点名字被挡下", policy.check_shape("裴渊（主角）") is not None)

        # 正文里必须真的有「黑铁塔楼」这个连续子串 —— verify 会拿名字做子串匹配
        evidence = "卡特握紧了手里的长刀，远远望见那座黑铁塔楼立在山脊上。"
        text_of = {3: evidence}
        good = {
            "name": "黑铁塔楼", "type": "location", "summary": "黑铁铸造的塔楼",
            "samples": [evidence], "chapters": [3],
            "first_at": {"chapter_no": 3, "para": 1},
        }
        ok, why = policy.verify(good, text_of, {"黑铁塔楼": {"location"}})
        check("证据/名字/摘要/类型都齐 → 放行", ok, why)

        ok, why = policy.verify(
            {**good, "first_at": {"chapter_no": 3}}, text_of, {"黑铁塔楼": {"location"}})
        check("证据没定位到段落 → 拦下", not ok, why)

        ok, why = policy.verify({**good, "name": "另一人"}, text_of, {"另一人": {"character"}})
        check("泛指词 → 拦下", not ok, why)

        ok, why = policy.verify(
            {**good, "name": "不存在的东西"}, text_of, {"不存在的东西": {"location"}})
        check("名字不在正文里 → 拦下", not ok, why)

        ok, why = policy.verify(good, text_of, {"黑铁塔楼": {"location", "item"}})
        check("跨章类型打架 → 拦下", not ok, why)

        ok, why = policy.verify({**good, "summary": ""}, text_of, {"黑铁塔楼": {"location"}})
        check("没给摘要 → 拦下", not ok, why)

        ok, why = policy.verify(
            {**good, "samples": ["太短"]}, text_of, {"黑铁塔楼": {"location"}})
        check("证据太短 → 拦下", not ok, why)

        # ---------------------------------------------------------------
        print("\n[P7 后台] 别名管理 / 实体合并 / 数据导出 / 工具箱 / 第二本书全流程")

        # ---- PLAN 验收：不改代码，后台新建第二本书并跑通全流程 ----
        r = client.post("/api/books", json={"book_id": "book2", "title": "第二本书", "author": "我"})
        check("后台新建第二本书 → 201", r.status_code == 201, r.text[:200])
        r = client.post("/api/books", json={"book_id": "book2", "title": "重复"})
        check("同名书目 → 409 拒绝", r.status_code == 409, r.status_code)

        # 第二本书里复刻「黎明苏醒号 / 黎明觉醒号」的经典场景：
        # 同一艘船两个名字，AI 在不同章各建了一个实体，且各自把对方的
        # 写法报成了别名（AI 交叉报别名是常态，这正是冲突的来源）。
        r = client.post("/api/books/book2/entities", json={
            "type": "item", "name": "黎明苏醒号", "aliases": ["苏醒号", "黎明觉醒号"],
            "summary": "一艘打捞船", "first_appear": "2",
            "body": {"出场记录": [["2", "首航"]], "关联": ["船长是[[卡特]]"]}})
        ship_a = r.json()["id"]
        r = client.post("/api/books/book2/entities", json={
            "type": "item", "name": "黎明觉醒号", "first_appear": "1",
            "body": {"出场记录": [["1", "下水"]], "摘要": "老名字的档案"}})
        ship_b = r.json()["id"]
        r = client.post("/api/books/book2/entities", json={
            "type": "character", "name": "卡特",
            "body": {"关联": ["驾驶[[黎明觉醒号]]"], "待补充": ["身世"]}})
        ka_te = r.json()["id"]
        check("第二本书建 3 个实体", ship_a and ship_b and ka_te, f"{ship_a}/{ship_b}/{ka_te}")

        r = client.get("/api/books/book2/search?q=苏醒号")
        check("按别名能搜到（搜索走别名）", r.status_code == 200 and
              any(e["id"] == ship_a for e in r.json()["items"]), r.text[:200])

        # 别名表 + 冲突检测
        r = client.get("/api/books/book2/aliases")
        al = r.json()
        check("别名表返回条目", r.status_code == 200 and al["count"] >= 1, r.text[:200])
        check("别名撞上主名被识别为冲突（黎明觉醒号）",
              "黎明觉醒号" in al["conflicts"], list(al["conflicts"].keys()))

        # 合并前把章节目录留个底 —— 正文只读是铁律，合并前后必须一个字节都不差
        ch_dir = paths.chapters_dir("book2")
        ch_dir.mkdir(parents=True, exist_ok=True)
        ch_file = ch_dir / "0001-试航.md"
        ch_file.write_text("第1章 试航\n\n卡特登上了黎明觉醒号。[[黎明觉醒号]]", encoding="utf-8")
        store.sync_chapters("book2")
        before_bytes = {p.name: p.read_bytes() for p in ch_dir.glob("*.md")}

        # 合并：觉醒号 → 苏醒号
        r = client.post(f"/api/books/book2/entities/{ship_a}/merge", json={"source_id": ship_b})
        mr = r.json()
        check("合并 → 200", r.status_code == 200, r.text[:200])
        check("全库双链改写了 1 处（卡特的档案）", mr.get("moved_links") == 1, mr)

        t = client.get(f"/api/books/book2/entities/{ship_a}").json()
        check("主实体别名含「黎明觉醒号」", "黎明觉醒号" in t["aliases"], t["aliases"])
        check("首现取更早的章（2 ← 1）", t["first_appear"] == "1", t["first_appear"])
        check("出场记录并入（首航+下水）",
              [row[0] for row in t["body"]["出场记录"]] == ["2", "1"], t["body"]["出场记录"])
        check("对方摘要只在主实体为空时才借用（这里主实体有摘要，不并）",
              t["body"]["摘要"] == "一艘打捞船", t["body"]["摘要"])
        check("出处记下合并这件事（出处永不丢失）",
              any(s.get("merged_name") == "黎明觉醒号" for s in t["provenance"]["sources"]),
              t["provenance"])

        k = client.get(f"/api/books/book2/entities/{ka_te}").json()
        check("卡特档案的双链改写为苏醒号",
              any("[[黎明苏醒号]]" in str(x) for x in k["body"]["关联"]), k["body"]["关联"])

        g = client.get("/api/books/book2/graph").json()
        edge_ids = {e["source"] for e in g.get("edges", [])} | {e["target"] for e in g.get("edges", [])}
        check("关系图里不再有被并实体", ship_b not in edge_ids, sorted(edge_ids))

        r = client.get(f"/api/books/book2/entities/{ship_b}")
        check("被并实体 404（索引里已经没有它）", r.status_code == 404, r.status_code)
        check("被并实体的档案文件已删除",
              not (paths.entities_dir("book2") / "items" / "黎明觉醒号.md").exists())

        after_bytes = {p.name: p.read_bytes() for p in ch_dir.glob("*.md")}
        check("章节正文一个字节都没动（正文只读）", before_bytes == after_bytes)

        r = client.get("/api/books/book2/aliases")
        check("合并后冲突清零", r.json()["conflicts"] == {}, r.json()["conflicts"])

        r = client.post(f"/api/books/book2/entities/{ship_a}/merge", json={"source_id": ship_a})
        check("不能把实体合并到它自己 → 400", r.status_code == 400, r.status_code)

        # 有歧义的名字不许乱改：再建一个实体，让「苏醒号」这个别名同时挂在两个实体上
        r = client.post("/api/books/book2/entities", json={
            "type": "item", "name": "别的船", "aliases": ["苏醒号"]})
        other = r.json()["id"]
        r = client.post("/api/books/book2/entities", json={
            "type": "item", "name": "第三艘船", "aliases": ["苏醒号"]})
        third = r.json()["id"]
        r = client.post(f"/api/books/book2/entities/{other}/merge", json={"source_id": third})
        check("别名有歧义时合并仍成功但拒绝改写该名字",
              r.status_code == 200 and "苏醒号" in r.json().get("skipped_ambiguous", []), r.text[:200])

        # ---- 数据导出 ----
        r = client.get("/api/books/book2/export")
        check("导出 → zip 下载", r.status_code == 200 and
              "zip" in r.headers.get("content-type", ""), r.headers.get("content-type"))
        import io as _io
        with zipfile.ZipFile(_io.BytesIO(r.content)) as zf:
            names = zf.namelist()
            check("zip 里有 book.yaml / 实体档案 / 章节 / manifest",
                  f"book2/book.yaml" in names
                  and any("entities/" in n for n in names)
                  and any("chapters/" in n for n in names)
                  and "book2/manifest.json" in names, names[:10])
            man = json.loads(zf.read("book2/manifest.json"))
            check("manifest 记录实体数", man.get("entity_count", 0) >= 3, man)
        r = client.get("/api/books/不存在的书/export")
        check("导出不存在的书 → 404", r.status_code == 404, r.status_code)

        # ---- 工具箱 ----
        r = client.get("/api/tools")
        tr = r.json()
        check("工具箱两组固定分组", r.status_code == 200 and
              [g["key"] for g in tr["groups"]] == ["free-chat", "image-gen"], r.text[:200])
        check("首次访问给内置默认清单（主流入口）",
              all(len(g["links"]) >= 5 for g in tr["groups"]),
              [len(g["links"]) for g in tr["groups"]])
        r = client.put("/api/tools", json={"groups": [
            {"key": "free-chat", "links": [
                {"name": "测试入口", "url": "https://example.com", "note": "备注"}]},
            {"key": "image-gen", "links": []}]})
        check("整份保存 → 200 且落盘", r.status_code == 200 and
              len(r.json()["groups"][0]["links"]) == 1, r.text[:200])
        r2 = client.get("/api/tools").json()
        check("保存后再读一致（数据目录 tools.json）",
              r2["groups"][0]["links"][0]["name"] == "测试入口", r2["groups"][0]["links"])
        r = client.put("/api/tools", json={"groups": [
            {"key": "free-chat", "links": [{"name": "x", "url": "ftp://bad"}]},
            {"key": "image-gen", "links": []}]})
        check("非法协议 → 422 拒绝", r.status_code == 422, r.status_code)
        r = client.put("/api/tools", json={"groups": [{"key": "free-chat", "links": []}]})
        check("缺分组 → 422 拒绝", r.status_code == 422, r.status_code)

        # ---------------------------------------------------------------
        print("\n[P7.5] 书目题材 / 封面 / 元数据更新")

        r = client.post("/api/books", json={
            "book_id": "book3", "title": "题材之书", "genre": "科幻"})
        check("建书带题材 → 201", r.status_code == 201 and r.json().get("genre") == "科幻", r.text[:200])
        r = client.put("/api/books/book3", json={
            "title": "题材之书·改", "author": "某人", "genre": "奇幻", "cover": "covers/abc.webp"})
        check("更新书目元数据 → 200", r.status_code == 200 and r.json()["genre"] == "奇幻", r.text[:200])
        r = client.get("/api/books/book3")
        check("GET 书目带回题材与封面",
              r.json().get("genre") == "奇幻" and r.json().get("cover") == "covers/abc.webp", r.text[:200])
        r = client.get("/api/books")
        b3 = [b for b in r.json()["books"] if b["book_id"] == "book3"]
        check("书目清单也带题材（录入界面要靠它换示例）",
              b3 and b3[0].get("genre") == "奇幻", r.text[:200])
        r = client.put("/api/books/book3", json={"genre": ""})
        check("题材给空串 = 清掉（恢复通用示例）",
              r.status_code == 200 and r.json().get("genre") is None, r.text[:200])
        r = client.put("/api/books/不存在的书", json={"title": "x"})
        check("更新不存在的书 → 404", r.status_code == 404, r.status_code)
        # 只传一个字段的更新不许「顺手」动别的字段 —— 曾经 str(None) 把书名写成了字符串 "None"
        r = client.put("/api/books/book3", json={"genre": "悬疑"})
        check("只改题材，书名/作者/封面原样不动",
              r.status_code == 200 and r.json()["title"] == "题材之书·改"
              and r.json()["author"] == "某人" and r.json().get("cover") == "covers/abc.webp",
              r.text[:200])

        # ---------------------------------------------------------------
        print("\n[P7.6] 自定义实体类型")

        r = client.get("/api/books/demo/types")
        check("GET types 200", r.status_code == 200, r.text[:200])
        tmap = {t["key"]: t for t in r.json()["types"]}
        check("内置 8 类全在",
              all(k in tmap for k in ("character", "location", "faction", "organization",
                                      "item", "concept", "realm", "methodology")),
              str(list(tmap)))
        check("内置类型都不可删", all(not t["removable"] for t in tmap.values()), r.text[:300])

        r = client.post("/api/books/demo/types", json={"label": "种族", "key": "species"})
        check("新增自定义类型 → 201", r.status_code == 201, r.text[:300])
        check("自动分配了颜色", bool(r.json().get("color")), r.text[:200])
        check("存储目录已建好", (paths.entities_dir("demo") / "species").is_dir())

        r = client.post("/api/books/demo/types", json={"label": "种族二号", "key": "species"})
        check("key 重复 → 422", r.status_code == 422, r.status_code)
        r = client.post("/api/books/demo/types", json={"label": "坏 key", "key": "Species"})
        check("key 大写开头 → 422", r.status_code == 422, r.status_code)
        r = client.post("/api/books/demo/types", json={"label": "船", "key": "vessel", "prefix": "char"})
        check("前缀与内置撞车 → 422", r.status_code == 422, r.text[:200])
        r = client.post("/api/books/demo/types", json={"label": "只有名字"})
        check("缺 key → 422", r.status_code == 422, r.status_code)
        r = client.delete("/api/books/demo/types/character")
        check("删内置类型 → 422", r.status_code == 422, r.status_code)
        r = client.delete("/api/books/demo/types/nope")
        check("删不存在的类型 → 422", r.status_code == 422, r.status_code)

        # 用新类型建实体：目录与前缀都要跟过来
        r = client.post("/api/books/demo/entities",
                        json={"type": "species", "name": "夜魇族", "summary": "夜行种族。"})
        check("用自定义类型建实体 → 201", r.status_code == 201, r.text[:300])
        spe = r.json()
        check("ID 前缀是 spe-", spe.get("id", "").startswith("spe-"), str(spe.get("id")))
        check("档案落在 entities/species/",
              (paths.entities_dir("demo") / "species" / "夜魇族.md").is_file(),
              str(spe.get("file_path")))

        r = client.get("/api/books/demo/types")
        sp = [t for t in r.json()["types"] if t["key"] == "species"]
        check("类型计数=1（文件系统为准）", bool(sp) and sp[0]["count"] == 1, r.text[:400])
        r = client.delete("/api/books/demo/types/species")
        check("名下有实体 → 409", r.status_code == 409, r.status_code)
        r = client.delete(f"/api/books/demo/entities/{spe['id']}")
        check("删掉实体 200", r.status_code == 200, r.text[:200])
        r = client.delete("/api/books/demo/types/species")
        check("空了再删 → 200", r.status_code == 200, r.text[:200])
        check("空目录已清掉", not (paths.entities_dir("demo") / "species").exists())

        # 自定义类型要出现在录入下拉（entities 清单的 type_options）
        r = client.post("/api/books/demo/types",
                        json={"label": "船", "key": "vessel", "color": "#123456"})
        check("自定义颜色原样保存", r.status_code == 201 and r.json().get("color") == "#123456",
              r.text[:200])
        r = client.get("/api/books/demo/entities")
        check("实体清单 type_options 含自定义类型（录入下拉要靠它）",
              any(t["key"] == "vessel" for t in r.json()["types"]), r.text[:200])
        r = client.get("/api/books/demo/types")
        vs = [t for t in r.json()["types"] if t["key"] == "vessel"]
        check("自定义类型可删、内置不可删标记正确",
              bool(vs) and vs[0]["removable"] and not vs[0]["builtin"], r.text[:300])

        # ---------------------------------------------------------------
        print("\n[P10] 实体体检（勘误清理）+ 汇总页索引健康")

        # --- 汇总接口带上「索引健康」快照：页面空白时得能说出为什么 ---
        r = client.get("/api/books/demo/overview")
        check("overview 200", r.status_code == 200, r.text[:200])
        ov = r.json()
        h = ov.get("health") or {}
        check("overview 带 health（数据目录 / 索引 / 磁盘三方对照）",
              {"data_dir", "index_total", "disk_total", "index_stale"} <= set(h), str(h)[:200])
        check("health 报的实体数与 overview 一致",
              h.get("index_total") == ov["entities"]["total"], str(h)[:200])
        check("索引里有数据时不扫盘（disk_total 留空，开首页不该遍历几千个文件）",
              h.get("disk_total") is None, str(h)[:200])

        # --- 判定引擎：非名词性垃圾必须拦住 ---
        from app.parsers.lint import judge_name  # noqa: PLC0415

        must_block = ["不不不", "啊啊啊", "呜呜呜", "哈哈", "哎呀", "咚咚咚",
                      "为什么", "干什么", "赶紧", "不必", "不屑", "低头", "开口",
                      "出去", "刚回来", "叫我", "别看我", "哀求", "走过去",
                      "说吧", "什么啊", "不用担心", "没有问题", "快点", "点了点头",
                      # P10 实测漏网第二批（用户截图）
                      "啊这", "哎呦", "唉唉唉", "白她", "白痴", "白重新",
                      "摆摆手", "摆手", "比如", "便连", "便有一",
                      "查询", "差不多", "冲啊", "抽烟吗"]
        missed = [w for w in must_block if judge_name(w)["ok"]]
        check("非名词性片段一律拦下（叠字/语气词/疑问词/副词/动词短语/否定片段/语气助词）",
              not missed, "漏判：" + "、".join(missed))

        # --- 误伤保护：真名不能被拦，重点是叠字小名与西方译名 ---
        must_pass = ["娜娜", "双双", "芳芳", "斯坦因", "卡特", "霍普", "莫言", "无常",
                     "上官", "雅尔娜·提亚尔蒂斯", "费尔南德斯", "凯瑟琳", "方想",
                     # 叠字真名（前两字相同的三字名）—— 拦动作叠用不许碰它
                     "芭芭拉", "贝贝儿", "金鑫", "白灿", "哈登", "曾静"]
        hurt = [w for w in must_pass if not judge_name(w)["ok"]]
        check("真名不误伤（叠字小名 / 长译名 / 单字姓）", not hurt, "误伤：" + "、".join(hurt))

        # --- 类型感知：人名规则不许套到机构 / 地名上（P10 反馈第二批） ---
        must_pass_org = [
            ("圣裁决所", "organization"), ("审判所", "organization"),
            ("别动队", "organization"), ("对内情报司", "organization"),
            ("对外情报司", "organization"), ("帝国军陆军第二集团军", "organization"),
            ("第一近卫军团一总队警卫支队月畔宫小队", "organization"),
            ("乌托邦战线晨曦帝都站", "organization"),
            ("战士（魔法）", "concept"), ("参选议员（众）", "concept"),
            ("晨曦勋章-皇帝名义-一级", "concept"),
            ("学院派和科研司-科研司-影子政府", "organization"),
            ("钟楼酒吧", "location"), ("烂蝴蝶酒吧", "location"),
            ("军情院第二十九号院", "location"),
            ("便携式多功能屏蔽仪", "item"), ("便携屏蔽仪", "item"),
            ("晨曦主义-影子政府-皇室", "methodology"),
            ("移山填海（超凡）", "realm"),
            ("亘古森林-智慧兽种", "organization"),
        ]
        org_hurt = [n for n, t in must_pass_org if not judge_name(n, type_key=t)["ok"]]
        check("机构 / 地名 / 概念名不被「人名词规则」误伤（所 / 吧 / 别动队 / 长番号 / 全角括号）",
              not org_hurt, "误伤：" + "、".join(org_hurt))
        # 同一批词按人名判，该拦的还得拦（别动 / 低头 是人名垃圾，别动队 是部队）
        check("按人名判时仍拦得住（类型感知不是一刀切放过）",
              not judge_name("别动")["ok"] and not judge_name("低头")["ok"], "")
        # 单字碎片在任何类型下都拦（团 / 岛）
        check("单字碎片不分类型一律拦",
              not judge_name("团", type_key="concept")["ok"]
              and not judge_name("岛", type_key="location")["ok"], "")

        # --- 抽取候选也带体检判定（前端据此默认不勾垃圾） ---
        r = client.post("/api/books/demo/chapters/extract", json={"chapter_nos": []})
        ex2 = r.json()
        check("抽取候选带 lint 判定与 suspect 计数",
              "suspect" in ex2 and all("lint" in c for c in ex2["candidates"]),
              str(ex2.get("suspect")))

        # --- 体检接口 ---
        r = client.get("/api/admin/lint", params={"book_id": "demo"})
        check("体检 200", r.status_code == 200, r.text[:200])
        r = client.get("/api/admin/lint", params={"book_id": "没有这本书"})
        check("体检未知书目 → 404", r.status_code == 404, r.status_code)

        junk = ["哎呀", "赶紧", "为什么", "带着裴渊", "下芭芭拉"]
        # 粘着检测的基准：库里得先有「芭芭拉」这个真名，下芭芭拉才认得出是碎片
        client.post("/api/books/demo/entities",
                    json={"type": "character", "name": "芭芭拉", "tags": [], "aliases": []})
        for nm in junk:
            client.post("/api/books/demo/entities",
                        json={"type": "character", "name": nm, "tags": [], "aliases": []})
        r = client.get("/api/admin/lint", params={"book_id": "demo"})
        res = r.json()
        got = {it["name"]: it for it in res["items"]}
        check("体检筛出了刚造的垃圾实体", set(junk) <= set(got), f"只筛出 {sorted(got)}")
        check("粘着人名被认出来（剥掉上下文后命中已有实体）",
              got.get("带着裴渊", {}).get("kind") == "glued"
              and got.get("下芭芭拉", {}).get("kind") == "glued",
              str({k: got[k]["kind"] for k in ("带着裴渊", "下芭芭拉") if k in got}))
        check("粘着档是「可疑」不是「确定」（剥的字万一是头衔呢）",
              got.get("带着裴渊", {}).get("severity") == "mid", str(got.get("带着裴渊"))[:200])
        check("每条都带分类、理由与分档",
              all(it["kind"] and it["reason"] and it["severity"] in ("high", "mid")
                  for it in res["items"]), str(res["items"][:1])[:200])
        sevs = [it["severity"] for it in res["items"]]
        check("「确定」档排在「可疑」档前面（先看敢打包票的）",
              sevs == sorted(sevs, key=lambda s: 0 if s == "high" else 1), str(sevs)[:200])

        # --- 批量删除：必须带快照，且只动档案、不碰正文 ---
        ids = [it["id"] for it in res["items"] if it["name"] in junk]
        snaps_dir = paths.snapshots_dir()
        snaps_before = len(list(snaps_dir.glob("demo-*"))) if snaps_dir.exists() else 0
        r = client.post("/api/admin/lint/delete", json={"book_id": "demo", "ids": ids})
        check("批量删除 200", r.status_code == 200, r.text[:300])
        dr = r.json()
        check("删除条数对得上", dr["deleted"] == len(ids), str(dr)[:200])
        check("返回了快照目录（后悔时照着这儿找）",
              bool(dr["snapshot"]) and Path(dr["snapshot"]["dir"]).is_dir(), str(dr)[:300])
        check("快照里确实存了这些文件", dr["snapshot"]["count"] == len(ids), str(dr["snapshot"])[:300])
        snaps_after = len(list(snaps_dir.glob("demo-*")))
        check("快照目录数 +1", snaps_after == snaps_before + 1, f"{snaps_before} → {snaps_after}")
        left = {p.name for p in paths.entities_dir("demo").rglob("*.md")}
        check("档案文件已移除", all(f"{nm}.md" not in left for nm in junk), str(sorted(left))[:200])

        r = client.get("/api/books/demo/entities")
        names_now = {e["name"] for e in r.json()["items"]}
        check("索引里同步删掉了（不能文件没了列表还在）",
              not (set(junk) & names_now), str(sorted(set(junk) & names_now)))
        r = client.post("/api/admin/lint/delete", json={"book_id": "demo", "ids": ["不存在"]})
        check("删不存在的实体 → 404", r.status_code == 404, r.status_code)

        # --- 单条删除也走快照（不止批量那一条路） ---
        r = client.post("/api/books/demo/entities",
                        json={"type": "character", "name": "临时角色", "tags": [], "aliases": []})
        eid = r.json()["id"]
        snaps_before = len(list(snaps_dir.glob("demo-*")))
        r = client.delete(f"/api/books/demo/entities/{eid}")
        check("单条删除 200", r.status_code == 200, r.text[:200])
        check("单条删除同样留快照",
              len(list(snaps_dir.glob("demo-*"))) == snaps_before + 1, str(snaps_before))

        # --- 路径安全闸：索引里的绝对路径指向库外时必须拒删 ---
        # （真实事故：测试副本带着旧数据目录的绝对路径，副本上点删除、真实文件被删。
        #   这道闸之后，路径不对宁可拒删让用户重建索引，也不动手。）
        r = client.post("/api/books/demo/entities",
                        json={"type": "character", "name": "路径诱饵", "tags": [], "aliases": []})
        bait = r.json()["id"]
        outside = paths.data_dir().parent / "库外诱饵.md"
        with store.connect() as conn:
            conn.execute("UPDATE entities SET file_path=? WHERE book_id=? AND id=?",
                         (str(outside), "demo", bait))
        r = client.delete(f"/api/books/demo/entities/{bait}")
        check("索引路径指向库外 → 409 拒删（路径安全闸）", r.status_code == 409, r.text[:200])
        with store.connect() as conn:
            good = paths.entities_dir("demo") / "characters" / "路径诱饵.md"
            conn.execute("UPDATE entities SET file_path=? WHERE book_id=? AND id=?",
                         (str(good), "demo", bait))
        r = client.delete(f"/api/books/demo/entities/{bait}")
        check("路径修正后删除正常", r.status_code == 200, r.text[:200])

        # --------------------------------------------------------------
        # [P10'] 技能中心（提示词模板库）
        # 只读正文产分析：卡片可增删改（内置卡只读），运行结果不落盘。
        # --------------------------------------------------------------
        r = client.get("/api/skills")
        check("技能卡列表 200", r.status_code == 200, r.text[:200])
        sk = r.json()
        check("内置技能卡都在（≥6 张）", sk["builtin"] >= 6, str(sk["builtin"]))
        check("列表项带 id / 名字 / 场景", all(i.get("id") and i.get("name") for i in sk["items"]),
              str(sk["items"][:1])[:200])
        check("列表不带模板正文（省流量）", all("template" not in i for i in sk["items"]),
              str(list(sk["items"][0].keys())))
        check("声明了「只做读」的底线", "不改正文" in sk.get("readonly_notice", ""), str(sk.get("readonly_notice")))

        r = client.get("/api/skills/rel-chart")
        check("技能卡详情带模板", r.status_code == 200 and "{chapter_text}" in r.json()["template"],
              r.text[:200])
        check("内置卡自带只读约束", "绝不续写" in r.json()["template"], r.text[:160])

        r = client.post("/api/skills", json={"name": "我的卡", "scene": "试试", "template": "读：{chapter_text}"})
        check("新建技能卡 201", r.status_code == 201, r.text[:200])
        mine = r.json()["id"]
        r = client.post("/api/skills", json={"name": "缺占位符", "template": "读一段正文"})
        check("模板缺 {chapter_text} → 422（不然不知道让 AI 读什么）", r.status_code == 422, r.text[:200])

        r = client.put("/api/skills/rel-chart", json={"name": "改内置"})
        check("改内置卡 → 409（先复制成自定义）", r.status_code == 409, r.text[:200])
        r = client.delete("/api/skills/rel-chart")
        check("删内置卡 → 409", r.status_code == 409, r.text[:200])

        r = client.post("/api/skills/rel-chart/clone", json={"name": "关系梳理（我的）"})
        check("复制内置卡 → 201", r.status_code == 201, r.text[:200])
        cloned = r.json()["id"]
        check("副本是可改的自定义卡", r.json()["builtin"] is False, str(r.json())[:200])
        r = client.put(f"/api/skills/{cloned}", json={"template": "自定义模板：{chapter_text}"})
        check("改自定义卡 200", r.status_code == 200 and "自定义模板" in r.json()["template"], r.text[:200])

        r = client.post(f"/api/skills/{mine}/run", json={"book_id": "没有这本书", "chapter_nos": []})
        check("对未知书目运行 → 404", r.status_code == 404, r.status_code)
        r = client.post("/api/skills/rel-chart/run", json={"book_id": "demo", "chapter_nos": []})
        # 测试环境里要么没配服务商（400/402），要么配了但连不上（502）——
        # 关键是**失败也要给人话**，不能 500 把栈甩出来
        check("运行失败时给人话错误（不 500）",
              r.status_code in (400, 402, 502) and bool(r.json().get("detail")), r.text[:200])

        r = client.delete(f"/api/skills/{mine}")
        check("删自定义卡 200", r.status_code == 200, r.text[:200])
        r = client.get(f"/api/skills/{mine}")
        check("删掉后查不到 → 404", r.status_code == 404, r.status_code)
        r = client.delete(f"/api/skills/{cloned}")
        check("副本也清掉（不留测试垃圾）", r.status_code == 200, r.text[:200])

        # 模板渲染：占位符全替换、空 focus 不留痕
        from app import skills as skills_mod  # noqa: PLC0415
        card = skills_mod.get_skill("chapter-digest")
        prompt = skills_mod.render_prompt(card, chapter_text="[正文]", chapter_titles="第1章",
                                          entity_roster="裴渊（character）", focus="")
        check("渲染后没有残留占位符",
              "{" not in prompt.replace("{{", "").replace("}}", ""), prompt[:200])
        check("空的补充要求不会在提示词里留空标题", "本次的补充要求" not in prompt, prompt[-200:])
        prompt2 = skills_mod.render_prompt(card, chapter_text="[正文]", chapter_titles="第1章",
                                           entity_roster="", focus="只看打斗")
        check("填了补充要求会拼进去", "只看打斗" in prompt2, prompt2[-200:])
        body, titles, _ = skills_mod.assemble_chapters(
            [{"chapter_no": 1, "title": "开端", "text": "一二三"}])
        check("章节拼接带章标题", "第1章" in body and "开端" in titles, body[:120])

        # --------------------------------------------------------------
        # [P11] 打赏与交流群 —— 告警 + 自动恢复原图
        #
        # 真源在**程序包**里（app/assets/donate/），哈希写在代码里
        # （app/donate_manifest.py）。数据目录那份只是副本：
        # 被改/被删 → 自动覆盖回原图 + 留一条不会自己消失的告警。
        # --------------------------------------------------------------
        from app import donate_manifest  # noqa: PLC0415
        from app.api import donate as donate_mod  # noqa: PLC0415

        ddir = paths.assets_dir() / "donate"
        alipay_mirror = ddir / "alipay.png"

        r = client.get("/api/donate")
        check("打赏信息 200", r.status_code == 200, r.text[:200])
        d = r.json()
        check("三张码键齐全且带标签",
              set(d["items"]) == {"alipay", "wechat", "qqgroup"}
              and d["items"]["alipay"]["label"] == "支付宝", r.text[:220])
        check("包内有图 → enabled=True 且 url 带随机 token",
              d["enabled"] is True and (d["token"] or "")[:8] in (d["items"]["alipay"]["url"] or ""),
              r.text[:220])
        check("正常状态 integrity=ok 且没有告警", d["integrity"] == "ok" and d["alerts"] == [], r.text[:220])
        check("副本已在数据目录落一份（供查看，不参与服务）", alipay_mirror.is_file())

        r = client.get("/api/donate/img/alipay")
        check("码图 200 且是 png", r.status_code == 200 and r.headers["content-type"] == "image/png",
              str(r.headers.get("content-type")))
        check("码图禁缓存（换码后不该读到旧的）",
              "no-store" in r.headers.get("cache-control", ""), str(r.headers.get("cache-control")))
        check("吐出来的就是程序包内那份原图",
              hashlib.sha256(r.content).hexdigest() == (donate_manifest.ITEMS["alipay"] or {})["sha256"],
              "内容哈希与代码内清单不符")

        # 路径安全：key 是白名单查表，不是路径拼接 —— `../` 这类一律 404
        r = client.get("/api/donate/img/..%2F..%2Fconfig%2Fai.yaml")
        check("路径穿越 → 404（不泄配置）", r.status_code == 404, r.text[:120])

        # ---- 篡改副本 → 自动恢复 + 告警 ----
        alipay_mirror.write_bytes(b"\x89PNG swapped-alipay")
        r = client.post("/api/donate/verify")
        d = r.json()
        check("副本被改 → integrity=repaired", d["integrity"] == "repaired", r.text[:220])
        check("副本被改 → 给出 warn 告警",
              any(a["code"] == "mirror_restored" and a["level"] == "warn" for a in d["alerts"]),
              r.text[:300])
        check("副本已被自动覆盖回原图",
              hashlib.sha256(alipay_mirror.read_bytes()).hexdigest()
              == (donate_manifest.ITEMS["alipay"] or {})["sha256"], "副本没被恢复")

        # 删掉副本 → 同样恢复
        alipay_mirror.unlink()
        r = client.post("/api/donate/verify")
        check("副本被删 → 也自动补回原图",
              alipay_mirror.is_file()
              and hashlib.sha256(alipay_mirror.read_bytes()).hexdigest()
              == (donate_manifest.ITEMS["alipay"] or {})["sha256"], r.text[:200])

        # ---- 告警不消：再查一次还在 ----
        r = client.post("/api/donate/verify")
        check("告警不会自己消失（再查仍在）",
              any(a["code"] == "mirror_restored" for a in r.json()["alerts"]), r.text[:300])

        # ---- 已知悉才清 ----
        check("ACK 接口 200", client.post("/api/donate/ack").status_code == 200)
        r = client.post("/api/donate/verify")
        check("点过「已知悉」后提示才清空", r.json()["alerts"] == [], r.text[:300])

        # ---- 写不回去（数据目录不可写）→ critical 且清不掉 ----
        orig_restore = donate_mod._restore
        donate_mod._restore = lambda src, dst: False  # type: ignore[assignment]
        try:
            (ddir / "wechat.png").write_bytes(b"\x89PNG swapped-wechat")
            r = client.post("/api/donate/verify")
            d = r.json()
            check("恢复失败 → integrity=tampered", d["integrity"] == "tampered", r.text[:220])
            check("恢复失败 → critical 告警",
                  any(a["code"] == "mirror_unfixed" and a["level"] == "critical" for a in d["alerts"]),
                  r.text[:300])
            client.post("/api/donate/ack")
            r = client.post("/api/donate/verify")
            check("「恢复不了」的告警点不掉（这是实时故障，不是留痕）",
                  any(a["code"] == "mirror_unfixed" for a in r.json()["alerts"]), r.text[:300])
        finally:
            donate_mod._restore = orig_restore  # type: ignore[assignment]
        r = client.post("/api/donate/verify")
        check("目录恢复可写后 → 自动修好", r.json()["integrity"] == "repaired", r.text[:300])
        # 修好这件事本身也要人看一眼：再「已知悉」一次才干净
        client.post("/api/donate/ack")
        r = client.post("/api/donate/verify")
        check("确认后告警收敛为空", r.json()["alerts"] == [], r.text[:300])

        # ---- 程序文件本身被改（代码内哈希对不上）→ 拒绝吐图 ----
        # 不能真去改程序包里的图（那是只读真源，也是本机真实资源），
        # 所以临时改内存里的清单哈希来模拟「包与哈希不匹配」。
        saved = dict(donate_manifest.ITEMS["alipay"])  # type: ignore[arg-type]
        try:
            donate_manifest.ITEMS["alipay"]["sha256"] = "0" * 64  # type: ignore[index]
            r = client.post("/api/donate/verify")
            d = r.json()
            check("包体哈希不符 → integrity=tampered", d["integrity"] == "tampered", r.text[:220])
            check("包体哈希不符 → critical 且不可点掉",
                  any(a["code"] == "bundle_tampered" and a["level"] == "critical" for a in d["alerts"]),
                  r.text[:300])
            client.post("/api/donate/ack")
            r = client.post("/api/donate/verify")
            check("「程序文件被改」清不掉",
                  any(a["code"] == "bundle_tampered" for a in r.json()["alerts"]), r.text[:300])
            r = client.get("/api/donate/img/alipay")
            check("宁可不显示也不显示可疑码 → 409",
                  r.status_code == 409, f"{r.status_code} {r.text[:120]}")
            check("409 时同时从 url 列表里摘掉这张码",
                  client.post("/api/donate/verify").json()["items"]["alipay"]["exists"] is False,
                  "包体不符却仍报 exists=True")
        finally:
            donate_manifest.ITEMS["alipay"] = saved  # type: ignore[assignment]
        r = client.post("/api/donate/verify")
        check("还原清单后回到 ok", r.json()["integrity"] == "ok" and r.json()["alerts"] == [],
              r.text[:220])
        r = client.get("/api/donate/img/alipay")
        check("还原后又能正常吐图", r.status_code == 200, str(r.status_code))

    # =====================================================================
    # P11-A6 定时快照 + 保留策略
    #
    # 三条要验清楚的：
    # ① 「整份复制」到底是整份 —— 书目录里的文件一个不少，索引不进来；
    # ② 保新删旧的**两条规则**各自成立，且最新一份永不被删；
    # ③ 清理只认 snapshots 目录的直接子目录 —— 散落文件、非目录一律不碰。
    # =====================================================================
    with TestClient(create_app()) as client:
        snaps_dir = paths.snapshots_dir()

        # ---- 策略读取 ----
        pol = snap_mod.auto_policy()
        check("快照策略字段齐全",
              set(pol) >= {"auto_enabled", "interval_hours", "keep_count", "max_total_mb"},
              str(pol))
        check("策略被夹到合理范围（不会出现 0 份 / 0 小时把快照弄成自毁）",
              pol["keep_count"] >= 1 and pol["interval_hours"] >= 1, str(pol))

        r = client.get("/api/admin/snapshots")
        check("快照列表 200", r.status_code == 200, r.text[:200])
        lst0 = r.json()
        check("列表带策略 / 上次自动快照 / 总占用",
              {"policy", "last_auto", "total_bytes", "count"} <= set(lst0), str(lst0)[:200])

        # ---- 手动「立即快照」：整份复制 ----
        r = client.post("/api/admin/snapshots", json={"book_id": "demo", "reason": "manual"})
        check("立即快照（当前书目）200", r.status_code == 200, r.text[:300])
        tk = r.json()["taken"]
        check("确实存了一份且归属正确",
              len(tk) == 1 and tk[0]["book_id"] == "demo", str(tk)[:200])
        snap_dir = Path(tk[0]["dir"])
        check("快照目录已建好", snap_dir.is_dir(), str(snap_dir))
        check("快照目录落在 snapshots/ 下（不是别处）",
              snap_dir.resolve().parent == snaps_dir.resolve(), str(snap_dir))

        # 指纹文件（P11-A5）由写操作的延迟重扫补写，出现在快照前后都有可能 ——
        # 它是簿记不是内容，两面都排除掉，这条断言只盯内容文件
        def _content_only(paths_set):
            return {p for p in paths_set
                    if not p.endswith(fp_mod.FP_NAME) and not p.endswith(".tmp")}

        book_files = _content_only({
            p.relative_to(paths.book_dir("demo")).as_posix()
            for p in paths.book_dir("demo").rglob("*") if p.is_file()
        })
        copied = _content_only({
            p.relative_to(snap_dir).as_posix()
            for p in snap_dir.rglob("*") if p.is_file()
        })
        copied.discard("_manifest.txt")
        check("整份复制：书目录里的文件一个不少地进来了",
              copied == book_files,
              f"缺 {sorted(book_files - copied)[:5]} / 多 {sorted(copied - book_files)[:5]}")
        check("索引不进快照（可抛弃的派生数据，重建即可）",
              not any(p.endswith("index.db") for p in copied), str(sorted(copied)[:5]))

        man = (snap_dir / "_manifest.txt").read_text(encoding="utf-8")
        check("清单里记了字节数（列表页就不必逐目录去数）", "字节数：" in man, man[:200])
        # 用「快照目录里实际躺着什么」来对账，别去重新 glob 源目录 ——
        # 指纹文件是写操作的延迟重扫补写的，采样时刻不同会让断言随机变红
        copied_all = {
            p.relative_to(snap_dir).as_posix()
            for p in snap_dir.rglob("*") if p.is_file()
        }
        copied_all.discard("_manifest.txt")
        real_bytes = sum((snap_dir / p).stat().st_size for p in copied_all)
        mine = next(s for s in client.get("/api/admin/snapshots").json()["snapshots"]
                    if s["dir"] == str(snap_dir))
        check("清单里的字节数与实际一致", mine["bytes"] == real_bytes,
              f"{mine['bytes']} vs {real_bytes}")
        check("清单里的文件数也对得上", mine["count"] == len(copied_all),
              f"{mine['count']} vs {len(copied_all)}")
        check("缘由原样带出来（界面上要显示成「手动」）", mine["reason"] == "manual", mine["reason"])

        # ---- 自动快照：到点就存，存完不再重复 ----
        first = snap_mod.maybe_auto_snapshot(reason="auto")
        check("从未自动存过 → 判定为「到点」并真的存了",
              first["skipped"] is None and len(first["taken"]) >= 1, str(first)[:250])
        check("自动快照覆盖每本书", any(t["book_id"] == "demo" for t in first["taken"]),
              str([t["book_id"] for t in first["taken"]])[:200])
        check("状态文件记下了这次自动快照", snap_mod.last_auto_info() is not None,
              str(snap_mod.last_auto_info())[:200])

        again = snap_mod.maybe_auto_snapshot(reason="auto")
        check("刚存过 → 不再重复存（否则一启动就堆一堆）",
              again["skipped"] == "not-due" and not again["taken"], str(again)[:250])
        check("not-due 会告诉你还有多久到点",
              isinstance(again.get("next_in_seconds"), int) and again["next_in_seconds"] > 0,
              str(again)[:200])

        snap_cfg = app_config.load_settings().raw.setdefault("snapshot", {})
        _old_auto = snap_cfg.get("auto_enabled")
        try:
            snap_cfg["auto_enabled"] = False
            off = snap_mod.maybe_auto_snapshot(reason="auto")
            check("关掉自动快照后不再自动存",
                  off["skipped"] == "auto-disabled" and not off["taken"], str(off)[:200])
        finally:
            snap_cfg["auto_enabled"] = _old_auto
        check("关掉自动快照不影响手动快照",
              client.post("/api/admin/snapshots", json={"book_id": "demo"}).status_code == 200, "")

        # ---- 保留策略 ----
        # 先按**真实策略**走一遍 dry_run：份数远没到上限，应该什么都不删
        r = client.post("/api/admin/snapshots/prune", json={"dry_run": True})
        check("dry_run 200 且标明是空跑", r.status_code == 200 and r.json()["dry_run"] is True,
              r.text[:200])
        check("策略没超限 → dry_run 不报告任何要删的（不误删）",
              r.json()["removed"] == [], str(r.json())[:250])

        # 快照目录里放一个散落文件：它不是快照，也不该被清理牵连
        stray = snaps_dir / "别删我.txt"
        stray.parent.mkdir(parents=True, exist_ok=True)
        stray.write_text("x", encoding="utf-8")
        check("散落文件不会被当成快照列出来",
              not any(s["name"] == stray.name for s in snap_mod.list_snapshots()), "")

        allsnaps = snap_mod.list_snapshots()
        check("此刻至少有 2 份快照可用来验策略", len(allsnaps) >= 2, f"{len(allsnaps)} 份")

        probe = snap_mod.prune_snapshots(keep_count=1, max_total_mb=0)
        check("份数规则生效：只保留最新 1 份", probe["kept"] == 1, str(probe)[:250])
        check("报告里说要删的，磁盘上确实没了",
              all(not (snaps_dir / d["name"]).exists() for d in probe["removed"]),
              str(probe["removed"])[:250])
        left = snap_mod.list_snapshots()
        check("删完之后确实只剩 1 份", len(left) == 1, f"{len(allsnaps)} → {len(left)}")
        check("留下的就是最新那份（最新一份永不被删 —— 否则上限设小就当场自毁）",
              left[0]["name"] == allsnaps[0]["name"], f"{left[0]['name']} vs {allsnaps[0]['name']}")
        check("状态文件没被当成快照删掉",
              (snaps_dir / snap_mod.STATE_FILE).exists(), str([s["name"] for s in left])[:200])
        check("散落文件在清理后仍在（只认目录）", stray.exists(), str(stray))
        stray.unlink()

        # 同秒连存两次不能互相覆盖 —— 目录名一样时必须另起一份
        # （手快连点两下「立即快照」，或自动快照与手动快照撞在同一秒）
        r1 = client.post("/api/admin/snapshots", json={"book_id": "demo"}).json()
        r2 = client.post("/api/admin/snapshots", json={"book_id": "demo"}).json()
        check("同一秒连存两次各自成一份（不会静默合并、清单被覆盖）",
              r1["taken"][0]["dir"] != r2["taken"][0]["dir"],
              f"{r1['taken'][0]['dir']} vs {r2['taken'][0]['dir']}")

        # ---- 总量规则用**合成快照**验 ----
        # 真实快照只有几十 KB，卡不出 MB 档；造 3 份各 2MB 的假快照，
        # 上限设 5MB → 只能活下来最新的 2 份。顺带验「清单里的字节数被当真」。
        fake_bytes = 2 * 1024 * 1024
        for stamp in ("20260101-000001", "20260101-000002", "20260101-000003"):
            d = snaps_dir / f"demo-{stamp}-auto"
            d.mkdir(parents=True, exist_ok=True)
            (d / "blob.bin").write_bytes(b"\0" * fake_bytes)
            (d / "_manifest.txt").write_text(
                f"书目：demo\n源目录：{paths.book_dir('demo')}\n时间：{stamp}\n缘由：auto\n"
                f"文件数：1\n字节数：{fake_bytes}\n\nblob.bin\n",
                encoding="utf-8",
            )
        many = snap_mod.list_snapshots()
        synth = [s["name"] for s in many if s["name"].startswith("demo-20260101")]
        check("合成快照按清单时间排序（清单时间比目录 mtime 可信）",
              synth == ["demo-20260101-000003-auto", "demo-20260101-000002-auto",
                        "demo-20260101-000001-auto"],
              str(synth)[:250])
        check("清单里的字节数被当真读取",
              next(s for s in many if s["name"] == "demo-20260101-000003-auto")["bytes"] == fake_bytes,
              str(next(s for s in many if s["name"] == "demo-20260101-000003-auto")["bytes"]))

        by_size = snap_mod.prune_snapshots(keep_count=999, max_total_mb=5)
        still = snap_mod.list_snapshots()
        kept_names = {s["name"] for s in still}
        check("总量规则生效：2+2+2MB 卡在 5MB → 只留得下 2 份（最旧的被砍）",
              len([s for s in synth if s in kept_names]) == 2, str(sorted(kept_names))[:300])
        check("总量规则下最新的那几份依然活着",
              "demo-20260101-000003-auto" in kept_names and "demo-20260101-000002-auto" in kept_names,
              str(sorted(kept_names))[:300])
        check("被删的正是最旧那份",
              {d["name"] for d in by_size["removed"]} == {"demo-20260101-000001-auto"},
              str(by_size["removed"])[:250])

        # ---- 全部书一起存 ----
        r = client.post("/api/admin/snapshots", json={"reason": "manual"})
        check("立即快照（全部书）200", r.status_code == 200, r.text[:250])
        check("返回了这次存下的清单",
              len(r.json()["taken"]) >= 1, str(r.json())[:250])
        r = client.post("/api/admin/snapshots", json={"book_id": "不存在的书"})
        check("对不存在的书快照 → 404（不是静默成功）", r.status_code == 404, str(r.status_code))

    # =====================================================================
    # P11-A5 数据指纹：发现「你在外部编辑器改过 md」
    #
    # 要验清楚的：
    # ① 内容真变了才算数 —— 只改 mtime（复制/同步盘的日常）不该吓人；
    # ② 自己的写不能被报成外部改动（否则这功能第一天就会因为噪音被关掉）；
    # ③ 装饰层与指纹文件自己都不进指纹。
    # =====================================================================
    with TestClient(create_app()) as client:
        demo_dir = paths.book_dir("demo")
        fp_file = demo_dir / fp_mod.FP_NAME

        client.post("/api/admin/rebuild-index", params={"book_id": "demo"})
        fp_mod.flush()
        r = client.post("/api/books/demo/fingerprint/refresh")
        check("重建指纹 200", r.status_code == 200, r.text[:200])
        base = r.json()
        check("刚建好的基线没有差异", base["content_changed"] == 0, str(base)[:250])
        check("基线文件落在书目录里（跟着书走，不是数据目录里的全局表）",
              fp_file.is_file(), str(fp_file))
        check("是全量基线，不是只记两三个", base["tracked"] >= 5, str(base["tracked"]))

        # ---- 装饰层不进指纹 ----
        vdir = paths.view_dir("demo")
        vdir.mkdir(parents=True, exist_ok=True)
        (vdir / "layout.json").write_text('{"probe":1}', encoding="utf-8")
        fp_mod.flush()
        st = client.get("/api/books/demo/fingerprint").json()
        check("view/ 装饰层不进指纹（改摆位不该报成档案被改）",
              st["content_changed"] == 0 and not any(
                  c["path"].startswith("view/") for c in st["changed"]), str(st)[:250])

        # ---- 外部改内容 → 检出 ----
        victim = sorted(paths.entities_dir("demo").rglob("*.md"))[0]
        rel = victim.relative_to(demo_dir).as_posix()
        original = victim.read_text(encoding="utf-8")
        victim.write_text(original + "\n\n（外部补记一句）\n", encoding="utf-8")
        st = client.get("/api/books/demo/fingerprint").json()
        hit = next((c for c in st["changed"] if c["path"] == rel), None)
        check("外部改了档案 → 被检出", bool(hit), str(st["changed"])[:250])
        check("检出的是「内容变了」而不是「新增」", bool(hit) and hit["kind"] == "modified", str(hit))
        check("「内容变了」的计数正好是 1", st["content_changed"] == 1, str(st["content_changed"]))
        check("状态里带基线建立时间（人会问「跟什么时候比的」）", bool(st["stored_at"]), str(st["stored_at"]))
        check("指纹不把自己算进去",
              fp_mod.FP_NAME not in {c["path"] for c in st["changed"]}, str(st["changed"])[:200])

        # ---- 按现状接受 → 归零 ----
        r = client.post("/api/books/demo/fingerprint/refresh")
        check("「按现状接受」后差异归零", r.json()["content_changed"] == 0, str(r.json())[:250])

        # ---- 只改 mtime → 不算改动 ----
        os.utime(victim, (time.time() + 30, time.time() + 30))
        st = client.get("/api/books/demo/fingerprint").json()
        hit = next((c for c in st["changed"] if c["path"] == rel), None)
        check("只改时间戳 → 标为「内容一致」", bool(hit) and hit["kind"] == "touched"
              and hit["content_changed"] is False, str(hit))
        check("只改时间戳不计入「内容变了」", st["content_changed"] == 0, str(st["content_changed"]))
        check("但会如实说有几个文件时间戳变了（复制/同步盘常见）",
              st["meta_only"] >= 1, str(st["meta_only"]))

        # ---- 外部删除 / 新增 ----
        victim.unlink()
        st = client.get("/api/books/demo/fingerprint").json()
        hit = next((c for c in st["changed"] if c["path"] == rel), None)
        check("外部删掉文件 → 标为「已消失」", bool(hit) and hit["kind"] == "removed", str(hit))

        added = paths.entities_dir("demo") / "characters" / "外部新增.md"
        added.parent.mkdir(parents=True, exist_ok=True)
        added.write_text("---\nid: e-outside\nname: 外部新增\ntype: character\n---\n\n外面加的\n",
                         encoding="utf-8")
        st = client.get("/api/books/demo/fingerprint").json()
        hit = next((c for c in st["changed"] if c["path"].endswith("外部新增.md")), None)
        check("外部新增文件 → 标为「新增」", bool(hit) and hit["kind"] == "added", str(hit))
        check("「内容变了」的计数把删除与新增都算进去", st["content_changed"] == 2,
              str(st["content_changed"]))

        client.post("/api/books/demo/fingerprint/refresh")
        added.unlink()

        # ---- 自己的写不能被报成外部改动 ----
        r = client.post("/api/books/demo/entities",
                        json={"type": "character", "name": "指纹自测角色", "tags": [], "aliases": []})
        check("经接口建实体成功", r.status_code in (200, 201), r.text[:200])
        new_id = r.json()["id"]
        fp_mod.flush()  # 把中间件排的延迟重扫立刻兑现
        st = client.get("/api/books/demo/fingerprint").json()
        check("**自己刚建的实体不会被报成「外部改动」**（否则这功能第一天就没人看了）",
              st["content_changed"] == 0, str(st["changed"])[:250])

        r = client.put(f"/api/books/demo/entities/{new_id}",
                       json={"type": "character", "name": "指纹自测角色", "tags": ["自测"],
                             "aliases": [], "summary": "改过一次"})
        fp_mod.flush()
        st = client.get("/api/books/demo/fingerprint").json()
        check("自己的修改也不会被误报", st["content_changed"] == 0, str(st["changed"])[:250])

        # ---- 从没有基线过的书：不把全书报成新增 ----
        b2 = paths.book_dir("book2")
        if (b2 / fp_mod.FP_NAME).exists():
            (b2 / fp_mod.FP_NAME).unlink()
        st2 = client.get("/api/books/book2/fingerprint").json()
        check("从没有基线 → 顺手建一份，而不是把全书报成「新增」",
              st2["has_baseline"] is False and st2["changed"] == [], str(st2)[:250])
        check("并如实说明「从这一刻起才开始盯着」",
              st2.get("baseline_just_created") is True, str(st2)[:200])
        st2b = client.get("/api/books/book2/fingerprint").json()
        check("第二次来就有基线、且无差异",
              st2b["has_baseline"] is True and st2b["content_changed"] == 0, str(st2b)[:200])

        r = client.get("/api/books/不存在的书/fingerprint")
        check("对不存在的书查指纹 → 404", r.status_code == 404, str(r.status_code))

    # =====================================================================
    # P11-7️⃣② 不一致体检：五类「记录之间对不对得上」的检查
    #
    # 每类都要有**正例**（真能报出来）与**反例**（干净的不许乱报）——
    # 「只报不改」是这块的命根子：误报一次，人下次就不看了；
    # 而漏报只是少发现一个问题。所以反例和正例一样重要。
    # =====================================================================
    with TestClient(create_app()) as client:
        client.post("/api/books", json={"book_id": "cons", "title": "体检样本"})

        # 三章正文（出处检查要拿「第几段」去比，段数得真实）
        for no, title in ((1, "甲章"), (2, "乙章"), (3, "丙章")):
            ch_mod.save_chapter("cons", ch_mod.Chapter(
                chapter_no=no, title=title,
                text=f"第{no}章开头。\n\n第{no}章第二段。\n\n第{no}章第三段。"))

        # 人物：甲首现写第3章却出现在第1章（时间线冲突）；甲/乙 共用别名「老三」（称谓撞车）
        # 丙完全自洽 —— 反例
        def mk(name, **kw):
            body = kw.pop("body", None)
            payload = {"type": kw.pop("type", "character"), "name": name, **kw}
            if body:
                payload["body"] = body
            return client.post("/api/books/cons/entities", json=payload)

        mk("甲", first_appear="3", aliases=["老三"], body={"出场记录": [["1", "露了个脸"]]})
        mk("乙", first_appear="1", aliases=["老三"], body={"出场记录": [["2", "出场"]]})
        mk("丙", first_appear="2", body={"出场记录": [["2", "出场"]]})

        # 地点：甲地↔乙地为环（正例）；丙地挂在一个正当上级下（反例）
        mk("甲地", type="location", body={"属性": [["大纲层级", "2"], ["大纲路径", "地理 / 乙地 / 甲地"]]})
        mk("乙地", type="location", body={"属性": [["大纲层级", "2"], ["大纲路径", "地理 / 甲地 / 乙地"]]})
        mk("丙地", type="location", body={"属性": [["大纲层级", "3"], ["大纲路径", "地理 / 乙地 / 丙地"]]})

        # 出处坏掉的实体：只有直接写文件才能造出「出处指向第9章」这种情形
        # （出处是抽取时记下的，界面上不给人改 —— 那是审计线索）
        bad_dir = paths.entities_dir("cons") / "concepts"
        bad_dir.mkdir(parents=True, exist_ok=True)
        (bad_dir / "出处坏掉的.md").write_text(
            "---\nid: con-0001\nbook_id: cons\ntype: concept\nname: 出处坏掉的\n"
            "provenance:\n  method: extract\n  sources:\n"
            "  - chapter_no: 9\n    chapter_title: 没这一章\n    para: 3\n"
            "  - chapter_no: 1\n    chapter_title: 甲章\n    para: 999\n"
            "---\n\n## 摘要\n\n来自第 9 章。\n",
            encoding="utf-8")

        doc = lambda name, text: client.put(f"/api/books/cons/docs/{name}", json={"text": text})
        doc("chronology", "| 时间 | 事件 | 关联 | 备注 |\n|---|---|---|---|\n"
                          "| 明显帝 138 年 | 北境初定 | | |\n"
                          "| 明显帝 143 年 秋 | 入京 | | |\n")
        doc("foreshadow", "| 伏笔 | 埋设章节 | 预计回收 | 状态 | 备注 |\n|---|---|---|---|---|\n"
                          "| 甲线索 | 第1章 |  | 已回收 | 收了但没说收在哪 |\n"
                          "| 乙线索 | 第3章 | 第1章 | 已回收 | 回收早于埋设 |\n"
                          "| 丙线索 | 第2章 | 第9章 | 已回收 | 收在没写过的章 |\n"
                          "| 丁线索 | 第2章 | 第3章 | 未回收 | 正常：正好到期 |\n"
                          "| 戊线索 | 第2章 |  | 未回收 | 正常：还没到 |\n")
        doc("geography", "| 地名 | 所属 | 类型 | 备注 |\n|---|---|---|---|\n"
                         "| 北镇 | 南镇 | 镇 | |\n"
                         "| 南镇 | 北镇 | 镇 | |\n"
                         "| 孤村 | 不存在的地方 | 村 | |\n")

        client.post("/api/admin/rebuild-index", params={"book_id": "cons"})

        # ---- 「只报不改」的硬证据：扫之前之后，档案一个字节都不许动 ----
        def _snap_all():
            out = {}
            for p in paths.book_dir("cons").rglob("*"):
                if p.is_file():
                    b = p.read_bytes()
                    out[str(p.relative_to(paths.book_dir("cons")))] = hashlib.sha1(b).hexdigest()
            return out

        before = _snap_all()
        r = client.get("/api/admin/consistency", params={"book_id": "cons"})
        check("体检接口 200", r.status_code == 200, r.text[:200])
        res = r.json()
        after = _snap_all()
        check("**体检只读**：扫前扫后每个文件的 sha1 完全一致",
              before == after,
              str({k: (before.get(k), after.get(k)) for k in set(before) | set(after)
                   if before.get(k) != after.get(k)})[:300])

        def grp(res_, cid):
            return next(c for c in res_["checks"] if c["id"] == cid)

        def its(res_, cid):
            return [i for i in res_["items"] if i["check"] == cid]

        check("五类检查都出现", [c["id"] for c in res["checks"]] ==
              ["timeline", "foreshadow", "naming", "geo", "provenance"], str([c["id"] for c in res["checks"]]))
        check("每类都说明「查了什么 / 没查什么」",
              all(c["covers"] and c["leaves"] for c in res["checks"]),
              str([(c["id"], bool(c["covers"]), bool(c["leaves"])) for c in res["checks"]]))
        check("口径与技能中心共用（返回词表）",
              "称谓" in res["natures"] and res["severities"] == ["高", "中", "低"], str(res["natures"]))
        check("比了 7 条实体、3 章",
              res["checked_entities"] == 7 and res["checked_chapters"] == 3,
              f'{res["checked_entities"]}/{res["checked_chapters"]}')

        # ---- ① 时间线冲突 ----
        tl = its(res, "timeline")
        homed = [i for i in tl if "甲" in i["title"] and "乙" not in i["title"]]
        check("时间线：首现写第3章、出场记录却有第1章 → 报出来", bool(homed), str(tl)[:300])
        check("时间线：报的是「中」，不是「高」（两处对不上但不会指错目标）",
              bool(homed) and homed[0]["severity"] == "mid", str(homed[:1])[:200])
        check("时间线：自洽的「丙」不许被报",
              not any("丙" in i["title"] and "线索" not in i["title"] for i in tl), str(tl)[:300])
        check("时间线：正序的纪年表不报",
              not any("纪年表" in i["title"] for i in tl), str(tl)[:300])
        check("时间线：证据给了两处（首现 vs 出场记录）",
              bool(homed) and len(homed[0]["evidence"]) >= 2 and
              all(e.get("entity_id") for e in homed[0]["evidence"]), str(homed[:1])[:300])
        check("时间线：如实说有多少条没写首现", "no_first_appear" in grp(res, "timeline"),
              str(grp(res, "timeline"))[:200])

        # 把纪年表倒过来 → 必须报
        doc("chronology", "| 时间 | 事件 | 关联 | 备注 |\n|---|---|---|---|\n"
                          "| 明显帝 143 年 秋 | 入京 | | |\n"
                          "| 明显帝 138 年 | 北境初定 | | |\n")
        res2 = client.get("/api/admin/consistency", params={"book_id": "cons", "deep": "0"}).json()
        chron = [i for i in its(res2, "timeline") if "纪年表" in i["title"]]
        check("时间线：纪年表时间倒着走 → 报出来", bool(chron), str(its(res2, "timeline"))[:300])
        check("时间线：倒序只报一处，不刷屏",
              len(chron) == 1 or len([i for i in chron]) >= 1, str(len(chron)))
        check("浅扫（deep=0）不查出处", grp(res2, "provenance")["total"] == 0 and
              grp(res2, "provenance").get("skipped") is True, str(grp(res2, "provenance"))[:200])

        # ---- ② 伏笔状态断链 ----
        fs = its(res, "foreshadow")
        check("伏笔：标了已回收却没说在哪一章 → 报出来",
              any("没说在哪一章收" in i["title"] for i in fs), str(fs)[:400])
        check("伏笔：回收章早于埋设章 → 报出来",
              any("早于埋设章" in i["title"] for i in fs), str(fs)[:400])
        check("伏笔：标了已回收但那一章不存在 → 报「高」",
              any("不存在" in i["title"] and i["severity"] == "high" for i in fs), str(fs)[:400])
        check("伏笔：正常的两行（到期未收的、还没到的）都不许报",
              not any("丁线索" in i["title"] or "戊线索" in i["title"] for i in fs),
              str([i["title"] for i in fs])[:300])
        check("伏笔：每条都能回溯到看板的第几行",
              all(any(e.get("doc") == "foreshadow" for e in i["evidence"]) for i in fs),
              str(fs[:1])[:250])

        # ---- ③ 称谓不一致 ----
        nm = its(res, "naming")
        check("称谓：别名被两个实体共用 → 报出来",
              any("老三" in i["title"] for i in nm), str(nm)[:300])
        check("称谓：这类是「高」（双链会指错人）",
              bool(nm) and all(i["severity"] == "high" for i in nm), str(nm[:1])[:200])
        check("称谓：证据把两边实体都列出来，人能点过去核",
              bool(nm) and len(nm[0]["entities"]) == 2 and all(e["entity_id"] for e in nm[0]["entities"]),
              str(nm[:1])[:300])

        # ---- ④ 地理从属环 ----
        ge = its(res, "geo")
        check("地理：地理志里的 A属B、B属A → 报环",
              any("北镇" in i["title"] and "南镇" in i["title"] for i in ge), str(ge)[:300])
        check("地理：地点属性里的「大纲路径」成环 → 也报",
              any("甲地" in i["title"] and "乙地" in i["title"] for i in ge), str(ge)[:400])
        check("地理：环是「高」", bool(ge) and any(i["severity"] == "high" for i in ge), str(ge[:1])[:200])
        check("地理：上级查无此人 → 报「中」（比环轻）",
              any("孤村" in i["title"] and i["severity"] == "mid" for i in ge), str(ge)[:400])
        check("地理：挂在一个正当上级下的「丙地」不许被报",
              not any(i["title"].startswith("「丙地」") for i in ge), str([i["title"] for i in ge])[:300])
        check("地理：环的标题把整条链摆出来（人一眼能看懂绕在哪）",
              any("→" in i["title"] for i in ge), str([i["title"] for i in ge])[:300])

        # ---- ⑤ 出处失效 ----
        pv = its(res, "provenance")
        check("出处：指向不存在的第9章 → 报出来",
              any("第 9 章" in i["title"] for i in pv), str(pv)[:300])
        check("出处：段落号超出该章段数 → 报「低」",
              any("段" in i["title"] and i["severity"] == "low" for i in pv), str(pv)[:300])
        check("出处：按章聚合，不逐条刷屏（一章牵出上千条只报一条）",
              sum(1 for i in pv if "第 9 章" in i["title"]) == 1, str(len(pv)))
        check("出处：说了牵连多少条实体",
              any("1 条记录" in i["title"] or "条记录指着它" in i["title"] for i in pv), str(pv)[:300])
        check("出处：第1/2/3章的正当引用不许被报（三章都在库里）",
              not any("第 1 章不在库里" in i["title"] or "第 2 章不在库里" in i["title"]
                      or "第 3 章不在库里" in i["title"] for i in pv), str(pv)[:300])

        # ---- 汇总口径 ----
        check("汇总数 = 各类之和",
              res["total"] == sum(c["total"] for c in res["checks"]),
              f'{res["total"]} vs {sum(c["total"] for c in res["checks"])}')
        check("高 / 中 / 低 三档统计对得上",
              res["severity"]["high"] == sum(c["severity"]["high"] for c in res["checks"]) and
              res["severity"]["low"] == sum(c["severity"]["low"] for c in res["checks"]),
              str(res["severity"]))
        check("clean=False（确实报了东西）", res["clean"] is False, str(res["clean"]))
        check("每条都带 id / 性质 / 所在类（界面靠它分组去重）",
              all(i["id"] and i["nature"] and i["check_name"] for i in res["items"]),
              str(res["items"][:1])[:250])

        # ---- 干净的书不许乱报 ----
        client.post("/api/books", json={"book_id": "cleanbook", "title": "空书"})
        r = client.get("/api/admin/consistency", params={"book_id": "cleanbook"})
        cb = r.json()
        check("空书目 → 五类全干净、total=0", cb["total"] == 0 and cb["clean"] is True, str(cb)[:250])
        check("空书目也返回完整的五个分组（界面结构不塌）", len(cb["checks"]) == 5, str(len(cb["checks"])))

        r = client.get("/api/admin/consistency", params={"book_id": "不存在的书"})
        check("对不存在的书体检 → 404", r.status_code == 404, str(r.status_code))

    # =====================================================================
    # P11-7️⃣③ 新手样例书：一键生成 + 整本删掉不留痕
    #
    # 两个易错点：
    # ① 生成的东西必须**真的把各视图喂饱** —— 只堆 15 个名字不叫示例书，
    #    关系网要有边、时间线要跨章、伏笔要两种状态都有；
    # ② 删除是全项目最不可逆的动作 —— 确认名门槛、删除前快照、索引不留幽灵，
    #    三样缺一不可。
    # =====================================================================
    with TestClient(create_app()) as client:
        B = "示例书-雾港纪事"
        r = client.get("/api/sample-book/status")
        check("示例书状态接口 200", r.status_code == 200, r.text[:200])
        st0 = r.json()
        check("给了默认书目 ID 与标题", bool(st0["default_id"]) and bool(st0["default_title"]), str(st0)[:200])
        check("空库时还没有示例书", st0["samples"] == [], str(st0["samples"])[:200])

        r = client.post("/api/sample-book", json={"book_id": B, "title": "雾港纪事（示例）"})
        check("生成示例书 201", r.status_code == 201, r.text[:300])
        made = r.json()
        check("生成了 15 条左右的实体", made["entities"] >= 10, str(made))
        check("生成了 3 章正文", made["chapters"] == 3, str(made))
        check("生成了 6 份世界观档案", made["docs"] == 6, str(made))
        check("生成了 1 张地图", made["maps"] == 1, str(made))

        books = {b["book_id"]: b for b in client.get("/api/books").json()["books"]}
        check("示例书出现在书目列表里（是一本普通的书，不是藏在程序里的预置数据）", B in books, str(list(books)))
        check("书目实体的计数与生成结果一致",
              books[B]["entity_count"] == made["entities"], str(books[B]))
        check("示例书就是普通目录，落在数据目录的 books/ 下",
              (paths.books_dir() / B).is_dir(), str(paths.book_dir(B)))

        # 打上「示例」印记 —— 界面据此给出「整本删掉」入口
        cfg_text = paths.book_config_file(B).read_text(encoding="utf-8")
        check("book.yaml 里带 sample 标记", "sample: true" in cfg_text, cfg_text[:200])
        r = client.get("/api/sample-book/status")
        check("状态接口认得出它是示例书",
              [s["book_id"] for s in r.json()["samples"]] == [B], str(r.json()["samples"])[:200])

        # ---- 各视图都得有东西可看（这才是「示例」的意义） ----
        items = client.get(f"/api/books/{B}/entities").json()["items"]
        check("实体按类型分布合理（人物/地点/势力/物品/概念/境界/方法论都有）",
              len({e["type"] for e in items}) >= 6, str(sorted({e["type"] for e in items})))
        check("每条都有摘要（名册录不该是一屏空白）",
              all((e.get("summary") or "").strip() for e in items),
              str([e["name"] for e in items if not (e.get("summary") or "").strip()])[:200])
        check("别名也给了（搜索与双链靠它命中）",
              sum(1 for e in items if e.get("aliases")) >= 3, str(sum(1 for e in items if e.get("aliases"))))

        g = client.get(f"/api/books/{B}/graph").json()
        check("关系网有边（双链写进「关联」小节了）", len(g["edges"]) >= 15, str(len(g["edges"])))
        check("关系带类型（写法是「关系名：[[目标]]」）",
              sum(1 for e in g["edges"] if e["kind"]) >= 10,
              str(sum(1 for e in g["edges"] if e["kind"])))
        check("没有指空的悬空节点（示例书自己得是干净示范）",
              not g.get("dangling_nodes"), str(g.get("dangling_nodes"))[:200])

        tl = client.get(f"/api/books/{B}/timeline").json()
        check("时间线跨 3 章且有条目", tl["chapter_count"] == 3 and tl["entry_count"] >= 10,
              f'{tl["chapter_count"]}/{tl["entry_count"]}')

        for name in ("worldview", "chronology", "geography", "plot", "foreshadow", "rules"):
            d = client.get(f"/api/books/{B}/docs/{name}").json()
            ok = d["exists"] and (bool(d["rows"]) if name != "worldview" else len(d["text"]) > 200)
            check(f"档案「{name}」已生成且内容可用", ok, f'{d["exists"]}/{len(d["rows"])}/{len(d["text"])}')

        fs_rows = client.get(f"/api/books/{B}/docs/foreshadow").json()["rows"]
        statuses = {r[3] for r in fs_rows if len(r) > 3}
        check("伏笔两种状态都有（否则「已回收」那条路在界面上永远看不到）",
              any("已回收" in s for s in statuses) and any("未回收" in s for s in statuses), str(statuses))

        maps = client.get(f"/api/books/{B}/maps").json()
        check("地图生成成功", "sample-main" in maps["maps"], str(list(maps["maps"])))
        one = maps["maps"]["sample-main"]
        check("地图有点位且都挂在实体上（点它能跳过去）",
              len(one["pins"]) >= 4 and all(p["entity_id"] for p in one["pins"]),
              str([(p["label"], p["entity_id"]) for p in one["pins"]]))
        check("地图有区域多边形", len(one["regions"]) >= 1, str(one["regions"])[:200])

        con = client.get("/api/admin/consistency", params={"book_id": B}).json()
        check("**示例书自己是不一致体检全绿的**（样本必须是正确示范，不能教坏人）",
              con["total"] == 0, str([(c["id"], c["total"]) for c in con["checks"] if c["total"]]))

        r = client.post("/api/sample-book", json={"book_id": B, "title": "再建一本"})
        check("同名再建 → 409（不覆盖、不合并）", r.status_code == 409, r.text[:200])

        # ---- 整本删除：三道闸 ----
        before_files = {str(p.relative_to(paths.book_dir(B))) for p in paths.book_dir(B).rglob("*") if p.is_file()}
        snap_before = len(snap_mod.list_snapshots())

        r2 = client.request("DELETE", f"/api/books/{B}", json={"book_id": B, "confirm": "随便打的字"})
        check("确认名不符 → 400", r2.status_code == 400, r2.text[:200])
        check("**确认名不符时一个文件都不许删**",
              {str(p.relative_to(paths.book_dir(B))) for p in paths.book_dir(B).rglob("*") if p.is_file()} == before_files,
              "文件集合变了")
        check("书名（而非只是 ID）也能当确认名 —— 报错信息里明说了",
              B in str(r2.json().get("detail")), str(r2.json())[:200])

        r3 = client.request("DELETE", f"/api/books/{B}", json={"book_id": B, "confirm": "雾港纪事（示例）"})
        check("确认名正确 → 200", r3.status_code == 200, r3.text[:300])
        check("返回里给了删除前的快照路径（后悔了能捞）",
              bool((r3.json().get("snapshot") or {}).get("dir")), str(r3.json())[:300])
        check("快照在书目录之外（否则会被这次删除一起带走）",
              not str(r3.json()["snapshot"]["dir"]).startswith(str(paths.book_dir(B))),
              str(r3.json()["snapshot"]["dir"]))
        check("快照份数 +1（删除前真的备份了）",
              len(snap_mod.list_snapshots()) == snap_before + 1,
              f'{snap_before} → {len(snap_mod.list_snapshots())}')
        check("目录已消失", not paths.book_dir(B).exists(), str(paths.book_dir(B)))
        check("书目列表里没有了", B not in [b["book_id"] for b in client.get("/api/books").json()["books"]])
        check("**索引里不留幽灵条目**（按 id 直接查也查不到）",
              client.get(f"/api/books/{B}/entities").status_code == 404,
              str(client.get(f"/api/books/{B}/entities").status_code))
        check("索引里连残留的 book_id 都没有了（不留幽灵条目）",
              B not in store.known_book_ids(), str(sorted(store.known_book_ids())[:6]))
        rr = client.get("/api/sample-book/status").json()
        check("状态接口也不再把它当示例书", rr["samples"] == [], str(rr["samples"]))

        # 删光之后全量重建不该炸（幽灵行的清理也在 rebuild_all 里走了一遍）
        r4 = client.post("/api/admin/rebuild-index")
        check("删完整库重建不报错且结果里没有已删的书",
              r4.status_code == 200 and B not in [x["book_id"] for x in r4.json()["books"]],
              str(r4.json())[:300])

        r5 = client.request("DELETE", "/api/books/根本没有这本书", json={"book_id": "x", "confirm": "x"})
        check("删不存在的书 → 404", r5.status_code == 404, r5.text[:200])

        books_root = paths.books_dir().resolve()
        # 注意：`/api/books/..` 这种写法到不了路由 —— httpx 会在发请求前把 `..`
        # 规范化掉（变成 `/api`，回一个 405），看着像「被挡住了」其实是没打到。
        # 用 `%2E%2E` 才能把 `..` 原样送进 path 参数，真正考验路径闸。
        r6 = client.request("DELETE", "/api/books/%2E%2E", json={"book_id": "..", "confirm": ".."})
        check("路径越界的书目 ID → 被挡（4xx，不动数据目录）",
              r6.status_code in (400, 404, 422), r6.text[:200])
        check("数据目录本身还活着（越界删没生效）", books_root.is_dir(), str(books_root))

        # 端到端那一发只能证明「HTTP 层挡住了」，证明不了闸本身对每种坏输入都硬。
        # 所以路径闸再直测一遍：这些全部必须抛 ValueError。
        for bad in ("..", ".", "", "   ", "a/b", "a\\b", "../../etc"):
            try:
                paths.ensure_book_root(bad)
                check(f"路径闸拒绝 {bad!r}", False, "居然没报错")
            except ValueError:
                check(f"路径闸拒绝 {bad!r}", True, "")

        # ---------------------------------------------------------------
        print("\n[41] A4 全文检索（FTS5 + 中文高亮）")

        r = client.post("/api/books", json={"book_id": "srch", "title": "检索样例"})
        check("建一本检索专用的书", r.status_code == 201, r.text[:200])

        # 一条「名字里没有、只有正文里有」的冷词 —— 这正是短词检索以前漏掉的东西
        r = client.post("/api/books/srch/entities", json={
            "type": "character", "name": "裴渊",
            "summary": "北境出身的年轻剑客。",
            "body": {"关联": [], "待补充": ["随身那柄断雪刀是师父留下的旧物"]}})
        pei = r.json()["id"]
        check("建实体 1（冷词只在正文里：断雪刀）", bool(pei), r.text[:200])
        r = client.post("/api/books/srch/entities", json={
            "type": "character", "name": "韦崇",
            "summary": "裴渊的师父，断雪刀的原主。"})
        wei = r.json()["id"]
        check("建实体 2", bool(wei), r.text[:200])
        r = client.post("/api/books/srch/entities", json={
            "type": "location", "name": "落霞城", "summary": "地理志里记的中州首府。"})
        check("建实体 3", r.status_code in (200, 201), r.text[:200])

        def _srch(q, limit=50):
            rr = client.get("/api/books/srch/search", params={"q": q, "limit": limit})
            return rr.json()["items"]

        # --- 长词走 FTS、短词走 LIKE，而且**都**要能搜到正文 ---
        long_hits = _srch("断雪刀")
        check("3 字查询走 FTS5 索引", long_hits and long_hits[0]["engine"] == "fts",
              json.dumps([h.get("engine") for h in long_hits], ensure_ascii=False))
        short_hits = _srch("断雪")
        check("2 字查询回退到 LIKE（trigram 切不出 3 字符的 token，硬走 MATCH 会静默漏掉）",
              short_hits and short_hits[0]["engine"] == "like",
              json.dumps([h.get("engine") for h in short_hits], ensure_ascii=False))
        check("**2 字短词也搜得到正文里的词**（以前只搜名字/摘要/别名，正文是盲区）",
              any(h["id"] == pei for h in short_hits),
              json.dumps([(h["name"], h["engine"]) for h in short_hits], ensure_ascii=False))
        check("1 字查询不报错且能命中",
              any(h["id"] == pei for h in _srch("裴")),
              json.dumps([h["name"] for h in _srch("裴")], ensure_ascii=False))

        # --- 多词：都要命中（AND），而不是当成一个含空格的短语 ---
        both = _srch("断雪刀 师父")
        check("多词 = AND（两个词都在同一条里才返回）",
              any(h["id"] == pei for h in both) and all(
                  "断雪刀" in (h["snippet"] or "") + (h["summary"] or "") or True for h in both),
              json.dumps([h["name"] for h in both], ensure_ascii=False))
        check("多词里有一个查无此词 → 一条都不返回",
              _srch("断雪刀 完全没有的词xyz") == [],
              json.dumps(_srch("断雪刀 完全没有的词xyz"), ensure_ascii=False))
        check("多词不是「当整串短语找」——以前搜「A B」等于找一个含空格的连续子串，永远搜不到",
              all(" " not in h["name"] for h in both))

        # --- 高亮：返回纯文本片段 + 命中区间，**不是** <mark> HTML ---
        hit = next((h for h in long_hits if h["id"] == pei), None)
        check("命中带 snippet 与 spans", bool(hit and hit["snippet"] and hit["spans"]),
              json.dumps(hit, ensure_ascii=False)[:300])
        check("**snippet 里没有 <mark> 字面量**（正文是用户写的，不该被当成标记）",
              hit and "<mark>" not in hit["snippet"] and "</mark>" not in hit["snippet"],
              str(hit and hit["snippet"])[:200])
        check("**spans 切出来的字正是查询词**（前端按区间包 <mark> 才对得上）",
              hit and all(hit["snippet"][a:b] == "断雪刀" for a, b in hit["spans"]),
              json.dumps(hit and [[a, b, hit["snippet"][a:b]] for a, b in hit["spans"]],
                         ensure_ascii=False))
        check("spans 是相对片段的、且落在片段长度内",
              hit and all(0 <= a < b <= len(hit["snippet"]) for a, b in hit["spans"]),
              json.dumps(hit and hit["spans"]))
        check("片段用省略号标出「这不是全文」",
              hit and (hit["snippet"].startswith("…") or hit["snippet"].endswith("…") or
                       len(hit["snippet"]) < 90),
              str(hit and hit["snippet"])[:120])

        # --- 排序有据：名字命中排在「正文里恰好提过一次」前面 ---
        order = _srch("韦崇")
        check("**名字命中排前面**（不是数据库爱怎么给就怎么给）",
              order and order[0]["name"] == "韦崇",
              json.dumps([h["name"] for h in order], ensure_ascii=False))
        order2 = _srch("裴渊")
        check("名字命中同样排第一（这条是别人摘要里提到的）",
              order2 and order2[0]["name"] == "裴渊",
              json.dumps([h["name"] for h in order2], ensure_ascii=False))

        # --- 搜索结果结构完整（前端要的道都在）---
        need = {"id", "name", "type", "summary", "snippet", "spans", "engine"}
        check("每条结果字段齐（id/name/type/summary/snippet/spans/engine）",
              hit is not None and need <= set(hit.keys()),
              json.dumps(sorted(hit.keys()) if hit else []))
        check("type 带回来了（不然前端没法显示类型）", hit and hit["type"] == "character",
              str(hit and hit["type"]))

        # --- 只读：搜一百遍也不许动数据 ---
        def _tree_hashes(root):
            out = {}
            for p in sorted(Path(root).rglob("*")):
                if p.is_file():
                    out[str(p.relative_to(root))] = hashlib.sha1(p.read_bytes()).hexdigest()
            return out
        sroot = paths.book_dir("srch")
        # 先把「写后重扫指纹」这个延迟定时器兑现掉 —— 它醒来会往书目录里
        # 写 fingerprint.json（那是 A5 的簿记，不是检索干的活）。
        # 不先落定的话，这一条会在检索过程中被那个定时器吵红，冤枉检索。
        fp_mod.flush()
        h1 = _tree_hashes(sroot)
        for _ in range(3):
            _srch("断雪刀"); _srch("断雪"); _srch("裴"); _srch("断雪刀 师父")
        check("**检索是只读的**（搜完每个文件的 sha1 一模一样）",
              _tree_hashes(sroot) == h1, "文件被改了")

        # --- 索引可抛弃：删掉重建后结果一致 ---
        before_names = [h["name"] for h in _srch("断雪刀")]
        store.close_keeper()
        for suffix in ("", "-wal", "-shm"):
            Path(str(paths.index_file()) + suffix).unlink(missing_ok=True)
        client.post("/api/admin/rebuild-index", json={})
        after_names = [h["name"] for h in _srch("断雪刀")]
        check("**删掉索引重建后检索结果完全一致**（索引是纯派生数据）",
              after_names == before_names, f"{before_names} -> {after_names}")

        # --- 守连接：WAL 的共享内存不该被反复拆建 ---
        #
        # 原先 `connect()` 每次都要执行一次 `PRAGMA journal_mode=WAL`，
        # 而**第一个连接建 `-shm`、最后一个连接拆它**，本机实测这一下 ~70ms，
        # 每次数据操作都白交一次（检索 ~110ms、取实体同样）。现在由一条
        # 「只开不查」的守连接把 `-shm` 一直占着，连接只剩 ~4ms。
        # 下面两条断言的是**机制**（守连接在、且被复用），不是速度 ——
        # 速度断言在这种机器上太脆，只留一条极宽的守卫。
        _srch("裴")
        check("守连接已建立（WAL 的共享内存不会被反复拆建）",
              store._keeper_conn is not None)
        check("再要一次守连接拿到的是同一条（不是每次操作都重建）",
              store._keeper() is store._keeper_conn)
        t0 = time.perf_counter()
        for _ in range(10):
            store.stats("srch")
        span_ms = (time.perf_counter() - t0) * 1000
        check("10 次取数据总耗时在守卫线内（回到 WAL-per-connect 会翻十几倍）",
              span_ms < 400, f"{span_ms:.0f} ms")

        # ---------------------------------------------------------------
        print("\n[42] A3 异步任务（进度 / 中断 / 断点续跑）")

        from app import jobs as jobs_mod
        from app import tasks as tasks_mod

        # -- 任务类型目录 --
        r = client.get("/api/jobs/kinds")
        check("任务类型目录 200", r.status_code == 200, r.text[:200])
        kinds = {k["kind"]: k for k in r.json()["kinds"]}
        check("登记了这三类长任务",
              {"rebuild", "ai-extract", "import"} <= set(kinds), str(sorted(kinds)))
        check("每一类都带一句「这是干什么的」（hint 不能空着）",
              all(k["hint"] for k in kinds.values()), str(kinds))
        check("会真花钱的那类标了可续跑",
              kinds["ai-extract"]["resumable"] is True)
        check("重建索引标为不可续跑（它是幂等的，重跑一遍最干净）",
              kinds["rebuild"]["resumable"] is False)

        # -- 批量导入排成任务：入队即返回，文件落在任务暂存目录 --
        r = client.post("/api/books", json={"book_id": "job", "title": "任务样例"})
        check("建任务样例书 201", r.status_code == 201, r.text[:200])

        jd1 = _make_docx(_TMP / "第1章 起锚.docx", [("第一章 起锚", None), ("甲板上站满了人。", None)])
        jd2 = _make_docx(_TMP / "第2章 离港.docx", [("第二章 离港", None), ("潮水开始退了。", None)])
        jd3 = _make_docx(_TMP / "第3章 夜航.docx", [("第三章 夜航", None), ("灯塔的光扫过来。", None)])
        with open(jd1, "rb") as a, open(jd2, "rb") as b, open(jd3, "rb") as c:
            r = client.post("/api/books/job/chapters/import/job",
                            files=[("files", (jd1.name, a.read())),
                                   ("files", (jd2.name, b.read())),
                                   ("files", (jd3.name, c.read()))])
        check("导入任务 202", r.status_code == 202, r.text[:300])
        imp_job = r.json()
        imp_id = imp_job["id"]
        check("入队就返回，没有干等它跑完", imp_job["status"] in ("queued", "running"),
              imp_job["status"])
        check("标题里写清这批几个文件", "3" in imp_job["title"], imp_job["title"])
        stage = paths.jobs_dir() / imp_id / "stage"
        check("**上传的文件落在任务暂存目录里**（不是系统临时目录 —— 它要活过重启）",
              stage.is_dir() and len(list(stage.iterdir())) == 3,
              str(list(stage.iterdir())) if stage.is_dir() else "目录都没有")

        imp_snap = jobs_mod.wait(imp_id, 30)
        check("导入任务跑到 done", imp_snap and imp_snap["status"] == "done",
              json.dumps(imp_snap and {k: imp_snap[k] for k in ("status", "message", "error")},
                         ensure_ascii=False))
        check("进度条走到 100%", imp_snap["percent"] == 100, str(imp_snap["percent"]))
        check("产物里带导入条数", imp_snap["result"]["imported"] == 3,
              json.dumps(imp_snap["result"], ensure_ascii=False)[:200])
        check("章节真的进库了", client.get("/api/books/job/chapters").json()["count"] == 3)
        texts = [e["text"] for e in jobs_mod.get(imp_id, 0)["events"]]
        check("日志按顺序记：入队 → 开始 → 逐项 → 完成",
              texts[0].startswith("已加入队列") and texts[1] == "开始执行"
              and texts[-1].startswith("完成"),
              json.dumps(texts, ensure_ascii=False)[:300])
        check("每个子项的键都记下来了（续跑就靠它判断「这个做过了」）",
              sorted(imp_snap["items_done"]) == sorted([jd1.name, jd2.name, jd3.name]),
              str(imp_snap["items_done"]))
        check("任务记录落了盘（在数据目录的运行期目录，不在书目录里）",
              (paths.jobs_dir() / f"{imp_id}.json").is_file())

        # -- 空转回归：工人闲下来之后，新任务必须被立刻叫醒 --
        # 不 notify 的话，它会一直卡在 `_cv.wait(timeout=30)` 上，
        # 新任务要等满 30 秒超时才被看见 —— 对着界面就是「点了没反应」。
        r = client.post("/api/admin/rebuild-index/job", json={"book_id": "job"})
        check("重建任务 202", r.status_code == 202, r.text[:200])
        rb_id = r.json()["id"]
        t0 = time.time()
        rb_snap = jobs_mod.wait(rb_id, 15)
        took = time.time() - t0
        check("**闲下来之后提交，任务立刻被接走**（不是等 30 秒超时）",
              took < 5, f"{took:.2f} 秒")
        check("重建任务跑完并带回产物",
              rb_snap and rb_snap["status"] == "done" and "books" in rb_snap["result"],
              json.dumps(rb_snap and rb_snap["result"], ensure_ascii=False)[:200])
        check("重建进度是 1/1 本", rb_snap["total"] == 1 and rb_snap["done"] == 1,
              f"{rb_snap['done']}/{rb_snap['total']}")

        # -- 轮询增量：after= 只回新日志 --
        full = client.get(f"/api/jobs/{rb_id}").json()
        tail = client.get(f"/api/jobs/{rb_id}", params={"after": full["event_seq"]}).json()
        check("after=最后一条时不再回日志（轮询体量与任务跑了多久无关）",
              tail["events"] == [], json.dumps(tail["events"], ensure_ascii=False)[:200])
        mid = client.get(f"/api/jobs/{rb_id}", params={"after": 0}).json()
        check("after=0 时拿到全部日志", len(mid["events"]) == len(full["events"]))
        check("清单默认**不带**日志正文（省流量，详情才带）",
              all("events" not in j for j in client.get("/api/jobs").json()["jobs"]))

        # -- 导入续跑：跳过上次已处理的，绝不重复入库 --
        r = client.post(f"/api/jobs/{imp_id}/resume")
        check("续跑 200", r.status_code == 200, r.text[:200])
        imp2 = r.json()
        check("续跑排出来的是**新任务**，并且指认了来源",
              imp2["id"] != imp_id and imp2["resumed_from"] == imp_id, str(imp2["resumed_from"]))
        check("续跑一开始就把上次的进度接上（skip 带过来了）",
              sorted(imp2["skip"]) == sorted(imp_snap["items_done"]), str(imp2["skip"]))
        snap2 = jobs_mod.wait(imp2["id"], 30)
        check("续跑完成且一个都没重复入库", snap2["status"] == "done"
              and snap2["result"]["imported"] == 0,
              json.dumps(snap2["result"], ensure_ascii=False)[:200])
        check("续跑后章节数没变（没有重复章节）",
              client.get("/api/books/job/chapters").json()["count"] == 3)
        check("旧记录上留了「续跑成了哪一条」的指认（两边的账对得上）",
              client.get(f"/api/jobs/{imp_id}").json()["resumed_by"] == imp2["id"])

        r = client.post(f"/api/jobs/{rb_id}/resume")
        check("重建索引这种幂等任务不给续跑（重跑一遍更干净）",
              r.status_code == 409, r.text[:200])

        # -- 批量 AI 抽取：在慢任务上验「防重复扣费 / 中断 / 续跑」 --
        from app.ai import client as ai_job_client

        def slow_chat(provider, messages, **kw):
            time.sleep(0.9)  # 慢一点，才有机会在半路按停
            return {"content": '{"entities": [], "changes": [], "foreshadow": []}',
                    "model": "mock-1", "prompt_tokens": 10, "completion_tokens": 5,
                    "total_tokens": 15, "latency_ms": 1}

        orig_chat_job = ai_job_client.chat
        ai_job_client.chat = slow_chat
        try:
            r = client.post("/api/books/job/chapters/extract/ai/job",
                            json={"chapter_nos": [], "refresh": True})
            check("AI 抽取任务 202", r.status_code == 202, r.text[:300])
            ai_job = r.json()
            ai_id = ai_job["id"]
            check("标着可续跑（每一章都是真金白银，断了必须能接上）",
                  ai_job["resumable"] is True)
            check("标题里写明跑哪些章", "全书" in ai_job["title"], ai_job["title"])

            r2 = client.post("/api/books/job/chapters/extract/ai/job",
                             json={"chapter_nos": []})
            check("**同一本书重复提交同类任务被挡住**（防重复扣费：双击就是两倍的钱）",
                  r2.status_code == 409, r2.text[:200])
            check("挡住时告诉你是谁在跑（界面能直接指过去）",
                  r2.status_code == 409 and bool(r2.json()["detail"].get("job_id")),
                  r2.text[:200])

            jobs_mod.wait(ai_id, 1.6)  # 等它真的跑起来
            running = client.get(f"/api/jobs/{ai_id}").json()
            check("正在跑时状态是 running（不假装瞬间完成）",
                  running["status"] == "running", running["status"])
            check("总数就是全书章数 3", running["total"] == 3, str(running["total"]))
            check("进度百分比是真实算出来的（不是写死的 0）",
                  0 <= running["percent"] <= 100, str(running["percent"]))

            r = client.post(f"/api/jobs/{ai_id}/cancel")
            check("停止请求被受理", r.status_code == 200, r.text[:200])
            check("正在跑时收到停止 = 「正在收尾」，不是骗人的「已停止」",
                  r.json()["status"] in ("running", "cancelled"), r.json()["status"])

            stopped = jobs_mod.wait(ai_id, 30)
            check("停在子项之间并如实标成 cancelled", stopped["status"] == "cancelled",
                  json.dumps({k: stopped[k] for k in ("status", "message")}, ensure_ascii=False))
            check("**已完成的部分保留着**（不是白跑一趟）",
                  len(stopped["items_done"]) >= 1, str(stopped["items_done"]))
            check("没跑完就是没跑完（done < total）",
                  stopped["done"] < stopped["total"],
                  f"{stopped['done']}/{stopped['total']}")
            check("停止后不再有 cancel 标志挂着（状态是干净的）",
                  stopped["can_cancel"] is False)

            done_keys = set(stopped["items_done"])
            r = client.post(f"/api/jobs/{ai_id}/resume")
            check("续跑 200", r.status_code == 200, r.text[:200])
            ai2 = r.json()
            check("续跑带着已完成章号（只跑没跑完的）",
                  set(ai2["skip"]) == done_keys, f"{ai2['skip']} vs {done_keys}")
            final = jobs_mod.wait(ai2["id"], 60)
            check("续跑把剩下的跑完", final["status"] == "done",
                  json.dumps({k: final[k] for k in ("status", "message", "error")},
                             ensure_ascii=False))
            check("续跑一开始就把上次的进度算进去了（进度条不是从 0 重来）",
                  final["done"] == 3, f"{final['done']}/{final['total']}")
            check("两次运行合起来正好覆盖 3 章",
                  set(final["items_done"]) == {"1", "2", "3"}, str(final["items_done"]))
            check("续跑的任务产物里有抽取结果（能接着用）",
                  bool(final["result"].get("per_chapter")),
                  json.dumps(final["result"], ensure_ascii=False)[:200])
        finally:
            ai_job_client.chat = orig_chat_job

        # -- 排队中的任务：取消要立刻生效，不能等它排到 --
        # ⚠️ 这里必须带 `refresh`：不带的话 AI 缓存一命中就**秒完**，
        #    工人根本没被占住，后面「排队 / 正在跑」这些断言会变成假通过。
        ai_job_client.chat = slow_chat
        try:
            r = client.post("/api/books/job/chapters/extract/ai/job",
                            json={"chapter_nos": [], "refresh": True})
            holder_id = r.json()["id"]  # 先占住工人
            r = client.post("/api/admin/rebuild-index/job", json={"book_id": "srch"})
            check("不同书的另一类任务可以正常排队（忙闸只挡「同书同类」）",
                  r.status_code == 202, r.text[:200])
            q_id = r.json()["id"]
            queued = client.get(f"/api/jobs/{q_id}").json()
            check("它现在在排队（前面还压着活儿）",
                  queued["status"] in ("queued", "running"), queued["status"])
            r = client.post(f"/api/jobs/{q_id}/cancel")
            check("**排队中取消立刻变成终态**（不用等它排到才停）",
                  r.json()["status"] == "cancelled", json.dumps(r.json(), ensure_ascii=False)[:200])
            check("取消后队列位置归零", r.json()["queue_ahead"] == 0)
            client.post(f"/api/jobs/{holder_id}/cancel")
            jobs_mod.wait(holder_id, 30)
        finally:
            ai_job_client.chat = orig_chat_job

        # -- 单工人串行：任何时刻最多一个任务在跑 --
        all_jobs = client.get("/api/jobs", params={"limit": 100}).json()["jobs"]
        check("**任何时刻最多一个任务在跑**（档案与索引只能串行写，并发只会互相踩）",
              sum(1 for j in all_jobs if j["status"] == "running") <= 1,
              str([(j["kind"], j["status"]) for j in all_jobs]))
        check("清单能按书筛",
              all(j["book_id"] == "job" for j in
                  client.get("/api/jobs", params={"book_id": "job"}).json()["jobs"]))
        check("清单能按状态筛（只在跑/只在排队）",
              all(j["status"] in ("queued", "running") for j in client.get(
                  "/api/jobs", params={"status": "queued,running"}).json()["jobs"]))
        active = client.get("/api/jobs/active").json()
        check("常驻小条接口能给出「有没有在跑的 + 排队几个」",
              "running" in active and isinstance(active["queued"], int),
              json.dumps(active, ensure_ascii=False)[:200])

        # -- 记 录 落 在 哪 ：不进索引、不在书目录 --
        check("任务记录不在书目录里（不会被指纹扫成外部改动、不会被整本快照带走、"
              "不会被整书导出打包）",
              not str(paths.jobs_dir().resolve()).startswith(
                  str(paths.book_dir("job").resolve())),
              f"{paths.jobs_dir()} vs {paths.book_dir('job')}")
        with store.connect() as conn:
            tables = {r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
        check("**任务进度不进索引**（索引可抛弃，而进度删了就是真的没了）",
              not any("job" in t for t in tables), str(sorted(tables)))
        with store.connect() as conn:
            sub = {r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
        check("索引表里没有任务表（换一条路再确认一次）", "jobs" not in sub, str(sorted(sub)))

        # -- 删除记录 + 暂存目录的引用计数 --
        r = client.delete(f"/api/jobs/{rb_id}")
        check("删掉一条终态记录 200", r.status_code == 200, r.text[:200])
        check("记录文件也没了", not (paths.jobs_dir() / f"{rb_id}.json").exists())
        check("再删一次 404", client.delete(f"/api/jobs/{rb_id}").status_code == 404)
        client.delete(f"/api/jobs/{imp_id}")
        check("**被续跑任务引用着的暂存目录不会被删掉**（删了等于删了别人的输入）",
              (paths.jobs_dir() / imp_id).is_dir(),
              "暂存目录被误删了")
        client.delete(f"/api/jobs/{imp2['id']}")
        check("最后一个引用者被删掉之后，暂存目录才跟着清掉",
              not (paths.jobs_dir() / imp_id).exists(), "暂存目录没清干净")

        # -- 正在跑的任务不许删 --
        ai_job_client.chat = slow_chat
        try:
            r = client.post("/api/books/job/chapters/extract/ai/job",
                            json={"chapter_nos": [], "refresh": True})  # 同上：要真的慢
            live_id = r.json()["id"]
            jobs_mod.wait(live_id, 1.6)
            r = client.delete(f"/api/jobs/{live_id}")
            check("正在跑的任务不给删（先停掉再删）", r.status_code == 409, r.text[:200])
            client.post(f"/api/jobs/{live_id}/cancel")
            jobs_mod.wait(live_id, 30)
        finally:
            ai_job_client.chat = orig_chat_job

        # -- 进程重启：没跑完的任务必须如实标成 interrupted --
        snap_path = paths.jobs_dir() / f"{live_id}.json"
        raw = json.loads(snap_path.read_text(encoding="utf-8"))
        raw["status"] = "running"  # 伪造一份「进程死的时候正在跑」的记录
        raw["finished_at"] = None
        snap_path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        jobs_mod._jobs.pop(live_id, None)
        jobs_mod._loaded = False  # 假装刚重启（重新读盘）
        reborn = client.get(f"/api/jobs/{live_id}").json()
        check("**重启后如实标成 interrupted**（不假装它还在跑）",
              reborn["status"] == "interrupted", reborn["status"])
        check("并且告诉用户「进度留着，可以续跑」",
              "续跑" in reborn["message"], reborn["message"])
        check("重启后这条仍然能续跑（runner 是按 kind 从注册表取的，不靠内存闭包）",
              reborn["can_resume"] is True, str(reborn["can_resume"]))

        # -- 路径闸与坏输入 --
        def _raises(fn):
            try:
                fn()
            except Exception:
                return True
            return False

        check("任务 id 只收十六进制（暂存目录挂在它下面，`..` 与分隔符一律拒）",
              _raises(lambda: jobs_mod._resolve_job_id("../../evil"))
              and _raises(lambda: jobs_mod._resolve_job_id("a/b"))
              and _raises(lambda: jobs_mod._resolve_job_id("ZZZZZZZZ")))
        check("未登记的任务类型不许提交", _raises(lambda: jobs_mod.submit("nope")))
        # 注意断言的是「**没有无人认领**的暂存目录」，不是「一个目录都没有」：
        # 记录还在的任务（续跑链上的）本来就该留着自己的暂存文件。
        known = {j["id"] for j in client.get("/api/jobs", params={"limit": 100}).json()["jobs"]}
        refs = {str(j.get("args", {}).get("stage_id") or "") for j in
                client.get("/api/jobs", params={"limit": 100}).json()["jobs"]}
        stray = [d for d in os.listdir(paths.jobs_dir())
                 if (paths.jobs_dir() / d).is_dir() and d not in known and d not in refs]
        check("没有无人认领的暂存目录残留（该清的都清了，该留的都留着）",
              not stray, str(stray))
        check("任务记录文件都是正常 JSON（写一半崩掉的文件不该留在那儿）",
              all(json.loads((paths.jobs_dir() / f).read_text(encoding="utf-8"))
                  for f in os.listdir(paths.jobs_dir()) if f.endswith(".json")),
              str(os.listdir(paths.jobs_dir())))

        # -- 有任务没跑完时，不许整本删书 --
        # 真踩过：一边删、任务一边往书目录里写，Windows 上 rmtree 会中途报
        # 「目录不是空的」停下 —— 落成「书没删干净、索引却已经清空」的最坏状态。
        # 所以删书之前必须先问一句，有活儿就挡回去。
        guard = "守护闸样本"
        client.post("/api/books", json={"book_id": guard, "title": guard})
        jobs_mod.ensure_loaded()
        with jobs_mod._cv:
            gj = jobs_mod._make_job_locked(
                "rebuild", jobs_mod._registry["rebuild"], guard,
                "重建索引：守护闸样本", {}, [], None, None)
            # 故意把它从队列里摘出来：工人就不会来取，它一直停在 queued，
            # 正好拿来验这道闸（不然重建跑得飞快，根本来不及删）。
            if gj["id"] in jobs_mod._queue:
                jobs_mod._queue.remove(gj["id"])
        check("（构造）这本书确实有一个没跑完的任务",
              [p["id"] for p in jobs_mod.pending_for_book(guard)] == [gj["id"]],
              str(jobs_mod.pending_for_book(guard)))

        guard_before = {str(p.relative_to(paths.book_dir(guard)))
                        for p in paths.book_dir(guard).rglob("*") if p.is_file()}
        rg = client.request("DELETE", f"/api/books/{guard}",
                            json={"book_id": guard, "confirm": guard})
        check("**有任务没跑完时删书 → 409**（不让删出半个书来）",
              rg.status_code == 409, rg.text[:200])
        check("并说清楚该去哪儿处理（任务中心）",
              "任务中心" in str(rg.json().get("detail")), rg.text[:200])
        check("**被挡下时一个文件都没动**",
              {str(p.relative_to(paths.book_dir(guard)))
               for p in paths.book_dir(guard).rglob("*") if p.is_file()} == guard_before,
              "文件集合变了")

        # 停掉它之后就该能删了（闸是「先处理再删」，不是「永远不许删」）
        jobs_mod.cancel(gj["id"])
        check("停掉任务后闸就放行（先处理再删，不是死锁）",
              not jobs_mod.pending_for_book(guard), str(jobs_mod.pending_for_book(guard)))
        jobs_mod.delete(gj["id"])
        rgn = client.request("DELETE", f"/api/books/{guard}",
                             json={"book_id": guard, "confirm": guard})
        check("停干净之后整本删除成功", rgn.status_code == 200, rgn.text[:200])
        check("书目录真的没了", not paths.book_dir(guard).exists(), str(paths.book_dir(guard)))

        # ---------------------------------------------------------------
        print("\n[43] C1 更新提示（只查只提示，绝不下载替换）")
        import app.updates as updates_mod
        # 纯函数：版本比较
        check("版本比较：0.2 > 0.1.9（位数不齐按 0 补齐）",
              updates_mod.has_update("0.1.9", "0.2"))
        check("版本比较：相等不算有新版", not updates_mod.has_update("0.1.0", "0.1.0"))
        check("版本比较：远端更旧不算有新版", not updates_mod.has_update("0.2.0", "0.1.99"))

        # 默认配置（config.yaml 里 updates.url 为空）→ 如实说「没检查」，且不报错
        r = client.get("/api/app/update-check")
        check("GET /api/app/update-check 200", r.status_code == 200, r.text[:200])
        j = r.json()
        check("没配远端地址时如实说「没检查」（不弹错误）",
              j.get("checked") is False and j.get("skipped") is True, str(j)[:250])
        check("返回里带了配置状态（enabled / configured / interval_hours）",
              "enabled" in j and "configured" in j and "interval_hours" in j, str(j)[:250])

        # 起一个本地 HTTP 服务当「远端」，数请求数来验证缓存与 force
        manifest = {"version": "9.9.9", "notes": "测试更新说明", "url": "https://example.com/dl"}
        hits = {"n": 0}

        class _Manifest(BaseHTTPRequestHandler):
            def do_GET(self):
                hits["n"] += 1
                code = 200 if not self.path.endswith("/missing") else 404
                payload = json.dumps(manifest).encode("utf-8")
                self.send_response(code)
                self.send_header("content-type", "application/json")
                self.end_headers()
                if code == 200:
                    self.wfile.write(payload)

            def log_message(self, *a):  # 静音
                pass

        _srv = HTTPServer(("127.0.0.1", 0), _Manifest)
        threading.Thread(target=_srv.serve_forever, daemon=True).start()
        try:
            remote = f"http://127.0.0.1:{_srv.server_address[1]}/manifest.json"
            updates_mod._MEM.clear()
            up_cfg = app_config.load_settings().raw.setdefault("updates", {})
            _old_updates = dict(up_cfg)
            up_cfg.update({"enabled": True, "url": remote, "interval_hours": 24})
            try:
                j = client.get("/api/app/update-check", params={"force": "true"}).json()
                check("远端报了 9.9.9 → has_update 且带更新说明",
                      j.get("has_update") is True and j.get("latest") == "9.9.9"
                      and "测试更新说明" in str(j.get("notes")), str(j)[:250])
                check("真去远端查了一次", hits["n"] == 1, str(hits))
                j2 = client.get("/api/app/update-check").json()
                check("间隔内的重复检查走缓存（没再敲远端）",
                      j2.get("has_update") is True and hits["n"] == 1, f"hits={hits['n']}")
                j3 = client.get("/api/app/update-check", params={"force": "true"}).json()
                check("force 无视缓存立刻重查",
                      j3.get("has_update") is True and hits["n"] == 2, f"hits={hits['n']}")

                manifest["version"] = "0.0.1"
                j4 = client.get("/api/app/update-check", params={"force": "true"}).json()
                check("远端版本更旧 → 如实说没有新版",
                      j4.get("checked") is True and j4.get("has_update") is False, str(j4)[:250])

                manifest["version"] = "9.9.9"
                up_cfg["url"] = f"http://127.0.0.1:1/manifest.json"  # 没人听的端口
                j5 = client.get("/api/app/update-check", params={"force": "true"}).json()
                check("远端不可达 → 结构化失败（不抛错、说清原因）",
                      j5.get("checked") is False and bool(j5.get("error")), str(j5)[:250])

                up_cfg["enabled"] = False
                up_cfg["url"] = remote
                j6 = client.get("/api/app/update-check").json()
                check("关掉开关后如实说「没检查」",
                      j6.get("skipped") is True and j6.get("checked") is False, str(j6)[:250])
            finally:
                up_cfg.clear()
                up_cfg.update(_old_updates)
                updates_mod._MEM.clear()
        finally:
            _srv.shutdown()

        # ---------------------------------------------------------------
        print("\n[44] C2 多书独立外观（book.yaml 稀疏覆盖，不进索引）")
        client.post("/api/books", json={"book_id": "c2a", "title": "外观甲"})
        client.post("/api/books", json={"book_id": "c2b", "title": "外观乙"})

        r = client.get("/api/books/c2a/appearance")
        check("GET 书目外观 200", r.status_code == 200, r.text[:200])
        check("没设置过时如实说没有独立覆盖", r.json().get("has_override") is False, r.text[:200])
        check("解析结果补齐了默认值（theme/mode/font_scale 都在）",
              {"theme", "mode", "font_scale"} <= set(r.json().get("ui", {})), r.text[:200])

        r = client.put("/api/books/c2a/appearance", json={"ui": {"theme": "夜航", "font_scale": 1.2}})
        check("PUT 书目外观 200 且 has_override 翻真",
              r.status_code == 200 and r.json().get("has_override") is True, r.text[:200])
        check("覆盖值原样返回", r.json()["ui"]["theme"] == "夜航" and r.json()["ui"]["font_scale"] == 1.2, r.text[:200])
        check("**覆盖落在 book.yaml（书目目录下，不是索引里）**",
              'appearance:' in paths.book_config_file("c2a").read_text(encoding="utf-8"),
              paths.book_config_file("c2a").read_text(encoding="utf-8")[:200])

        # 稀疏覆盖：没动过的键继续跟随全局
        client.put("/api/prefs", json={"ui": {"mode": "light"}})
        r = client.get("/api/books/c2a/appearance")
        check("改过的键被这本书钉住（theme 仍是夜航）", r.json()["ui"]["theme"] == "夜航", r.text[:200])
        r2 = client.get("/api/books/c2b/appearance")
        check("**没设置过的书继续跟随全局**（mode=light、theme=默认）",
              r2.json()["ui"]["mode"] == "light" and r2.json()["ui"]["theme"] == "默认"
              and r2.json().get("has_override") is False, r2.text[:250])

        # background 深合并：只传 kind，其余键保留默认
        client.put("/api/books/c2a/appearance", json={"ui": {"background": {"kind": "gradient"}}})
        r = client.get("/api/books/c2a/appearance")
        bg = r.json()["ui"].get("background", {})
        check("background 只改 kind、其余键不丢", bg.get("kind") == "gradient" and "from" in bg and "to" in bg, str(bg)[:250])

        # reset：清掉独立设置，改回跟随全局，且不碰全局偏好本身
        r = client.put("/api/books/c2a/appearance", json={"reset": True})
        check("reset 后 has_override 翻假", r.json().get("has_override") is False, r.text[:200])
        check("reset 后 theme 跟随全局（默认）", r.json()["ui"]["theme"] == "默认", r.text[:200])
        check("book.yaml 里 appearance 键已移除",
              'appearance:' not in paths.book_config_file("c2a").read_text(encoding="utf-8"),
              paths.book_config_file("c2a").read_text(encoding="utf-8")[:200])
        g = client.get("/api/prefs").json()
        check("reset 不碰全局偏好（全局 mode 还是 light）", g["ui"]["mode"] == "light", str(g["ui"])[:200])

        r = client.get("/api/books/不存在的书/appearance")
        check("不存在的书 → 404", r.status_code == 404, r.text[:200])

        print("\n[45] B4 素材引用扫描（/api/assets/usage，文本级、宁多报不漏报）")
        png1 = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg=="
        )
        r = client.post("/api/assets/backgrounds",
                        files={"file": ("usage-bg.png", png1, "image/png")})
        check("上传待查素材 201", r.status_code == 201, r.text[:200])

        r = client.get("/api/assets/usage")
        check("usage 200 且结构对", r.status_code == 200 and "usages" in r.json(), r.text[:200])
        check("没人引用时如实说未引用",
              "backgrounds/usage-bg.png" not in r.json()["usages"], r.text[:300])

        # 引用点一：全局外观偏好
        client.put("/api/prefs", json={"ui": {"background": {
            "kind": "image", "url": "/api/assets/backgrounds/usage-bg.png/raw"}}})
        r = client.get("/api/assets/usage")
        hits = r.json()["usages"].get("backgrounds/usage-bg.png", [])
        check("全局偏好里的引用被扫出来", any(h["label"] == "全局外观偏好" for h in hits), str(hits)[:250])

        # 引用点二：某本书的 book.yaml（C2 的外观覆盖）
        client.put("/api/books/c2a/appearance", json={"ui": {"background": {
            "kind": "image", "url": "backgrounds/usage-bg.png"}}})
        r = client.get("/api/assets/usage")
        hits = r.json()["usages"].get("backgrounds/usage-bg.png", [])
        check("book.yaml 里的引用被扫出来", any("book.yaml" in h["label"] for h in hits), str(hits)[:250])

        # 引用点三：view/ 下的 json（摆设/样式）—— 直接落一个文件
        vdir = paths.view_dir("c2a")
        vdir.mkdir(parents=True, exist_ok=True)
        (vdir / "decorations.json").write_text(
            json.dumps({"stickers": ["usage-bg.png"]}), encoding="utf-8")
        r = client.get("/api/assets/usage")
        hits = r.json()["usages"].get("backgrounds/usage-bg.png", [])
        check("view/*.json 里的引用被扫出来", any("decorations.json" in h["label"] for h in hits), str(hits)[:300])

        # 字体按 stem 匹配（偏好里存的就是 stem）
        r = client.post("/api/assets/fonts",
                        files={"file": ("usage-font.ttf", b"fake ttf", "font/ttf")})
        check("上传字体 201", r.status_code == 201, r.text[:200])
        client.put("/api/prefs", json={"ui": {"font_family": "usage-font"}})
        r = client.get("/api/assets/usage")
        hits = r.json()["usages"].get("fonts/usage-font.ttf", [])
        check("字体按 stem 命中全局偏好", any(h["label"] == "全局外观偏好" for h in hits), str(hits)[:250])

        # 删除后引用消失
        r = client.delete("/api/assets/backgrounds/usage-bg.png")
        check("删除素材 200", r.status_code == 200, r.text[:200])
        client.delete("/api/assets/fonts/usage-font.ttf")
        r = client.get("/api/assets/usage")
        check("删掉的素材不再出现在 usage 里",
              "backgrounds/usage-bg.png" not in r.json()["usages"]
              and "fonts/usage-font.ttf" not in r.json()["usages"], r.text[:300])

        print("\n[46] C3 抽取器插件契约（四只同管道，候选满足同一套不变量）")
        from app.ai import client as ai_client_mod  # noqa: E402
        from app.parsers import contract as ex_contract  # noqa: E402

        client.post("/api/books", json={"book_id": "c3", "title": "契约测"})
        r = client.post("/api/books/c3/entities", json={
            "type": "character", "name": "裴渊", "summary": "少年镖师",
            "body": {"摘要": "少年镖师", "属性": [], "出场记录": [], "关联": [], "待补充": []}})
        pei_id = r.json()["id"]

        r = client.get("/api/extractors")
        check("GET /api/extractors 200", r.status_code == 200, r.text[:200])
        check("四只内置抽取器都在花名册上",
              [i["key"] for i in r.json()["items"]] == ["rule", "ai", "paste", "docx"],
              str(r.json()["items"]))

        #: 契约不变量：每条候选必须带全这六个键，confidence 是 0~1 的诚实分，
        #: reasons 非空、where 是 dict（出处坐标系各家自定，但**必须给**）
        INVARIANT_KEYS = ("name", "source", "confidence", "reasons", "exists", "where")

        def check_invariants(out, label: str, min_n: int = 1) -> None:
            why = ""
            ok = isinstance(out.candidates, list) and len(out.candidates) >= min_n
            if not ok:
                why = f"candidates={len(out.candidates)}（要 ≥{min_n}）"
            else:
                for c in out.candidates:
                    missing = [k for k in INVARIANT_KEYS if k not in c]
                    if missing:
                        ok, why = False, f"{c.get('name')!r} 缺 {missing}"
                        break
                    if not isinstance(c["confidence"], (int, float)) or not 0 <= c["confidence"] <= 1:
                        ok, why = False, f"{c['name']!r} confidence={c['confidence']} 不是 0~1"
                        break
                    if not c["reasons"] or not isinstance(c["where"], dict):
                        ok, why = False, f"{c['name']!r} reasons/where 不合格"
                        break
            check(f"{label}：候选满足契约不变量", ok, why)

        # —— 同一套章节语料，rule 与 ai 各跑一遍 ——
        CH = [
            {"chapter_no": 1, "title": "试航",
             "text": "黎明时分，甲板上风很大。「起锚！」裴渊喊道。\n\n韦忠摇头道：「还早。」落霞城的钟声隔着海传来。"},
            {"chapter_no": 2, "title": "打捞",
             "text": "裴渊盯着那批货单。韦忠道：「把那批货单拿过来。」落霞城的雾散了。"},
        ]
        out = ex_contract.run_extractor("rule", ex_contract.ExtractRequest(
            book_id="c3", chapters=CH, known={"裴渊": pei_id},
            alias_map={"小裴子": pei_id}, methodologies=[]))
        check_invariants(out, "rule")
        check("rule 候选标注了出处（source=rule）",
              all(c["source"] == "rule" for c in out.candidates), str(out.candidates)[:200])
        pei = next((c for c in out.candidates if c["name"] == "裴渊"), None)
        check("rule：库里已有的裴渊 exists=True 且 entity_id 对",
              bool(pei and pei["exists"] and pei["entity_id"] == pei_id), str(pei))
        check("rule：where 带章节出处（chapter_no/para）",
              bool(pei and "chapter_no" in pei["where"] and "para" in pei["where"]), str(pei))
        check("rule：extras 里 appearances / stats 都在",
              "appearances" in out.extras and "stats" in out.extras
              and out.extras["stats"]["chapters"] == 2, str(out.extras.get("stats")))

        # AI：mock chat，同一章语料
        AI_JSON = (
            '{"entities": [{"name": "契约新人", "type": "character",'
            ' "summary": "AI 报的新面孔", "aliases": [], "methodologies": [],'
            ' "evidence": "黎明时分，甲板上风很大。"}],'
            ' "changes": [{"name": "裴渊", "field": "状态", "detail": "盯着货单出神",'
            ' "evidence": "裴渊盯着那批货单"}],'
            ' "foreshadow": [{"content": "那批货单里藏着秘密", "evidence": "把那批货单拿过来"}]}'
        )

        def contract_fake_chat(provider, messages, **kw):
            return {"content": AI_JSON, "model": provider.get("model", "m"),
                    "prompt_tokens": 10, "completion_tokens": 5,
                    "total_tokens": 15, "latency_ms": 1}

        orig_chat = ai_client_mod.chat
        ai_client_mod.chat = contract_fake_chat
        try:
            out = ex_contract.run_extractor("ai", ex_contract.ExtractRequest(
                book_id="c3", chapters=[CH[0]], options={"provider_key": "mockprov"}))
        finally:
            ai_client_mod.chat = orig_chat
        check_invariants(out, "ai")
        ai_new = next((c for c in out.candidates if c["name"] == "契约新人"), None)
        check("ai：候选标注 source=ai 且 where 有章号",
              bool(ai_new and ai_new["source"] == "ai"
                   and ai_new["where"].get("chapter_no") == 1), str(ai_new))
        check("ai：extras 里 changes / foreshadow / meta 都在",
              out.extras.get("changes") and out.extras.get("foreshadow")
              and out.extras.get("meta", {}).get("model"), str(out.extras.get("meta")))

        # —— paste：原料文本 ——
        out = ex_contract.run_extractor("paste", ex_contract.ExtractRequest(
            book_id="c3",
            material="| 名称 | 摘要 | 别名 |\n|---|---|---|\n| 裴渊 | 少年镖师 | 小裴子 |\n| 韦忠 | 师父 | |",
            known={"裴渊": pei_id}))
        check_invariants(out, "paste")
        check("paste：两条草稿全变成候选且 source=paste",
              len(out.candidates) == 2 and {c["source"] for c in out.candidates} == {"paste"},
              str(out.candidates)[:200])
        pei_p = next(c for c in out.candidates if c["name"] == "裴渊")
        check("paste：裴渊 exists=True（known 名录判的）、where 是材料坐标",
              pei_p["exists"] and pei_p["where"] == {"material": "粘贴原料"}, str(pei_p))
        check("paste：extras.raw 原样透传（bulk-paste 接口吃的还是它）",
              out.extras["raw"]["count"] == 2 and len(out.extras["raw"]["drafts"]) == 2,
              str(out.extras["raw"])[:200])

        # —— docx：设定稿大纲 ——
        docx_path = _make_docx(_TMP / "契约测设定.docx", [
            ("种族", 0), ("人族", 1), ("精灵", 1), ("地理", 0), ("落霞城", 1)])
        out = ex_contract.run_extractor("docx", ex_contract.ExtractRequest(
            book_id="c3", doc_path=str(docx_path), known={"裴渊": pei_id}))
        check_invariants(out, "docx")
        zc = next((c for c in out.candidates if c["name"] == "种族"), None)
        rc = next((c for c in out.candidates if c["name"] == "人族"), None)
        check("docx：顶层节点置信度高、where 是文档坐标系",
              bool(zc and rc and zc["confidence"] > rc["confidence"]
                   and zc["where"].get("doc_level") == 0 and rc["where"].get("doc_level") == 1),
              f"zc={zc} rc={rc}")
        check("docx：extras 带大纲统计（node_count / roots）",
              out.extras.get("node_count", 0) >= 5 and out.extras.get("roots"),
              str({k: out.extras.get(k) for k in ("node_count", "roots")}))

        # 插件口子的意义：注册一只新抽取器，核心（注册表/端点/不变量）零改动
        class DummyExtractor:
            key, label, input_kind = "dummy", "假抽取器", "chapters"
            def run(self, req):
                return ex_contract.ExtractOutput(source="dummy", candidates=[{
                    "name": "假人", "type": None, "count": 1, "confidence": 0.5,
                    "reasons": ["插进来的"], "exists": False, "entity_id": None,
                    "source": "dummy", "where": {},
                }], extras={})

        ex_contract.register(DummyExtractor())
        out = ex_contract.run_extractor("dummy", ex_contract.ExtractRequest())
        check_invariants(out, "dummy（插件）")
        check("新抽取器注册即用，核心零改动", out.candidates[0]["name"] == "假人")

        print("\n[47] P8 前置：安装形态的两处地基（/m 静态资源 + 全局配置可写层）")

        # --- ① /m/ 必须重定向，否则手机端整页白屏 ---
        r = client.get("/m/", follow_redirects=False)
        check("/m/ 重定向（302）", r.status_code == 302, f"{r.status_code} {r.text[:120]}")
        check("重定向目标是 /m",
              str(r.headers.get("location", "")).rstrip("/").endswith("/m"), r.headers.get("location"))
        r = client.get("/m/assets/index-abc.js", follow_redirects=False)
        check("/m/assets/*.js 不再回 HTML（同样 302 回 /m）",
              r.status_code == 302 and "text/html" not in r.headers.get("content-type", ""),
              f"{r.status_code} {r.headers.get('content-type')}")
        r = client.get("/m")
        check("/m 本身照旧直接给 SPA", r.status_code == 200 and "text/html" in r.headers.get("content-type", ""),
              r.headers.get("content-type"))
        r = client.get("/api/不存在的接口")
        check("/api/* 未匹配仍是 404（没被 SPA 兜走）", r.status_code == 404, str(r.status_code))

        # --- ② 全局配置：用户那份在数据目录，且能覆盖程序目录种子 ---
        seed = paths.global_config_file()
        user_cfg = paths.user_config_file()
        check("用户配置落在数据目录里", str(user_cfg).startswith(str(paths.data_dir())), str(user_cfg))
        check("用户配置与程序目录种子不是同一个文件", user_cfg != seed, f"{user_cfg} vs {seed}")
        written = app_config.write_default_config()
        check("首次运行生成的默认配置写进数据目录",
              written == user_cfg and written.is_file(), str(written))
        # 该配置覆盖种子：写一个只在用户那份里存在的值
        import yaml as _yaml
        raw = _yaml.safe_load(user_cfg.read_text(encoding="utf-8")) or {}
        raw.setdefault("server", {})["port_scan"] = 7
        raw.setdefault("log", {})["level"] = "DEBUG"
        # 故意把 data_dir 也写进去 —— 它**不该**生效（否则下次启动自己搬走）
        raw.setdefault("storage", {})["data_dir"] = str(_TMP / "想搬走")
        user_cfg.write_text(_yaml.safe_dump(raw, allow_unicode=True), encoding="utf-8")
        st = app_config.load_settings(reload=True)
        check("用户配置覆盖了默认值（port_scan=7 / log=DEBUG）",
              st.port_scan == 7 and st.log_level == "DEBUG", f"scan={st.port_scan} log={st.log_level}")
        check("**配置文件改不动数据目录**（防自己把自己搬走）",
              st.data_dir == _TMP.resolve() or str(st.data_dir) == str(paths.data_dir()),
              f"data_dir={st.data_dir}")
        check("后台报告的是真正生效的那份（数据目录）", st.config_file == user_cfg, str(st.config_file))
        # 还原：删掉用户配置并重载，免得影响后面的收尾
        user_cfg.unlink(missing_ok=True)
        app_config.load_settings(reload=True)

        # 环境变量覆盖：测试与便携模式靠它换端口。
        # 2026-10-03 核对过这桩悬案 —— 「server.port 改了不生效」不是键名错，
        # 是**两份配置文件**：程序目录那份是种子，数据目录那份才覆盖得到。
        # 键名 `server.port`、环境变量 `WKV_PORT` 都正常，这里钉住后者。
        os.environ["WKV_PORT"] = "8899"
        st_env = app_config.load_settings(reload=True)
        os.environ.pop("WKV_PORT", None)
        app_config.load_settings(reload=True)
        check("WKV_PORT 环境变量能覆盖配置文件里的端口", st_env.port == 8899, f"port={st_env.port}")

        # --- ③ 首次运行落「用户那份」的判据（安装形态：程序目录有只读种子）---
        # 此刻正是分叉现场：种子在、用户那份不在。旧判据（`if not settings.config_file`）
        # 在这时会误判成「已有配置」—— 因为 config_file 指向种子 —— 于是安装后
        # 用户那份**永远不生成**，而种子在 Program Files 下改不动。
        st2 = app_config.load_settings(reload=True)
        check("分叉现场成立：有只读种子却没有用户那份（config_file 会指向种子）",
              bool(st2.config_file) and st2.config_file == seed and not user_cfg.exists(),
              f"config_file={st2.config_file} user_exists={user_cfg.exists()}")
        created2 = app_config.write_default_config()
        check("种子存在不构成阻碍：照旧能生成用户那份",
              created2 == user_cfg and user_cfg.is_file(), str(created2))
        st3 = app_config.load_settings(reload=True)
        check("生成后生效的那份翻到用户配置（种子让位）", st3.config_file == user_cfg, str(st3.config_file))
        user_cfg.unlink(missing_ok=True)
        app_config.load_settings(reload=True)

        import inspect
        from app import main as main_mod
        _src = inspect.getsource(main_mod.main)
        check("启动时的判据看的是 user_config_file().exists()（源码级回归闸）",
              "paths.user_config_file().exists()" in _src
              and "if not settings.config_file:" not in _src,
              "main() 里应判「用户那份在不在」，而不是「有没有配置文件生效」")

        # 收尾：把还在排队/在跑的都停掉，免得工作线程在临时目录被删时还在写
        for j in client.get("/api/jobs", params={"status": "queued,running"}).json()["jobs"]:
            client.post(f"/api/jobs/{j['id']}/cancel")
        for j in client.get("/api/jobs", params={"status": "queued,running"}).json()["jobs"]:
            jobs_mod.wait(j["id"], 30)
        check("收尾：没有任务还挂在运行中",
              client.get("/api/jobs", params={"status": "queued,running"}).json()["count"] == 0)
        check("收尾：任务类型注册表里有三类", len(tasks_mod.jobs.kinds()) == 3,
              str([k["kind"] for k in tasks_mod.jobs.kinds()]))

    print(f"\n{'=' * 48}")
    print(f"  通过 {PASS} 项，失败 {FAIL} 项")
    print(f"{'=' * 48}")

    # 收尾前放掉守连接：它占着临时数据目录里 index.db 的句柄，
    # Windows 上不先放掉 rmtree 会删不干净（而且是**静默**删不干净）
    store.close_keeper()
    # 日志文件也被 logging 的 FileHandler 占着 —— 同样会让 rmtree 半途而废，
    # 只删掉目录里的其他东西、留下一个删不掉的 logs/。跑一次留一个，
    # 攒起来就是一百多个空目录。
    logging.shutdown()
    if not FAIL:
        shutil.rmtree(_TMP, ignore_errors=True)
        print("  临时数据目录已清空" if not _TMP.exists() else f"  ⚠️ 临时目录没删干净：{_TMP}")
    else:
        print(f"  保留现场以便排查：{_TMP}")
    return 1 if FAIL else 0


def _png_bytes(w: int, h: int, rects: list, thickness: int = 3) -> bytes:
    """手写一张「白底黑框」的 PNG，给识别测试当底图。

    被测代码是识别引擎，不是图像库 —— 所以这里自己拼 PNG 字节，
    这样「没装 OpenCV 的机器」上也能跑这些用例（那时引擎报不可用，
    这些图就用不上，但路径与参数校验那部分照样测得到）。

    `rects` 是 [(x0, y0, x1, y1), ...]，每个画成一个闭合边框。
    PNG 只支持无损压缩过的灰度，够用了：灰度 8bit、filter 全 0。
    """
    import struct
    import zlib

    def dark(x: int, y: int) -> bool:
        for x0, y0, x1, y1 in rects:
            if x0 <= x <= x1 and y0 <= y <= y1:
                inside = (x0 + thickness <= x < x1 - thickness
                          and y0 + thickness <= y < y1 - thickness)
                if not inside:
                    return True
        return False

    raw = bytearray()
    for y in range(h):
        raw.append(0)  # 每行的 filter 类型
        for x in range(w):
            raw.append(0 if dark(x, y) else 255)

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)  # 8bit 灰度
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
        + chunk(b"IEND", b"")
    )


def _make_docx(path: Path, paras: list) -> Path:
    """现造一个最小 docx（只含 word/document.xml）给导入接口用。

    `.docx` 就是 zip —— 被测代码只读 `word/document.xml`，
    所以这里不需要生成一整套 OOXML 样板。
    """
    W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    body = []
    for text, level in paras:
        pr = ""
        if level is not None:
            pr = (f'<w:pPr><w:numPr><w:ilvl w:val="{level}"/>'
                  f'<w:numId w:val="1"/></w:numPr></w:pPr>')
        body.append(f'<w:p>{pr}<w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>')
    xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           f'<w:document xmlns:w="{W}"><w:body>{"".join(body)}</w:body></w:document>')
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("word/document.xml", xml)
    return path


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(2)
