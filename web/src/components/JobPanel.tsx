/**
 * 任务中心（P11-A3）—— 长任务看得见、停得下、断了能续。
 *
 * 这一页回答三个问题，顺序也就是版面的顺序：
 *   1. **现在在跑什么**（大卡：进度条、跑到第几项、还要多久的体感）
 *   2. **还排着什么**（队列，含「我前面还有几个」）
 *   3. **跑过什么**（历史；失败的能看日志、中断的能续跑）
 *
 * 两条自我约束：
 * - **「已完成 N 项」是手数出来的，不是估的**。后端每做完一个子项报一次，
 *   进度条因此永远与真实进度一致 —— 不给「预计剩余时间」那种编出来的数字。
 * - **中断/失败不美化**。`interrupted`（程序上次退出时还没跑完）与
 *   `cancelled`（你按了停）分开显示：它们该做的决定不一样，一个是「续跑」，
 *   一个是「我知道我停了」。
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import type { Job, JobStatus } from '../api/types'
import { Panel } from '../components/Panel'
import { useJobs } from '../state/jobs'

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: '排队中',
  running: '执行中',
  done: '完成',
  failed: '失败',
  cancelled: '已停止',
  interrupted: '中断（未跑完）',
}

/** 状态 → 颜色语义。失败与中断必须是红的/黄的不同色 —— 处理方式不一样 */
const STATUS_TONE: Record<JobStatus, string> = {
  queued: 'job__badge--idle',
  running: 'job__badge--run',
  done: 'job__badge--ok',
  failed: 'job__badge--bad',
  cancelled: 'job__badge--idle',
  interrupted: 'job__badge--warn',
}

function clock(s: string | null): string {
  if (!s) return '—'
  // 后端给的是本地时间字符串（YYYY-MM-DDTHH:MM:SS），直接切出时分秒就好
  const t = s.includes('T') ? s.split('T')[1] : s
  return t.slice(0, 8)
}

function elapsed(j: Job): string {
  if (j.elapsed_seconds != null) return `${j.elapsed_seconds.toFixed(1)} 秒`
  return '—'
}

