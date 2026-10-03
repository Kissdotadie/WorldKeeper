/**
 * 时间线（独立界面）。
 *
 * 当前是**叙事序**（第 N 章）—— 数据来自每个实体的「首次出场」与「出场记录」。
 * 故事内时间（明显帝143年秋）那条轨要等 world/ 里的纪年表落地，两轨对齐后再补。
 */

import { useEffect, useMemo, useState } from 'react'
import * as api from '../api/client'
import type { TimelineData } from '../api/types'
import { useApp } from '../state/store'
import { useGraphEdit } from '../state/useGraphEdit'
import { Panel } from '../components/Panel'
import { StateGate } from '../components/Toast'
import { Timeline3D } from '../graph/Timeline3D'
import { useSceneStyles } from '../graph/useSceneStyles'

type Mode = 'axis' | 'river3d' | 'table'

export function TimelineView() {
  const { bookId, types, openEntity, query, prefs, requestView } = useApp()
  const [data, setData] = useState<TimelineData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('axis')
  const [collapseEmpty, setCollapseEmpty] = useState(false)
  const [themeTick, setThemeTick] = useState(0)
  /** 编辑落盘后重拉时间线（P11-B5：双击长河节点即可改实体） */
  const [reloadTick, setReloadTick] = useState(0)

  // 图上就地编辑（P11-B5）：浮层、调接口、刷新数据都在这层，
  // 这里只管把 onNodeEdit 递给三维长河、把浮层渲染出来。
  // 长河的坐标是算死的（没有 scene.json），不需要接节点拖动的撤销。
  const gEdit = useGraphEdit({
    bookId,
    types,
    onChanged: () => setReloadTick((t) => t + 1),
    onOpenDetail: openEntity,
  })

  /** 辉光与三维关系网、世界观共用同一个开关（scene.json 的 styles.glow） */
  const styles = useSceneStyles(bookId)

  // 主题切换要重建 3D 场景（WebGL 不认 CSS 变量，颜色都得重取）
  useEffect(() => setThemeTick((t) => t + 1), [prefs?.ui.mode, prefs?.ui.theme])

  useEffect(() => {
    if (!bookId) return
    let alive = true
    setLoading(true)
    setError(null)
    api
      .getTimeline(bookId, typeFilter ?? undefined)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [bookId, typeFilter, reloadTick])

  const labelOf = (key: string) => types.find((t) => t.key === key)?.label ?? key
  const hl = query.trim().toLowerCase()

  const chapters = useMemo(() => {
    const list = data?.chapters ?? []
    if (!hl) return list
    // 搜索时只留命中的条目，命中为空就不占用时间轴
    return list
      .map((c) => ({ ...c, entries: c.entries.filter((e) => e.name.toLowerCase().includes(hl)) }))
      .filter((c) => c.entries.length > 0 || !collapseEmpty)
  }, [data, hl, collapseEmpty])

  const flat = useMemo(
    () =>
      chapters.flatMap((c) =>
        c.entries.map((e) => ({ ...e, chapter: c.chapter, order: c.order })),
      ),
    [chapters],
  )

  // ---- 线索断点（P4 验收：时间线能看出线索断点） ----
  // 实体最后一次出场之后，再有 ≥2 章没出现 = 断点（线头悬着没收）
  const GAP_THRESHOLD = 2
  const gaps = useMemo(() => {
    const ordered = chapters.filter((c) => c.order !== null)
    const out = new Map<string, { last: number; gap: number }>()
    if (!ordered.length) return out
    const latest = Math.max(...ordered.map((c) => c.order as number))
    const lastSeen = new Map<string, number>()
    for (const c of ordered) {
      for (const e of c.entries) {
        lastSeen.set(e.entity_id, Math.max(lastSeen.get(e.entity_id) ?? -1, c.order as number))
      }
    }
    for (const [id, last] of lastSeen) {
      const gap = latest - last
      if (gap >= GAP_THRESHOLD) out.set(id, { last, gap })
    }
    return out
  }, [chapters])

  return (
    <div className="timeline">
      <Panel
        title="时间线"
        actions={
          <>
            <select
              className="select"
              style={{ width: 'auto', minHeight: 'var(--control-h-sm)' }}
              value={typeFilter ?? ''}
              onChange={(e) => setTypeFilter(e.target.value || null)}
              aria-label="只看某类实体"
            >
              <option value="">全部类型</option>
              {types.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
            <label className="row fs-xs muted" style={{ gap: 4, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={collapseEmpty}
                onChange={(e) => setCollapseEmpty(e.target.checked)}
              />
              隐藏空章
            </label>
            {/* 长河没有「疏密」「图标」可调 —— 它的坐标是算死的，不是力布局。
                所以这里只给辉光这一个开关，不硬塞一整套面板。 */}
            {mode === 'river3d' && (
              <label className="row fs-xs muted" style={{ gap: 4, cursor: 'pointer' }} title="节点周围那圈柔光；机器吃力就关掉">
                <input
                  type="checkbox"
                  checked={styles.glow}
                  onChange={(e) => styles.setGlow(e.target.checked)}
                />
                辉光
              </label>
            )}
            {/* 就地编辑开关（P11-B5）：与关系网/世界观同一套两态开关 */}
            {mode === 'river3d' && (
              <label className="row fs-xs muted" style={{ gap: 4, cursor: 'pointer' }} title="关掉后双击节点只看不动">
                <input
                  type="checkbox"
                  checked={gEdit.editable}
                  onChange={(e) => gEdit.setEditable(e.target.checked)}
                />
                就地编辑
              </label>
            )}
            <div className="seg">
              <button
                className={`seg__item ${mode === 'axis' ? 'seg__item--on' : ''}`}
                onClick={() => setMode('axis')}
              >
                时间轴
              </button>
              <button
                className={`seg__item ${mode === 'river3d' ? 'seg__item--on' : ''}`}
                onClick={() => setMode('river3d')}
                title="线索长河：X=章节、同类聚成一条带，同一实体的出场连成线，线断了就是断点"
              >
                三维长河
              </button>
              <button
                className={`seg__item ${mode === 'table' ? 'seg__item--on' : ''}`}
                onClick={() => setMode('table')}
              >
                清单
              </button>
            </div>
          </>
        }
      >
        <StateGate
          loading={loading}
          error={error}
          empty={chapters.length === 0}
          emptyTitle="时间线还是空的"
          emptyHint="给实体填上「首次出场」（例如 第1章），或在编辑实体时往「出场记录」里加行，这里就会自动排出来。"
          emptyAction={
            <>
              <button className="btn btn--primary btn--sm" onClick={() => requestView('entities')}>
                去「全部实体」填出场信息 →
              </button>
              <button className="btn btn--sm" onClick={() => requestView('text', 'text:import')}>
                先导入章节 →
              </button>
            </>
          }
        >
          {data && (
            <>
              <div className="row row--wrap" style={{ marginBottom: 'var(--p-space-3)' }}>
                <span className="chip">{data.chapter_count} 个章节</span>
                <span className="chip">{data.entry_count} 条记录</span>
                {gaps.size > 0 && (
                  <span className="chip tl-gap" title="这些实体最后一次出场之后，再有 2 章以上没出现 —— 线头悬着没收">
                    {gaps.size} 条线索断点
                  </span>
                )}
                <div className="grow" />
                <span className="faint fs-xs">
                  这是叙事序（第几章）。故事内时间（如「明显帝十一年秋」）排在数列后面，要等纪年表落地后双轨对齐。
                </span>
              </div>

              {mode === 'river3d' && data && (
                <div style={{ height: 'min(72vh, 720px)' }}>
                  <Timeline3D
                    data={data}
                    themeKey={String(themeTick)}
                    glow={styles.glow}
                    onSelectEntity={openEntity}
                    onNodeEdit={gEdit.graphProps.onNodeEdit}
                    editable={gEdit.editable}
                  />
                </div>
              )}

              {mode === 'axis' ? (
                <ol className="tl">
                  {chapters.map((c) => (
                    <li className="tl__chapter" key={c.chapter}>
                      <div className="tl__marker">
                        <span className="tl__dot" />
                        <span className="tl__chapter-name">{c.chapter}</span>
                        {c.order === null && <span className="chip" style={{ marginLeft: 6 }}>非叙事序</span>}
                        <span className="faint fs-xs" style={{ marginLeft: 6 }}>
                          {c.entries.length} 条
                        </span>
                      </div>
                      <div className="tl__entries">
                        {c.entries.map((e, i) => (
                          <button
                            key={`${e.entity_id}-${i}`}
                            className={`tl__entry ${e.kind === 'first' ? 'tl__entry--first' : ''}`}
                            data-entity-type={e.type}
                            onClick={() => openEntity(e.entity_id)}
                            title={e.note || '打开实体详情'}
                          >
                            <span className="dot" />
                            <span className="tl__entry-name">{e.name}</span>
                            <span className="chip chip--type">{labelOf(e.type)}</span>
                            {e.kind === 'first' && <span className="chip chip--accent">首现</span>}
                            {gaps.get(e.entity_id)?.last === c.order && (
                              <span
                                className="chip tl-gap"
                                title={`这章之后 ${gaps.get(e.entity_id)!.gap} 章没再出现 —— 线头悬着没收`}
                              >
                                断点 {gaps.get(e.entity_id)!.gap}章
                              </span>
                            )}
                            {e.note && <span className="tl__entry-note muted fs-sm">{e.note}</span>}
                          </button>
                        ))}
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="table-wrap">
                  <table className="etable">
                    <thead>
                      <tr>
                        <th style={{ width: '110px' }}>章节</th>
                        <th style={{ width: '90px' }}>类型</th>
                        <th style={{ width: '150px' }}>实体</th>
                        <th style={{ width: '70px' }}>标记</th>
                        <th>表现</th>
                      </tr>
                    </thead>
                    <tbody>
                      {flat.map((r, i) => (
                        <tr key={i} onClick={() => openEntity(r.entity_id)}>
                          <td className="mono fs-xs">{r.chapter}</td>
                          <td data-entity-type={r.type}>
                            <span className="chip chip--type">
                              <span className="chip__dot" />
                              {labelOf(r.type)}
                            </span>
                          </td>
                          <td className="etable__name">{r.name}</td>
                          <td>{r.kind === 'first' ? <span className="chip chip--accent">首现</span> : <span className="faint">—</span>}</td>
                          <td className="muted fs-sm">{r.note || <span className="faint">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </StateGate>
      </Panel>
      {/* 就地编辑浮层（P11-B5）：挂在视图根上，不受面板滚动裁剪 */}
      {gEdit.layer}
    </div>
  )
}

export default TimelineView
