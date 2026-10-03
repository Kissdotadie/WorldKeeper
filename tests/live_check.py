"""对**正在运行的真实服务**做一次验收（不是 TestClient，走真 HTTP）。

用法：
    1. 先把服务起起来
    2. .venv/Scripts/python.exe tests/live_check.py [端口] [书目标识]

验收链路与 P0 标准一致：
    空库 → 建书 → 批量粘贴 → 看到卡片 → 删索引 → 一键重建 → 数据原样恢复
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, paths  # noqa: E402

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
BOOK = sys.argv[2] if len(sys.argv) > 2 else "验收书"
BASE = f"http://127.0.0.1:{PORT}"

PASS = 0
FAIL = 0


def call(method: str, path: str, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    # 路径里可能含中文书目标识，必须编码（http.client 只接受 ASCII 请求行）
    url = BASE + urllib.parse.quote(path, safe="/?=&")
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw


def check(label: str, cond: bool, extra: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [OK]   {label}")
    else:
        FAIL += 1
        print(f"  [FAIL] {label}\n         {extra}")


def main() -> int:
    print(f"目标服务：{BASE}    书目：{BOOK}\n")

    status, health = call("GET", "/api/health")
    check("服务在线", status == 200 and health.get("app") == "world-keeper", str(health))
    if status != 200:
        return 2

    # ---------------------------------------------------------------- 建书
    status, _ = call("POST", "/api/books", {"book_id": BOOK, "title": "P0 验收用书"})
    check("建书（已存在时 409 也算通过）", status in (201, 409), f"status={status}")

    status, book = call("GET", f"/api/books/{BOOK}")
    check("能读回书目", status == 200, str(book))
    check("书目标识正确", (book or {}).get("book_id") == BOOK, str(book))

    # ---------------------------------------------------------------- 粘贴
    table = (
        "姓名 | 别名 | 简介 | 标签\n"
        "验收甲 | 甲某 | 用于验收的第一个人物。 | 验收\n"
        "验收乙 | 乙某 | 用于验收的第二个人物。 | 验收\n"
    )
    status, prev = call("POST", f"/api/books/{BOOK}/bulk-paste/preview",
                        {"text": table, "mode": "auto", "type": "character"})
    check("粘贴解析成功", status == 200 and prev["count"] == 2, str(prev)[:200])

    drafts = [
        {"name": d["name"], "summary": d["summary"], "aliases": d["aliases"],
         "tags": d["tags"], "attributes": d["attributes"]}
        for d in prev["drafts"]
    ]
    status, res = call("POST", f"/api/books/{BOOK}/bulk-paste/commit",
                       {"text": table, "mode": "auto", "type": "character",
                        "drafts": drafts, "on_duplicate": "skip"})
    check("落盘成功", status == 201, str(res)[:200])

    # ---------------------------------------------------------------- 列表
    status, listing = call("GET", f"/api/books/{BOOK}/entities")
    items = listing["items"]
    check("能在列表里看到", len(items) >= 2, f"{len(items)} 条")
    ids = [e["id"] for e in items if e["name"] in ("验收甲", "验收乙")]
    check("两个实体都有稳定 ID", len(ids) == 2, str(ids))

    status, detail = call("GET", f"/api/books/{BOOK}/entities/{ids[0]}")
    check("实体卡片有内容", status == 200 and bool(detail.get("summary")), str(detail)[:160])
    check("卡片带出处", bool(detail.get("provenance")), str(detail.get("provenance")))

    status, hit = call("GET", f"/api/books/{BOOK}/search?q=验收")
    check("能搜到", status == 200 and hit["count"] >= 2, str(hit)[:160])

    # ---------------------------------------------------------------- 索引可抛弃
    cfg = config.load_settings()
    idx = paths.index_file()
    before = sorted((e["id"], e["name"]) for e in items)
    for suffix in ("", "-wal", "-shm"):
        Path(str(idx) + suffix).unlink(missing_ok=True)
    check("索引已物理删除", not idx.is_file(), str(idx))

    status, rebuilt = call("POST", f"/api/admin/rebuild-index")
    check("重建接口返回 200", status == 200, str(rebuilt)[:200])

    _, listing2 = call("GET", f"/api/books/{BOOK}/entities")
    after = sorted((e["id"], e["name"]) for e in listing2["items"])
    check("重建后数据原样恢复", before == after, f"\n         before={before}\n         after ={after}")

    # ---------------------------------------------------------------- 日志与后台
    status, info = call("GET", "/api/admin/info")
    check("后台信息可读", status == 200 and bool(info.get("data_dir")), str(info)[:200])
    check("数据目录与配置一致",
          str(cfg.data_dir) == info.get("data_dir"),
          f"{cfg.data_dir} vs {info.get('data_dir')}")

    status, logs = call("GET", "/api/admin/logs?lines=50")
    check("日志文件已落盘且可读", status == 200 and len(logs.get("lines", [])) > 0,
          str(logs)[:200])

    print(f"\n{'=' * 48}")
    print(f"  通过 {PASS} 项，失败 {FAIL} 项")
    print(f"{'=' * 48}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
