"""思维导图 / Word 大纲导入接口。

**只解析，不落盘。**

解析出来的是一棵带「子级 / 描述」初判的树，连同**为什么这么判**一起返回；
用户在预览面板里逐条确认（或一键整组切换）之后，才由前端写进
`view/scene.json` 的 `outlines[sceneKey]`。

这是铁律 1 在结构层的同一条规矩：
工具只产「待确认清单」，人是唯一有权拍板的那个。
所以这里连一次写操作都没有 —— 解析坏了最多是白导一次，不会脏任何数据。
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

from ..logging_setup import get_logger
from ..parsers import docx as docx_parser
from ..parsers import outline_import as oi
from ._common import check_book_id as _check_book_id

log = get_logger(__name__)
router = APIRouter(tags=["outline"])

MAX_UPLOAD = 20 * 1024 * 1024  # 20MB，与章节导入同一把尺子


@router.post("/books/{book_id}/outline/parse")
async def api_outline_parse(book_id: str, file: UploadFile = File(...)) -> dict:
    """收一个 .mm / .docx / .txt / .md，还原成带角色初判的结构树。

    优先传 `.mm`：它是思维导图的**源文件**，层级无损（实测同一份导图
    22 层，导成 docx 后被 Word 的多级列表上限压到 9 层）。
    响应里的 `source.exact` 会告诉前端这次是不是无损的那一种。
    """
    _check_book_id(book_id)
    name = Path(file.filename or "未命名").name
    suffix = Path(name).suffix.lower()
    if suffix not in oi.OUTLINE_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的格式 {suffix or '(无扩展名)'}；只收 {' / '.join(oi.OUTLINE_EXTS)}",
        )
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="文件是空的")
    if len(data) > MAX_UPLOAD:
        raise HTTPException(
            status_code=413,
            detail=f"文件过大（{len(data) // 1024 // 1024}MB，上限 20MB）",
        )

    with tempfile.TemporaryDirectory(prefix="wkv-outline-") as td:
        staged = Path(td) / name
        staged.write_bytes(data)
        try:
            roots, meta = oi.parse_any(staged)
        except docx_parser.DocxError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:  # 坏文件别把 500 抛到前端
            log.warning("解析大纲 %s 失败：%s", name, exc)
            raise HTTPException(status_code=400, detail=f"解析失败：{exc}") from exc
        payload = oi.to_payload(roots, meta, name)

    payload["book_id"] = book_id
    log.info(
        "大纲解析 %s：%d 个节点（描述 %d），最深 %d 层",
        name, payload["stats"]["total"], payload["stats"]["descs"], payload["stats"]["max_depth"],
    )
    return payload
