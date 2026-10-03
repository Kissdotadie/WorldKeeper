/** 伏笔看板（P4）。
 *
 * 真源是 `world/foreshadow.md` 的 Markdown 表格（整册档案通道）。
 * 这个界面只做三件事：分列看板、状态流转、增删改 ——
 * 改完全部 PUT 回同一个文件，不引入第二种数据。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '../api/client'
import { useApp } from '../state/store'
import { Panel } from '../components/Panel'
import { StateGate } from '../components/Toast'

/** 看板列：伏笔 | 埋设章节 | 预计回收 | 状态 | 备注（与后端模板一致） */
interface FsRow {
  content: string
  chapter: string
  expect: string
  status: string
  note: string
}

const COLUMNS = ['伏笔', '埋设章节', '预计回收', '状态', '备注']

function renderDoc(title: string, rows: FsRow[]): string {
  const head = `| ${COLUMNS.join(' | ')} |\n`
  const sep = `|${COLUMNS.map(() => '---').join('|')}|\n`
  const esc = (s: string) => s.replace(/\|/g, '／')
  const body = rows
    .map((r) => `| ${[r.content, r.chapter, r.expect, r.status, r.note].map(esc).join(' | ')} |\n`)
    .join('')
  return `# ${title}\n\n${head}${sep}${body}`
}