export function JobPanel() {
  const { active, jobs, detail, kinds, loading, cancel, resume, remove, watch, refresh } = useJobs()
  const [err, setErr] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)

  // 打开这一页时先要一份最新的（别等下一次轮询）
  useEffect(() => {
    void refresh().catch(() => undefined)
  }, [refresh])

  // 日志尾巴跟着滚 —— 不然跑到第 30 章时还得手动往下拖
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [detail?.events?.length])

  const running = active.running
  const queued = useMemo(() => jobs.filter((j) => j.status === 'queued'), [jobs])

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id)
    setErr(null)
    try {
      await fn()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Panel
      title="任务中心"
      actions={
        <button className="btn btn--sm" onClick={() => void refresh()}>
          刷新
        </button>
      }
    >
      <div className="job">
        <div className="fs-xs job__lede">
          批量 AI 抽取、批量导入、重建索引都是长活儿，交给后台跑：可以离开这一页、
          切书、关掉面板，活儿照跑。进度是真的数出来的 —— 后端每做完一项报一次。
        </div>

        {err && <div className="notice notice--danger fs-sm">{err}</div>}

        {/* ---------- 现在在跑什么 ---------- */}
        {running ? (
          <div className="job__hero">
            <div className="row job__hero-top">
              <span className="job__kind">{running.kind_label}</span>
              <span className="job__title" title={running.title}>{running.title}</span>
              <div className="grow" />
              <button
                className="btn btn--sm btn--danger"
                disabled={busyId === running.id}
                onClick={() => void act(running.id, () => cancel(running.id))}
              >
                停止
              </button>
            </div>
            <div className="job__bar">
              <div className="job__bar-fill" style={{ width: `${running.percent}%` }} />
            </div>
            <div className="row fs-xs job__meta">
              <span className="tnum">
                {running.total
                  ? `${running.done} / ${running.total} ${running.unit}`
                  : running.done
                    ? `已处理 ${running.done}`
                    : '正在准备…'}
              </span>
              <span className="tnum">{running.percent}%</span>
              <div className="grow" />
              <span>已用 {elapsed(running)}</span>
              {running.detail && (
                <span>
                  正在跑：
                  {Object.entries(running.detail)
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join(' ')}
                </span>
              )}
            </div>
            <div className="fs-xs job__msg">{running.message}</div>
            <div className="row">
              <button
                className="btn btn--sm"
                onClick={() => watch(detail?.id === running.id ? null : running.id)}
              >
                {detail?.id === running.id ? '收起日志' : '看日志'}
              </button>
            </div>
          </div>
        ) : (
          <div className="job__idle fs-sm">
            现在没有任务在跑。
            <span className="fs-xs job__idle-hint">
              正文面板导入章节、技能面板跑批量抽取、汇总页点重建索引，都会排到这里来。
            </span>
          </div>
        )}

        {/* ---------- 还排着什么 ---------- */}
        {queued.length > 0 && (
          <div className="job__queue">
            <div className="job__sec">排队中（前面还有 {queued.length} 个）</div>
            {queued.map((j) => (
              <div key={j.id} className="row job__qrow">
                <span className="job__kind">{j.kind_label}</span>
                <span className="job__title" title={j.title}>{j.title}</span>
                <div className="grow" />
                <span className="fs-xs">
                  前面还有 {j.queue_ahead} 个任务
                </span>
                <button
                  className="btn btn--sm"
                  disabled={busyId === j.id}
                  onClick={() => void act(j.id, () => cancel(j.id))}
                >
                  取消
                </button>
              </div>
            ))}
          </div>
        )}

        {/* ---------- 日志尾巴 ---------- */}
        {detail && (
          <div className="job__log-wrap">
            <div className="row job__sec">
              日志 · {detail.title}
              <div className="grow" />
              <span className="fs-xs">
                共 {detail.event_seq} 条
                {detail.events_dropped > 0 && `（更早的 ${detail.events_dropped} 条已滚出）`}
              </span>
              <button className="btn btn--sm" onClick={() => watch(null)}>收起</button>
            </div>
            <div className="job__log" ref={logRef}>
              {(detail.events ?? []).map((e) => (
                <div key={e.seq} className={`job__line job__line--${e.level}`}>
                  <span className="job__lt">{e.at}</span>
                  <span>{e.text}</span>
                </div>
              ))}
              {!detail.events?.length && <div className="fs-xs job__line">（还没有日志）</div>}
            </div>
          </div>
        )}

        {/* ---------- 跑过什么 ---------- */}
        <div className="job__sec">历史记录</div>
        {loading && <div className="fs-xs">正在载入…</div>}
        {!loading && jobs.length === 0 && (
          <div className="fs-xs">
            还没有任何任务记录。任务记录存在数据目录的 <code>jobs/</code> 下 ——
            不进索引，因为索引可以随时删掉重建，而「这一章抽过了」删掉就真没了。
          </div>
        )}
        <div className="job__list">
          {jobs.map((j) => (
            <div key={j.id} className={`job__item ${detail?.id === j.id ? 'job__item--on' : ''}`}>
              <div className="row job__item-top">
                <span className={`job__badge ${STATUS_TONE[j.status]}`}>
                  {STATUS_LABEL[j.status]}
                </span>
                <span className="job__kind">{j.kind_label}</span>
                <span className="job__title" title={j.title}>{j.title}</span>
                <div className="grow" />
                <span className="fs-xs tnum">{clock(j.created_at)}</span>
              </div>
              <div className="row fs-xs job__item-meta">
                <span>
                  {j.total ? `${j.done}/${j.total} ${j.unit}` : `处理了 ${j.done}`}
                  {j.elapsed_seconds != null && ` · ${j.elapsed_seconds.toFixed(1)} 秒`}
                </span>
                {j.resumed_from && <span>续跑自 {j.resumed_from.slice(0, 6)}</span>}
                {j.resumed_by && <span>已续跑为 {j.resumed_by.slice(0, 6)}</span>}
                <div className="grow" />
                <button className="btn btn--sm" onClick={() => watch(detail?.id === j.id ? null : j.id)}>
                  {detail?.id === j.id ? '收起' : '详情'}
                </button>
                {j.can_resume && (
                  <button
                    className="btn btn--sm"
                    disabled={busyId === j.id}
                    title="拿同一份参数再排一个任务，跳过上次已完成的部分（会真的再跑一次）"
                    onClick={() => void act(j.id, () => resume(j.id))}
                  >
                    续跑
                  </button>
                )}
                {!j.can_cancel && (
                  <button
                    className="btn btn--sm"
                    disabled={busyId === j.id}
                    title="只删这条记录（正在跑的不给删）"
                    onClick={() => void act(j.id, () => remove(j.id))}
                  >
                    删除
                  </button>
                )}
              </div>
              {j.status === 'failed' && j.error && (
                <div className="fs-xs job__err">失败原因：{j.error}</div>
              )}
              {j.status === 'cancelled' && (
                <div className="fs-xs job__msg">
                  停在子项之间 —— 已完成的部分都保留着，点「续跑」只补没做完的。
                </div>
              )}
              {j.status === 'interrupted' && (
                <div className="fs-xs job__msg">
                  程序上次退出时它还没跑完（进度留着）。点「续跑」接着做。
                </div>
              )}
            </div>
          ))}
        </div>

        {/* ---------- 这类任务是什么（空态时用来教人）---------- */}
        {jobs.length === 0 && kinds.length > 0 && (
          <div className="job__kinds">
            {kinds.map((k) => (
              <div key={k.kind} className="fs-xs job__kindrow">
                <b>{k.label}</b>
                <span>{k.hint}</span>
                {k.resumable && <span className="job__tag">可续跑</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  )
}

/** 顶栏那条常驻小条在 JobChip.tsx —— 单独一个文件，因为顶栏要 import 它，
 *  而这一页是懒加载的：放一起会把整个任务中心的代码拖进首屏包。 */
