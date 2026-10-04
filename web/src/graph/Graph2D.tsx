/**
 * 通用 2D 图谱组件。
 *
 * 这是「2D 思维导图」的地基：关系网先用它，之后世界观、地理观、剧情线
 * 都复用同一个组件，只是喂不同的数据与布局。
 *
 * 关键设计：
 * - 力导向用**同步预迭代**（先跑 220 次 tick 再渲染），避免节点开局乱飞；
 *   其余布局是纯计算，位置每次打开都一样。
 * - 布局、节点形状、配色、连线样式都是参数化的 —— P5 的「一键变换样式」
 *   就是把参数从外面塞进来，**不用改这个组件**。
 *   `resolveStyle` 负责「这个节点该长什么样」，这里只管照着画。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useShortcutScope, useShortcuts } from '../lib/shortcuts'
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'
import { edgePath } from './edgePath'
import {
  boundsOf,
  layoutStatic,
} from './layouts'
import {
  nodeColor,
  nodeRadius,
  shortName,
  type GEdge,
  type GNode,
  type LayoutKind,
  type Pt,
} from './types'
import {
  shapeGeom,
  withAlpha,
  type BackgroundKind,
  type GraphSpec,
  type ResolvedNode,
} from './styles'
import { assetUrlOf } from '../api/client'
import { GraphEditGuide } from '../components/GraphEditGuide'
import { hasSeenGraphGuide, markGraphGuideSeen } from '../lib/graphGuide'

interface SimNode extends GNode, SimulationNodeDatum {}
type SimLink = SimulationLinkDatum<SimNode> & { kind?: string | null }

/** 结构模式（自由结构）的编辑接口 —— 真源在外层，见 Props.outline 的注释 */
export interface OutlineEditApi {
  active: boolean
  /** 该节点的父级 id；根为 null */
  parentIdOf: (id: string) => string | null
  /** 是不是界面自造的自由节点（实体节点走 onNodeEdit 开档案） */
  isVirtual: (id: string) => boolean
  addChild: (id: string) => void
  addSibling: (id: string) => void
  /** 摘下（实体）/删除（自由节点） */
  remove: (id: string) => void
  /** 只对自由节点生效；实体改名走档案浮层 */
  rename: (id: string, name: string) => void
  /** 拖 B 落到 A 上 = B 挂到 A 下。防环由外层把关 */
  reparent: (childId: string, parentId: string | null) => void
  /** 外层刚建好一个自由节点，让图自动进入改名（WPS 的新节点手感） */
  pendingRenameId?: string | null
  onRenameHandled?: () => void
}

interface Props {
  nodes: GNode[]
  edges: GEdge[]
  layout: LayoutKind
  selectedId?: string | null
  /** 树形/放射布局的根。为空时自动取连接最多的那个 */
  rootId?: string | null
  /** 选中某个节点；**传 null = 点了空白，取消选中**（P11-2️⃣②） */
  onSelect?: (id: string | null) => void
  /**
   * 这个视图**能**开「自由结构」（哪怕现在还没开）。
   *
   * 为什么要单独一个 prop：地理观/关系网这类视图，结构开关没开的时候
   * `outline` 是 undefined，迷你工具条整个不渲染 —— 用户选中一个节点，
   * 看不到任何「加子级/同级」的入口，会以为功能是坏的。
   * 有了这个标记，就能在那种时候给出一个明确的「开启自由结构」按钮。
   */
  outlineAvailable?: boolean
  /** 点迷你条上的「开启自由结构」 */
  onEnableOutline?: () => void
  /** Alt+双击：把某个节点设为布局的根（普通双击让位给「就地编辑」） */
  onPickRoot?: (id: string) => void
  /** 搜索高亮串 */
  highlight?: string
  showLabels?: boolean
  /** 点击虚线节点时的回调（通常用于提示「这条还没录入」） */
  onUnresolvedClick?: (name: string) => void

  // ---- 就地编辑（P4.3）----
  /**
   * 图上就地编辑是否开启（P11-2️⃣①）。默认开，关掉 = 纯浏览：
   * 不能拖节点改位置、双击不改也不新建（只看得动、缩放、选中）。
   * 留着这个开关是为了「我只想看图、别手滑改坏东西」。
   */
  editable?: boolean
  /** 工具条上那个「浏览 / 编辑」的切换回调。不传就不显示该控件 */
  onToggleEditable?: (next: boolean) => void
  /** 连线模式：拖节点 = 连线，而不是挪位置 */
  linkMode?: boolean
  /** 双击节点：就地改名称/类型/标签/摘要 */
  onNodeEdit?: (id: string, name: string, screen: { x: number; y: number }, nearType?: string) => void
  /** 双击空白：就地新建。nearType 是鼠标附近节点的类型，用来预选 */
  onCanvasEdit?: (screen: { x: number; y: number }, world?: undefined, nearType?: string) => void
  /** 从一个节点拖到另一个节点：建立关联 */
  onLink?: (
    fromId: string,
    fromName: string,
    toId: string,
    toName: string,
    screen: { x: number; y: number },
  ) => void
  /** 工具栏上的「连线模式」开关（状态由外层持有，连完自动复位） */
  onToggleLinkMode?: () => void

  // ---- 自由结构（WPS 式思维导图编辑）----
  /**
   * 结构编辑接口。传了且 `active` 为真，图就进入「结构模式」：
   * 选中节点浮出迷你工具条（＋子级 / ＋同级 / 改名 / 摘下），
   * Tab=加子级、Enter=加同级、Delete=摘下、F2=改名，
   * 拖一个节点落到另一个节点上 = 改挂到它下面。结构数据的真源在外层
   * （CatalogView 存 `view/scene.json`），这里只管把事件抛回去。
   */
  outline?: OutlineEditApi
  /**
   * 层级覆盖（结构模式下树的形状由这里决定，不再按连线 BFS 自行推理）。
   * 与 `outline` 分开传：布局要的是纯数据，编辑要的是回调。
   */
  hierarchy?: { root: string; children: Map<string, string[]> } | null
  /**
   * 节点 → 描述文本（导入大纲时识别出的那些「说明」）。
   * 非空时画在名字下方的小字里 —— 说明和节点是两回事，得看得见区别。
   */
  noteOf?: (id: string) => string