export function ForeshadowView() {
  const { bookId, notify, query, dataVersion } = useApp()
  const [rows, setRows] = useState<FsRow[]>([])
  const [title, setTitle] = useState('伏笔看板')
  const [exists, setExists] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showDone, setShowDone] = useState(true)
  const [draft, setDraft] = useState({ content: '', chapter: '', expect: '', note: '' })
  // 行就地编辑（P11-B5）：以前只能加/删/流转状态，埋错的雷改不了字
  const [editIdx, setEditIdx] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState<FsRow | null>(null)

  const startEdit = (i: number) => {
    setEditIdx(i)
    setEditDraft(rows[i])
  }
  const saveEdit = () => {
    if (editIdx === null || !editDraft) return
    const content = editDraft.content.trim()
    if (!content) {
      notify('err', '伏笔内容不能为空')
      return
    }
    void save(rows.map((r, j) => (j === editIdx ? { ...editDraft, content } : r)), '已更新')
    setEditIdx(null)
    setEditDraft(null)
  }

  const load = useCallback(() => {
    if (!bookId) return
    setLoading(true)
    setError(null)
    api
      .getDoc(bookId, 'foreshadow')
      .then((d) => {
        setExists(d.exists)
        setTitle(d.title || '伏笔看板')
        setRows(
          d.rows.map((r) => ({
            content: r[0] ?? '',
            chapter: r[1] ?? '',
            expect: r[2] ?? '',
            status: r[3] ?? '未回收',
            note: r[4] ?? '',
          })),
        )
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }, [bookId, dataVersion])

  useEffect(load, [load])

  const save = useCallback(
    async (next: FsRow[], okMsg: string) => {
      if (!bookId) return
      setBusy(true)
      try {
        await api.saveDoc(bookId, 'foreshadow', renderDoc(title, next))
        setRows(next)
        setExists(true)
        notify('ok', okMsg)
      } catch (e) {
        notify('err', `保存失败：${(e as Error).message}`)
      } finally {
        setBusy(false)
      }
    },
    [bookId, title, notify],
  )

  const setStatus = (i: number, status: string) => {
    const next = rows.map((r, j) => (j === i ? { ...r, status } : r))
    void save(next, status === '已回收' ? `「${rows[i].content.slice(0, 12)}」已回收` : '已重新打开')
  }

  const removeRow = (i: number) => {
    if (!window.confirm(`删掉伏笔「${rows[i].content.slice(0, 16)}」？`)) return
    void save(rows.filter((_, j) => j !== i), '已删除')
  }

  const addRow = () => {
    const content = draft.content.trim()
    if (!content) return
    void save(
      [...rows, { content, chapter: draft.chapter.trim() || '—', expect: draft.expect.trim(), status: '未回收', note: draft.note.trim() }],
      '已埋下一颗雷，记得收',
    )
    setDraft({ content: '', chapter: '', expect: '', note: '' })
  }

  const hl = query.trim().toLowerCase()
  const { open, done } = useMemo(() => {
    const hit = (r: FsRow) => !hl || `${r.content}${r.note}${r.chapter}`.toLowerCase().includes(hl)
    return {
      open: rows.filter((r) => r.status !== '已回收' && hit(r)),
      done: rows.filter((r) => r.status === '已回收' && hit(r)),
    }
  }, [rows, hl])

  return (
    <div className="fsview">
      <Panel
        title={title}
        actions={
          <>
            <span className="chip">未回收 {open.length}</span>
            <span className="chip faint">已回收 {done.length}</span>
            <label className="row fs-xs muted" style={{ gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
              显示已回收
            </label>
          </>
        }
      >
        <StateGate
          loading={loading}
          error={error}
          empty={!exists && rows.length === 0}
          emptyTitle="伏笔看板还没建"
          emptyHint="埋下第一颗雷它就出现了 —— 或者去「章节原文」跑 AI 抽取，让 AI 帮你找伏笔。"
        >
          {/* ---- 新增 ---- */}
          <div className="row row--wrap" style={{ marginBottom: 'var(--p-space-3)' }}>
            <input
              className="input input--sm"
              style={{ minWidth: 220, flex: 2 }}
              placeholder="伏笔内容（埋了什么雷）"
              value={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && addRow()}
            />
            <input
              className="input input--sm"
              style={{ width: 90 }}
              placeholder="埋设章节"
              value={draft.chapter}
              onChange={(e) => setDraft({ ...draft, chapter: e.target.value })}
            />
            <input
              className="input input--sm"
              style={{ width: 110 }}
              placeholder="预计回收"
              value={draft.expect}
              onChange={(e) => setDraft({ ...draft, expect: e.target.value })}
            />
            <input
              className="input input--sm"
              style={{ minWidth: 140, flex: 1 }}
              placeholder="备注"
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
            <button className="btn btn--primary btn--sm" disabled={busy || !draft.content.trim()} onClick={addRow}>
              埋下
            </button>
          </div>

          <div className="fs-board">
            {open.map((r) => {
              const i = rows.indexOf(r)
              if (editIdx === i && editDraft) {
                return (
                  <div key={`${r.content}-${i}`} className="fs-row fs-row--edit">
                    <input
                      className="input input--sm"
                      style={{ minWidth: 200, flex: 2 }}
                      value={editDraft.content}
                      onChange={(e) => setEditDraft({ ...editDraft, content: e.target.value })}
                      onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
                      aria-label="伏笔内容"
                    />
                    <input
                      className="input input--sm"
                      style={{ width: 90 }}
                      placeholder="埋设章节"
                      value={editDraft.chapter}
                      onChange={(e) => setEditDraft({ ...editDraft, chapter: e.target.value })}
                      aria-label="埋设章节"
                    />
                    <input
                      className="input input--sm"
                      style={{ width: 110 }}
                      placeholder="预计回收"
                      value={editDraft.expect}
                      onChange={(e) => setEditDraft({ ...editDraft, expect: e.target.value })}
                      aria-label="预计回收"
                    />
                    <input
                      className="input input--sm"
                      style={{ minWidth: 140, flex: 1 }}
                      placeholder="备注"
                      value={editDraft.note}
                      onChange={(e) => setEditDraft({ ...editDraft, note: e.target.value })}
                      aria-label="备注"
                    />
                    <button className="btn btn--primary btn--sm" disabled={busy} onClick={saveEdit}>
                      存
                    </button>
                    <button
                      className="btn btn--ghost btn--sm"
                      disabled={busy}
                      onClick={() => {
                        setEditIdx(null)
                        setEditDraft(null)
                      }}
                    >
                      取消
                    </button>
                  </div>
                )
              }
              return (
                <div key={`${r.content}-${i}`} className="fs-row">
                  <span className="fs-row__content">{r.content}</span>
                  <span className="chip chip--accent">{r.chapter || '—'}</span>
                  {r.expect && <span className="chip">预计 {r.expect}</span>}
                  {r.note && <span className="faint fs-xs">{r.note}</span>}
                  <div className="grow" />
                  <button
                    className="btn btn--sm"
                    disabled={busy || editIdx !== null}
                    onClick={() => startEdit(i)}
                    title="改这条伏笔的字"
                  >
                    ✎ 改
                  </button>
                  <button
                    className="btn btn--sm"
                    disabled={busy}
                    onClick={() => setStatus(i, '已回收')}
                    title="这条线收掉了"
                  >
                    ✓ 回收
                  </button>
                  <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => removeRow(i)}>
                    删
                  </button>
                </div>
              )
            })}
            {open.length === 0 && (
              <p className="empty fs-sm">没有悬着的伏笔 —— 要么没埋，要么都收干净了。</p>
            )}

            {showDone && done.length > 0 && (
              <>
                <div className="detail__section-title" style={{ marginTop: 'var(--p-space-2)' }}>
                  已回收（{done.length}）
                </div>
                {done.map((r) => {
                  const i = rows.indexOf(r)
                  return (
                    <div key={`${r.content}-${i}`} className="fs-row fs-row--done">
                      <span className="fs-row__content" style={{ textDecoration: 'line-through' }}>
                        {r.content}
                      </span>
                      <span className="chip faint">{r.chapter || '—'}</span>
                      {r.note && <span className="faint fs-xs">{r.note}</span>}
                      <div className="grow" />
                      <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setStatus(i, '未回收')}>
                        重新打开
                      </button>
                    </div>
                  )
                })}
              </>
            )}
          </div>

          <p className="faint fs-xs" style={{ marginTop: 'var(--p-space-3)' }}>
            真源是 world/foreshadow.md 的 Markdown 表格 —— 这里改的就是那个文件，手改文件这里也会跟着变。
            AI 抽取出的伏笔候选在「章节原文 → 待确认清单」里落盘。
          </p>
        </StateGate>
      </Panel>
    </div>
  )
}

export default ForeshadowView
