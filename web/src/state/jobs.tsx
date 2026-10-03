/**
 * 异步任务状态层（P11-A3）。
 *
 * 为什么单独一层、还要放在 App 级别
 * -------------------------------
 * 长任务的特点是「人在别的界面上干活，活儿在后台跑」。所以：
 * - **只有一个轮询器**。每个组件各拉各的话，打开五个视图就是五倍请求，
 *   而且它们看到的状态还可能不在同一秒上（同一个任务在两个地方显示
 *   不一样的百分比，比不显示更糟）。
 * - 状态放在 App 之上的 Provider 里，于是**切视图、切书、关掉面板，
 *   任务照跑照显示**（顶栏那条常驻小条就是从这儿读的）。
 *
 * 轮询而不是 SSE：进度本来就是秒级粒度；轮询还白送两件事 ——
 * **刷新页面回来进度还在**、**打包成桌面程序后不新增长连接**。
 * 增量靠 `?after=<上次最大 event_seq>`，所以轮询体量恒定，跟跑了多久无关。
 *
 * 空闲时**停止轮询**：没任务的时候一秒一次是纯浪费。需要一个任务一提交
 * 就立刻恢复（`submit` 里会踢一脚），否则会出现「点了没反应」的错觉。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import * as api from '../api/client'
import type { Job, JobKindInfo, JobsActive } from '../api/types'
import { useApp } from './store'

/** 有活儿时的轮询间隔。1.2 秒 —— 进度条看起来是连续的，又不至于把后端打满 */
const POLL_BUSY = 1200
/** 空闲时也慢慢看一眼的间隔。**不能完全不轮询** —— 刷新页面后要能发现
 *  「别处提交的任务已经跑完了」，或者别的标签页提交了任务 */
const POLL_IDLE = 6000
/** 盯单个任务的日志尾部时的间隔 */
const POLL_WATCH = 1000

interface JobsValue {
  /** 当前在跑的那个 + 排队情况（顶栏常驻小条用） */
  active: JobsActive
  /** 最近的任务清单（任务中心用） */
  jobs: Job[]
  /** 正在盯的那个任务的详情（含日志尾巴） */
  detail: Job | null
  /** 任务类型目录（含「能不能续跑」与一句说明） */
  kinds: JobKindInfo[]
  loading: boolean

  /** 提交三类长任务。返回入队后的任务快照。 */
  submitRebuild: (bookId?: string) => Promise<Job>
  submitAiExtract: (
    bookId: string,
    chapterNos?: number[],
    opts?: { provider?: string; refresh?: boolean },
  ) => Promise<Job>
  submitImport: (
    bookId: string,
    files: File[],
    overwrite?: boolean,
    onProgress?: (pct: number) => void,
  ) => Promise<Job>

  cancel: (jobId: string) => Promise<void>
  resume: (jobId: string) => Promise<Job>
  remove: (jobId: string) => Promise<void>
  /** 盯住某个任务（任务中心点开一条时用）；传 null 取消 */
  watch: (jobId: string | null) => void
  /** 等某个任务跑到终态。**不阻塞界面**，只是返回一个 Promise */
  waitFor: (jobId: string) => Promise<Job>
  refresh: () => Promise<void>
}

const Ctx = createContext<JobsValue | null>(null)

export function useJobs(): JobsValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('任务相关的组件必须在 JobsProvider 内渲染')
  return v
}

