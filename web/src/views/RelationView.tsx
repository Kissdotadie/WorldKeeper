/**
 * 关系网（独立界面）。
 *
 * 数据来自实体正文里的 [[双链]]，不是另立一份关系数据 ——
 * 「关系真源唯一」这条铁律在这里体现为：图上没有一份自己的关系表，
 * 就地连线也只是**替你去写一条 [[双链]]**，改完照样回到实体文件里。
 */

import { useEffect, useMemo, useState } from 'react'
import * as api from '../api/client'
import type { GraphData } from '../api/types'
import { useApp } from '../state/store'
import { useGraphEdit } from '../state/useGraphEdit'
import { Panel, PanelClose } from '../components/Panel'
import { StateGate } from '../components/Toast'
import { GraphStylePanel, spacingLabel } from '../components/GraphStylePanel'
import { StylePackPanel } from '../components/StylePackPanel'
import { StickerLayer, StickerPanel } from '../components/StickerLayer'
import { Graph2D } from '../graph/Graph2D'
import { Graph3D } from '../graph/Graph3D'
import { useSceneStyles } from '../graph/useSceneStyles'
import { useStyleResolver } from '../graph/useStyleResolver'
import { useOutlineEdit } from '../graph/useOutlineEdit'
import { LAYOUT_LABELS, typeColorVar, type GEdge, type GNode, type LayoutKind } from '../graph/types'

const LAYOUT_KEY = 'wkv.graphLayout'
const DIM_KEY = 'wkv.graphDim'

/** first_appear 是「第几章」的字符串；null = 设定先于正文，播放时始终显示 */
function appearChapter(n: GNode): number | null {
  if (n.first_appear == null || n.first_appear === '') return null
  const v = parseInt(String(n.first_appear), 10)
  return Number.isFinite(v) ? v : null
}