  // ---- 样式系统（P5）----
  /** 节点该长什么样。不传 = 老行为：圆节点 + 按类型上色 */
  resolveStyle?: (n: GNode) => ResolvedNode
  edgeStyle?: GraphSpec['edge']
  background?: BackgroundKind
  /** 标签字号倍率 */
  labelScale?: number
  /**
   * 盖在图上面的东西（现在只有贴纸层）。
   *
   * 为什么放在这里而不是让调用方自己套一层 div：贴纸的坐标是「相对图容器
   * 左上角的像素」，这个原点必须**正好**是 `.graph` 的左上角，
   * 否则贴纸会和节点错位，而且缩放窗口时错得还不一样多。
   */
  children?: ReactNode
}

const MAX_PRETICK = 220

/** 双击空白时，多远之内的节点算「我这是想加在它旁边」 */
const NEAR_RADIUS = 110

/** 一个形状画成 SVG 元素。halo 与主体共用，靠 `grow` 放大一圈。 */
function ShapeEl({
  geom,
  className,
  style,
  halo,
}: {
  geom: ReturnType<typeof shapeGeom>
  className?: string
  style?: React.CSSProperties
  /**
   * 环的来由，渲染成 `data-halo`。
   *
   * 为什么要区分：`.graph__halo` 同时承载**四种**来由 ——
   * 样式包规则里的 `highlight`（type/tag 规则命中，可能好几个）、
   * 搜索命中、拖拽落点、以及「当前选中」。
   * 验收脚本要断的是「选中」，用 class 计数会把前三种一起算进去
   * （人物类型挂了 highlight 规则时，光样式环就 3 个），
   * 于是「halo=1 表示选中了」这条断言会莫名其妙失败。
   * 给个稳定锚点，断言就能精确指向它真正关心的那一种。
   */
  halo?: 'style' | 'hit' | 'sel' | 'drop'
}) {
  const anchor = halo ? { 'data-halo': halo } : {}
  if (geom.kind === 'circle') {
    return <circle r={geom.r} className={className} style={style} {...anchor} />
  }
  if (geom.kind === 'rect') {
    return (
      <rect
        x={-geom.w / 2}
        y={-geom.h / 2}
        width={geom.w}
        height={geom.h}
        rx={geom.rx}
        className={className}
        style={style}
        {...anchor}
      />
    )
  }
  return <polygon points={geom.points} className={className} style={style} {...anchor} />
}

/** 图上这个节点的「视觉半径」，用来裁连线端点 —— 形状不同，能碰到的地方也不同 */
function visualRadius(geom: ReturnType<typeof shapeGeom>): number {
  if (geom.kind === 'circle') return geom.r
  if (geom.kind === 'rect') return Math.max(geom.w, geom.h) / 2
  // 多边形按外接圆算，宁可留一点缝也别让线戳进形状里
  let max = 0
  for (const p of geom.points.split(' ')) {
    const [x, y] = p.split(',').map(Number)
    max = Math.max(max, Math.hypot(x, y))
  }
  return max
}



/** 虚线样式。**高亮的那条不断线** —— 断线会削弱「就是这一条」的确定感。 */
function dashOf(edge: GraphSpec['edge'] | undefined): string | undefined {
  return edge?.dashed ? '7 5' : undefined
}

/** 星空背景。种子固定 —— 每次刷新星星位置不一样会让人以为图变了 */
function StarField({ w, h }: { w: number; h: number }) {
  const stars = useMemo(() => {
    // 一行简单的确定性伪随机，不引任何库
    let s = 20261001
    const rnd = () => {
      s = (s * 1103515245 + 12345) % 2147483648
      return s / 2147483648
    }
    return Array.from({ length: 140 }, () => ({
      x: rnd() * w,
      y: rnd() * h,
      r: 0.5 + rnd() * 1.5,
      o: 0.18 + rnd() * 0.5,
    }))
  }, [w, h])
  return (
    <g pointerEvents="none">
      {stars.map((s, i) => (
        <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="var(--text-primary)" opacity={s.o} />
      ))}
    </g>
  )
}

