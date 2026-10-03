/** 快照与保留策略（P11-A6）。
 *
 * 之前只有「删除前快照」—— 也就是说，**只有你动手删东西的那一刻**才留底。
 * 改了半天属性、拖乱了图、批量导入跑歪了，都没有后悔药。
 * 这里补上「按时间存一份」：启动时与每 N 小时各存一整份，配保留策略自动清理。
 *
 * 三条自我约束：
 * 1. **只读展示 + 显式动作**。这份面板自己不会偷偷存、也不会偷偷删；
 *    清理走「先算一遍给你看 → 确认 → 才真删」两步。
 * 2. **不吹牛能一键恢复**。恢复目前是手动按路径拷回 —— 界面如实说明，
 *    不写一个做不到的按钮。
 * 3. **不碰正文**。快照是整份复制（含正文），但复制不会改任何原件。
 */

import { useCallback, useEffect, useState } from 'react'
import * as api from '../api/client'
import type { SnapshotList, SnapshotPruneResult } from '../api/types'
import { useApp } from '../state/store'
import { Panel } from '../components/Panel'

/** 缘由 → 中文说明。后端存的是短英文串（也当目录名用）。 */
const REASON_LABEL: Record<string, string> = {
  auto: '定时自动',
  manual: '手动',
  'lint-delete': '删除前',
  delete: '删除前',
  unknown: '（无清单）',
}