export function JobsProvider({ children }: { children: ReactNode }) {
  const { notify } = useApp()
  const [active, setActive] = useState<JobsActive>({ running: null, queued: 0, queue: [] })
  const [jobs, setJobs] = useState<Job[]>([])
  const [detail, setDetail] = useState<Job | null>(null)
  const [kinds, setKinds] = useState<JobKindInfo[]>([])
  const [loading, setLoading] = useState(true)
  /** 正在盯的那个任务 id（放 state 而不是 ref —— 它一变就该换一条轮询） */
  const [watchId, setWatchId] = useState<string | null>(null)

  /** 立刻醒过来跑一轮（提交完任务要踢这一脚，不然最多要等 POLL_IDLE） */
  const kickRef = useRef<(() => void) | null>(null)
  /** 轮询循环要读「当前有没有活儿」，用 ref 读到最新的，而不进依赖数组 */
  const activeNowRef = useRef<JobsActive>(active)
  activeNowRef.current = active
  const cursorRef = useRef(0)
  const mounted = useRef(true)

  const loadKinds = useCallback(async () => {
    try {
      const r = await api.jobKinds()
      if (mounted.current) setKinds(r.kinds)
    } catch {
      /* 任务类型拉不到不影响别的功能 */
    }
  }, [])

  const refresh = useCallback(async () => {
    const [act, list] = await Promise.all([api.jobsActive(), api.listJobs({ limit: 30 })])
    if (!mounted.current) return
    setActive(act)
    setJobs(list.jobs)
    setLoading(false)
  }, [])

  // ---- 全局轮询：有活儿时密集，空闲时稀疏（但不停 —— 换个标签页提交的
  //      任务，这边也得能发现它跑完了）----
  useEffect(() => {
    let stopped = false
    let timer: number | null = null

    const loop = async () => {
      try {
        await refresh()
      } catch {
        /* 后端可能刚起来 / 正在重启，下一轮再试 */
      }
      if (stopped) return
      const a = activeNowRef.current
      const busy = Boolean(a.running) || a.queued > 0
      timer = window.setTimeout(loop, busy ? POLL_BUSY : POLL_IDLE)
    }

    kickRef.current = () => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(loop, 0)
    }
    timer = window.setTimeout(loop, 0)
    return () => {
      stopped = true
      kickRef.current = null
      if (timer != null) window.clearTimeout(timer)
    }
  }, [refresh])

  // ---- 盯单个任务：只回新日志，所以轮询体量恒定（跟它跑了多久无关）----
  useEffect(() => {
    if (!watchId) return
    let stopped = false
    let timer: number | null = null
    cursorRef.current = 0
    setDetail(null)

    const tick = async () => {
      try {
        const j = await api.getJob(watchId, cursorRef.current)
        if (stopped) return
        const fresh = j.events ?? []
        if (fresh.length) cursorRef.current = fresh[fresh.length - 1].seq
        setDetail((prev) =>
          prev && prev.id === j.id && fresh.length
            ? { ...j, events: [...(prev.events ?? []), ...fresh] }
            : j,
        )
        if (['done', 'failed', 'cancelled', 'interrupted'].includes(j.status)) return
      } catch {
        /* 记录可能被清理了；下一轮再说 */
      }
      if (!stopped) timer = window.setTimeout(tick, POLL_WATCH)
    }
    timer = window.setTimeout(tick, 0)
    return () => {
      stopped = true
      if (timer != null) window.clearTimeout(timer)
    }
  }, [watchId])

  useEffect(() => {
    void loadKinds()
    return () => {
      mounted.current = false
    }
  }, [loadKinds])

  const afterSubmit = useCallback(
    (job: Job) => {
      // 提交完立刻把轮询密度拉起来 —— 不然最多要等 POLL_IDLE 才见到它，
      // 对着界面就是「点了没反应」。
      kickRef.current?.()
      void refresh().catch(() => undefined)
      return job
    },
    [refresh],
  )

  const submitRebuild = useCallback(
    async (bookId?: string) => afterSubmit(await api.rebuildIndexJob(bookId)),
    [afterSubmit],
  )

  const submitAiExtract = useCallback(
    async (bookId: string, chapterNos: number[] = [], opts = {}) =>
      afterSubmit(await api.extractWithAiJob(bookId, chapterNos, opts)),
    [afterSubmit],
  )

  const submitImport = useCallback(
    async (
      bookId: string,
      files: File[],
      overwrite = false,
      onProgress?: (pct: number) => void,
    ) => afterSubmit(await api.importChaptersJob(bookId, files, overwrite, onProgress)),
    [afterSubmit],
  )

  const watch = useCallback((jobId: string | null) => setWatchId(jobId), [])

  const cancel = useCallback(
    async (jobId: string) => {
      const j = await api.cancelJob(jobId)
      setDetail((prev) =>
        prev && prev.id === j.id ? { ...prev, ...j, events: prev.events } : prev)
      void refresh()
    },
    [refresh],
  )

  const resume = useCallback(
    async (jobId: string) => {
      const j = await api.resumeJob(jobId)
      notify('ok', `已续跑：只跑上次没做完的部分（跳过 ${j.skip.length} 项）`)
      setWatchId(j.id)
      kickRef.current?.()
      void refresh()
      return j
    },
    [notify, refresh],
  )

  const remove = useCallback(
    async (jobId: string) => {
      await api.deleteJob(jobId)
      setWatchId((cur) => (cur === jobId ? null : cur))
      void refresh()
    },
    [refresh],
  )

  const waitFor = useCallback(async (jobId: string) => {
    // 自带一套轻轮询：等结果的人自己关心，不该让全局循环跟着变密
    for (;;) {
      const j = await api.getJob(jobId)
      if (['done', 'failed', 'cancelled', 'interrupted'].includes(j.status)) return j
      await new Promise((r) => window.setTimeout(r, 900))
    }
  }, [])

  const value = useMemo<JobsValue>(
    () => ({
      active, jobs, detail, kinds, loading,
      submitRebuild, submitAiExtract, submitImport,
      cancel, resume, remove, watch, waitFor, refresh,
    }),
    [active, jobs, detail, kinds, loading, submitRebuild, submitAiExtract, submitImport,
     cancel, resume, remove, watch, waitFor, refresh],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
