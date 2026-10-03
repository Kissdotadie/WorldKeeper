/** 别名管理（后台，P7）：全局别名视角 + 冲突检测 + 实体合并。
 *
 * 为什么需要这一页：单个实体的别名在实体表单里就能编辑，但那是**一个实体
 * 一个实体地看** —— 「黎明觉醒号 / 黎明苏醒号」这种同一物两种写法（AI 在
 * 不同章各建了一个），只有把全库名字摊在一张表里才看得出来。
 *
 * 合并的规矩（后端 merge_entity_files 同款，这里只是入口）：
 * - 关系真源是 [[双链]]，合并只改实体档案 + 重建关系解析，正文一个字不动
 * - 被并实体（source）的名字和别名都变成主实体（target）的别名，
 *   所以「按旧名字搜还能搜到」——不需要物理墓碑文件
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '../api/client'
import type { AliasConflicts } from '../api/client'
import { useApp } from '../state/store'
import { Panel } from './Panel'
import type { SearchHit } from '../api/types'

export function AliasPanel() {
  const { bookId, notify, refresh, openEntity, dataVersion } = useApp()
  const [rows, setRows] = useState<api.AliasRow[]>([])
  const [conflicts, setConflicts] = useState<AliasConflicts>({})
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!bookId) return
    setLoading(true)
    try {
      const r = await api.listAliases(bookId)
      setRows(r.aliases)
      setConflicts(r.conflicts)
    } catch (e) {
      notify('err', `别名表读取失败：${(e as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [bookId, notify, dataVersion])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return rows
    return rows.filter(
      (r) => r.alias.toLowerCase().includes(s) || r.entity_name.toLowerCase().includes(s),
    )
  }, [rows, q])

  /** 1000+ 实体的书全渲染会拖慢面板 —— 不搜时只画前一段，搜了再看全 */
  const shown = useMemo(() => (q.trim() ? filtered : filtered.slice(0, 300)), [filtered, q])

  const conflictPairs = useMemo(() => Object.entries(conflicts), [conflicts])

  // ---- 任意两个实体的合并（同物异名走这里：名字零重叠不会进冲突区）----
  const [mergeTarget, setMergeTarget] = useState<{ id: string; name: string } | null>(null)
  const [candQ, setCandQ] = useState('')
  const [cands, setCands] = useState<SearchHit[]>([])

  useEffect(() => {
    if (!mergeTarget || !bookId) return
    const q = candQ.trim()
    if (!q) {
      setCands([])
      return
    }
    const t = window.setTimeout(() => {
      api
        .search(bookId, q, 12)
        .then((r) => setCands(r.items.filter((x) => x.id !== mergeTarget.id)))
        .catch(() => setCands([]))
    }, 200)
    return () => window.clearTimeout(t)
  }, [candQ, mergeTarget, bookId])

  const doMerge = async (targetId: string, sourceId: string, sourceName: string) => {
    if (!bookId) return
    setBusy(true)
    try {
      const r = await api.mergeEntity(bookId, targetId, sourceId)
      const skipped = r.skipped_ambiguous.length
        ? `；${r.skipped_ambiguous.length} 个有歧义的名字没动（它们同时挂在别的实体上）`
        : ''
      notify(
        'ok',
        `已把「${sourceName}」并入：吸收 ${r.absorbed_names.length} 个名字、改写 ${r.moved_links} 处双链${skipped}`,
      )
      await load()
      await refresh()
    } catch (e) {
      notify('err', `合并失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      title="别名管理"
      collapsible
      sectionId="admin:alias"
      actions={
        <button className="btn btn--sm" onClick={() => void load()} disabled={loading || !bookId}>
          刷新
        </button>
      }
    >
      {!bookId ? (
        <div className="notice">
          <div>先在顶栏选一本书 —— 别名按书目归各自的书管。</div>
        </div>
      ) : (
        <>
          <div className="notice" style={{ marginBottom: 'var(--p-space-3)' }}>
            <div>
              同一个名字挂在<b>多个实体</b>上会标红在下面 —— 那往往是同一个东西的两种写法
              （AI 分章抽取时容易各建一个）。点「合并」把它们并成一个：被并的那方的名字
              会变成别名，双链自动改写，<b>正文一个字不动</b>。
            </div>
          </div>

          {conflictPairs.length > 0 && (
            <div className="alias-conflicts">
              {conflictPairs.map(([alias, entries]) => (
                <ConflictRow
                  key={alias}
                  alias={alias}
                  entries={entries}
                  busy={busy}
                  onMerge={doMerge}
                  onOpen={openEntity}
                />
              ))}
            </div>
          )}

          {mergeTarget && (
            <div className="alias-mergebar">
              <span>
                把谁并入 <b>{mergeTarget.name}</b>？
              </span>
              <input
                className="input input--sm"
                style={{ maxWidth: 220 }}
                placeholder="搜实体名或别名…"
                value={candQ}
                autoFocus
                onChange={(e) => setCandQ(e.target.value)}
              />
              {cands.length > 0 && (
                <select
                  className="input input--sm"
                  defaultValue=""
                  onChange={(e) => {
                    const c = cands.find((x) => x.id === e.target.value)
                    if (c && window.confirm(`确定把「${c.name}」并入「${mergeTarget.name}」吗？\n被并方删除，名字变成别名；此操作不改正文，但不易撤销。`)) {
                      void doMerge(mergeTarget.id, c.id, c.name)
                    }
                    setMergeTarget(null)
                    setCandQ('')
                    setCands([])
                  }}
                >
                  <option value="" disabled>
                    {cands.length} 个候选，选一个…
                  </option>
                  {cands.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}（{c.type}）
                    </option>
                  ))}
                </select>
              )}
              <button
                className="btn btn--sm"
                onClick={() => {
                  setMergeTarget(null)
                  setCandQ('')
                  setCands([])
                }}
              >
                取消
              </button>
            </div>
          )}

          <div className="alias-toolbar" style={{ margin: 'var(--p-space-3) 0 var(--p-space-2)' }}>
            <input
              className="input"
              style={{ maxWidth: 280 }}
              placeholder="筛别名或实体名…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <span className="faint fs-xs">
              共 {rows.length} 条{conflictPairs.length > 0 ? ` · ${conflictPairs.length} 处冲突` : ' · 无冲突'}
              {!q.trim() && filtered.length > shown.length ? `（显示前 ${shown.length} 条，搜索看全部）` : ''}
            </span>
          </div>

          <div className="alias-table">
            {shown.map((r) => (
              <div key={`${r.via}-${r.alias}-${r.entity_id}`} className="alias-table__line">
                <button
                  className="alias-table__row"
                  onClick={() => openEntity(r.entity_id)}
                  title={`打开「${r.entity_name}」`}
                >
                  <span className="alias-table__alias mono">{r.alias}</span>
                  <span className="alias-table__arrow">→</span>
                  <span className="alias-table__name">{r.entity_name}</span>
                  {r.via === 'name' && <span className="chip chip--faint">主名</span>}
                  <span className="alias-table__type faint fs-xs">{r.type}</span>
                </button>
                <button
                  className="btn btn--sm alias-table__merge"
                  title={`把别的实体并入「${r.entity_name}」`}
                  onClick={() => {
                    setMergeTarget({ id: r.entity_id, name: r.entity_name })
                    setCandQ('')
                  }}
                >
                  并入…
                </button>
              </div>
            ))}
            {shown.length === 0 && !loading && (
              <div className="faint fs-sm" style={{ padding: 'var(--p-space-3)' }}>
                没有匹配的别名。
              </div>
            )}
          </div>
        </>
      )}
    </Panel>
  )
}

function ConflictRow(props: {
  alias: string
  entries: { entity_id: string; name: string; type: string; via: 'name' | 'alias' }[]
  busy: boolean
  onMerge: (targetId: string, sourceId: string, sourceName: string) => Promise<void>
  onOpen: (id: string) => void
}) {
  const { alias, entries, busy } = props
  // 冲突至少两个实体；把选择权给用户：选谁当「正主」，其余全部并入它
  const [targetId, setTargetId] = useState(entries[0].entity_id)
  const unique = entries.filter((e, i, arr) => arr.findIndex((x) => x.entity_id === e.entity_id) === i)
  const target = unique.find((e) => e.entity_id === targetId) ?? unique[0]
  const others = unique.filter((e) => e.entity_id !== target.entity_id)

  return (
    <div className="alias-conflict">
      <div className="alias-conflict__head">
        <span className="alias-conflict__alias mono">{alias}</span>
        <span className="alias-conflict__hint">被 {unique.length} 个实体占用</span>
      </div>
      <div className="alias-conflict__body">
        <ul>
          {unique.map((e) => (
            <li key={e.entity_id}>
              <button className="linklike" onClick={() => props.onOpen(e.entity_id)}>
                {e.name}
              </button>
              <span className="faint fs-xs">（{e.type}，按{e.via === 'name' ? '主名' : '别名'}占用）</span>
            </li>
          ))}
        </ul>
        <div className="alias-conflict__merge">
          <select className="input input--sm" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            {unique.map((e) => (
              <option key={e.entity_id} value={e.entity_id}>
                并入「{e.name}」
              </option>
            ))}
          </select>
          <button
            className="btn btn--sm"
            disabled={busy || others.length === 0}
            onClick={() => {
              const src = others[0]
              if (src && window.confirm(`确定把「${src.name}」并入「${target.name}」吗？\n被并方删除，名字变成别名；此操作不改正文，但不易撤销。`)) {
                void props.onMerge(target.entity_id, src.entity_id, src.name)
              }
            }}
          >
            {busy && <span className="spinner" />}
            合并
          </button>
        </div>
      </div>
    </div>
  )
}

export default AliasPanel