function formatBytes(n: number): string {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function SnapshotPanel() {
  const { bookId, notify } = useApp()
  const [data, setData] = useState<SnapshotList | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [onlyMine, setOnlyMine] = useState(false)
  const [plan, setPlan] = useState<SnapshotPruneResult | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await api.adminSnapshots())
      setErr(null)
    } catch (e) {
      setData(null)
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const take = async (scope: 'book' | 'all') => {
    setBusy(true)
    setPlan(null)
    try {
      const r = await api.snapshotNow(scope === 'book' ? bookId ?? undefined : undefined)
      notify(
        'ok',
        `已存 ${r.taken.length} 份快照（共 ${r.taken.reduce((s, t) => s + t.count, 0)} 个文件）`,
      )
      await load()
    } catch (e) {
      notify('err', `快照失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  /** 第一步：只算不删。让人先看到「会清掉哪几份」再决定。 */
  const planPrune = async () => {
    setBusy(true)
    try {
      setPlan(await api.pruneSnapshots(true))
    } catch (e) {
      notify('err', `无法计算清理方案：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const doPrune = async () => {
    const n = plan?.removed.length ?? 0
    if (!n) return
    if (!window.confirm(`确定删掉这 ${n} 份快照？释放约 ${formatBytes(plan?.freed_bytes ?? 0)}。\n\n保留下来的永远是最新的那些，最新一份永不会被删。`)) {
      return
    }
    setBusy(true)
    try {
      const r = await api.pruneSnapshots(false)
      notify('ok', `已清理 ${r.removed.length} 份，释放 ${formatBytes(r.freed_bytes)}`)
      setPlan(null)
      await load()
    } catch (e) {
      notify('err', `清理失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const pol = data?.policy
  const rows = (data?.snapshots ?? []).filter((s) => !onlyMine || s.book_id === bookId)

  return (
    <Panel
      title="快照"
      className="admin__snap"
      collapsible
      sectionId="admin:snap"
      actions={
        <button className="btn btn--sm" onClick={() => void load()} disabled={busy}>
          刷新
        </button>
      }
    >
      <div className="notice" style={{ marginBottom: 'var(--p-space-3)' }}>
        <div>
          快照是<b>整份复制</b>，不含索引（索引是派生数据，重建即可）。
          <b>「删除前快照」一直都有</b>；这里补的是按时间的自动快照 ——
          启动时与每 {pol?.interval_hours ?? 24} 小时各存一份，
          超出「{pol?.keep_count ?? 20} 份」或「{pol?.max_total_mb ?? 512} MB」的部分自动保新删旧。
          恢复方式：把快照目录里的文件按原路径拷回 <code>books/&lt;书目&gt;/</code>。
        </div>
      </div>

      {err && (
        <div className="notice notice--warn" style={{ marginBottom: 'var(--p-space-3)' }}>
          读取失败：{err}
        </div>
      )}

      {data && (
        <>
          <div className="audit__bar">
            <span className="chip">{data.count} 份快照</span>
            <span className="chip chip--accent">占用 {formatBytes(data.total_bytes)}</span>
            <span className="chip">
              自动快照 {pol?.auto_enabled ? `开（每 ${pol.interval_hours} 小时）` : '关'}
            </span>
            <label className="audit__pick fs-xs">
              <input
                type="checkbox"
                checked={onlyMine}
                onChange={(e) => setOnlyMine(e.target.checked)}
              />
              只看当前书目
            </label>
          </div>

          <div className="audit__tools">
            <button
              className="btn btn--primary btn--sm"
              onClick={() => void take('book')}
              disabled={busy || !bookId}
            >
              {busy && <span className="spinner" />}
              {busy ? '正在存…' : '立即快照（当前书目）'}
            </button>
            <button className="btn btn--sm" onClick={() => void take('all')} disabled={busy}>
              立即快照（全部书）
            </button>
            <button className="btn btn--sm" onClick={() => void planPrune()} disabled={busy}>
              看看能清理什么
            </button>
            {plan && plan.removed.length > 0 && (
              <button className="btn btn--danger btn--sm" onClick={() => void doPrune()} disabled={busy}>
                清理这 {plan.removed.length} 份（释放 {formatBytes(plan.freed_bytes)}）
              </button>
            )}
          </div>
          {/* 大书是逐文件复制的 —— 上千个实体要十几秒。不写清楚，人会以为卡死了。 */}
          {busy && (
            <div className="faint fs-xs" style={{ marginBottom: 'var(--p-space-2)' }}>
              正在整份复制，实体多的书可能要十几秒，请稍候。
            </div>
          )}
          {/* 清理方案：先说清楚要删什么，再让人按下确认 */}
          {plan && (
            <div
              className={`notice ${plan.removed.length ? 'notice--warn' : 'notice--ok'}`}
              style={{ margin: 'var(--p-space-3) 0' }}
            >
              {plan.removed.length === 0 ? (
                <div>
                  按当前策略（保留最新 {pol?.keep_count} 份 / {pol?.max_total_mb} MB）没有需要清理的，
                  清完之后会留下 {plan.kept} 份。
                </div>
              ) : (
                <div>
                  按当前策略会清掉这 {plan.removed.length} 份（<b>还没有真删</b>）：
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {plan.removed.slice(0, 12).map((r) => (
                      <li key={r.name} className="fs-xs mono" style={{ wordBreak: 'break-all' }}>
                        {r.name}（{formatBytes(r.bytes)}）
                      </li>
                    ))}
                  </ul>
                  {plan.removed.length > 12 && (
                    <div className="fs-xs faint" style={{ marginTop: 4 }}>
                      …另有 {plan.removed.length - 12} 份
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {rows.length === 0 ? (
            <div className="empty">
              <div className="empty__title">还没有快照</div>
              <div className="fs-sm" style={{ maxWidth: 460 }}>
                自动快照会在启动后第一次检查时存下第一份（前提是配置里的
                <code> snapshot.auto_enabled </code>为 true）。也可以现在点「立即快照」。
              </div>
            </div>
          ) : (
            <ul className="audit__list">
              {rows.map((s) => (
                <li key={s.name} className="audit__row">
                  <span className="snap__name">{s.name}</span>
                  <span className="chip">{s.book_id}</span>
                  <span className="chip">{REASON_LABEL[s.reason] ?? s.reason}</span>
                  <span className="faint fs-xs">
                    {s.created_at || '—'} · {s.count} 个文件 · {formatBytes(s.bytes)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {data.last_auto && (
            <div className="faint fs-xs" style={{ marginTop: 'var(--p-space-3)' }}>
              上次自动快照：{data.last_auto.at}
              {data.last_auto.books.length ? `（${data.last_auto.books.join('、')}）` : ''}
            </div>
          )}
        </>
      )}
    </Panel>
  )
}
