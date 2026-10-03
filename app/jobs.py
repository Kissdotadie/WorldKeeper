"""异步任务运行时：长任务看得见、停得下、断了还能续 —— 口子 #9 / P11-A3。

要解决的问题
------------
批量 AI 抽取一本 30 章的书要十几分钟，批量导入几十个 docx 要几十秒。
这些活儿原来都是**同步阻塞**的：浏览器一直转圈、看不出跑到第几章、
中途想停只能把整个程序关掉、关了还得从头再来（AI 那头是要花钱的）。
这一层把「跑」和「看」拆开：活儿交给后台线程，界面只负责看进度。

三条设计取舍（都是权衡过的，不是随手选的）
------------------------------------------
1. **单线程串行执行，不做并发。**
   三类任务都在写同一份档案与同一份索引。「重建索引」会把索引里的行清掉
   重灌，而「AI 抽取」正在往档案里写 —— 并行跑只会互相踩，最坏的结果是
   索引里一半旧一半新，而且**看不出来错了**。排队看得见（`queued` +
   前面还排着几个）比悄悄并发安全得多。另外单线程也让「同一本书不并跑
   同类任务」这道防重复扣费的闸变得简单可靠。

2. **状态放内存，痕迹放文件。**
   运行中的任务属于「进程」：进程没了，线程就没了。硬把内存里的状态存下来
   假装它还活着，是骗自己。所以分两处放：
   - **活的进度**只在内存里（快、不用抢锁、随进程一起消失）
   - **任务记录**（含每个子项的完成情况）落 `data/jobs/<id>.json`，状态变化时写
   重启后读回来的是**历史**：上次没跑完的任务如实标成 `interrupted`，
   而不是假装还在跑 —— 界面要能说清「它没跑完」这件事。
   **为什么不进索引**：铁律「索引零独占状态」。索引随时可以删掉重建，而
   「第 12 章抽过了」这种进度删掉就是真的没了。所以任务记录落数据目录下的
   运行期目录（与 `data/logs/`、`data/snapshots/` 同级），它既不在书目录里
   （不会被指纹扫成「外部改动」、不会被整本快照带走、不会被整书导出打包），
   也不要求索引活着。

3. **中断是协作式的，不是杀线程。**
   Python 没有安全的线程终止手段。`cancel()` 只置一个标志，worker 在**每个
   子项之间**查一次；正在发出去的那个 API 请求会跑完（钱已经花了，掐断它
   也不省钱），之后干净收尾。所以界面上要说「正在收尾」而不是「已停止」——
   状态如实，别为了好看撒谎。

断点续跑怎么算「续」
--------------------
任务完成后 `items_done` 里留着每个子项的键（章号 / 文件名）。续跑不是
「把那个线程接上」（做不到），而是**拿着同一份参数重新排一个任务，跳过
上次已完成的那些子项**，并在记录里用 `resumed_from` / `resumed_by` 互相
指认。所以续跑要能跨重启 —— runner 从注册表按 kind 取，不靠内存里的闭包。
"""

from __future__ import annotations

import json
import re
import shutil
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Callable

from . import paths
from .logging_setup import get_logger

log = get_logger(__name__)

# --------------------------------------------------------------------------
# 状态机
# --------------------------------------------------------------------------

QUEUED = "queued"
RUNNING = "running"
DONE = "done"
FAILED = "failed"
CANCELLED = "cancelled"
INTERRUPTED = "interrupted"

#: 终态 —— 到了这几个状态就再也不会自己变了
TERMINAL = (DONE, FAILED, CANCELLED, INTERRUPTED)

#: 每个任务在内存里留多少条日志。超了丢最老的，但 `seq` 继续涨 ——
#: 客户端的增量游标（`?after=N`）因此不会因为丢日志而错位。
EVENT_CAP = 400
#: 历史记录保留份数（含阶段文件目录）
HISTORY_KEEP = 60
#: 落盘节流：同一个任务最快多久写一次（终态一定写，不受节流限制）
PERSIST_MIN_GAP = 0.7
#: 单条日志的长度上限（防止把整段正文打进事件里）
EVENT_TEXT_MAX = 400
TITLE_MAX = 80
#: 孤儿暂存目录的兜底清理门槛。给得这么宽是有意的：**「目录刚建出来、
#: 记录还没登记」是正常的中间状态**（导入接口先落文件、后 submit），
#: 按分钟级去猜就会把正在提交的任务的输入删掉。宁可留着当垃圾。
STALE_STAGE_SECONDS = 7 * 86400


