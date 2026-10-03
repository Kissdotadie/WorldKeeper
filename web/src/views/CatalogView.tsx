/**
 * 「一类实体」的整册界面。
 *
 * 世界观、地理观基本上是同一个东西的两次实例化：筛出若干类型 → 派生一张思维导图 → 旁边列清单。
 * 做成通用组件是因为它们除了「收哪些类型」之外没有任何差别。
 *
 * 关键规矩：**思维导图的骨架是派生的，不是新数据**。
 * 中心节点是界面名、一级分支是标签、二级是实体本身，实体之间的边依旧来自 [[双链]]。
 * 所以删掉索引重建之后，这张图必须长得一模一样（「索引零独占状态」）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '../api/client'
import type { EntityMeta, GraphData, TypeOption } from '../api/types'
import { useApp } from '../state/store'
import { useActions } from '../shell/panels'
import { useGraphEdit } from '../state/useGraphEdit'
import { Panel, PanelClose } from '../components/Panel'
import { GeoMapBoard } from '../components/GeoMapBoard'
import { GraphStylePanel, spacingLabel } from '../components/GraphStylePanel'
import { StylePackPanel } from '../components/StylePackPanel'
import { StickerLayer, StickerPanel } from '../components/StickerLayer'
import { StateGate } from '../components/Toast'
import { Graph2D } from '../graph/Graph2D'
import { Graph3D } from '../graph/Graph3D'
import { useSceneStyles } from '../graph/useSceneStyles'
import { useStyleResolver } from '../graph/useStyleResolver'
import { LAYOUT_LABELS } from '../graph/types'
import type { GEdge, GNode, LayoutKind } from '../graph/types'

const ROOT = '__root__'
const tagNodeId = (t: string) => `__tag__:${t}`
/** 界面自造的骨架节点（中心、分组）不是实体，点了不能当实体打开 */
export const isVirtualNode = (id: string) => id.startsWith('__')

export interface CatalogProps {
  /** 界面名，同时用作思维导图的中心节点 */
  title: string
  /** 收录哪些实体类型 */
  types: string[]
  /** 这个界面管什么（右栏底部的一句话） */
  note?: string
  /** 空库时的引导文案 */
  emptyHint?: string
  /** 是否按标签聚成一级分支 —— 思维导图的默认形态 */
  groupByTag?: boolean
  /** 一个实体最多挂几个标签分支，挂多了会糊成一团 */
  maxTagsPerNode?: number
  /** 是否多一档「地图」（地理观要；世界观、历史观用不上） */
  enableMap?: boolean
}

type Mode = 'map' | 'table' | '3d' | 'geo'