export function RelationView() {
  const { bookId, query, openEntity, notify, types, prefs, requestView } = useApp()

  const [data, setData] = useState<GraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [dim, setDim] = useState<'2d' | '3d'>(
    () => (localStorage.getItem(DIM_KEY) as '2d' | '3d') || '3d',
  )
  /**
   * 布局：**本界面手动选过的赢，没选过就跟样式包走**。
   *
   * 和节点外观同一条规矩（手动 > 批量）。不这么分的话会有两处说不清：
   * 要么「切了样式包布局纹丝不动」（因为旧代码里 layout 初值就写死成 'radial'
   * 存进了 localStorage，等于人人都是手动档），要么「在世界观里换了布局，
   * 关系网跟着变」——地理观那张按标签聚的导图最怕这个。
   */
  const [layoutPick, setLayoutPick] = useState<LayoutKind | null>(() => {
    try {
      return (localStorage.getItem(LAYOUT_KEY) as LayoutKind) || null
    } catch {
      return null
    }
  })
  const [rootId, setRootId] = useState<string | null>(null)
  const [showGhost, setShowGhost] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  /** 贴纸编辑态。开着才显示手柄、才能拖 —— 关着时贴纸是「看得见但点不着」 */
  const [stickerEdit, setStickerEdit] = useState(false)

  // 章节播放（P4 验收：关系图能按章节播放）
  const [maxChapter, setMaxChapter] = useState(0)
  const [playChapter, setPlayChapter] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)

  // 三维外观（装饰层，存 view/scene.json 的 styles 段，与实体文件无关）
  // 这份状态所有「图」共用，见 graph/useSceneStyles.ts
  const styles = useSceneStyles(bookId)

  // 样式包（装饰层，存 view/styles/ + view/nodes.json）。2D 全接，3D 只接颜色与大小。
  const sr = useStyleResolver()
  const layout: LayoutKind = layoutPick ?? sr.layout

  // ---- 自由结构（WPS 式思维导图编辑）----
  // 关系网是一张**网**：边来自 [[双链]]，没有天然的层级。结构模式在这里的
  // 意义是「在网上面加一层自己的归拢」—— 把关心的一簇拉进树里，其余照旧
  // 留在孤儿行（它们本来就靠双链连着，不会看不出关系）。
  // 所以这一页的 hierarchy **不做合成**：没挂进结构的就是没归位。
  const oe = useOutlineEdit({ sceneKey: 'relation', title: '关系网', onSelect: setSelected })

  const load = () => {
    if (!bookId) return
    setLoading(true)
    setError(null)
    api
      .getGraph(bookId)
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
    api
      .listChapters(bookId)
      .then((r) => setMaxChapter(Math.max(0, ...r.items.map((c) => c.chapter_no))))
      .catch(() => undefined)
  }

  useEffect(load, [bookId])

  // ---- 就地编辑（P4.3）----
  // 从 3D 里落下来的新节点，顺手把落点写进 scene.json；否则它会先被力模拟
  // 甩到别处，下次打开又换个地方，等于「我明明放在这儿」白说了。
  const seedPosition = async (id: string, world: { x: number; y: number; z: number }) => {
    if (!bookId) return
    try {
      const cur = await api.getScene(bookId)
      const scene = cur.scene ?? {}
      const graphs = { ...(scene.graphs ?? {}) }
      const one = graphs.relation ?? {}
      graphs.relation = { ...one, positions: { ...(one.positions ?? {}), [id]: world } }
      await api.saveScene(bookId, { ...scene, graphs })
    } catch {
      /* 钉不上就让它自己找位置，不影响看图 */
    }
  }

  const gEdit = useGraphEdit({
    bookId,
    sceneKey: 'relation', // 撤销「挪动节点」时要指到这张图
    types,
    onChanged: (id, world) => {
      if (id && world) void seedPosition(id, world)
      load()
      if (id) setSelected(id)
    },
    onOpenDetail: (id) => openEntity(id),
  })

  const pickLayout = (k: LayoutKind) => {
    // 选中的正好是样式包给的那个 = 「我不反对，跟着包走」，于是把手动档撤掉，
    // 否则用户永远停在手动档上，之后再切样式包布局就再也不动了。
    const next = k === sr.layout ? null : k
    setLayoutPick(next)
    try {
      if (next) localStorage.setItem(LAYOUT_KEY, next)
      else localStorage.removeItem(LAYOUT_KEY)
    } catch {
      /* 忽略 */
    }
  }

  const pickDim = (d: '2d' | '3d') => {
    setDim(d)
    try { localStorage.setItem(DIM_KEY, d) } catch { /* 忽略 */ }
  }

  // 自动播放：每 1.4s 推进一章，播完自动停
  useEffect(() => {
    if (!playing || maxChapter === 0) return
    const t = window.setInterval(() => {
      setPlayChapter((cur) => {
        const next = (cur ?? 0) + 1
        if (next >= maxChapter) {
          setPlaying(false)
          return maxChapter
        }
        return next
      })
    }, 1400)
    return () => window.clearInterval(t)
  }, [playing, maxChapter])

  // ---- 过滤（类型 / 未录入 / 章节播放） ----
  const view = useMemo(() => {
    if (!data) return { nodes: [] as GNode[], edges: [] as GEdge[] }
    let ns = data.nodes
    if (!showGhost) ns = ns.filter((n) => !n.unresolved)
    if (typeFilter) {
      // 只看某类型时把它的直接邻居也留着，否则看不出「和谁有关系」
      const keep = new Set(ns.filter((n) => n.type === typeFilter).map((n) => n.id))
      for (const e of data.edges) {
        if (keep.has(e.source)) keep.add(e.target)
        if (keep.has(e.target)) keep.add(e.source)
      }
      ns = ns.filter((n) => keep.has(n.id))
    }
    if (playChapter !== null) {
      // 播到第 N 章：只有「已经登场」的节点才在图上
      ns = ns.filter((n) => {
        if (n.unresolved) return true
        const c = appearChapter(n)
        return c === null || c <= playChapter
      })
    }
    const ids = new Set(ns.map((n) => n.id))
    return { nodes: ns, edges: data.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) }
  }, [data, typeFilter, showGhost, playChapter])

  const labelOf = (key: string) =>
    types.find((t) => t.key === key)?.label ?? data?.type_labels?.[key] ?? '未录入'

  /**
   * 结构模式下额外要画的骨架（根 + 自由节点 + 包含边）。
   * 实体节点本来就在 `view` 里，这里只**补**结构自造的那几个，别重复加。
   */
  const viewPlus = useMemo(() => {
    if (!oe.on || !oe.outline) return view
    const sk = oe.skeleton()
    const have = new Set(view.nodes.map((n) => n.id))
    const nodes = [...view.nodes]
    for (const n of sk.nodes) {
      if (have.has(n.id)) continue
      have.add(n.id)
      nodes.push({ ...n, degree: 2 })
    }
    const seen = new Set(view.edges.map((e) => `${e.source}\u0000${e.target}`))
    const edges = [...view.edges]
    for (const e of sk.edges) {
      const k = `${e.source}\u0000${e.target}`
      if (seen.has(k)) continue
      seen.add(k)
      edges.push(e)
    }
    return { nodes, edges }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, oe.on, oe.outline])

  // ---- 选中节点的关系明细 ----
  const detail = useMemo(() => {
    if (!data || !selected) return null
    const node = data.nodes.find((n) => n.id === selected)
    if (!node) return null
    const nameOf = (id: string) => data.nodes.find((n) => n.id === id)
    const out = data.edges
      .filter((e) => e.source === selected)
      .map((e) => ({ kind: e.kind, node: nameOf(e.target), raw: e.target }))
    const inc = data.edges
      .filter((e) => e.target === selected)
      .map((e) => ({ kind: e.kind, node: nameOf(e.source), raw: e.source }))
    return { node, out, inc }
  }, [data, selected])

  const ghosts = data?.nodes.filter((n) => n.unresolved) ?? []

  return (
    <div className="relation">
      <Panel
        title="关系网"
        actions={
          <>
            <div className="seg" role="tablist" aria-label="维度">
              <button
                className={`seg__item ${dim === '2d' ? 'seg__item--on' : ''}`}
                onClick={() => pickDim('2d')}
                title="平面模式：四种布局，编辑顺手"
              >
                平面
              </button>
              <button
                className={`seg__item ${dim === '3d' ? 'seg__item--on' : ''}`}
                onClick={() => pickDim('3d')}
                title="三维模式：拖动旋转视角；坐标会锁定，不会每次刷新乱飞"
              >
                三维
              </button>
            </div>
            {dim === '2d' && (
              <button
                className={`btn btn--sm ${oe.on ? 'btn--on' : ''}`}
                onClick={oe.toggle}
                title="自由结构：在网上面加一层自己的归拢 —— 选中节点后 Tab 加子级、Enter 加同级、拖到节点上换父级。边仍然来自 [[双链]]，这里只理层级"
              >
                {oe.on ? '✓ 自由结构' : '自由结构'}
              </button>
            )}
            {dim === '2d' && (
              <div className="seg" role="tablist" aria-label="布局">
                {LAYOUT_LABELS.map((l) => (
                  <button
                    key={l.key}
                    className={`seg__item ${layout === l.key ? 'seg__item--on' : ''}`}
                    onClick={() => pickLayout(l.key)}
                    title={l.hint}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            )}
            {dim === '2d' && layoutPick !== null && (
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => pickLayout(sr.layout)}
                title={`改回跟样式包走（当前样式包给的是「${
                  LAYOUT_LABELS.find((l) => l.key === sr.layout)?.label ?? sr.layout
                }」）`}
              >
                ↻ 跟随样式
              </button>
            )}
            <button className="btn btn--sm" onClick={load} disabled={loading}>
              重新读取
            </button>
          </>
        }
        flush
      >
        {/* ---- 章节播放条：播到第 N 章，图就是第 N 章时的样子 ---- */}
        {maxChapter > 0 && (
          <div className="relation__play">
            <button
              className="btn btn--sm"
              onClick={() => {
                if (playChapter === null) {
                  setPlayChapter(0)
                  setPlaying(true)
                } else {
                  setPlaying(!playing)
                }
              }}
              title={playChapter === null ? '从第 0 章开始播放' : playing ? '暂停' : '继续'}
            >
              {playChapter !== null && playing ? '⏸' : '▶'}
            </button>
            <input
              type="range"
              min={0}
              max={maxChapter}
              value={playChapter ?? maxChapter}
              onChange={(e) => {
                setPlaying(false)
                setPlayChapter(Number(e.target.value))
              }}
              style={{ flex: 1 }}
            />
            <span className="fs-xs mono muted" style={{ minWidth: 86, textAlign: 'right' }}>
              {playChapter === null ? `全部 ${maxChapter} 章` : `第 ${playChapter} / ${maxChapter} 章`}
            </span>
            {playChapter !== null && (
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setPlaying(false)
                  setPlayChapter(null)
                }}
              >
                退出播放
              </button>
            )}
          </div>
        )}
        <StateGate
          loading={loading}
          error={error}
          empty={view.nodes.length === 0}
          emptyTitle={data && data.nodes.length > 0 ? '当前筛选下没有可显示的节点' : '还没有任何关系'}
          emptyHint={
            data && data.nodes.length > 0
              ? '把类型筛选调回「全部」，或勾上「显示未录入」。'
              : '关系来自实体正文「关联」一节里的 [[双链]]。在实体详情里点编辑，在关联里写「师父：[[韦忠]]」这样的内容，这里就有图了。'
          }
          emptyAction={
            data && data.nodes.length > 0 ? undefined : (
              <>
                <button className="btn btn--primary btn--sm" onClick={() => requestView('entities')}>
                  去「全部实体」写双链 →
                </button>
                <button className="btn btn--sm" onClick={() => requestView('text', 'text:import')}>
                  去「正文」导入章节 →
                </button>
              </>
            )
          }
        >
          {data && dim === '2d' && (
            <Graph2D
              {...gEdit.graphProps}
              {...sr.g2d}
              outlineAvailable
              onEnableOutline={oe.toggle}
              nodes={viewPlus.nodes}
              edges={viewPlus.edges}
              layout={layout}
              rootId={oe.on && oe.outline ? oe.outline.root : rootId}
              selectedId={selected}
              hierarchy={oe.hierarchy}
              outline={oe.editApi}
              noteOf={oe.noteOf}
              onSelect={(id) => setSelected(id)}
              onPickRoot={(id) => {
                setRootId(id)
                notify('info', `已把「${data.nodes.find((n) => n.id === id)?.name}」设为布局的根`)
              }}
              onUnresolvedClick={(name) => notify('info', `「${name}」这条关联指向的实体还没录入`)}
              onToggleLinkMode={() => gEdit.setLinkMode((v) => !v)}
              highlight={query}
              showLabels={showLabels}
            >
              <StickerLayer sceneKey="relation" editing={stickerEdit} />
            </Graph2D>
          )}
          {data && dim === '3d' && bookId && (
            <Graph3D
              {...gEdit.graphProps}
              bookId={bookId}
              sceneKey="relation"
              nodes={view.nodes}
              edges={view.edges}
              selectedId={selected}
              onSelect={(id) => setSelected(id)}
              onToggleLinkMode={() => gEdit.setLinkMode((v) => !v)}
              showLabels={showLabels}
              themeKey={`${prefs?.ui.mode ?? ''}-${prefs?.ui.theme ?? ''}`}
              typeIcons={styles.typeIcons}
              glow={styles.glow}
              spacing={styles.spacing}
              layoutToken={styles.layoutToken}
              nodeStyle={sr.hasPack ? sr.s3d : undefined}
            />
          )}
        </StateGate>
      </Panel>

      {/* ---- 右侧：控制与明细 ---- */}
      <div className="relation__side">
        {/* 「节点明细」钉在侧栏最上面（P11-2️⃣②）—— 理由同「世界观」页：
            侧栏里「显示 / 图长相 / 贴纸」加起来就有两千多像素高，明细卡排在最下面
            时，在图上点节点等于没有任何反馈。 */}
        <Panel
          title="节点明细"
          className="panel--pin"
          actions={detail ? <PanelClose onClick={() => setSelected(null)} /> : undefined}
        >
          {!detail ? (
            <div className="empty fs-sm" style={{ padding: 'var(--p-space-4) 0' }}>
              点图上一个节点，这里显示它连了谁。
            </div>
          ) : (
            <>
              <div className="row" data-entity-type={detail.node.type}>
                <span className="dot" />
                <b>{detail.node.name}</b>
                <div className="grow" />
                {detail.node.unresolved ? (
                  <span className="chip" style={{ color: 'var(--warn)' }}>未录入</span>
                ) : (
                  <span className="chip chip--type">{labelOf(detail.node.type)}</span>
                )}
              </div>

              {!detail.node.unresolved && (
                <button
                  className="btn btn--sm"
                  style={{ marginTop: 'var(--p-space-2)' }}
                  onClick={() => openEntity(detail.node.id)}
                >
                  打开实体详情 →
                </button>
              )}

              <div className="detail__section">
                <div className="detail__section-title">它指向（{detail.out.length}）</div>
                {detail.out.length === 0 ? (
                  <div className="faint fs-sm">无</div>
                ) : (
                  <ul className="rel-list">
                    {detail.out.map((r, i) => (
                      <li key={i}>
                        {r.kind && <span className="faint fs-xs">{r.kind}：</span>}
                        <button
                          className="node-link"
                          onClick={() => r.node && !r.node.unresolved && setSelected(r.raw)}
                        >
                          {r.node?.name ?? r.raw}
                          {r.node?.unresolved && <span className="faint">（未录入）</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="detail__section">
                <div className="detail__section-title">指向它（{detail.inc.length}）</div>
                {detail.inc.length === 0 ? (
                  <div className="faint fs-sm">无</div>
                ) : (
                  <ul className="rel-list">
                    {detail.inc.map((r, i) => (
                      <li key={i}>
                        {r.kind && <span className="faint fs-xs">{r.kind}：</span>}
                        <button
                          className="node-link"
                          onClick={() => r.node && !r.node.unresolved && setSelected(r.raw)}
                        >
                          {r.node?.name ?? r.raw}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </Panel>

        <Panel title="显示">
          <div className="row row--wrap" style={{ marginBottom: 'var(--p-space-3)' }}>
            <span className="chip">节点 {view.nodes.length}</span>
            <span className="chip">关系 {view.edges.length}</span>
            {data && data.dangling_nodes > 0 && (
              <span className="chip" style={{ color: 'var(--warn)' }}>
                待录入 {data.dangling_nodes}
              </span>
            )}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="g-type">只看某类（保留一跳邻居）</label>
            <select
              id="g-type"
              className="select"
              value={typeFilter ?? ''}
              onChange={(e) => setTypeFilter(e.target.value || null)}
            >
              <option value="">全部类型</option>
              {types.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          <div className="row row--wrap" style={{ marginTop: 'var(--p-space-3)' }}>
            <label className="row fs-sm" style={{ gap: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
              显示名字
            </label>
            <label className="row fs-sm" style={{ gap: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={showGhost} onChange={(e) => setShowGhost(e.target.checked)} />
              显示未录入
            </label>
          </div>

          {rootId && (
            <button className="btn btn--sm" style={{ marginTop: 'var(--p-space-3)' }} onClick={() => setRootId(null)}>
              取消固定根（改回自动）
            </button>
          )}

          <hr className="hr" />

          <div className="detail__section-title" style={{ marginBottom: 6 }}>图例</div>
          <div className="legend">
            {types.map((t) => (
              <span key={t.key} className="legend__item" data-entity-type={t.key}>
                <span className="dot" />
                {t.label}
              </span>
            ))}
            <span className="legend__item">
              <span className="ghost-dot" />
              未录入
            </span>
          </div>
          <p className="faint fs-xs" style={{ marginTop: 8, lineHeight: 1.6 }}>
            节点越大 = 关系越多。虚线空心圈 = 被引用但还没建档的实体，点它能看到是哪个名字。
          </p>

          {dim === '3d' && (
            <>
              <hr className="hr" />
              <div className="detail__section-title" style={{ marginBottom: 6 }}>三维外观</div>
              <GraphStylePanel
                styles={styles}
                types={types}
                sceneKey="relation"
                onRelayout={(nextSpacing) => {
                  setSelected(null)
                  notify(
                    'info',
                    nextSpacing
                      ? `已切到「${spacingLabel(nextSpacing)}」并重新排版`
                      : '正在重新排版…',
                  )
                }}
              />
            </>
          )}
        </Panel>

        <Panel title="图长相 · 样式包">
          <StylePackPanel
            // 未录入的虚线节点没有档案，不提供单独设定（点了也只是个待录名单的影子）
            nodeId={detail && !detail.node.unresolved ? detail.node.id : null}
            nodeName={detail && !detail.node.unresolved ? detail.node.name : null}
          />
        </Panel>

        {/* 贴纸只在平面档有意义 —— 三维里它是另一套东西（空间精灵），P5 不动 */}
        {dim === '2d' && (
          <Panel title="贴纸">
            <StickerPanel
              sceneKey="relation"
              editing={stickerEdit}
              onEditingChange={setStickerEdit}
              hint="把势力旗、地图碎片、角色设定图钉在图上做标记"
            />
          </Panel>
        )}

        {ghosts.length > 0 && (
          <Panel title={`待录名单（${ghosts.length}）`}>
            <p className="faint fs-xs" style={{ marginBottom: 8 }}>
              这些名字被双链引用了，但还没有自己的档案。点一下可以拿它当搜索词。
            </p>
            <div className="row row--wrap">
              {ghosts.map((g) => (
                <span key={g.id} className="chip" style={{ color: typeColorVar('', true) }}>
                  {g.name}
                </span>
              ))}
            </div>
          </Panel>
        )}
      </div>

      {gEdit.layer}
    </div>
  )
}

export default RelationView