class JobCancelled(Exception):
    """协作式中断信号。worker 抛出来之后由运行时代为收尾。"""


class BusyError(Exception):
    """同一本书已经在跑同类任务。防重复扣费 —— 双击两下就是两倍的钱。"""

    def __init__(self, job: dict):
        super().__init__(f"已经有同类任务在跑：{job.get('id')}")
        self.job = job


class ResumeError(Exception):
    """续跑的前提不成立（还在跑 / 这类任务不支持续跑 / 记录已清）。"""


# --------------------------------------------------------------------------
# 注册表与全局状态
# --------------------------------------------------------------------------

_registry: dict[str, dict] = {}          # kind -> {label, resumable, hint, runner}
_jobs: dict[str, dict] = {}              # job_id -> 任务
_queue: list[str] = []                   # 待跑的 job_id（FIFO）
_cv = threading.Condition(threading.RLock())
_worker: threading.Thread | None = None
_loaded = False


def register(
    kind: str,
    *,
    label: str,
    runner: Callable[["Task", dict], None],
    resumable: bool = False,
    hint: str = "",
) -> None:
    """登记一种任务。

    `runner` 存在注册表里而**不是**存在任务记录里，是为了续跑能跨重启：
    重启后内存里的闭包早没了，只有按 kind 从注册表取回来的函数还在。
    """
    _registry[kind] = {
        "kind": kind,
        "label": label,
        "resumable": bool(resumable),
        "hint": hint,
        "runner": runner,
    }


def kinds() -> list[dict]:
    """有哪些任务类型（界面上的任务中心靠它渲染）。"""
    return [
        {k: v for k, v in meta.items() if k != "runner"}
        for meta in _registry.values()
    ]


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def new_job_id() -> str:
    """给调用方预占一个任务 id（导入任务要先按 id 建暂存目录）。"""
    return _resolve_job_id(None)


_JOB_ID_RE = re.compile(r"^[0-9a-f]{8,32}$")


def _resolve_job_id(wanted: str | None) -> str:
    """任务 id 会变成目录名（暂存目录就挂在它下面），所以必须自己校验一遍。

    只认 8~32 位小写十六进制 —— 这样 `..`、`/`、盘符这些东西连进来的机会都没有。
    """
    if not wanted:
        return _new_id()
    if not _JOB_ID_RE.match(wanted):
        raise ValueError(f"任务 id 不合法（只允许 8~32 位十六进制）：{wanted!r}")
    if wanted in _jobs:
        raise ValueError(f"任务 id 已存在：{wanted}")
    return wanted


def _iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


# --------------------------------------------------------------------------
# 进度手柄：交给 worker 用的那个对象
# --------------------------------------------------------------------------

class Task:
    """worker 手里的进度手柄。所有方法都会自己加锁，并顺手触发一次节流落盘。

    **只为当前这一次执行服务**，别跨任务留着它。
    """

    __slots__ = ("id",)

    def __init__(self, job_id: str) -> None:
        self.id = job_id

    def _job(self) -> dict:
        j = _jobs.get(self.id)
        if j is None:
            raise JobCancelled()
        return j

    # ---- 中断 ----

    def check(self) -> None:
        """在**每个子项之间**调一次。收到停止请求就抛 `JobCancelled`。

        刻意不做成「定时器到点抛异常」：那样可能在你正写文件的中途炸掉。
        子项之间是天然的安全点 —— 上一个已经完整落盘，下一个还没开始。
        """
        with _cv:
            j = _jobs.get(self.id)
            if j is None or j.get("cancel_requested"):
                raise JobCancelled()

    # ---- 进度 ----

    def set_total(self, total: int, *, unit: str = "", label: str | None = None) -> None:
        with _cv:
            j = self._job()
            j["total"] = int(total)
            j["unit"] = unit
            if label:
                j["message"] = label
            _persist(j)

    def log(self, text: object, level: str = "info") -> None:
        with _cv:
            _emit(self._job(), str(text)[:EVENT_TEXT_MAX], level=level)
            _persist(self._job())

    def detail(self, **data: Any) -> None:
        """当前子项的细信息。界面拿它显示「正在跑第 12 / 30 章」这类话。"""
        with _cv:
            j = self._job()
            j["detail"] = data
            _persist(j)

    def advance(self, n: int = 1, *, text: object | None = None, key: str | None = None,
                level: str = "info") -> None:
        """一个子项处理完了。

        `key` 是**续跑用的子项标识**（章号 / 文件名）。给了就必须稳定 ——
        下次续跑靠它判断「这个已经做过了」。
        """
        with _cv:
            j = self._job()
            j["done"] = int(j["done"]) + int(n)
            if key is not None and str(key) not in j["items_done"]:
                j["items_done"].append(str(key))
            if text is not None:
                _emit(j, str(text)[:EVENT_TEXT_MAX], level=level)
            _persist(j)

    def result(self, **kw: Any) -> None:
        """往任务的产物里塞东西（终态时会被界面取走）。"""
        with _cv:
            j = self._job()
            j["result"].update(kw)
            _persist(j)

    # ---- 续跑用 ----

    @property
    def skip(self) -> set[str]:
        """上次已完成、这次要跳过的子项键。"""
        with _cv:
            return set(self._job().get("skip") or [])

    @property
    def book_id(self) -> str | None:
        with _cv:
            return self._job().get("book_id")