export function CatalogView({
  title,
  types,
  note,
  emptyHint,
  groupByTag = true,
  maxTagsPerNode = 2,
  enableMap = false,
}: CatalogProps) {
  const { bookId, entities, openEntity, notify, query, types: allTypes, refresh, prefs, dataVersion, requestView } = useApp()
  const { onNewEntity } = useActions()

  const [data, setData] = useState<GraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>(() => (enableMap ? 'geo' : 'map'))
  /**
   * 布局：本界面手动选过的赢，没选过就跟样式包走（见 RelationView 的同一段注释）。
   * 世界观和地理观各有各的 localStorage 键 —— 它们本来就是两张不同的图。
   */
  const [layoutPick, setLayoutPick] = useState<LayoutKind | null>(() => {
    try {
      return (localStorage.getItem(`wkv.layout.${title}`) as LayoutKind) || null
    } catch {
      return null
    }
  })
  const [rootId, setRootId] = useState<string | null>(ROOT)
  const [showLabels, setShowLabels] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  /** 贴纸编辑态（只在导图档用得上） */
  const [stickerEdit, setStickerEdit] = useState(false)
  /** 三维取景令牌：每次切进三维都重新取一次全景 */
  const [token3d, setToken3d] = useState(0)
  /** 三维外观（辉光 / 疏密 / 类型图标）—— 与关系网共用同一份状态 */
  const styles = useSceneStyles(bookId)
  /** 样式包（图长相）：2D 全接，3D 只接颜色与大小 */
  const sr = useStyleResolver()
  const layout: LayoutKind = layoutPick ?? sr.layout

  const load = useCallback(() => {
    if (!bookId) return
    setLoading(true)
    setError(null)
    api
      .getGraph(bookId, { types, includeIsolated: true })
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
    // types 是数组字面量，用 join 当依赖避免每次渲染都重取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, types.join(','), dataVersion])

  useEffect(load, [load])

  // ---- 就地编辑（P4.3）----
  // 这个界面只管收进来的那几类，所以「类型」下拉也只列这几类 ——
  // 否则在世界观里能新建出一个人物，新建完又不在这一页，看着像丢了。
  const myTypes = useMemo<TypeOption[]>(
    () => allTypes.filter((t) => types.includes(t.key)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allTypes, types.join(',')],
  )
  const sceneKey = `catalog-${types.join('-')}`

  const seedPosition = async (id: string, world: { x: number; y: number; z: number }) => {
    if (!bookId) return
    try {
      const cur = await api.getScene(bookId)
      const scene = cur.scene ?? {}
      const graphs = { ...(scene.graphs ?? {}) }
      const one = graphs[sceneKey] ?? {}
      graphs[sceneKey] = { ...one, positions: { ...(one.positions ?? {}), [id]: world } }
      await api.saveScene(bookId, { ...scene, graphs })
    } catch {
      /* 钉不上就让它自己找位置 */
    }
  }

  const gEdit = useGraphEdit({
    bookId,
    sceneKey, // 撤销「挪动节点」时要指到这张图
    types: myTypes.length ? myTypes : allTypes,
    onChanged: (id, world) => {
      if (id && world) void seedPosition(id, world)
      load()
      if (id) setSelected(id)
    },
    onOpenDetail: (id) => openEntity(id),
  })

  const pickLayout = (k: LayoutKind) => {
    // 选中的正好是样式包给的那个 => 撤回手动档，重新跟着包走
    const next = k === sr.layout ? null : k
    setLayoutPick(next)
    try {
      if (next) localStorage.setItem(`wkv.layout.${title}`, next)
      else localStorage.removeItem(`wkv.layout.${title}`)
    } catch {
      /* 忽略 */
    }
  }

  // ---- 本界面的实体（元信息取自应用状态，图只提供边） ----
  const mine = useMemo(() => entities.filter((e) => types.includes(e.type)), [entities, types])
  const byId = useMemo(() => new Map(mine.map((e) => [e.id, e])), [mine])

  // ---- 思维导图：把「中心 → 标签分组 → 实体」的骨架与真实双链合起来 ----
  const graph = useMemo(() => {
    const nodes: GNode[] = []
    const edges: GEdge[] = []
    const seen = new Set<string>()
    const push = (source: string, target: string, kind?: string | null) => {
      const key = `${source}\u0000${target}`
      if (seen.has(key) || source === target) return
      seen.add(key)
      edges.push({ source, target, kind })
    }

    const live = new Set(mine.map((e) => e.id))

    if (groupByTag) {
      nodes.push({ id: ROOT, name: title, type: '__root' })
      const tags: string[] = []
      for (const e of mine) {
        for (const t of (e.tags ?? []).slice(0, maxTagsPerNode)) {
          if (!tags.includes(t)) tags.push(t)
        }
      }
      for (const t of tags) nodes.push({ id: tagNodeId(t), name: t, type: '__tag' })
      for (const e of mine) {
        const ts = (e.tags ?? []).slice(0, maxTagsPerNode)
        if (ts.length) {
          for (const t of ts) {
            push(ROOT, tagNodeId(t), '分组')
            push(tagNodeId(t), e.id)
          }
        } else {
          push(ROOT, e.id)
        }
      }
    }

    // 实体自身的节点（含被引用但未录入的虚线节点）
    for (const n of data?.nodes ?? []) {
      if (!n.unresolved && !live.has(n.id)) continue
      nodes.push(n)
    }
    // 真实双链
    for (const e of data?.edges ?? []) {
      if (e.source === e.target) continue
      const okSrc = live.has(e.source) || e.source.startsWith('?')
      const okDst = live.has(e.target) || e.target.startsWith('?')
      if (okSrc && okDst) push(e.source, e.target, e.kind)
    }

    // 度数重新算一遍：带上分组边之后，节点大小才反映「挂了多少东西」
    const deg = new Map<string, number>()
    for (const e of edges) {
      deg.set(e.source, (deg.get(e.source) ?? 0) + 1)
      deg.set(e.target, (deg.get(e.target) ?? 0) + 1)
    }
    for (const n of nodes) n.degree = deg.get(n.id) ?? 0

    return { nodes, edges }
  }, [data, mine, groupByTag, maxTagsPerNode, title])

  // 三维全景只吃真实实体 —— 导图里的「中心/标签分组」骨架节点是界面自造的，不进 3D
  const solid = useMemo(
    () => ({
      nodes: graph.nodes.filter((n) => !isVirtualNode(n.id)),
      edges: graph.edges.filter((e) => !isVirtualNode(e.source) && !isVirtualNode(e.target)),
    }),
    [graph],
  )

  const ghosts = useMemo(() => (data?.nodes ?? []).filter((n) => n.unresolved), [data])

  const labelOf = (key: string) => allTypes.find((t) => t.key === key)?.label ?? data?.type_labels?.[key] ?? key

  /** 清单：按标签分组时的分组结构 */
  const groups = useMemo(() => {
    if (!groupByTag) return [{ name: '', items: mine }]
    const tagOrder: string[] = []
    for (const e of mine) for (const t of (e.tags ?? []).slice(0, maxTagsPerNode)) if (!tagOrder.includes(t)) tagOrder.push(t)
    const out: { name: string; items: EntityMeta[] }[] = []
    for (const t of tagOrder) {
      const list = mine.filter((e) => (e.tags ?? []).includes(t))
      if (list.length) out.push({ name: t, items: list })
    }
    const rest = mine.filter((e) => !(e.tags ?? []).length)
    if (rest.length) out.push({ name: '（未打标签）', items: rest })
    return out
  }, [mine, groupByTag, maxTagsPerNode])

  const hl = query.trim().toLowerCase()
  const filteredGroups = useMemo(() => {
    if (!hl) return groups
    return groups
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (e) =>
            e.name.toLowerCase().includes(hl) ||
            (e.aliases ?? []).some((a) => a.toLowerCase().includes(hl)) ||
            (e.summary ?? '').toLowerCase().includes(hl),
        ),
      }))
      .filter((g) => g.items.length)
  }, [groups, hl])

  const selectedMeta = selected && !isVirtualNode(selected) ? byId.get(selected) : null

  /** 呈现方式的切换条。三处 Panel 共用，省得加一档就要改三遍。 */
  const modeSeg = (
    <div className="seg" role="tablist" aria-label="呈现方式">
      {enableMap && (
        <button
          className={`seg__item ${mode === 'geo' ? 'seg__item--on' : ''}`}
          onClick={() => setMode('geo')}
          title="地图：把地点摆到你自己画的底图上"
        >
          地图
        </button>
      )}
      <button className={`seg__item ${mode === 'map' ? 'seg__item--on' : ''}`} onClick={() => setMode('map')}>
        导图
      </button>
      <button
        className={`seg__item ${mode === '3d' ? 'seg__item--on' : ''}`}
        onClick={() => {
          setMode('3d')
          setToken3d((t) => t + 1)
        }}
        title="三维全景：同一类聚成一团，整体看设定格局"
      >
        三维
      </button>
      <button className={`seg__item ${mode === 'table' ? 'seg__item--on' : ''}`} onClick={() => setMode('table')}>
        清单
      </button>
    </div>
  )

  /**
   * 空状态的出口（N8）。
   *
   * 世界观 / 地理观 / 历史观这些视角**故意**没有自己的录入入口 ——
   * 设定一律是实体，实体在「全部实体」里建；成批的正文在「正文」里导入后跑抽取。
   * 但这套分工只写在 emptyHint 的**文字**里，用户看到空图的第一反应仍然是
   * 「这里怎么没有导入按钮」。所以空态要把这两条路直接摆成能点的按钮。
   *
   * 不去给每个视角加独立的导入通道：那会变成八个入口写同一份数据，
   * 冲突标红、增量识别、断点续跑的账就全乱了。
   */
  const emptyActions = (
    <>
      <button className="btn btn--primary btn--sm" onClick={() => onNewEntity(types[0])}>
        ＋ 手录一条{labelOf(types[0])}
      </button>
      <button
        className="btn btn--sm"
        onClick={() => requestView('text', 'text:import')}
        title="导入章节原文，跑规则或 AI 抽取，候选确认后自动进这一页"
      >
        去「正文」导入章节 →
      </button>
      <button className="btn btn--ghost btn--sm" onClick={() => requestView('entities')}>
        去「全部实体」 →
      </button>
    </>
  )

  // 地图模式占满整宽 —— 它自己就是一套三栏工作台，不该再套一层侧栏
  if (mode === 'geo' && enableMap && bookId) {
    return (
      <div className="catalog catalog--map">
        <Panel title={`${title} · 地图`} flush actions={modeSeg}>
          <GeoMapBoard
            bookId={bookId}
            types={myTypes.length ? myTypes : allTypes}
            entities={entities}
            query={query}
            onOpenEntity={(id) => openEntity(id)}
            onChanged={() => {
              load()
              void refresh()
            }}
            dataVersion={dataVersion}
          />
        </Panel>
      </div>
    )
  }

  return (
    <div className="catalog">
      {mode === 'map' ? (
        <Panel
          title={`${title} · 思维导图`}
          flush
          actions={
            <>
              <button
                className="btn btn--primary btn--sm"
                onClick={() => onNewEntity(types[0])}
                title={`新建一条${title}，表单会预选类型`}
              >
                ＋ 新建
              </button>
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
              {layoutPick !== null && (
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => pickLayout(sr.layout)}
                  title="改回跟样式包走"
                >
                  ↻ 跟随样式
                </button>
              )}
              {modeSeg}
            </>
          }
        >
          <StateGate
            loading={loading}
            error={error}
            empty={mine.length === 0}
            emptyTitle={`${title}还是空的`}
            emptyHint={emptyHint}
            emptyAction={emptyActions}
          >
            <Graph2D
              {...gEdit.graphProps}
              {...sr.g2d}
              nodes={graph.nodes}
              edges={graph.edges}
              layout={layout}
              rootId={groupByTag ? rootId : null}
              selectedId={selected}
              highlight={query}
              showLabels={showLabels}
              onSelect={(id) => {
                // null = 点了空白，取消选中（P11-2️⃣②）
                if (id === null) setSelected(null)
                else setSelected(id)
              }}
              onNodeEdit={(id, name, screen, nearType) => {
                // 中心 / 标签分组是界面自造的骨架节点，不是实体：
                // 双击它当「设为根」使，别去开一个不存在的档案。
                if (isVirtualNode(id)) {
                  setRootId(id)
                  notify('info', `「${name}」是分组骨架，已设为根`)
                  return
                }
                gEdit.graphProps.onNodeEdit(id, name, screen, nearType)
              }}
              onPickRoot={(id) => {
                setRootId(id)
                notify('info', `「${graph.nodes.find((n) => n.id === id)?.name}」已设为根`)
              }}
              onUnresolvedClick={(name) => notify('info', `「${name}」还没录入，它是被别的实体引用进来的`)}
              onToggleLinkMode={() => gEdit.setLinkMode((v) => !v)}
            >
              <StickerLayer sceneKey={sceneKey} editing={stickerEdit} />
            </Graph2D>
          </StateGate>
        </Panel>
      ) : mode === '3d' && bookId ? (
        <Panel
          title={`${title} · 三维全景`}
          flush
          actions={
            <>
              <button
                className="btn btn--primary btn--sm"
                onClick={() => onNewEntity(types[0])}
                title={`新建一条${title}，表单会预选类型`}
              >
                ＋ 新建
              </button>
              {modeSeg}
            </>
          }
        >
          <StateGate loading={loading} error={error} empty={solid.nodes.length === 0}
            emptyTitle={`${title}还是空的`} emptyHint={emptyHint} emptyAction={emptyActions}>
            <Graph3D
              {...gEdit.graphProps}
              bookId={bookId}
              sceneKey={sceneKey}
              nodes={solid.nodes}
              edges={solid.edges}
              selectedId={selected}
              onSelect={(id) => setSelected(id)}
              onToggleLinkMode={() => gEdit.setLinkMode((v) => !v)}
              showLabels={showLabels}
              themeKey={`${prefs?.ui.mode ?? ''}-${prefs?.ui.theme ?? ''}`}
              typeIcons={styles.typeIcons}
              glow={styles.glow}
              spacing={styles.spacing}
              clusterByType={types.length > 1}
              nodeStyle={sr.hasPack ? sr.s3d : undefined}
              // 两个令牌相加当变化量：切进三维要重新取景，改疏密要重新排布，
              // Graph3D 只看「值变没变」，加起来正好一次说清两件事
              layoutToken={token3d + styles.layoutToken}
            />
          </StateGate>
        </Panel>
      ) : (
        <Panel
          title={`${title} · 清单`}
          actions={
            <>
              <button className="btn btn--primary btn--sm" onClick={() => onNewEntity(types[0])}>
                ＋ 新建
              </button>
              <button className="btn btn--sm" onClick={load} disabled={loading}>
                重新读取
              </button>
              {modeSeg}
            </>
          }
        >
          <StateGate
            loading={loading}
            error={error}
            empty={mine.length === 0}
            emptyTitle={`${title}还是空的`}
            emptyHint={emptyHint}
            emptyAction={emptyActions}
          >
            {filteredGroups.map((g) => (
              <section key={g.name || '_all'} style={{ marginBottom: 'var(--p-space-5)' }}>
                {g.name && (
                  <div className="row" style={{ marginBottom: 'var(--p-space-2)' }}>
                    <h3 className="fs-sm">{g.name}</h3>
                    <span className="faint fs-xs">{g.items.length}</span>
                  </div>
                )}
                <div className="table-wrap">
                  <table className="etable">
                    <thead>
                      <tr>
                        <th style={{ width: '170px' }}>名称</th>
                        <th style={{ width: '80px' }}>类型</th>
                        <th style={{ width: '160px' }}>别名</th>
                        <th style={{ width: '90px' }}>首现</th>
                        <th>摘要</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.items.map((e) => (
                        <tr key={e.id} data-entity-type={e.type} onClick={() => openEntity(e.id)}>
                          <td className="etable__name">
                            <span className="dot" />
                            {e.name}
                          </td>
                          <td className="muted fs-sm">{labelOf(e.type)}</td>
                          <td className="muted fs-sm">{(e.aliases ?? []).join('、') || <span className="faint">—</span>}</td>
                          <td className="faint fs-xs">{e.first_appear || '—'}</td>
                          <td className="muted fs-sm etable__summary">{e.summary || <span className="faint">还没有摘要</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          </StateGate>
        </Panel>
      )}

      {/* ---- 右侧：控件、清单、说明 ---- */}
      <div className="catalog__side">
        {/* 「选中 / 图例」钉在侧栏最上面（P11-2️⃣②）。
            侧栏里躺着「条目」这种几百上千行的清单，整列能长到上万像素 ——
            这张卡排在最底下时，用户在图上点了节点**看不到任何反馈**，
            更看不到退出选中的 ✕。所以它必须是侧栏的第一张卡并吸顶。 */}
        {selectedMeta ? (
          <Panel
            title="选中"
            className="panel--pin"
            actions={<PanelClose onClick={() => setSelected(null)} />}
          >
            <div className="row" data-entity-type={selectedMeta.type}>
              <span className="dot" />
              <b>{selectedMeta.name}</b>
            </div>
            <div className="fs-sm muted" style={{ marginTop: 6, lineHeight: 1.6 }}>
              {selectedMeta.summary || '还没有摘要。'}
            </div>
            <button className="btn btn--sm" style={{ marginTop: 'var(--p-space-2)' }} onClick={() => openEntity(selectedMeta.id)}>
              打开实体详情 →
            </button>
          </Panel>
        ) : (
          <Panel title="图例" className="panel--pin">
            <div className="legend">
              {types.map((t) => (
                <span key={t} className="legend__item" data-entity-type={t}>
                  <span className="dot" />
                  {labelOf(t)}
                </span>
              ))}
              <span className="legend__item" data-entity-type="__tag">
                <span className="dot" />
                标签分组
              </span>
              {ghosts.length > 0 && (
                <span className="legend__item">
                  <span className="ghost-dot" />
                  未录入
                </span>
              )}
            </div>
            {note && (
              <p className="faint fs-xs" style={{ marginTop: 8, lineHeight: 1.7 }}>
                {note}
              </p>
            )}
          </Panel>
        )}

        {/* 三维外观只在这一档出现 —— 导图/清单模式下它是无关的噪音 */}
        {mode === '3d' && (
          <Panel title="三维外观">
            <GraphStylePanel
              styles={styles}
              types={myTypes.length ? myTypes : allTypes}
              sceneKey={sceneKey}
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
          </Panel>
        )}

        {/* 图长相（样式包）在「导图」与「三维」两档都出现 —— 地图和清单没有图可改 */}
        {(mode === 'map' || mode === '3d') && (
          <Panel title="图长相 · 样式包">
            <StylePackPanel nodeId={selectedMeta?.id ?? null} nodeName={selectedMeta?.name ?? null} />
          </Panel>
        )}

        {mode === 'map' && (
          <Panel title="贴纸">
            <StickerPanel
              sceneKey={sceneKey}
              editing={stickerEdit}
              onEditingChange={setStickerEdit}
              hint="在设定图上钉参考图、标重点"
            />
          </Panel>
        )}

        <Panel title="这张图怎么来的">
          <div className="row row--wrap">
            <span className="chip">实体 {mine.length}</span>
            <span className="chip">节点 {graph.nodes.length}</span>
            <span className="chip">连线 {graph.edges.length}</span>
            {ghosts.length > 0 && (
              <span className="chip" style={{ color: 'var(--warn)' }}>
                未录入 {ghosts.length}
              </span>
            )}
          </div>
          <p className="faint fs-xs" style={{ marginTop: 8, lineHeight: 1.7 }}>
            中心是「{title}」，一级分支是<strong>标签</strong>，二级是实体本身。
            实体的连线来自各自正文的「关联」一节里的 <code>[[双链]]</code> ——
            图只是把它画出来，改关系仍然只能去改实体。
          </p>
          {groupByTag && (
            <div className="row" style={{ marginTop: 'var(--p-space-3)' }}>
              <label className="row fs-sm" style={{ gap: 5, cursor: 'pointer' }}>
                <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
                显示名字
              </label>
              {rootId !== ROOT && (
                <button className="btn btn--ghost btn--sm" onClick={() => setRootId(ROOT)}>
                  回到中心
                </button>
              )}
            </div>
          )}
          {/* 这一页没有自己的导入 / 录入入口（N8）。
              这个分工不该只写在文字里 —— 非空的时候用户同样会找「内容怎么进来」，
              所以常驻摆两个能点的下一跳。 */}
          <div className="row row--wrap" style={{ marginTop: 'var(--p-space-3)', gap: 6 }}>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => requestView('text', 'text:import')}
              title="导入章节原文，跑规则或 AI 抽取，候选确认后自动进这一页"
            >
              内容从哪来 · 章节导入 →
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => requestView('entities')}>
              手录实体 →
            </button>
          </div>
        </Panel>

        <Panel title={`条目（${mine.length}）`} className="panel--scroll">
          {filteredGroups.length === 0 ? (
            <div className="faint fs-sm">没有匹配的条目。</div>
          ) : (
            filteredGroups.map((g) => (
              <div key={g.name || '_all'} style={{ marginBottom: 'var(--p-space-4)' }}>
                {g.name && (
                  <div className="row" style={{ marginBottom: 4 }}>
                    <span className="fs-xs muted">{g.name}</span>
                    <span className="faint fs-xs">{g.items.length}</span>
                  </div>
                )}
                <ul className="cat-list">
                  {g.items.map((e) => (
                    <li key={e.id}>
                      <button
                        className={`cat-list__item ${selected === e.id ? 'cat-list__item--on' : ''}`}
                        data-entity-type={e.type}
                        onClick={() => {
                          setSelected(e.id)
                          setRootId(e.id)
                        }}
                        onDoubleClick={() => openEntity(e.id)}
                        title="单击把它设为图的中心，双击打开实体详情"
                      >
                        <span className="dot" />
                        <span className="cat-list__name">{e.name}</span>
                        {(e.aliases ?? []).length > 0 && (
                          <span className="faint fs-xs">{e.aliases![0]}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </Panel>
      </div>

      {gEdit.layer}
    </div>
  )
}

export default CatalogView
