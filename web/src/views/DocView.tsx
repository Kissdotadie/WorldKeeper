/**
 * 「整册档案」界面 —— 历史观、剧情线、伏笔看板都是它的实例化。
 *
 * 这类内容不适合拆成一实体一文件：纪年表就是一张表，剧情线就是一条线。
 * 所以这里读写的是一份 **Markdown 文件**（`world/<name>.md`），
 * 工具只做两件事：把它的第一张表格渲染成视图、把你的修改原样写回去。
 * 没表格就按纯文本显示，不强迫你改成表格。
 *
 * 位置说明：`world/` 是**可写的档案区**，和只读的 `chapters/` 正文区是两回事。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '../api/client'
import type { DocData } from '../api/types'
import { useApp } from '../state/store'
import { useGraphEdit } from '../state/useGraphEdit'
import { useOutlineEdit } from '../graph/useOutlineEdit'
import { useStyleResolver } from '../graph/useStyleResolver'
import { Graph2D } from '../graph/Graph2D'
import type { GNode } from '../graph/types'
import { extractLinks } from '../lib/format'
import { Panel } from '../components/Panel'
import { StateGate } from '../components/Toast'
import { LinkText } from '../components/LinkText'
import { ChronologyAxis } from '../components/ChronologyAxis'

interface Props {
  /** 档案名，对应 world/<name>.md */
  name: string
  /** 界面标题（档案还没建时也用它） */
  title: string
  /** 按第几列分组（0 起）。不填就只有表格视图。 */
  groupColumn?: number
  /** 右栏或底部的说明 */
  note?: string
  /** 表格为空时的引导 */
  emptyHint?: string
  /**
   * 多给一种「纪年轴」视图并**默认选中**（历史观用，用户 2026-10-04 拍板）：
   * 把第一列的时间解析成可排序的键，按年分组排成竖轴。
   * 表格视图仍然保留 —— 编辑源码走的还是那一份 Markdown。
   */
  axis?: boolean
}

type Mode = 'table' | 'group' | 'axis' | 'outline'