# --------------------------------------------------------------------------
# 内部：日志与落盘
# --------------------------------------------------------------------------

def _emit(job: dict, text: str, level: str = "info") -> None:
    job["event_seq"] = int(job["event_seq"]) + 1
    job["events"].append({
        "seq": job["event_seq"],
        "at": time.strftime("%H:%M:%S"),
        "level": level,
        "text": text,
    })
    if len(job["events"]) > EVENT_CAP:
        drop = len(job["events"]) - EVENT_CAP
        del job["events"][:drop]
        job["events_dropped"] = int(job["events_dropped"]) + drop


def _persist(job: dict, force: bool = False) -> None:
    """把任务记录写一份到 `data/jobs/<id>.json`。

    落盘失败**绝不能**影响任务执行 —— 记录是给「看」用的，不是正确的来源。
    """
    now = time.time()
    if not force and now - float(job.get("_persisted_at") or 0) < PERSIST_MIN_GAP:
        return
    job["_persisted_at"] = now
    try:
        d = paths.jobs_dir()
        d.mkdir(parents=True, exist_ok=True)
        payload = {k: v for k, v in job.items() if not k.startswith("_")}
        tmp = d / (job["id"] + ".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp.replace(d / (job["id"] + ".json"))
    except OSError as exc:
        log.warning("任务记录落盘失败（不影响执行）：%s", exc)


def _snapshot(job: dict | None, after: int | None = None) -> dict | None:
    """给外部的只读快照。`after` 给了就只回增量日志（轮询用）。"""
    if job is None:
        return None
    events = list(job["events"])
    if after is not None:
        events = [e for e in events if e["seq"] > after]
    total = int(job.get("total") or 0)
    done = int(job.get("done") or 0)
    status = job["status"]
    if total:
        percent = max(0, min(100, round(done * 100 / total)))
    else:
        # 总数还不知道时：跑完了就是 100%，否则给 0（界面显示不确定态）
        percent = 100 if status in (DONE, CANCELLED, INTERRUPTED) and done else 0
    out = {k: v for k, v in job.items() if not k.startswith("_")}
    out.update({
        "events": events,
        "items_done": list(job["items_done"]),
        "result": dict(job["result"]),
        "percent": percent,
        "queue_ahead": _queue.index(job["id"]) if job["id"] in _queue else 0,
        "can_cancel": status in (QUEUED, RUNNING),
        "can_resume": status in TERMINAL and bool(job.get("resumable"))
        and status != DONE and bool(job.get("items_done")),
        "elapsed_seconds": _elapsed(job),
    })
    return out


def _elapsed(job: dict) -> float | None:
    t0 = job.get("_t0")
    if t0 is None:
        return None
    end = job.get("_t1") or time.time()
    return round(end - t0, 3)


# --------------------------------------------------------------------------
# 历史记录读写
# --------------------------------------------------------------------------

def _ensure_loaded() -> None:
    global _loaded
    with _cv:
        if _loaded:
            return
        _loaded = True
        _load_history_locked()


def ensure_loaded() -> None:
    """读一次历史（幂等）。**要在「先落暂存文件」之前调。**

    只有一个理由：读历史时会顺手清掉该清的暂存目录。如果这一步晚于落盘，
    刚写进去的文件就会被当成孤立目录删掉 —— 真发生过：全新进程里的第一个
    导入任务，上传的文件刚落到 `jobs/<id>/stage/`，紧接着 submit 触发的
    首次加载把它清了，任务起来只能报「暂存目录里一个文件都没找到」。
    所以调用方在落文件前先显式把历史读进来。
    """
    _ensure_loaded()


def _load_history_locked() -> None:
    """把 `data/jobs/*.json` 读回内存。

    暂存目录的清理只做**两件有把握的事**，不做任何猜测：
      ① 本次真正被裁掉的记录（超保留份数 / 文件坏了），它的暂存目录一并清掉
      ② 明显过期的孤儿目录（很久没人认领）—— 阈值给得极宽，
         因为「刚建出来、记录还没登记」的目录是**正常的中间状态**，
         宁可留着也不能误删（误删等于删掉正在提交的任务的输入）
    """
    d = paths.jobs_dir()
    if not d.is_dir():
        return
    try:
        root = d.resolve()
        files = [p for p in d.glob("*.json") if p.is_file()]
        files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError as exc:
        log.warning("读取任务历史失败（忽略）：%s", exc)
        return

    keep_ids: set[str] = set()
    pruned: set[str] = set()
    for i, f in enumerate(files):
        if i >= HISTORY_KEEP:
            pruned.add(f.stem)
            try:
                f.unlink()
            except OSError:
                pass
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pruned.add(f.stem)
            try:
                f.unlink()
            except OSError:
                pass
            continue
        if not isinstance(data, dict) or not data.get("id"):
            continue
        jid = str(data["id"])
        keep_ids.add(jid)
        data.setdefault("events", [])
        data.setdefault("items_done", [])
        data.setdefault("result", {})
        data.setdefault("args", {})
        data.setdefault("event_seq", 0)
        data.setdefault("events_dropped", 0)
        data.setdefault("skip", [])
        data.setdefault("detail", None)
        data.setdefault("elapsed_seconds", None)
        data["cancel_requested"] = False
        data["_persisted_at"] = 0.0
        data["_t0"] = None
        data["_t1"] = None
        if data.get("status") in (QUEUED, RUNNING):
            # 进程重启过 —— 那个线程早就不在了。如实说，不要假装它还在跑。
            data["status"] = INTERRUPTED
            data["message"] = "程序上次退出时这个任务还没跑完（进度留着，可以续跑）"
            data["finished_at"] = data.get("finished_at") or _iso()
            if not data["events"] or data["events"][-1]["text"] != data["message"]:
                _emit(data, data["message"], level="warn")
        _jobs[jid] = data

    # 续跑出来的任务会指着**上一个任务**的暂存目录（args.stage_id）。
    # 那个任务的记录可能已经被删了，但目录还得留着 —— 否则续跑会报「文件没了」。
    for j in _jobs.values():
        ref = str(j.get("args", {}).get("stage_id") or "")
        if ref:
            keep_ids.add(ref)

    # 清暂存目录：只清「有把握」的两类（① 这次裁掉的记录 ② 明显过期的孤儿）
    try:
        now = time.time()
        for p in d.iterdir():
            if not p.is_dir():
                continue
            if p.resolve().parent != root:
                continue  # 路径闸：不是直接子目录，不碰
            if p.name in keep_ids:
                continue
            if p.name in pruned:
                log.info("清理已裁掉记录的任务暂存目录：%s", p.name)
                shutil.rmtree(p, ignore_errors=True)
                continue
            try:
                age = now - p.stat().st_mtime
            except OSError:
                continue
            if age > STALE_STAGE_SECONDS:
                log.info("清理过期的孤儿任务暂存目录：%s（%.1f 天没人认领）",
                         p.name, age / 86400)
                shutil.rmtree(p, ignore_errors=True)
    except OSError as exc:
        log.warning("清理任务暂存目录失败（忽略）：%s", exc)


# --------------------------------------------------------------------------
# 入队与执行
# --------------------------------------------------------------------------

def submit(
    kind: str,
    *,
    book_id: str | None = None,
    title: str = "",
    args: dict | None = None,
    skip: list[str] | set[str] | None = None,
    resumed_from: str | None = None,
    job_id: str | None = None,
) -> dict:
    """排一个任务。返回它的快照（含 id，界面拿这个 id 轮询）。

    `job_id` 允许调用方**事先指定**，只有一个理由：导入任务要先按 id 建暂存
    目录把文件落进去，而目录名得跟任务 id 一致（不然重启后对不上）。
    自己指定就得自己保证它干净 —— 这里只收 8~32 位十六进制，挡住 `..` 之类。
    """
    _ensure_loaded()
    meta = _registry.get(kind)
    if meta is None:
        raise ValueError(f"未登记的任务类型：{kind}")
    with _cv:
        busy = _find_busy_locked(kind, book_id)
        if busy is not None and resumed_from is None:
            raise BusyError(_snapshot(busy))
        job = _make_job_locked(kind, meta, book_id, title, args, skip, resumed_from, job_id)
        return _snapshot(job)


def _find_busy_locked(kind: str, book_id: str | None) -> dict | None:
    for j in _jobs.values():
        if j["kind"] == kind and j.get("book_id") == book_id and j["status"] in (QUEUED, RUNNING):
            return j
    return None


def _make_job_locked(
    kind: str, meta: dict, book_id: str | None, title: str,
    args: dict | None, skip: list[str] | set[str] | None, resumed_from: str | None,
    job_id: str | None = None,
) -> dict:
    skip_list = sorted({str(s) for s in (skip or [])})
    jid = _resolve_job_id(job_id)
    job = {
        "id": jid,
        "kind": kind,
        "kind_label": meta["label"],
        "hint": meta.get("hint") or "",
        "book_id": book_id,
        "title": (title or meta["label"])[:TITLE_MAX],
        "status": QUEUED,
        "total": 0,
        "done": 0,
        "unit": "",
        "message": "排队中",
        "error": None,
        "traceback": None,
        "created_at": _iso(),
        "started_at": None,
        "finished_at": None,
        "cancel_requested": False,
        "resumable": bool(meta.get("resumable")),
        "args": dict(args or {}),
        # 续跑：上次已完成的部分直接算作这次已处理，进度条从一开始就是真的
        "skip": skip_list,
        "items_done": list(skip_list),
        "result": {},
        "detail": None,
        "events": [],
        "event_seq": 0,
        "events_dropped": 0,
        "resumed_from": resumed_from,
        "resumed_by": None,
        "_persisted_at": 0.0,
        "_t0": None,
        "_t1": None,
    }
    _jobs[job["id"]] = job
    _queue.append(job["id"])
    if skip_list:
        _emit(job, f"续跑：跳过上次已完成的 {len(skip_list)} 项")
    _emit(job, f"已加入队列：{job['title']}")
    _persist(job, force=True)
    _start_worker_locked()
    # ⚠️ 必须叫醒工人。它闲下来时正卡在 `_cv.wait(timeout=30)` 上，
    #    只入队不 notify 的话，新任务要等那 30 秒超时才被看见 ——
    #    表现是「点了没反应，半分钟后突然开始跑」，且日志上看不出任何异常。
    _cv.notify_all()
    return job


def _start_worker_locked() -> None:
    global _worker
    if _worker is not None and _worker.is_alive():
        return
    _worker = threading.Thread(target=_loop, name="wkv-jobs", daemon=True)
    _worker.start()


def _loop() -> None:
    """唯一的工人。串行取任务、跑、收尾。"""
    while True:
        with _cv:
            while not _queue:
                _cv.wait(timeout=30)
            jid = _queue.pop(0) if _queue else None
            if jid is None:
                continue
            job = _jobs.get(jid)
            if job is None or job["status"] != QUEUED:
                continue
            if job["cancel_requested"]:
                _finish_locked(job, CANCELLED, message="排队时被取消")
                continue
            job["status"] = RUNNING
            job["started_at"] = _iso()
            job["message"] = "执行中"
            job["_t0"] = time.time()
            _emit(job, "开始执行")
            _persist(job, force=True)
            runner = _registry.get(job["kind"], {}).get("runner")

        if runner is None:
            with _cv:
                _finish_locked(job, FAILED, message=f"任务类型「{job['kind']}」没有注册执行体",
                               error="runner-missing")
            continue
        try:
            runner(Task(jid), job["args"])
        except JobCancelled:
            with _cv:
                _finish_locked(job, CANCELLED,
                               message="已停止（停在子项之间，已完成的部分都保留着，可以续跑）")
        except Exception as exc:  # noqa: BLE001 —— 任何异常都要落成任务状态，不能让工人死掉
            log.exception("任务 %s 执行失败：%s", jid, exc)
            with _cv:
                job["traceback"] = traceback.format_exc()[-2000:]
                _finish_locked(job, FAILED, message=f"{type(exc).__name__}：{exc}", error=str(exc))
        else:
            with _cv:
                if job["status"] == RUNNING:
                    if job["cancel_requested"]:
                        _finish_locked(job, CANCELLED, message="已停止（跑到收尾处才看到停止请求）")
                    else:
                        _finish_locked(job, DONE, message=_done_message(job))


def _done_message(job: dict) -> str:
    total = int(job.get("total") or 0)
    done = int(job.get("done") or 0)
    if total and done == total:
        return f"完成：{done}/{total}{job.get('unit') or ''}"
    return f"完成：处理了 {done}{job.get('unit') or ''}"


def _finish_locked(job: dict, status: str, *, message: str | None = None,
                   error: str | None = None) -> None:
    job["status"] = status
    if message:
        job["message"] = message
    if error:
        job["error"] = error
    job["finished_at"] = _iso()
    job["_t1"] = time.time()
    job["elapsed_seconds"] = _elapsed(job)
    job["cancel_requested"] = False
    level = "ok" if status == DONE else ("warn" if status in (FAILED, CANCELLED, INTERRUPTED) else "info")
    _emit(job, message or status, level=level)
    _persist(job, force=True)


# --------------------------------------------------------------------------
# 对外操作：查 / 停 / 续 / 删
# --------------------------------------------------------------------------

def get(job_id: str, after: int | None = None) -> dict | None:
    """单个任务快照。`after` 是上次拿到的最大 `event_seq`，只回之后的日志。"""
    _ensure_loaded()
    with _cv:
        j = _jobs.get(job_id)
        return _snapshot(j, after) if j else None


def list_jobs(
    *, book_id: str | None = None, status: str | None = None, limit: int = 30,
    with_events: bool = False,
) -> list[dict]:
    _ensure_loaded()
    with _cv:
        items = list(_jobs.values())
        if book_id:
            items = [j for j in items if j.get("book_id") == book_id]
        if status:
            wanted = {s for s in status.split(",") if s}
            items = [j for j in items if j["status"] in wanted]
        items.sort(key=lambda j: (j.get("created_at") or ""), reverse=True)
        out = []
        for j in items[: max(0, limit)]:
            snap = _snapshot(j, None if with_events else 0)
            if snap is not None and not with_events:
                snap.pop("events", None)
            out.append(snap)
        return out


def pending_for_book(book_id: str) -> list[dict]:
    """这本书还有没有没跑完的任务（排队中或正在跑）。

    **删书之前必须先问这一句**：任务还在往书目录里写，一边删一边写，
    Windows 上 `rmtree` 会中途报「目录不是空的」停下 —— 落成
    「书没删干净、索引却已经清空」的最坏状态（真踩到过，见验收脚本注释）。
    宁可让用户先去任务中心把活儿停掉，也不要删出半个书来。
    """
    _ensure_loaded()
    with _cv:
        return [
            _snapshot(j, 0)
            for j in _jobs.values()
            if j.get("book_id") == book_id and j["status"] not in TERMINAL
        ]


def active() -> dict:
    """当前在跑的那个 + 排队情况。界面顶部的常驻小条用它，要便宜。"""
    _ensure_loaded()
    with _cv:
        run = next((j for j in _jobs.values() if j["status"] == RUNNING), None)
        queued = [j for j in _jobs.values() if j["status"] == QUEUED]
        return {
            "running": _snapshot(run, 0) if run else None,
            "queued": len(queued),
            "queue": [_snapshot(j, 0) for j in queued][:5],
        }


def cancel(job_id: str) -> dict:
    """请求停止。排队中的立刻变终态；正在跑的置标志，worker 在下一个安全点收尾。"""
    _ensure_loaded()
    with _cv:
        j = _jobs.get(job_id)
        if j is None:
            raise KeyError(job_id)
        if j["status"] in TERMINAL:
            return _snapshot(j, 0)
        j["cancel_requested"] = True
        if j["status"] == QUEUED:
            if j["id"] in _queue:
                _queue.remove(j["id"])
            _finish_locked(j, CANCELLED, message="排队时被取消")
        else:
            j["message"] = "正在收尾（跑到下一个安全点就停）"
            _emit(j, "收到停止请求：跑到下一个安全点就停", level="warn")
            _persist(j, force=True)
        return _snapshot(j, 0)


def resume(job_id: str) -> dict:
    """拿同一份参数再排一个任务，跳过上次已完成的子项。

    不是「把那个线程接上」—— 做不到，也不该假装做得到。会真的**再花一次钱**
    跑剩下的那些章，所以界面上必须写清「只跑没跑完的部分」。
    """
    _ensure_loaded()
    with _cv:
        old = _jobs.get(job_id)
        if old is None:
            raise KeyError(job_id)
        if old["status"] not in TERMINAL:
            raise ResumeError("这个任务还在跑，不用续跑")
        if not old.get("resumable"):
            raise ResumeError("这一类任务不支持续跑（重跑一遍更干净）")
        if old["kind"] not in _registry:
            raise ResumeError(f"任务类型「{old['kind']}」已经不存在了，无法续跑")
        new = _make_job_locked(
            old["kind"], _registry[old["kind"]], old.get("book_id"),
            old.get("title") or "", old.get("args") or {},
            old.get("items_done") or [], old["id"],
        )
        old["resumed_by"] = new["id"]
        _persist(old, force=True)
        return _snapshot(new, 0)


def delete(job_id: str) -> bool:
    """删掉一条历史记录（连带它的暂存文件）。只允许删终态。

    暂存文件的归属是**引用计数**式的：续跑出来的任务靠 `args.stage_id`
    指着最初那份目录。所以删一条记录时要看两件事：
      - 别人还指着我 → 我的目录留着（删了别人下次就只能报「文件没了」）
      - 我指着别人，而我是最后一个引用者 → 顺手把那份目录也清了
        （不然它会永远躺在那儿，因为它的记录早就没了）
    """
    _ensure_loaded()
    with _cv:
        j = _jobs.get(job_id)
        if j is None:
            return False
        if j["status"] not in TERMINAL:
            raise ResumeError("任务还在跑（或还在排队），先停掉再删")
        ref = str(j.get("args", {}).get("stage_id") or "")
        _jobs.pop(job_id, None)
        if job_id in _queue:
            _queue.remove(job_id)
        still_used = _stage_in_use_locked(job_id)
        stage_orphan = bool(ref) and ref != job_id and not _stage_in_use_locked(ref)
    _drop_record_file(job_id)
    if not still_used:
        _drop_stage_dir(job_id)
    if stage_orphan:
        _drop_stage_dir(ref)
    return True


def _stage_in_use_locked(job_id: str) -> bool:
    """还有别的任务指着这份暂存目录吗？"""
    return any(
        str(o.get("args", {}).get("stage_id") or "") == job_id for o in _jobs.values()
    )


def _drop_record_file(job_id: str) -> None:
    """删记录文件。**先校验路径归属**再动手（沿用删除类操作的纪律）。"""
    d = paths.jobs_dir()
    try:
        root = d.resolve()
        f = d / (job_id + ".json")
        if f.is_file() and f.resolve().parent == root:
            f.unlink()
    except OSError as exc:
        log.warning("删除任务记录失败：%s", exc)


def _drop_stage_dir(job_id: str) -> None:
    """删暂存目录。同样先过路径闸。"""
    d = paths.jobs_dir()
    try:
        root = d.resolve()
        sub = d / job_id
        if sub.is_dir() and sub.resolve().parent == root:
            shutil.rmtree(sub, ignore_errors=True)
    except OSError as exc:
        log.warning("删除任务暂存目录失败：%s", exc)


def stage_dir(job_id: str) -> Path:
    """导入类任务的暂存目录：`<jobs>/<id>/stage/`（上传的文件先落这里）。

    放在数据目录而不是系统临时目录，是因为它要**活过重启**：
    重启后要么续跑、要么记录被清掉，总之不能悄悄消失掉一半。
    """
    return paths.jobs_dir() / job_id / "stage"


def wait(job_id: str, timeout: float = 30.0, interval: float = 0.05) -> dict | None:
    """等一个任务到终态。**只给测试用** —— 界面一律轮询，不要阻塞请求线程。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        snap = get(job_id, None)
        if snap is None:
            return None
        if snap["status"] in TERMINAL:
            return snap
        time.sleep(interval)
    return get(job_id, None)