export function Graph2D({
  nodes,
  edges,
  layout,
  selectedId,
  rootId,
  onSelect,
  onPickRoot,
  highlight = '',
  showLabels = true,
  onUnresolvedClick,
  linkMode = false,
  onNodeEdit,
  onCanvasEdit,
  onLink,
  onToggleLinkMode,
  editable = true,
  onToggleEditable,
  resolveStyle,
  edgeStyle,
  background = 'none',
  labelScale = 1,
  children,
  outline,
  hierarchy,
  noteOf,
  outlineAvailable,
  onEnableOutline,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const sizeRef = useRef({ w: 900, h: 600 })
  const [size, setSize] = useState({ w: 900, h: 600 })
  const [pos, setPos] = useState<Map<string, Pt>>(new Map())
  const [t, setT] = useState({ k: 1, x: 0, y: 0 })
  const [hover, setHover] = useState<string | null>(null)
  // 一次性引导（P11-2️⃣①）：初值来自 localStorage，看过就不再弹
  const [guideSeen, setGuideSeen] = useState(() => hasSeenGraphGuide())
  // 上一轮画出来的节点 id 集合 —— 用来判断「这批变化是新视图还是小改动」
  const prevIdsRef = useRef<Set<string> | null>(null)
  // 上一次「适配」时画布多大。尺寸微变（往往只是滚动条一进一出）不该重新适配：
  // 加一个节点让内容变长 → 面板冒出滚动条 → 画布窄了 15px → ResizeObserver 一响，
  // 整张图就跟着缩 0.3%，看着就是「画面自己抖了一下」。
  const lastFitSizeRef = useRef<{ w: number; h: number } | null>(null)
  // 视野的实时值。maybeRefit 要读它算屏幕坐标，但**不能**进依赖 ——
  // 否则拖一下画面就把整棵树重新布局一遍。
  const tRef = useRef(t)
  tRef.current = t

  // 连线拖拽：从哪个节点起、拖到哪了
  const [linkFrom, setLinkFrom] = useState<{ id: string; name: string; x: number; y: number } | null>(null)
  const [linkPt, setLinkPt] = useState<Pt | null>(null)

  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null)
  const simNodesRef = useRef<SimNode[]>([])
  const dragRef = useRef<string | null>(null)
  const panRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const userMovedRef = useRef(false)
  const fittedForRef = useRef('')

  // ---- 尺寸跟踪 ----
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth || 900
      const h = el.clientHeight || 600
      sizeRef.current = { w, h }
      setSize({ w, h })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  /**
   * 每个节点解析后的外观。
   *
   * 一次算好放 Map 里，**不要在渲染里反复调 `resolveStyle`** ——
   * 图上有几百个节点、每次 hover / 拖动都会重渲，重复解析会让拖动掉帧。
   */
  const resolved = useMemo(() => {
    const m = new Map<string, ResolvedNode>()
    if (!resolveStyle) return m
    for (const n of nodes) m.set(n.id, resolveStyle(n))
    return m
  }, [nodes, resolveStyle])

  /** 节点的实际半径：单节点写死的像素 > 基础半径 × 倍率 */
  const radiusOf = useCallback(
    (n: GNode) => {
      const st = resolved.get(n.id)
      if (!st) return nodeRadius(n)
      if (st.size != null) return Math.max(3, Math.min(80, st.size))
      return Math.max(4, Math.min(90, nodeRadius(n) * st.sizeScale))
    },
    [resolved],
  )

  /** 连线端点该停在哪 —— 方形/菱形能碰到的地方比圆更外，不按形状算会戳进形状里 */
  const hitRadiusOf = useCallback(
    (n: GNode) => visualRadius(shapeGeom(resolved.get(n.id)?.shape ?? 'auto', radiusOf(n))),
    [resolved, radiusOf],
  )

  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const n of nodes) m.set(n.id, new Set())
    for (const e of edges) {
      m.get(e.source)?.add(e.target)
      m.get(e.target)?.add(e.source)
    }
    return m
  }, [nodes, edges])

  const fitTo = useCallback((p: Map<string, Pt>) => {
    if (!p.size) return
    const b = boundsOf(p, 70)
    const { w, h } = sizeRef.current
    const k = Math.min(w / (b.maxX - b.minX), h / (b.maxY - b.minY), 1.5)
    const cx = (b.minX + b.maxX) / 2
    const cy = (b.minY + b.maxY) / 2
    setT({ k, x: w / 2 - cx * k, y: h / 2 - cy * k })
    userMovedRef.current = false
    lastFitSizeRef.current = { ...sizeRef.current }
  }, [])

  /**
   * 决定这一轮布局之后要不要动视野。
   *
   * **这是「思维导图像 WPS」的关键一环。** 早先这里是每次布局完都无脑
   * `fitTo` —— 加一个子级，922 个节点全部重排，然后整张图按新的边界
   * 重新缩放归位：画面猛地一缩、光标底下的东西飞走，写两个字就得
   * 重新找自己在哪。WPS 之所以不这样，是因为它加节点时**视野根本不动**。
   *
   * 规则：
   *  - 「换了一批节点」（重叠率 < 50%：切视图、切类型切片、开/关结构、导入）
   *    或「换了布局/根」→ 重新适配，这是人预期内的画面切换；
   *  - 只是加/删/改名了少数节点（重叠率高）→ **视野纹丝不动**，
   *    但如果恰好只新增了一个节点且它落在画面外，就平移最少的距离把它带进来
   *    —— 这正是 WPS 新建子级后让你立刻看到新节点的那一下。
   */
  const maybeRefit = useCallback(
    (p: Map<string, Pt>) => {
      const ids = new Set(p.keys())
      const prev = prevIdsRef.current
      prevIdsRef.current = ids

      let overlap = 0
      if (prev) {
        let same = 0
        for (const id of ids) if (prev.has(id)) same++
        overlap = same / Math.max(prev.size, ids.size, 1)
      }
      const key = `${layout}:${rootId ?? ''}`
      const isNewView = !prev || overlap < 0.5
      const isLayoutChange = fittedForRef.current !== key
      fittedForRef.current = key

      if (isNewView || isLayoutChange) {
        fitTo(p)
        return
      }

      // 小改动：只把「刚出生的那一个」带进视野，其余照旧
      const added: string[] = []
      for (const id of ids) if (prev && !prev.has(id)) added.push(id)
      if (added.length !== 1) return
      const np = p.get(added[0])
      if (!np) return
      const { w, h } = sizeRef.current
      const cur = tRef.current
      const sx = np.x * cur.k + cur.x
      const sy = np.y * cur.k + cur.y
      const M = 60 // 留一圈呼吸边距，别让新节点贴着边
      const dx = sx < M ? M - sx : sx > w - M ? w - M - sx : 0
      const dy = sy < M ? M - sy : sy > h - M ? h - M - sy : 0
      if (dx || dy) setT((c) => ({ ...c, x: c.x + dx, y: c.y + dy }))
    },
    [fitTo, layout, rootId],
  )

  // ---- 计算布局 ----
  useEffect(() => {
    if (!nodes.length) {
      simRef.current = null
      simNodesRef.current = []
      setPos(new Map())
      return
    }

    if (layout === 'force') {
      const simNodes: SimNode[] = nodes.map((n) => ({ ...n }))
      const simLinks: SimLink[] = edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind }))
      const sim = forceSimulation<SimNode, SimLink>(simNodes)
        .force(
          'link',
          forceLink<SimNode, SimLink>(simLinks)
            .id((d) => d.id)
            .distance(95)
            .strength(0.45),
        )
        .force('charge', forceManyBody().strength(-300))
        .force('center', forceCenter(0, 0))
        .force('collide', forceCollide<SimNode>().radius((d) => radiusOf(d) + 8))
        .stop()

      // 同步预迭代：先算出稳定位置再上屏，避免开局满屏乱飞
      for (let i = 0; i < MAX_PRETICK; i++) sim.tick()

      const p = new Map<string, Pt>()
      for (const n of simNodes) p.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 })

      // 拖拽时让物理继续响应
      sim.on('tick', () => {
        const next = new Map<string, Pt>()
        for (const n of simNodesRef.current) next.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 })
        setPos(next)
      })

      simRef.current = sim
      simNodesRef.current = simNodes
      setPos(p)
      maybeRefit(p)
      return
    }

    simRef.current = null
    simNodesRef.current = []
    const p = layoutStatic(layout, nodes, edges, rootId, hierarchy ?? null)
    setPos(p)
    maybeRefit(p)
  }, [nodes, edges, layout, rootId, fitTo, radiusOf, hierarchy, maybeRefit])

  // 尺寸变化：用户没手动动过视野、且变化足够大，才重新适配。
  // 「足够大」这一条是必须的 —— 滚动条一进一出就会让 ResizeObserver 响一次，
  // 那种 1% 级别的抖动不该动画面（见 lastFitSizeRef 的注释）。
  useEffect(() => {
    if (userMovedRef.current || !pos.size) return
    const prev = lastFitSizeRef.current
    if (!prev) {
      fitTo(pos)
      return
    }
    const dw = Math.abs(size.w - prev.w) / Math.max(prev.w, 1)
    const dh = Math.abs(size.h - prev.h) / Math.max(prev.h, 1)
    if (dw < 0.08 && dh < 0.08) return
    fitTo(pos)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size])

  // ---- 缩放（需要非 passive 监听才能 preventDefault） ----
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      userMovedRef.current = true
      const rect = el.getBoundingClientRect()
      const sx = ev.clientX - rect.left
      const sy = ev.clientY - rect.top
      setT((prev) => {
        const k = Math.min(3, Math.max(0.2, prev.k * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)))
        // 以指针为锚点缩放
        const gx = (sx - prev.x) / prev.k
        const gy = (sy - prev.y) / prev.k
        return { k, x: sx - gx * k, y: sy - gy * k }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ---- 指针交互 ----
  const toGraph = (clientX: number, clientY: number) => {
    const rect = wrapRef.current!.getBoundingClientRect()
    return {
      x: (clientX - rect.left - t.x) / t.k,
      y: (clientY - rect.top - t.y) / t.k,
    }
  }

  // 背景按下的起点。用来区分「在空白上点了一下」（取消选中）和「按住空白拖」（平移画布）
  const bgDownRef = useRef<{ x: number; y: number } | null>(null)
  // Esc 取消选中（P11-A2 的第一个用户；P11-2️⃣②）
  useShortcutScope('graph')
  useShortcuts(
    [{ id: 'graph.esc', keys: 'Esc', scope: 'graph', desc: '取消选中的节点', run: () => onSelect?.(null) }],
    [onSelect],
  )

  // ---- 自由结构（WPS 式编辑）----
  const oEdit = outline?.active ? outline : null
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  /** 拖动悬停的潜在新父级 —— 给它亮个环，人才敢松手 */
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const startRename = useCallback(
    (id: string) => {
      const def = byId.get(id)
      if (!def) return
      setRenaming({ id, value: def.name })
    },
    [byId],
  )

  // 外层刚建好一个自由节点 → 自动进入改名（WPS 的新节点手感：建完就打字）
  useEffect(() => {
    const pid = oEdit?.pendingRenameId
    if (!pid) return
    // 节点可能还没进这一帧的图（结构与图是同一次更新里的两件事），
    // 那就先不清标记，等 byId 补上再触发 —— 早先这里 `startRename` 遇到
    // 找不到 def 就直接 return，但标记已经被清掉了，于是「新节点自动改名」
    // 时灵时不灵。
    if (!byId.get(pid)) return
    setRenaming({ id: pid, value: byId.get(pid)!.name })
    oEdit?.onRenameHandled?.()
    // oEdit 是外层每次渲染新建的对象，不能进依赖 —— 只认「待改名的是谁」和节点表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oEdit?.pendingRenameId, byId])

  // 结构模式快捷键。改名输入框是 INPUT，这里的裸键默认不会在打字时触发
  useShortcuts(
    oEdit && selectedId && !renaming
      ? [
          {
            id: 'graph.outline.child',
            keys: 'Tab',
            scope: 'graph',
            desc: '结构模式：给选中节点加子级',
            run: (e) => {
              e.preventDefault()
              oEdit.addChild(selectedId)
            },
          },
          {
            id: 'graph.outline.sibling',
            keys: 'Enter',
            scope: 'graph',
            desc: '结构模式：给选中节点加同级',
            run: (e) => {
              e.preventDefault()
              oEdit.addSibling(selectedId)
            },
          },
          {
            id: 'graph.outline.detach',
            keys: 'Delete',
            scope: 'graph',
            desc: '结构模式：把选中节点摘下（实体本身不动）',
            run: () => oEdit.remove(selectedId),
          },
          {
            id: 'graph.outline.rename',
            keys: 'F2',
            scope: 'graph',
            desc: '结构模式：就地改名（自由节点）',
            run: () => {
              if (oEdit.isVirtual(selectedId)) startRename(selectedId)
            },
          },
        ]
      : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [oEdit, selectedId, renaming],
  )


  const onBgPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    bgDownRef.current = { x: e.clientX, y: e.clientY }
    panRef.current = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    // 连线拖拽中：只更新那根临时线，不动布局也不平移
    if (linkFrom) {
      setLinkPt(toGraph(e.clientX, e.clientY))
      return
    }
    const pan = panRef.current
    if (pan) {
      userMovedRef.current = true
      setT((prev) => ({
        ...prev,
        x: pan.tx + (e.clientX - pan.x),
        y: pan.ty + (e.clientY - pan.y),
      }))
      return
    }
    const id = dragRef.current
    if (id) {
      const g = toGraph(e.clientX, e.clientY)
      setPos((prev) => new Map(prev).set(id, g))
      // 结构模式：拖到哪个节点上，哪个就是候选新父级 —— 亮环提示，松手即换挂
      if (oEdit) {
        const over = nodeIdUnder(e.clientX, e.clientY, id)
        setDropTarget(over)
      }
      const sn = simNodesRef.current.find((n) => n.id === id)
      if (sn && simRef.current) {
        sn.fx = g.x
        sn.fy = g.y
        simRef.current.alphaTarget(0.2).restart()
      }
    }
  }

  /** 屏幕点落在哪个节点上。指针被 capture 之后 pointerenter 不再跨元素触发，
   *  所以连线收尾只能自己按坐标查一次。 */
  const nodeIdAt = (clientX: number, clientY: number): string | null => {
    const el = document.elementFromPoint(clientX, clientY)
    const g = el?.closest?.('[data-nid]')
    return g?.getAttribute('data-nid') ?? null
  }

  /** 同上，但**穿透排除某个节点** —— 结构模式拖拽换父时，被拖的节点自己
   *  就悬在指针底下（松手点=目标中心），elementFromPoint 只会查到它自己。
   *  elementsFromPoint 从顶到底逐层找，跳过被拖节点才能拿到真正压在下面的目标。 */
  const nodeIdUnder = (clientX: number, clientY: number, exclude: string): string | null => {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const nid = el.closest?.('[data-nid]')?.getAttribute('data-nid') ?? null
      if (nid && nid !== exclude) return nid
    }
    return null
  }

  const endPointer = (e?: React.PointerEvent) => {
    if (linkFrom) {
      const to = e ? nodeIdAt(e.clientX, e.clientY) : null
      if (e && to && to !== linkFrom.id) {
        onLink?.(linkFrom.id, linkFrom.name, to, byId.get(to)?.name ?? to, {
          x: e.clientX,
          y: e.clientY,
        })
      }
      setLinkFrom(null)
      setLinkPt(null)
      return
    }
    panRef.current = null
    const id = dragRef.current
    if (id) {
      // 结构模式：松手时落在哪个节点上 = 挂到它下面（WPS 的拖拽换父）。
      // 被拖节点自己就悬在指针底下，必须穿透排除（nodeIdUnder），否则永远查到自己。
      // 防环（挂到自己后代下面）由外层的 reparent 把关，这里只管抛事件。
      if (oEdit && e) {
        const to = nodeIdUnder(e.clientX, e.clientY, id)
        if (to) oEdit.reparent(id, to)
      }
      const sn = simNodesRef.current.find((n) => n.id === id)
      if (sn) {
        sn.fx = null
        sn.fy = null
      }
      simRef.current?.alphaTarget(0)
    }
    dragRef.current = null
    setDropTarget(null)
    // 空白单击 → 取消选中（P11-2️⃣②）。
    // 按位移判：平移画布松手不算「点」，免得拖一下图就把选中丢了。
    const down = bgDownRef.current
    bgDownRef.current = null
    if (down && e && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) {
      onSelect?.(null)
    }
  }

  /** 双击空白：就地新建。附近有节点就继承它的类型，省得再选一次 */
  const onCanvasDouble = (e: React.MouseEvent) => {
    const el = e.target as Element
    if (el.closest?.('[data-nid]')) return
    // 浏览态：双击空白什么都不做（免得「就想放大看看」时手一抖建出个空实体）
    if (!editable) return
    if (!onCanvasEdit) return
    const g = toGraph(e.clientX, e.clientY)
    let near: GNode | null = null
    let best = NEAR_RADIUS / Math.max(0.3, t.k)
    for (const n of nodes) {
      const p = pos.get(n.id)
      if (!p) continue
      const d = Math.hypot(p.x - g.x, p.y - g.y)
      if (d < best) {
        best = d
        near = n
      }
    }
    onCanvasEdit({ x: e.clientX, y: e.clientY }, undefined, near?.type)
  }

  // ---- 高亮判定 ----
  const hl = highlight.trim().toLowerCase()
  const focusId = hover ?? selectedId ?? null

  const focusSet = useMemo(() => {
    if (!focusId) return null
    return new Set<string>([focusId, ...(adj.get(focusId) ?? [])])
  }, [focusId, adj])

  // 搜索命中的节点 + 它们的直接邻居，其余压暗
  const searchSet = useMemo(() => {
    if (!hl) return null
    const s = new Set<string>()
    for (const n of nodes) {
      if (n.name.toLowerCase().includes(hl)) {
        s.add(n.id)
        for (const nb of adj.get(n.id) ?? []) s.add(nb)
      }
    }
    return s
  }, [hl, nodes, adj])

  const dimSet = searchSet ?? focusSet

  /**
   * 括号式连线的**共用竖脊**：每个父节点算一根 x，它下面的所有子边都走这一根。
   *
   * 这是括号与折线的唯一区别 —— 折线每条边各自取中点，子节点一多就成了
   * 一把扇子，正是用户说的「堆在一起」；共用竖脊则合流成一棵树。
   *
   * 脊的位置取「最近的子节点距离的一半」，并夹在 24~240px 之间：
   * 太近会贴着父节点看不出括号，太远又会画到子节点外面去。
   */
  const bracketSpine = useMemo(() => {
    if ((edgeStyle?.curve ?? 'straight') !== 'bracket') return null
    const groups = new Map<string, number[]>()
    for (const e of edges) {
      const a = pos.get(e.source)
      const b = pos.get(e.target)
      if (!a || !b) continue
      const list = groups.get(e.source)
      if (list) list.push(b.x - a.x)
      else groups.set(e.source, [b.x - a.x])
    }
    const out = new Map<string, number>()
    for (const [id, dxs] of groups) {
      const a = pos.get(id)
      if (!a) continue
      const abs = dxs.map(Math.abs).filter((d) => d > 2)
      const base = abs.length ? Math.min(...abs) : 90
      const sign = dxs.reduce((s, d) => s + d, 0) >= 0 ? 1 : -1
      out.set(id, a.x + sign * Math.max(24, Math.min(240, base * 0.55)))
    }
    return out
  }, [edges, pos, edgeStyle?.curve])

  // 引导浮层讲完该讲的就让位：用户一旦真的动手（选中节点 / 进连线 / 就地改名），
  // 这块卡就该收起来 —— 它 z-index 6、迷你工具条 z-index 5，两者都在 .graph 左上角
  // 一带时**卡正好压住「＋子级」那一排**，点下去落空，看起来就是「按钮点了没反应」。
  useEffect(() => {
    if (guideSeen) return
    if (!selectedId && !renaming && !linkFrom) return
    markGraphGuideSeen()
    setGuideSeen(true)
  }, [guideSeen, selectedId, renaming, linkFrom])

  const posOf = (id: string): Pt => pos.get(id) ?? { x: 0, y: 0 }

  return (
    <div className="graph" ref={wrapRef}>
      <svg
        className="graph__svg"
        width={size.w}
        height={size.h}
        onPointerDown={onBgPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerLeave={endPointer}
        onDoubleClick={onCanvasDouble}
        style={{ cursor: linkFrom ? 'crosshair' : panRef.current ? 'grabbing' : 'grab' }}
      >
        <defs>
          <marker id="g2d-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border-strong)" />
          </marker>
          <marker id="g2d-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
          </marker>
          {/* 图片节点按圆裁切。用 objectBoundingBox 单位，一张定义给所有图片节点复用 —— 
              每个节点各建一个 clipPath 在几百个节点时会明显拖慢。 */}
          <clipPath id="g2d-imgclip" clipPathUnits="objectBoundingBox">
            <circle cx="0.5" cy="0.5" r="0.5" />
          </clipPath>
          {/* 网格背景：细线 + 粗线双层，缩小后细线糊成一片也还有骨架 */}
          <pattern id="g2d-grid" width="26" height="26" patternUnits="userSpaceOnUse">
            <path d="M 26 0 L 0 0 0 26" fill="none" stroke="var(--border-subtle)" strokeWidth="0.6" opacity="0.5" />
          </pattern>
        </defs>

        {background === 'solid' && (
          <rect x={0} y={0} width={size.w} height={size.h} fill="var(--panel-bg)" />
        )}
        {background === 'grid' && (
          // 网格画在**未变换**的坐标系里（不跟缩放走）—— 跟着缩放的话
          // 缩小时网格会密成一片灰，放大时又稀得看不见，反而干扰读图。
          <rect x={0} y={0} width={size.w} height={size.h} fill="url(#g2d-grid)" opacity={0.75} />
        )}
        {background === 'stars' && <StarField w={size.w} h={size.h} />}

        <g transform={`translate(${t.x},${t.y}) scale(${t.k})`}>
          {/* 连线 */}
          <g className="graph__edges">
            {edges.map((e, i) => {
              const a = posOf(e.source)
              const b = posOf(e.target)
              const na = byId.get(e.source)
              const nb = byId.get(e.target)
              const ra = na ? hitRadiusOf(na) + 2 : 8
              const rb = nb ? hitRadiusOf(nb) + 6 : 8
              const dx = b.x - a.x
              const dy = b.y - a.y
              const len = Math.hypot(dx, dy) || 1
              const ux = dx / len
              const uy = dy / len
              const x1 = a.x + ux * ra
              const y1 = a.y + uy * ra
              const x2 = b.x - ux * rb
              const y2 = b.y - uy * rb
              const hot = focusSet != null && focusSet.has(e.source) && focusSet.has(e.target)
              const dim = focusSet != null && !hot
              const curve = edgeStyle?.curve ?? 'straight'
              // 层级边（结构模式的「包含」、分组骨架的「分组」）必须带箭头 ——
              // 上下级方向是它的语义，样式包再怎么配也不许把方向藏掉
              const hierarchyEdge = e.kind === '包含' || e.kind === '分组'
              const withArrow = hierarchyEdge || edgeStyle?.arrow !== false
              return (
                <path
                  key={i}
                  d={edgePath(x1, y1, x2, y2, curve, bracketSpine?.get(e.source))}
                  className={`graph__edge ${hot ? 'graph__edge--hot' : ''}`}
                  style={{
                    opacity: dim ? 0.12 : hot ? 0.95 : 0.42,
                    strokeWidth: (edgeStyle?.width ?? 1) * 1.2,
                    strokeDasharray: hot ? undefined : dashOf(edgeStyle),
                  }}
                  markerEnd={withArrow ? (hot ? 'url(#g2d-arrow-hot)' : 'url(#g2d-arrow)') : undefined}
                />
              )
            })}
          </g>

          {/* 连线草稿：从起点一路跟到指针 */}
          {linkFrom && linkPt && (
            <line
              className="graph__linkdraft"
              x1={linkFrom.x}
              y1={linkFrom.y}
              x2={linkPt.x}
              y2={linkPt.y}
            />
          )}

          {/* 节点 */}
          {/* 力导向布局的坐标每帧都在变，加过渡只会拖着影子跑；
              静态布局（树/放射/鱼骨…）重排时给个 180ms 的滑动，
              加子级/换父就是「节点们滑到新家」而不是「闪一下换了一幅画」。
              拖拽中的那一个节点要即时跟手，见下面 graph__node--snap。 */}
          <g className={`graph__nodes ${layout !== 'force' ? 'graph__nodes--anim' : ''}`}>
            {nodes.map((n) => {
              const p = posOf(n.id)
              const r = radiusOf(n)
              const st = resolved.get(n.id)
              const dim = dimSet ? !dimSet.has(n.id) : false
              const isSel = selectedId === n.id
              const hit = hl ? n.name.toLowerCase().includes(hl) : false
              // 没有样式解析时保持老行为：按类型上色、圆形
              const shape = st?.shape ?? 'auto'
              const geom = shapeGeom(shape, r)
              const fill = st ? st.fill : n.unresolved ? 'transparent' : nodeColor(n)
              const stroke = st?.stroke || (n.unresolved ? 'var(--text-faint)' : 'var(--bg-app)')
              const imgUrl = shape === 'image' && st?.image ? assetUrlOf(st.image) : ''
              const labelOn = st ? st.label : showLabels
              const wantHighlight = st?.highlight ?? false
              return (
                <g
                  key={n.id}
                  data-nid={n.id}
                  className={dragRef.current === n.id ? 'graph__node--snap' : undefined}
                  transform={`translate(${p.x},${p.y})`}
                  style={{
                    cursor:
                      editable && linkMode && !n.unresolved
                        ? 'crosshair'
                        : editable && !n.unresolved
                          ? 'move' /* 编辑态：告诉人「这是可以拖的」 */
                          : 'pointer',
                    opacity: dim ? 0.22 : 1,
                  }}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    // 连线模式：按下即起线，松手落到哪个节点就连哪个。
                    // 这里刻意不 setPointerCapture —— 收尾要靠 elementFromPoint
                    // 反查落点，被 capture 之后 pointerenter 不再跨元素触发。
                    if (editable && linkMode && !n.unresolved) {
                      setLinkFrom({ id: n.id, name: n.name, x: p.x, y: p.y })
                      setLinkPt({ x: p.x, y: p.y })
                      return
                    }
                    ;(e.target as Element).setPointerCapture?.(e.pointerId)
                    // 浏览态不允许拖动改位置 —— 但按下去仍然「选得中」
                    if (editable) dragRef.current = n.id
                  }}
                  onPointerEnter={() => setHover(n.id)}
                  onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (n.unresolved) onUnresolvedClick?.(n.name)
                    else onSelect?.(n.id)
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    if (n.unresolved) return
                    // 双击 = 就地编辑；Alt+双击 = 设为布局的根（老习惯留在 Alt 上）。
                    // Alt+双击是**视图操作**，浏览态也留着 —— 只想看图的人也常要换根。
                    if (e.altKey) onPickRoot?.(n.id)
                    // 结构模式：自由节点双击进就地改名；实体节点照旧开档案浮层
                    else if (oEdit && oEdit.isVirtual(n.id)) startRename(n.id)
                    else if (editable) onNodeEdit?.(n.id, n.name, { x: e.clientX, y: e.clientY }, n.type)
                  }}
                >
                  {wantHighlight && !n.unresolved && (
                    // 高亮：外面套一层同色描边环。用形状本体放大一圈而不是画个圆 ——
                    // 方节点套个圆环看起来像放歪了。
                    <ShapeEl
                      geom={shapeGeom(shape, r + 4)}
                      className="graph__halo"
                      halo="style"
                      style={{ stroke: fill, opacity: 0.55 }}
                    />
                  )}
                  {(isSel || hit || dropTarget === n.id) && (
                    <ShapeEl
                      geom={shapeGeom(shape, r + 6)}
                      className="graph__halo"
                      halo={dropTarget === n.id ? 'drop' : hit ? 'hit' : 'sel'}
                      style={{
                        stroke: dropTarget === n.id ? 'var(--accent)' : hit ? 'var(--warn)' : 'var(--accent)',
                        opacity: dropTarget === n.id ? 0.9 : undefined,
                      }}
                    />
                  )}
                  {/* 悬停反馈（P11-2️⃣①）：一圈更细的灰环。
                      以前悬停只压暗邻居、节点本身毫无变化，用户不知道「这东西能点」；
                      现在一眼能看出鼠标底下有个可交互的对象，且不抢选中态的风头。 */}
                  {hover === n.id && !isSel && !hit && !n.unresolved && (
                    <ShapeEl
                      geom={shapeGeom(shape, r + 3)}
                      className="graph__hoverring"
                    />
                  )}
                  {imgUrl ? (
                    <>
                      <ShapeEl geom={shapeGeom('circle', r)} style={{ fill: withAlpha('#000000', 0) }} />
                      <image
                        href={imgUrl}
                        x={-r}
                        y={-r}
                        width={r * 2}
                        height={r * 2}
                        preserveAspectRatio="xMidYMid meet"
                        clipPath="url(#g2d-imgclip)"
                        style={{ pointerEvents: 'none' }}
                      />
                    </>
                  ) : (
                    <ShapeEl
                      geom={geom}
                      className={`graph__node ${n.unresolved ? 'graph__node--ghost' : ''}`}
                      style={{ fill, stroke, strokeWidth: wantHighlight ? 2.2 : undefined }}
                    />
                  )}
                  {labelOn && t.k > 0.55 && (
                    <text
                      className="graph__label"
                      y={geom.kind === 'rect' ? geom.h / 2 + 12 : r + 12}
                      textAnchor="middle"
                      style={{ fontSize: `${(11 * labelScale).toFixed(1)}px` }}
                    >
                      {shortName(n.name, t.k > 1 ? 10 : 5)}
                    </text>
                  )}
                  {/* 描述：导入大纲时被判为「说明」的那些文本。画在名字下面一行，
                      字号更小、颜色更淡 —— 一眼分得清「这是节点」还是「这是它的注脚」。
                      多条描述换行拼在一起，这里只露头一行，全文在悬停提示里。 */}
                  {(() => {
                    const note = (noteOf?.(n.id) ?? '').replace(/\s+/g, ' ').trim()
                    if (!note || !labelOn || t.k <= 0.55) return null
                    const baseY = geom.kind === 'rect' ? geom.h / 2 + 12 : r + 12
                    return (
                      <text
                        className="graph__note"
                        y={baseY + 13}
                        textAnchor="middle"
                        style={{ fontSize: `${(9.5 * labelScale).toFixed(1)}px` }}
                      >
                        <title>{noteOf?.(n.id)}</title>
                        {shortName(note, t.k > 1 ? 16 : 8)}
                      </text>
                    )
                  })()}
                </g>
              )
            })}
          </g>
        </g>
      </svg>

      {children}

      {/* 结构模式：选中节点的迷你工具条。屏幕坐标 = 世界坐标 × k + 平移，
          与贴纸层同一个换算原点（.graph 左上角），缩放窗口也不漂。 */}
      {oEdit && selectedId && !renaming && pos.has(selectedId) && (() => {
        const p = pos.get(selectedId)!
        const isRoot = !oEdit.parentIdOf(selectedId)
        const isVirt = oEdit.isVirtual(selectedId)
        return (
          <div
            className="graph__outline-bar"
            style={{ left: p.x * t.k + t.x, top: p.y * t.k + t.y }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button title="加一个子级节点（Tab）" onClick={() => oEdit.addChild(selectedId)}>
              ＋子级
            </button>
            <button
              title="在它旁边加一个同级节点（Enter）"
              disabled={isRoot}
              onClick={() => oEdit.addSibling(selectedId)}
            >
              ＋同级
            </button>
            {isVirt && (
              <button title="就地改名（F2 / 双击节点）" onClick={() => startRename(selectedId)}>
                改名
              </button>
            )}
            {!isRoot && (
              <button
                title={isVirt ? '删除这个自由节点（不影响实体）' : '从结构摘下，实体档案一个字不动'}
                onClick={() => oEdit.remove(selectedId)}
              >
                {isVirt ? '删除' : '摘下'}
              </button>
            )}
          </div>
        )
      })()}

      {/* 结构还没开但这个视图能开：别让人选中节点后对着一片空白发愣 ——
          地理观/关系网一开始就是这样，看着像「加子级是坏的」，
          其实只差一个开关。给他一个一键到位的按钮。 */}
      {!oEdit && outlineAvailable && selectedId && editable && !renaming && pos.has(selectedId) && (() => {
        const p = pos.get(selectedId)!
        return (
          <div
            className="graph__outline-bar"
            style={{ left: p.x * t.k + t.x, top: p.y * t.k + t.y }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              title="开了它，才能在图上加子级/同级、拖拽换父（结构只记摆法，不动档案）"
              onClick={() => onEnableOutline?.()}
            >
              ✨ 开启自由结构
            </button>
          </div>
        )
      })()}

      {/* 结构模式：就地改名。Enter 认账，Esc 反悔，点别处当没改过 */}
      {renaming &&
        (() => {
          const p = pos.get(renaming.id)
          if (!p) return null
          return (
            <input
              className="graph__outline-rename"
              style={{ left: p.x * t.k + t.x, top: p.y * t.k + t.y }}
              value={renaming.value}
              autoFocus
              placeholder="节点名字，回车确认"
              onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  oEdit?.rename(renaming.id, renaming.value.trim() || '新节点')
                  setRenaming(null)
                } else if (e.key === 'Escape') {
                  setRenaming(null)
                }
              }}
              onBlur={() => {
                // 点别处 = 认账（WPS 的手感）。Esc 才是反悔 —— 不然手一抖点空处，
                // 刚打的字就全没了，比「不想改却提交了」恼火得多。
                oEdit?.rename(renaming.id, renaming.value.trim() || '新节点')
                setRenaming(null)
              }}
            />
          )
        })()}

      <div className="graph__toolbar">
        {/* 编辑开关（P11-2️⃣①）：以前编辑是**隐形常开**的，用户压根不知道能改。
            摆一个明面上的两态开关，配上下面那行说明，功能才算真的「存在」。 */}
        {onToggleEditable && (
          <span className="graph__seg" role="group" aria-label="图上编辑开关">
            <button
              className={`graph__seg-btn ${!editable ? 'graph__seg-btn--on' : ''}`}
              onClick={() => onToggleEditable(false)}
              title="只平移缩放、单击选中；不会误改到任何东西"
            >
              浏览
            </button>
            <button
              className={`graph__seg-btn ${editable ? 'graph__seg-btn--on' : ''}`}
              onClick={() => onToggleEditable(true)}
              title="拖动节点改位置、双击改名或新建、拖到另一个节点建立关联"
            >
              编辑
            </button>
          </span>
        )}
        <button className="btn btn--sm" onClick={() => fitTo(pos)} title="把整张图收进视野">
          适应窗口
        </button>
        <button
          className="btn btn--sm"
          onClick={() => {
            userMovedRef.current = false
            setT((p) => ({ ...p, k: Math.min(3, p.k * 1.2) }))
          }}
        >
          放大
        </button>
        <button
          className="btn btn--sm"
          onClick={() => setT((p) => ({ ...p, k: Math.max(0.2, p.k / 1.2) }))}
        >
          缩小
        </button>
        {/* 浏览态下「连线模式」是个死按钮（起点已被 editable 拦住），干脆藏掉 */}
        {onToggleLinkMode && editable && (
          <button
            className={`btn btn--sm ${linkMode ? 'btn--on' : ''}`}
            onClick={() => {
              setLinkFrom(null)
              setLinkPt(null)
              onToggleLinkMode()
            }}
            title="开启后，从一个节点拖到另一个节点即可建立关联"
          >
            连线模式
          </button>
        )}
        <span className="graph__hint faint fs-xs">
          {editable
            ? oEdit
              ? 'Tab=子级 · Enter=同级 · 拖到节点上=挂它下面 · 双击自由节点改名 · Delete=摘下'
              : '双击节点改它 · 双击空白新建 · 拖到另一个节点连线 · Alt+双击设为根'
            : '浏览态：滚轮缩放 · 空白拖动平移 · 单击选中（想改就切到「编辑」）'}
        </span>
      </div>

      {linkMode && (
        <div className="graph__mode-tip">连线模式：从一个节点拖到另一个节点 · 再点一次按钮可退出</div>
      )}

      {/* 头一次打开带图的视图时弹一次（P11-2️⃣①）。看过的就不再有 —— 
          这种浮层每天弹一遍比不弹更烦人。 */}
      {editable && !guideSeen && (
        <GraphEditGuide onDismiss={() => setGuideSeen(true)} onBrowseOnly={() => onToggleEditable?.(false)} />
      )}
    </div>
  )
}