export function DocView({ name, title, groupColumn, note, emptyHint, axis = false }: Props) {
  const { bookId, notify, dataVersion, entities, types, openEntity } = useApp()

  const [doc, setDoc] = useState<DocData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [mode, setMode] = useState<Mode>(axis ? 'axis' : 'table')

  // ---- 自由结构（WPS 式思维导图编辑）----
  // 历史观 / 剧情线原本只有表格：一行一行填。现在多一档「结构」，
  // 素材是**表格里 [[双链]] 提到的实体**——把「哪一年属于哪个时代、
  // 哪个时代包含哪几件事」亲手排出来，比竖着读表格容易看出全貌。
  // 表格仍然是真源（world/<name>.md），结构是叠加的一层看法，存在 scene.json。
  const [outlineSel, setOutlineSel] = useState<string | null>(null)
  const oe = useOutlineEdit({ sceneKey: `doc-${name}`, title, onSelect: setOutlineSel })
  const sr = useStyleResolver()

  const outlineNodes = useMemo(() => {
    const seen = new Set<string>()
    const out: GNode[] = []
    const byName = new Map(entities.map((e) => [e.name, e]))
    for (const row of doc?.rows ?? []) {
      for (const cell of row) {
        for (const nm of extractLinks(cell)) {
          const e = byName.get(nm)
          if (!e || seen.has(e.id)) continue
          seen.add(e.id)
          out.push({ id: e.id, name: e.name, type: e.type, degree: 2 })
        }
      }
    }
    return out
  }, [doc, entities])

  const outlineGraph = useMemo(() => {
    if (!oe.on || !oe.outline) return null
    const sk = oe.skeleton()
    const have = new Set(sk.nodes.map((n) => n.id))
    for (const n of outlineNodes) {
      if (have.has(n.id)) continue
      have.add(n.id)
      sk.nodes.push(n)
    }
    return sk
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oe.on, oe.outline, outlineNodes])

  const load = useCallback(async () => {
    if (!bookId) return
    setLoading(true)
    setError(null)
    try {
      const d = await api.getDoc(bookId, name)
      setDoc(d)
      setDraft(d.text)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [bookId, name, dataVersion])

  useEffect(() => {
    void load()
  }, [load])

  /** 结构档里双击实体 = 就地改档案；落盘后重拉这份 Markdown（表格里的双链名可能变了） */
  const gEdit = useGraphEdit({
    bookId,
    types,
    onChanged: () => void load(),
    onOpenDetail: openEntity,
  })

  const save = async (text: string) => {
    if (!bookId) return
    setSaving(true)
    try {
      await api.saveDoc(bookId, name, text)
      await load()
      setEditing(false)
      notify('ok', `${title}已保存`)
    } catch (e) {
      notify('err', `保存失败：${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  /** 表格一旦有内容，分组视图才成立 */
  const canGroup = groupColumn !== undefined && (doc?.columns.length ?? 0) > groupColumn
  /** 纪年轴：传了 axis 且表格有列才成立 */
  const canAxis = axis && (doc?.columns.length ?? 0) > 0

  const groups = useMemo(() => {
    if (!doc || !canGroup || groupColumn === undefined) return []
    const map = new Map<string, string[][]>()
    for (const row of doc.rows) {
      const key = (row[groupColumn] || '').trim() || '（未标）'
      const bucket = map.get(key)
      if (bucket) bucket.push(row)
      else map.set(key, [row])
    }
    return [...map.entries()].map(([k, rows]) => ({ name: k, rows }))
  }, [doc, canGroup, groupColumn])

  const renderRow = (row: string[], key: string | number, cols: string[]) => (
    <tr key={key}>
      {cols.map((_, i) => (
        <td key={i} className={i === 0 ? 'etable__name' : 'fs-sm'}>
          {row[i] ? <LinkText text={row[i]} /> : <span className="faint">—</span>}
        </td>
      ))}
    </tr>
  )

  return (
    <div className="doc">
      <Panel
        title={`${doc?.title ?? title}`}
        actions={
          <>
            {doc?.exists && !editing && (
              <button
                className={`btn btn--sm ${mode === 'outline' ? 'btn--on' : ''}`}
                onClick={() => {
                  if (mode === 'outline') {
                    setMode(axis ? 'axis' : 'table')
                    return
                  }
                  if (!oe.on) oe.toggle()
                  setMode('outline')
                }}
                title="结构：把表格里 [[双链]] 提到的实体排成层级。存 view/scene.json，这份 Markdown 一个字不动"
              >
                {mode === 'outline' ? '✓ 结构' : '结构'}
              </button>
            )}
            {doc?.exists && !editing && (canAxis || canGroup) && (
              <div className="seg">
                {canAxis && (
                  <button
                    className={`seg__item ${mode === 'axis' ? 'seg__item--on' : ''}`}
                    onClick={() => setMode('axis')}
                    title="按故事内时间排序的竖轴"
                  >
                    纪年轴
                  </button>
                )}
                <button className={`seg__item ${mode === 'table' ? 'seg__item--on' : ''}`} onClick={() => setMode('table')}>
                  表格
                </button>
                {canGroup && (
                  <button className={`seg__item ${mode === 'group' ? 'seg__item--on' : ''}`} onClick={() => setMode('group')}>
                    按「{doc.columns[groupColumn!]}」分组
                  </button>
                )}
              </div>
            )}
            {doc?.exists && !editing && (
              <button className="btn btn--sm" onClick={() => setEditing(true)}>
                编辑源码
              </button>
            )}
            {editing && (
              <>
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    setDraft(doc?.text ?? '')
                    setEditing(false)
                  }}
                  disabled={saving}
                >
                  取消
                </button>
                <button className="btn btn--primary btn--sm" onClick={() => save(draft)} disabled={saving}>
                  {saving ? '保存中…' : '保存'}
                </button>
              </>
            )}
          </>
        }
        flush={!editing}
      >
        <StateGate loading={loading} error={error} empty={false}>
          {!doc ? null : editing ? (
            <div className="doc__edit">
              <p className="faint fs-xs" style={{ marginBottom: 6 }}>
                这就是 <code>world/{name}.md</code> 的原文。表格用 <code>|</code> 分隔，
                第二行的 <code>|---|---|</code> 不能少。想引用实体就写 <code>[[裴渊]]</code>。
              </p>
              <textarea
                className="textarea doc__editor"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
              />
            </div>
          ) : !doc.exists ? (
            <div className="empty">
              <div className="empty__title">还没有「{doc.title}」这份档案</div>
              <div className="fs-sm" style={{ maxWidth: 520, textAlign: 'center' }}>
                {doc.hint}
              </div>
              <div className="doc__preview">
                <pre>{doc.template}</pre>
              </div>
              <div className="row">
                <button className="btn btn--primary" onClick={() => save(doc.template)} disabled={saving}>
                  {saving ? '建立中…' : '按这个骨架建立'}
                </button>
                <button className="btn btn--ghost" onClick={() => { setDraft(doc.template); setEditing(true) }}>
                  先改骨架再建
                </button>
              </div>
            </div>
          ) : doc.columns.length === 0 ? (
            <div className="doc__plain">
              <p className="faint fs-xs">
                这份档案里没有 Markdown 表格，所以按纯文本显示。想要表格视图，点「编辑源码」加一张表。
              </p>
              <pre>{doc.text}</pre>
              {emptyHint && <p className="faint fs-xs">{emptyHint}</p>}
            </div>
          ) : mode === 'outline' ? (
            outlineGraph ? (
              <div style={{ height: 'min(68vh, 700px)' }}>
                <Graph2D
                  {...gEdit.graphProps}
                  {...sr.g2d}
                  outlineAvailable
                  onEnableOutline={oe.toggle}
                  nodes={outlineGraph.nodes}
                  edges={outlineGraph.edges}
                  layout="tree"
                  rootId={oe.outline?.root ?? null}
                  selectedId={outlineSel}
                  hierarchy={oe.hierarchy}
                  outline={oe.editApi}
                  noteOf={oe.noteOf}
                  onSelect={(id) => setOutlineSel(id)}
                />
              </div>
            ) : (
              <div className="empty">
                <div className="empty__title">结构还没打开</div>
                <button className="btn btn--primary btn--sm" onClick={oe.toggle}>
                  打开自由结构
                </button>
              </div>
            )
          ) : mode === 'axis' && canAxis ? (
            <ChronologyAxis doc={doc} />
          ) : (
            <>
              <div className="row row--wrap doc__meta">
                <span className="chip">{doc.rows.length} 行</span>
                <span className="chip">{doc.columns.length} 列</span>
                <div className="grow" />
                <span className="faint fs-xs" title={doc.path}>
                  真源：world/{name}.md
                </span>
              </div>

              {mode === 'group' && canGroup ? (
                groups.map((g) => (
                  <section key={g.name} style={{ marginBottom: 'var(--p-space-5)' }}>
                    <div className="row" style={{ marginBottom: 'var(--p-space-2)' }}>
                      <h3 className="fs-sm">{g.name}</h3>
                      <span className="faint fs-xs">{g.rows.length}</span>
                    </div>
                    <div className="table-wrap">
                      <table className="etable">
                        <thead>
                          <tr>
                            {doc.columns.map((c) => (
                              <th key={c}>{c}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>{g.rows.map((r, i) => renderRow(r, `${g.name}-${i}`, doc.columns))}</tbody>
                      </table>
                    </div>
                  </section>
                ))
              ) : (
                <div className="table-wrap">
                  <table className="etable">
                    <thead>
                      <tr>
                        {doc.columns.map((c) => (
                          <th key={c}>{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {doc.rows.length === 0 ? (
                        <tr>
                          <td colSpan={doc.columns.length} className="faint fs-sm">
                            表格还是空的。点「编辑源码」把行填进去。
                          </td>
                        </tr>
                      ) : (
                        doc.rows.map((r, i) => renderRow(r, i, doc.columns))
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {note && <p className="faint fs-xs doc__note">{note}</p>}
            </>
          )}
        </StateGate>
      </Panel>
    </div>
  )
}

export default DocView
