/** 3D 图谱（P4 + 视觉升级）：3d-force-graph 封装。
 *
 * 四条设计红线：
 * 1. **坐标锁定** —— 3D 力导向每次从零模拟节点会乱飞，所以模拟稳定后
 *    把 fx/fy/fz 锁进 scene.json（装饰层），下次打开原样摆回。
 * 2. **颜色必须取计算色** —— WebGL 不认 CSS 变量，得用
 *    getComputedStyle 把 `var(--type-*)` 解析成真实色值。
 * 3. **形状/图标是装饰，不是内容** —— 实体自带的 icon 属内容（写在 frontmatter），
 *    「按类型统一换图标」属装饰（存 view/scene.json），两者物理隔离。
 * 4. **纹理要回收** —— 每个节点都会新建 canvas 纹理与几何体，
 *    整图重建时必须统一 dispose，否则拖几次内存就上去了。
 */

import { useEffect, useRef } from 'react'
import ForceGraph3D, { type ForceGraph3DInstance, type NodeObject, type LinkObject } from '3d-force-graph'
import * as THREE from 'three'
import { forceCollide, forceLink, forceManyBody, forceX, forceY, forceZ } from 'd3-force-3d'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import * as api from '../api/client'
import { nodeRadius, type GEdge, type GNode } from './types'
import { useShortcutScope, useShortcuts } from '../lib/shortcuts'

/** 图节点 = 业务节点 + 力模拟坐标（x/y/z 模拟位，fx/fy/fz 锁定钉住位） */
type FGNode = GNode & NodeObject
type FGLink = LinkObject<FGNode>

interface Props {
  bookId: string
  /** scene.json 里这本图的分区键（relation / world / geo…） */
  sceneKey: string
  nodes: GNode[]
  edges: GEdge[]
  selectedId?: string | null
  /** 选中某个节点；**传 null = 点了背景，取消选中**（P11-2️⃣②） */
  onSelect?: (id: string | null) => void
  showLabels?: boolean
  /** 主题/明暗切换时变化，强制重取计算色 */
  themeKey?: string
  /** 类型 → 图标（素材相对路径 `icons/x.png` 或完整 URL）。装饰层映射。 */
  typeIcons?: Record<string, string>
  /**
   * 样式包投影（P5）—— 只给**颜色与大小**。
   *
   * 为什么不接形状：三维的形状本来就承担「哪类东西」的语义（势力方块、地点柱），
   * 二维的形状是纯装饰。把包级「全部圆形」照搬过来会把这个能力抹平。
   *
   * 颜色必须是**具体色值**：`var()` 在 WebGL 里不生效。调用方负责解析。
   */
  nodeStyle?: (n: GNode) => { color: string; scale: number }
  /** 辉光后处理。低配机器可关。 */
  glow?: boolean
  /** 疏密。默认力参数下 400 个节点会挤成一坨 —— 这里按档位放大斥力与连线长度。 */
  spacing?: Spacing
  /**
   * 重排令牌。自增即表示「作废旧坐标、重新模拟一次」。
   * 光清后端坐标不够：组件的 effect 不会因为后端文件变了而重跑。
   */
  layoutToken?: number
  /** 按类型分簇（世界观全景用）：给每个类型一个球面锚点，弱力拉过去。 */
  clusterByType?: boolean

  // ---- 就地编辑（P4.3）----
  /** 就地编辑开关（P11-2️⃣①）。默认开；关掉 = 纯浏览（不能拖、不能双击改/新建） */
  editable?: boolean
  /** 工具条上「浏览 / 编辑」的切换。不传就不显示该控件 */
  onToggleEditable?: (next: boolean) => void
  /** 连线模式：拖节点 = 连线，而不是挪位置 */
  linkMode?: boolean
  /** 双击（或右键）节点：就地改名称/类型/标签/摘要 */
  onNodeEdit?: (id: string, name: string, screen: { x: number; y: number }, nearType?: string) => void
  /** 双击（或右键）空白：就地新建。world 是落点，会写进 scene.json 的装饰层 */
  onCanvasEdit?: (
    screen: { x: number; y: number },
    world?: { x: number; y: number; z: number },
    nearType?: string,
  ) => void
  /** 从一个节点拖到另一个节点：建立关联 */
  onLink?: (
    fromId: string,
    fromName: string,
    toId: string,
    toName: string,
    screen: { x: number; y: number },
  ) => void
  /**
   * 用户手动拖完一个节点（**钉住之前**报出来）。
   *
   * `from` = 上次存进 scene.json 的坐标（没有则为 null）。给撤销栈用：
   * 撤销 = 把这个节点放回 `from`。**不传就完全不记录**，默认行为一个字不变。
   *
   * 为什么在拖拽结束时报、而不是在「模拟停了自动存档」时报：后者在**首次布局
   * 定型**时也会跑一次，那不是用户动作，记进去就成了「什么都没干却能撤销一步」。
   */
  onNodeDropped?: (
    id: string,
    to: { x: number; y: number; z: number },
    from: { x: number; y: number; z: number } | null,
  ) => void
  /** 浮层里的「连线模式」开关（状态由外层持有，连完自动复位） */
  onToggleLinkMode?: () => void
}

export type Spacing = 'compact' | 'normal' | 'loose'

/** 三档疏密的力参数倍率：斥力、连线长度、碰撞半径余量 */
const SPACING: Record<Spacing, { charge: number; link: number; gap: number }> = {
  compact: { charge: 0.55, link: 0.7, gap: 2 },
  normal: { charge: 1, link: 1, gap: 6 },
  loose: { charge: 2.1, link: 1.45, gap: 14 },
}

// --------------------------------------------------------------------------
// 小工具
// --------------------------------------------------------------------------

/** 素材相对路径 → 可访问 URL。实现放在 api 层，这里只做转发，避免两处各写一份 */
const assetUrl = api.assetUrlOf

/** 图标纹理缓存 —— 同一个图标挂在几十个节点上时只解一次码 */
const ICON_CACHE = new Map<string, THREE.Texture>()

function loadIconTexture(url: string): THREE.Texture {
  const hit = ICON_CACHE.get(url)
  if (hit) return hit
  const tex = new THREE.TextureLoader().load(url)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearFilter
  ICON_CACHE.set(url, tex)
  return tex
}

/** 把 CSS 变量解析成 WebGL 能用的色值（var() 在 canvas/three 里不生效） */
function cssColor(varName: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return v || fallback
}

function resolveColor(node: GNode): string {
  if (node.color) return node.color
  if (node.unresolved) return cssColor('--text-faint', '#6b7280')
  return cssColor(`--type-${node.type}`, cssColor('--text-muted', '#9ca3af'))
}

/** 形状按「这类东西长什么样」分配 —— 一眼能分辨人物/地点/势力/物品 */
function geometryFor(type: string, r: number): THREE.BufferGeometry {
  switch (type) {
    case 'faction':
    case 'organization':
      return new THREE.BoxGeometry(r * 1.7, r * 1.7, r * 1.7)
    case 'location':
      return new THREE.CylinderGeometry(r * 0.98, r * 0.98, r * 1.9, 6)
    case 'item':
      return new THREE.OctahedronGeometry(r * 1.32)
    case 'realm':
      return new THREE.TorusGeometry(r * 0.85, r * 0.33, 12, 28)
    case 'methodology':
      return new THREE.CapsuleGeometry(r * 0.8, r * 1.3, 8, 18)
    default:
      return new THREE.SphereGeometry(r, 32, 24)
  }
}

const FONT_STACK = '"Noto Sans SC", system-ui, -apple-system, sans-serif'

/** 文字精灵。字号给足 + 圆角底衬 —— 之前 40px 无底衬，远了糊、压在亮节点上看不清。 */
function makeLabel(text: string, color: string, worldHeight: number): THREE.Sprite {
  const font = 56
  const padX = 18
  const padY = 12
  const probe = document.createElement('canvas').getContext('2d')!
  probe.font = `600 ${font}px ${FONT_STACK}`
  const width = Math.ceil(probe.measureText(text).width) + padX * 2

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = font + padY * 2
  const ctx = canvas.getContext('2d')!
  const h = canvas.height

  // 圆角底衬
  const rr = h / 2
  ctx.fillStyle = 'rgba(10,12,18,0.42)'
  ctx.beginPath()
  ctx.moveTo(rr, 0)
  ctx.arcTo(width, 0, width, h, rr)
  ctx.arcTo(width, h, 0, h, rr)
  ctx.arcTo(0, h, 0, 0, rr)
  ctx.arcTo(0, 0, width, 0, rr)
  ctx.closePath()
  ctx.fill()

  ctx.font = `600 ${font}px ${FONT_STACK}`
  ctx.fillStyle = color
  ctx.textBaseline = 'middle'
  ctx.fillText(text, padX, h / 2 + 2)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }),
  )
  const scale = worldHeight / h
  sprite.scale.set(width * scale, h * scale, 1)
  return sprite
}

/** 选中光圈：环状光晕纹理，靠缩放做呼吸感 */
function makeRingTexture(color: string): THREE.CanvasTexture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.3, size / 2, size / 2, size * 0.48)
  grad.addColorStop(0, 'rgba(255,255,255,0)')
  grad.addColorStop(0.55, color)
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size * 0.48, 0, Math.PI * 2)
  ctx.fill()
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** 图标底衬光晕：png 图标多半带不透明底，垫一层同色光晕才融得进场景 */
function makeHaloTexture(color: string): THREE.CanvasTexture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, color)
  grad.addColorStop(0.5, color)
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.globalAlpha = 0.3
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
  ctx.fill()
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** 一个节点在场景里的全部对象与可调参数 */
interface NodeVisual {
  group: THREE.Group
  /** 主体（球/方/图标精灵），亮度随 hover 变化 */
  core: THREE.Object3D
  /** 主体材质（Mash 或 Sprite 都有 opacity） */
  materials: (THREE.Material & { opacity: number })[]
  label?: THREE.Sprite
  ring?: THREE.Sprite
  /** 光圈基准直径，脉冲时按它缩放 */
  ringBase: number
  baseOpacity: number
}

export function Graph3D({
  bookId, sceneKey, nodes, edges, selectedId, onSelect, showLabels = true, themeKey = '',
  typeIcons = {}, glow = true, spacing = 'normal', layoutToken = 0, clusterByType = false,
  nodeStyle, linkMode = false, editable = true, onToggleEditable,
  onNodeEdit, onCanvasEdit, onLink, onToggleLinkMode, onNodeDropped,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<ForceGraph3DInstance<FGNode> | null>(null)
  const lockedRef = useRef(false)
  const selectedRef = useRef<string | null | undefined>(selectedId)
  selectedRef.current = selectedId

  // 事件回调放 ref 里：上面的建图 effect 依赖很长，不该为了一个回调重跑
  // （重跑 = 重新模拟 = 节点乱飞）。事件触发时再取最新的一份。
  // Esc 取消选中（P11-A2 的第一个用户；P11-2️⃣②）
  useShortcutScope('graph')
  useShortcuts(
    [{ id: 'graph3d.esc', keys: 'Esc', scope: 'graph', desc: '取消选中的节点', run: () => onSelect?.(null) }],
    [onSelect],
  )

  const cbRef = useRef({ linkMode, editable, onNodeEdit, onCanvasEdit, onLink, onSelect, onToggleLinkMode, onNodeDropped })
  cbRef.current = { linkMode, editable, onNodeEdit, onCanvasEdit, onLink, onSelect, onToggleLinkMode, onNodeDropped }
  /** 最近一次**存进 scene.json** 的坐标。拖动结束时报「从哪儿来的」就靠它。 */
  const savedPosRef = useRef<Record<string, { x: number; y: number; z: number }>>({})
  // 上次的布局参数：变了就不能沿用旧坐标，否则新力参数等于没设
  const lastLayoutRef = useRef<string>(`${spacing}|${layoutToken}`)
  const layoutChanged = lastLayoutRef.current !== `${spacing}|${layoutToken}`

  useEffect(() => {
    const host = hostRef.current
    if (!host || nodes.length === 0) return
    let disposed = false

    const labelColor = cssColor('--text-secondary', '#d6deeb')
    const linkColor = cssColor('--border-default', 'rgba(128,128,128,0.4)')
    const bgColor = cssColor('--bg-app', '#0b0e14')

    // hover 状态：null = 没悬停任何节点
    let hoveredId: string | null = null
    let spot: Set<string> | null = null

    // 构造器声明用的是默认 NodeObject 泛型，这里断言成带业务字段的构造签名
    type GraphCtor = new (el: HTMLElement) => ForceGraph3DInstance<FGNode>
    const graph = new (ForceGraph3D as unknown as GraphCtor)(host)

    // 每个节点的可回收资源都登记在册，销毁时统一 dispose
    const disposables: { dispose(): void }[] = []
    const visuals = new Map<string, NodeVisual>()

    // 邻接表：hover 时用来点亮一跳邻居
    const adj = new Map<string, Set<string>>()
    for (const e of edges) {
      if (!adj.has(e.source)) adj.set(e.source, new Set())
      if (!adj.has(e.target)) adj.set(e.target, new Set())
      adj.get(e.source)!.add(e.target)
      adj.get(e.target)!.add(e.source)
    }

    // ---- 连线：轻微弧度 + 箭头，方向看得出来 ----
    const linkColorAccessor = (l: FGLink) => {
      if (!spot) return linkColor
      const src = typeof l.source === 'object' ? String((l.source as FGNode).id) : String(l.source)
      return spot.has(src) ? linkColor : 'rgba(128,128,128,0.10)'
    }

    // ---- 布局力：默认斥力太小，几百个节点必然叠在一起；但也不能放太开 ——
    // 视口是固定的（zoomToFit 会把整个分布塞进来），所以分布半径决定节点在
    // 屏幕上的大小。目标：标准档把 400 节点撑到半径 ~650（平均间距 3~5 个
    // 节点直径，不叠也不至于节点缩成芝麻），宽松档翻倍，紧凑档收紧。
    const sp = SPACING[spacing]
    const charge = (graph.d3Force('charge') as { strength(v: unknown): unknown } | undefined)
      ?? forceManyBody()
    charge.strength((n: FGNode) => -(8 + nodeRadius(n) * 2.8) * sp.charge)
    graph.d3Force('charge', charge as never)

    const link = (graph.d3Force('link') as { distance(v: unknown): unknown } | undefined)
      ?? forceLink()
    link.distance((l: FGLink) => {
      const a = l.source as FGNode
      const b = l.target as FGNode
      const avg = ((a ? nodeRadius(a) : 8) + (b ? nodeRadius(b) : 8)) / 2
      return (26 + avg * 2.6) * sp.link
    })
    graph.d3Force('link', link as never)

    // 碰撞力：保证节点之间至少留出「半径 + 余量」的空隙，这是防叠的关键一层
    graph.d3Force(
      'collide',
      forceCollide<FGNode>((n) => nodeRadius(n) * 1.2 + sp.gap).iterations(2),
    )
    graph.d3AlphaDecay(0.022).d3VelocityDecay(0.34)

    // 按类型分簇：球面上给每个类型一个锚点，弱力牵引 → 自动分成几团
    if (clusterByType) {
      const typeList = [...new Set(nodes.map((n) => n.type))]
      const anchors = new Map<string, { x: number; y: number; z: number }>()
      const R = 780
      typeList.forEach((t, i) => {
        // 黄金螺旋分布在球面上，类型之间不会挤在一边
        const phi = Math.acos(1 - (2 * (i + 0.5)) / typeList.length)
        const theta = Math.PI * (1 + Math.sqrt(5)) * i
        anchors.set(t, {
          x: R * Math.sin(phi) * Math.cos(theta),
          y: R * Math.sin(phi) * Math.sin(theta),
          z: R * Math.cos(phi),
        })
      })
      const at = (n: FGNode) => anchors.get(n.type) ?? { x: 0, y: 0, z: 0 }
      const pull = 0.16
      graph.d3Force('clusterX', forceX<FGNode>((n) => at(n).x).strength(pull))
      graph.d3Force('clusterY', forceY<FGNode>((n) => at(n).y).strength(pull))
      graph.d3Force('clusterZ', forceZ<FGNode>((n) => at(n).z).strength(pull))
    }

    // ------------------------------------------------------------------
    // 就地编辑（P4.3）：3D 里相机是斜的、节点还在被模拟挪动，所以
    // ①「双击」不能用 DOM 事件，得按时间窗自判；
    // ②「拖到哪个节点上」不能用 elementFromPoint，得射线反查。
    // ------------------------------------------------------------------
    let lastPt = { x: 0, y: 0 }
    const trackPointer = (e: PointerEvent) => {
      lastPt = { x: e.clientX, y: e.clientY }
    }
    // 捕获阶段挂，拖拽时事件会被画布自己 capture，冒泡阶段可能收不到
    host.addEventListener('pointermove', trackPointer, true)
    host.addEventListener('pointerdown', trackPointer, true)

    let lastClick = { key: '', t: 0 }
    /** 同一个目标 360ms 内点第二下算双击 */
    const isDouble = (key: string) => {
      const now = Date.now()
      const hit = lastClick.key === key && now - lastClick.t < 360
      lastClick = { key: hit ? '' : key, t: hit ? 0 : now }
      return hit
    }

    /** 屏幕点落在哪个节点上。射线打到的是 three 对象，
     *  沿 parent 往上找挂着 `__data` 的那个就是节点本体。 */
    function nodeAtScreen(cx: number, cy: number): FGNode | null {
      const rect = host!.getBoundingClientRect()
      if (!rect.width || !rect.height) return null
      try {
        const cam = graph.camera() as unknown as THREE.Camera
        const ndc = new THREE.Vector2(
          ((cx - rect.left) / rect.width) * 2 - 1,
          -((cy - rect.top) / rect.height) * 2 + 1,
        )
        const ray = new THREE.Raycaster()
        ray.setFromCamera(ndc, cam)
        for (const hit of ray.intersectObjects(graph.scene().children, true)) {
          let o: THREE.Object3D | null = hit.object
          while (o) {
            const d = (o as unknown as { __data?: FGNode }).__data
            if (d && typeof d.id === 'string') return d
            o = o.parent
          }
        }
      } catch {
        /* 射线失败就当点空了，不影响别的 */
      }
      return null
    }

    /** 空白处的落点：沿「穿过原点、正对相机」的那条视线取交点，
     *  新节点于是出现在你正看着的位置，而不是贴在镜头脸上。 */
    function worldAt(cx: number, cy: number) {
      const rect = host!.getBoundingClientRect()
      const cam = graph.cameraPosition()
      const dist = Math.hypot(cam.x, cam.y, cam.z) || 600
      const p = graph.screen2GraphCoords(cx - rect.left, cy - rect.top, dist)
      return { x: p.x, y: p.y, z: p.z }
    }

    /** 空白处新建：顺带看一眼最近的节点是什么类型，让「类型」预选上 */
    function blankEdit(cx: number, cy: number) {
      const world = worldAt(cx, cy)
      let near: FGNode | null = null
      let best = 320
      for (const n of graph.graphData().nodes) {
        if (n.x == null) continue
        const d = Math.hypot(n.x - world.x, (n.y ?? 0) - world.y, (n.z ?? 0) - world.z)
        if (d < best) {
          best = d
          near = n
        }
      }
      cbRef.current.onCanvasEdit?.({ x: cx, y: cy }, world, near?.type)
    }

    // 右键：节点上 → 改这一条；空白 → 新建。顺便把系统菜单按掉。
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      if (!cbRef.current.editable || cbRef.current.linkMode) return
      const n = nodeAtScreen(e.clientX, e.clientY)
      if (n) {
        if (!n.unresolved) {
          cbRef.current.onNodeEdit?.(String(n.id), n.name, { x: e.clientX, y: e.clientY }, n.type)
        }
      } else {
        blankEdit(e.clientX, e.clientY)
      }
    }
    host.addEventListener('contextmenu', onContextMenu)

    // 连线拖拽的起点（连同原始坐标，松手时要放回去）
    let linkFrom: {
      id: string
      name: string
      x: number
      y: number
      z: number
      fx?: number | null
      fy?: number | null
      fz?: number | null
    } | null = null

    graph
      .backgroundColor(bgColor)
      .nodeOpacity(1)
      .nodeLabel((n) => `${n.name}${n.unresolved ? '（未录入）' : ''} · ${n.type}`)
      .linkColor(linkColorAccessor)
      .linkOpacity(0.36)
      .linkWidth(0.5)
      .linkCurvature(0.08)
      .linkDirectionalArrowLength(3.2)
      .linkDirectionalArrowRelPos(1)
      .linkDirectionalArrowColor(() => linkColor)
      .onNodeClick((n, event) => {
        if (cbRef.current.linkMode) return // 连线模式单击不选中，免得起线时镜头乱飞
        const id = String(n.id)
        if (isDouble(id)) {
          // 浏览态：双击不就地改（单击选中仍然好使）
          if (!n.unresolved && cbRef.current.editable) {
            cbRef.current.onNodeEdit?.(id, n.name, { x: event.clientX, y: event.clientY }, n.type)
          }
          return
        }
        if (!n.unresolved) cbRef.current.onSelect?.(id)
      })
      .onBackgroundClick((event) => {
        if (cbRef.current.linkMode) return
        // 单击背景 = 取消选中；双击背景 = 就地新建（P11-2️⃣②）。
        // isDouble 有状态（它自己会翻 lastClick），所以两个分支都必须走它一次。
        if (isDouble('::bg') && cbRef.current.editable) blankEdit(event.clientX, event.clientY)
        else cbRef.current.onSelect?.(null)
      })
      .onNodeDrag((n) => {
        if (!cbRef.current.linkMode || linkFrom) return
        linkFrom = {
          id: String(n.id),
          name: n.name,
          x: n.x ?? 0,
          y: n.y ?? 0,
          z: n.z ?? 0,
          fx: n.fx,
          fy: n.fy,
          fz: n.fz,
        }
      })
      .onNodeDragEnd((n) => {
        const from = linkFrom
        linkFrom = null
        if (!from) {
          // 普通拖拽：就地钉住，用户的手动调整不该被模拟冲掉。
          // 浏览态不钉 —— 省得「只看了看」却在数据目录里留下坐标。
          if (!cbRef.current.editable) return
          n.fx = n.x
          n.fy = n.y
          n.fz = n.z
          // 报给撤销栈：撤销 = 把这个节点放回拖之前那个坐标。
          // `from` 取**上次存进 scene.json 的值**，不是拖动过程中的中间值 ——
          // 中间值每次 pointermove 都在变，拿它当起点等于撤销到一半。
          const nid = String(n.id)
          cbRef.current.onNodeDropped?.(
            nid,
            { x: n.x ?? 0, y: n.y ?? 0, z: n.z ?? 0 },
            savedPosRef.current[nid] ?? null,
          )
          return
        }
        // 连线模式下拖拽只是「手势」：把起点放回原处，免得顺手挪了位置
        const src = graph.graphData().nodes.find((x) => String(x.id) === from.id)
        if (src) {
          src.x = from.x
          src.y = from.y
          src.z = from.z
          src.fx = from.fx ?? undefined
          src.fy = from.fy ?? undefined
          src.fz = from.fz ?? undefined
        }
        const to = nodeAtScreen(lastPt.x, lastPt.y)
        if (to && String(to.id) !== from.id && !to.unresolved) {
          cbRef.current.onLink?.(from.id, from.name, String(to.id), to.name, {
            x: lastPt.x,
            y: lastPt.y,
          })
        }
        graph.refresh()
      })
      .onNodeHover((n) => {
        const id = n ? String(n.id) : null
        if (id === hoveredId) return
        applySpotlight(id)
      })

    // ---- 光照：默认那套太平，补一盏主光 + 一盏冷色轮廓光，球体才有立体感 ----
    const ambient = new THREE.AmbientLight(0xffffff, 1.7)
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.4)
    keyLight.position.set(1, 1.2, 1)
    const rimLight = new THREE.DirectionalLight(0x7aa2ff, 1.6)
    rimLight.position.set(-1, -0.8, -1)
    graph.lights([ambient, keyLight, rimLight])

    // ---- 星尘：给空间一点纵深参照，否则节点像贴在黑板上 ----
    const dustGeo = new THREE.BufferGeometry()
    const DUST = 1400
    const dustPos = new Float32Array(DUST * 3)
    for (let i = 0; i < DUST; i++) {
      const r = 900 + Math.random() * 1500
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      dustPos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      dustPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
      dustPos[i * 3 + 2] = r * Math.cos(phi)
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3))
    const dustMat = new THREE.PointsMaterial({
      color: new THREE.Color(cssColor('--text-faint', '#6b7280')),
      size: 2.4,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    })
    graph.scene().add(new THREE.Points(dustGeo, dustMat))
    disposables.push(dustGeo, dustMat)

    try {
      // 雾的初值给个保守区间，引擎停稳后会按实际机位重新校准
      graph.scene().fog = new THREE.Fog(new THREE.Color(bgColor), 900, 5000)
    } catch {
      /* 背景色不是 three 认得的格式就跳过雾，不影响看图 */
    }

    // ---- 辉光后处理：低配可关 ----
    let bloom: UnrealBloomPass | null = null
    if (glow) {
      try {
        bloom = new UnrealBloomPass(
          new THREE.Vector2(host.clientWidth || 1, host.clientHeight || 1),
          0.5,   // strength
          0.6,   // radius
          0.82,  // threshold：只让高光溢出，别把整个球都糊掉
        )
        graph.postProcessingComposer().addPass(bloom)
      } catch {
        bloom = null
      }
    }

    // ---- 节点外观 ----
    const haloCache = new Map<string, THREE.CanvasTexture>()

    function buildNode(n: FGNode): THREE.Object3D {
      // 样式包先说话，它没说才回到「按类型上色」。半径同理：
      // 几何体在建造时就把半径烘进去了，所以大小变化只能靠整图重建生效。
      const styled = nodeStyle?.(n)
      const r = nodeRadius(n) * 1.38 * (styled?.scale ?? 1)
      const color = styled?.color || resolveColor(n)
      const group = new THREE.Group()
      const materials: (THREE.Material & { opacity: number })[] = []
      const baseOpacity = n.unresolved ? 0.5 : 0.94

      const iconRef = (n.icon as string | undefined) || typeIcons[n.type] || ''
      const iconUrl = assetUrl(iconRef)

      let core: THREE.Object3D
      if (n.unresolved) {
        // 未录入：线框球，一眼看出是「虚的」
        const geo = new THREE.SphereGeometry(r, 16, 12)
        const mat = new THREE.MeshBasicMaterial({
          color, wireframe: true, transparent: true, opacity: baseOpacity,
        })
        core = new THREE.Mesh(geo, mat)
        materials.push(mat)
        disposables.push(geo, mat)
      } else if (iconUrl) {
        // 自定义图标：类型色光晕 + 图片精灵。光晕要和图片一起被 hover 压暗
        let halo = haloCache.get(color)
        if (!halo) {
          halo = makeHaloTexture(color)
          haloCache.set(color, halo)
          disposables.push(halo)
        }
        // 光晕只给一点点存在感 —— 开了 bloom 后太亮会被辉光放大成一团白
        const haloMat = new THREE.SpriteMaterial({ map: halo, transparent: true, opacity: 0.4, depthWrite: false })
        const haloSprite = new THREE.Sprite(haloMat)
        haloSprite.scale.set(r * 2.7, r * 2.7, 1)
        haloSprite.position.set(0, 0, -0.01)
        group.add(haloSprite)
        materials.push(haloMat)

        const iconMat = new THREE.SpriteMaterial({
          map: loadIconTexture(iconUrl), transparent: true, opacity: baseOpacity, depthWrite: false,
        })
        const sprite = new THREE.Sprite(iconMat)
        sprite.scale.set(r * 2.5, r * 2.5, 1)
        core = sprite
        materials.push(iconMat)
      } else {
        const geo = geometryFor(n.type, r)
        const mat = new THREE.MeshPhongMaterial({
          color, shininess: 65, specular: 0x555f77, transparent: true, opacity: baseOpacity,
        })
        core = new THREE.Mesh(geo, mat)
        materials.push(mat)
        disposables.push(geo, mat)
      }
      group.add(core)

      // 选中光圈（默认透明，选中时才亮）
      const ringMat = new THREE.SpriteMaterial({
        map: makeRingTexture(color), transparent: true, opacity: 0, depthWrite: false,
      })
      const ringBase = r * 4.2
      const ring = new THREE.Sprite(ringMat)
      ring.scale.set(ringBase, ringBase, 1)
      group.add(ring)
      disposables.push(ringMat.map!)

      let label: THREE.Sprite | undefined
      if (showLabels) {
        const text = n.name.length > 10 ? n.name.slice(0, 10) + '…' : n.name
        label = makeLabel(text, labelColor, r * 0.95)
        label.position.set(0, r + r * 0.85, 0)
        group.add(label)
        disposables.push(label.material.map!)
      }

      visuals.set(String(n.id), { group, core, materials, label, ring, ringBase, baseOpacity })
      return group
    }

    /** 把颜色写到已经建好的 three 对象上。
     *  ⚠️ hover 时**绝不能**再调 `graph.linkColor(访问器)` —— 底层 kapsule 每设一次
     *  访问器都会执行 `engineRunning = true` 把力模拟重新唤醒，模拟跑完停下又触发
     *  一次 onEngineStop，于是「鼠标蹭一下节点，视角就自己跳回全景」。
     *  直接改材质才是零副作用的做法（顺带省掉 hover 那一瞬的全量重建）。 */
    function paintLinks() {
      for (const l of graph.graphData().links as FGLink[]) {
        const src = typeof l.source === 'object' ? String((l.source as FGNode).id) : String(l.source)
        const on = !spot || spot.has(src)
        const withRefs = l as unknown as { __lineObj?: THREE.Object3D; __arrowObj?: THREE.Object3D }
        for (const obj of [withRefs.__lineObj, withRefs.__arrowObj]) {
          if (!obj) continue
          // 箭头可能被包在 Group 里，用 traverse 一并覆盖
          obj.traverse((o) => {
            const mats = (o as THREE.Mesh).material
            if (!mats) return
            for (const one of Array.isArray(mats) ? mats : [mats]) {
              const mm = one as THREE.Material & { color?: THREE.Color }
              if (mm.color) mm.color.set(on ? linkColor : '#808080')
              mm.transparent = true
              mm.opacity = on ? 0.36 : 0.10
            }
          })
        }
      }
    }

    /** 点亮悬停节点及其一跳邻居，其余压暗 —— 关系图最需要的其实是「这一坨和谁有关」 */
    function applySpotlight(id: string | null) {
      hoveredId = id
      spot = id ? new Set<string>([id, ...(adj.get(id) ?? [])]) : null
      for (const [nid, v] of visuals) {
        const lit = !spot || spot.has(nid)
        for (const m of v.materials) {
          m.transparent = true
          m.opacity = lit ? v.baseOpacity : v.baseOpacity * 0.12
        }
        if (v.label) (v.label.material as THREE.SpriteMaterial).opacity = lit ? 1 : 0
        v.group.scale.setScalar(lit ? 1 : 0.75)
      }
      paintLinks()
    }

    graph.nodeThreeObject((n) => buildNode(n))

    graph.graphData({
      nodes: nodes.map((n) => ({ ...n }) as FGNode),
      links: edges.map((e) => ({ source: e.source, target: e.target })),
    })

    // ---- 坐标锁定：先读 scene.json，有锁就直接钉住（不模拟、不乱飞）。
    // 但如果疏密档变了或点了重排，旧坐标就是作废的，这次要重新模拟。
    lastLayoutRef.current = `${spacing}|${layoutToken}`
    void (async () => {
      try {
        const r = await api.getScene(bookId)
        if (disposed) return
        const saved = r.scene?.graphs?.[sceneKey]
        if (saved?.positions && !layoutChanged) {
          savedPosRef.current = saved.positions
          const p = saved.positions
          let locked = 0
          for (const n of graph.graphData().nodes) {
            const one = p[String(n.id)]
            if (one) {
              n.fx = one.x
              n.fy = one.y
              n.fz = one.z
              locked++
            }
          }
          if (locked > 0) {
            // ⚠️ 只有「绝大多数节点都有存档」才敢整体冻结。
            // 否则场景里只要有一个「从图上新建时钉下的落点」，就会把整张图冻在
            // 初始随机位置上 —— 剩下的节点根本没来得及散开。
            // 不够冻结就让模拟照常跑，那一个落点靠 fx/fy/fz 自己待在原处。
            if (locked >= Math.max(1, Math.ceil(nodes.length * 0.6))) {
              lockedRef.current = true
              graph.cooldownTicks(0)
            }
            graph.refresh()
          }
        }
      } catch {
        /* 场景读不到就当没锁过，正常模拟 */
      }
    })()

    // 模拟稳定：把坐标锁进 scene.json，然后取一次全景。
    // zoomToFit 只动相机不动布局，所以锁定的图也能安全取景。
    // ⚠️ 只取一次：引擎会因为别的原因（hover、数据微调）重新起停，要是每停一次
    // ------------------------------------------------------------------
    // 渲染循环开关（P4.5.5）
    //
    // 力模拟收敛之后，这张图就是一帧静态图 —— 每帧重绘它没有任何意义，
    // 而开着辉光时每帧都要多跑几遍后处理。所以状态是这样定的：
    //
    //   可见 && (还没定型 || 刚有过交互 || 有节点被选中)  →  跑
    //   其余情况                                          →  停
    //
    // 停帧之后鼠标动一下就由 wake() 唤醒 —— 手感不受影响。
    //
    // ⚠️ 两个坑，都踩过：
    //
    // 1. **不要拿自己的标志位去短路 library 的调用**。`onEngineStop` 是在
    //    `_animationCycle` 内部（`tickFrame()` 里）触发的，而库在回调返回后
    //    才执行最后那行 `animationFrameRequestId = requestAnimationFrame(...)`。
    //    于是回调里调用的 `pauseAnimation()` 置空的那个 id，**紧接着又被库自己
    //    登记上了** —— 循环永动，而这边的标志位已经停在「已暂停」，按标志位
    //    短路就永远不会再去暂停它，静态图就此一直烧 60fps。
    //    `resume/pauseAnimation` 在已是目标状态时本身就是空转（库里各自有
    //    null 判断），所以**每次都真的调**才是正确且免费的做法。
    //
    // 2. 所以还得有个**心跳**：光在事件里调不够，库自己也可能把循环拉起来。
    //    下面 60ms 的 pulse 每次都会重新拨一遍开关，保证最终一致。
    // ------------------------------------------------------------------
    let visible = true
    let settled = false
    let animating = true
    let wakeUntil = 0

    /**
     * 把渲染循环拨到此刻该有的状态。**幂等，且每次都真的调库**（见上面坑 1）。
     */
    const applyAnim = () => {
      const want = visible && (!settled || Date.now() < wakeUntil || !!selectedRef.current)
      animating = want
      try {
        if (want) graph.resumeAnimation()
        else graph.pauseAnimation()
      } catch {
        /* 万一这版库没有这对方法，顶多多烧一点，不影响看 */
      }
    }

    /** 有交互了：先醒 420ms，之后由心跳判断要不要睡回去 */
    const wake = () => {
      wakeUntil = Date.now() + 420
      applyAnim()
    }

    // 就把镜头拉回全景，你刚凑近看清某个节点就会被弹走。
    let fitted = false
    graph.onEngineStop(() => {
      if (disposed) return
      // 模拟停了 = 这张图定型了。这一刻起可以停帧 —— 静态图多画一帧都是白烧。
      settled = true
      // 但下面那次取景是 800ms 的相机过渡，得有帧才动得起来。
      // 所以先把开关拨到「醒着」，等过渡走完再由心跳睡回去。
      // （这里调 applyAnim 其实是**打不中**的 —— 见上面坑 1，库紧接着会
      //  自己登记下一帧；真正把帧停掉的是 60ms 那个心跳。）
      wakeUntil = Date.now() + 1100
      applyAnim()
      if (fitted) return
      fitted = true
      graph.zoomToFit(800, 60)
      // 雾跟着机位走：机位远了雾就推远，否则整张图都被雾吞成背景色
      window.setTimeout(() => {
        if (disposed) return
        const fog = graph.scene().fog as THREE.Fog | null
        const cam = graph.cameraPosition()
        const dist = Math.hypot(cam.x, cam.y, cam.z)
        if (fog && dist > 0) {
          fog.near = dist * 0.6
          fog.far = dist * 2.2
        }
      }, 1000)
      if (lockedRef.current) return
      lockedRef.current = true
      const positions: Record<string, { x: number; y: number; z: number }> = {}
      for (const n of graph.graphData().nodes) {
        if (n.x == null) continue
        positions[String(n.id)] = { x: n.x, y: n.y ?? 0, z: n.z ?? 0 }
        n.fx = n.x
        n.fy = n.y
        n.fz = n.z
      }
      const cam = graph.cameraPosition()
      savedPosRef.current = positions
      void (async () => {
        try {
          const cur = await api.getScene(bookId)
          const scene = cur.scene ?? {}
          const graphs = { ...(scene.graphs ?? {}) }
          graphs[sceneKey] = { positions, camera: { x: cam.x, y: cam.y, z: cam.z } }
          await api.saveScene(bookId, { ...scene, graphs })
        } catch {
          /* 锁失败最多下次重新模拟，不影响看图 */
        }
      })()
    })

    graphRef.current = graph
    // 调试口：定位取景/性能问题时用，正式版留着也无害（不引用就不占资源）。
    // 第二个是渲染循环的开关状态 —— 「为什么还在烧帧」这类问题，
    // 光看画面看不出来，得能把这几个布尔值读出来。
    ;(window as unknown as Record<string, unknown>).__g3d = graph
    ;(window as unknown as Record<string, unknown>).__g3dState = () => ({
      visible,
      settled,
      animating,
      wakeUntil,
      selected: selectedRef.current,
      locked: lockedRef.current,
    })

    // ---- 失活即停 ----
    // dockview 会把不激活的面板从文档里摘掉，但这里的渲染循环 + d3 力模拟
    // 不会自己停 —— 后台开着两个 3D 面板就是两份持续的 GPU/CPU 开销。
    // 用 IntersectionObserver 侦测：看不见就暂停整个动画循环。
    //
    // 注意「停帧 = 画面完全不重绘」（tick 只由这个循环驱动，controller 的
    // change 事件自己不出图）。所以面板被重新挂回来、再可见的那一刻，必须
    // **强制醒一下**：画布在脱离文档期间那帧可能已经丢了，不补几帧的话
    // 你会看到一块空白，还以为图挂了 —— 非得动一下鼠标才出来。
    const io = new IntersectionObserver(
      ([e]) => {
        const was = visible
        visible = Boolean(e?.isIntersecting && e.intersectionRatio > 0)
        if (visible && !was) wake()
        else applyAnim()
      },
      { threshold: 0 },
    )
    io.observe(host)

    // 交互唤醒：停帧之后，鼠标动一下必须立刻活过来，否则就是「卡住了」。
    // 捕获阶段挂，免得被画布自己的处理挡掉。
    host.addEventListener('pointerdown', wake, true)
    host.addEventListener('pointermove', wake, true)
    host.addEventListener('wheel', wake, { passive: true, capture: true })

    // 心跳 + 选中脉冲 —— 两件事同一拍做，省一个定时器。
    //
    // 心跳那份职责是「不管谁把渲染循环动过，60ms 之内一定被拨回该有的状态」。
    // 见上面坑 1、2：光在事件里拨开关是不够的，这里是唯一能保证最终一致的地方。
    // 顺带给选中光圈做呼吸（60ms 一次足够顺，比常驻渲染循环便宜）。
    const pulse = window.setInterval(() => {
      if (disposed) return
      applyAnim()
      const id = selectedRef.current
      if (!id || !animating) return
      const t = (Date.now() % 1600) / 1600
      const k = 0.92 + 0.2 * Math.sin(t * Math.PI * 2)
      for (const [nid, v] of visuals) {
        if (!v.ring) continue
        const mat = v.ring.material as THREE.SpriteMaterial
        const on = nid === id
        mat.opacity = on ? 0.5 + 0.3 * Math.sin(t * Math.PI * 2) : 0
        v.ring.scale.set(v.ringBase * k, v.ringBase * k, 1)
      }
    }, 60)

    const handleResize = () => {
      // ⚠️ 顺序要紧：**先定像素密度，再报尺寸**。
      // 出图其实全都走后处理合成器（库在 init 时就把它建好了，即使没开辉光，
      // 它也是唯一出屏通道），而合成器的渲染目标是按「当时的像素比」分配的。
      // 反过来做的话，它先按旧比例分一份大缓冲，之后再改 ratio 也不会重建 ——
      // 白占显存，等于这次封顶没封。
      try {
        // 像素密度封顶 1.5：2K/4K 屏上按 devicePixelRatio 全量渲染是白烧 GPU ——
        // 这张图由半透明球和细线组成，1.5 倍和 2.5 倍肉眼分不出，却要多画一倍多像素。
        graph.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
      } catch {
        /* 拿不到渲染器就算了，不影响看图 */
      }
      graph.width(host.clientWidth)
      graph.height(host.clientHeight)
      try {
        graph.postProcessingComposer()?.setSize(host.clientWidth, host.clientHeight)
      } catch {
        /* 老版本库没有合成器就算了 */
      }
      bloom?.setSize(host.clientWidth, host.clientHeight)
    }
    handleResize()
    const ro = new ResizeObserver(handleResize)
    ro.observe(host)

    return () => {
      disposed = true
      window.clearInterval(pulse)
      io.disconnect()
      ro.disconnect()
      host.removeEventListener('pointermove', trackPointer, true)
      host.removeEventListener('pointerdown', trackPointer, true)
      host.removeEventListener('pointermove', wake, true)
      host.removeEventListener('pointerdown', wake, true)
      host.removeEventListener('wheel', wake, true)
      host.removeEventListener('contextmenu', onContextMenu)
      for (const d of disposables) {
        try {
          d.dispose()
        } catch {
          /* 已释放就算了 */
        }
      }
      graph._destructor()
      host.innerHTML = ''
      graphRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, sceneKey, nodes, edges, showLabels, themeKey, JSON.stringify(typeIcons), glow,
      spacing, layoutToken, clusterByType, nodeStyle])

  // ---- 选中：相机飞到节点上（光圈由上面的脉冲负责） ----
  useEffect(() => {
    const graph = graphRef.current
    if (!graph || !selectedId) return
    const target = graph.graphData().nodes.find((n) => String(n.id) === selectedId)
    if (target && target.x != null) {
      const d = Math.hypot(target.x, target.y ?? 0, target.z ?? 0) || 1
      const k = Math.min(3.2, Math.max(1, 220 / d))
      graph.cameraPosition(
        { x: target.x * k, y: (target.y ?? 0) * k, z: (target.z ?? 0) * k },
        { x: target.x, y: target.y ?? 0, z: target.z ?? 0 },
        1200,
      )
    }
  }, [selectedId])

  return (
    <div className="graph3d-wrap">
      {/* 这层是库自己的地盘，React 不能往里塞子节点（会被 append 的画布打架） */}
      <div ref={hostRef} className="graph3d" />
      {(onToggleLinkMode || onToggleEditable) && (
        <div className="graph3d__tools">
          {onToggleEditable && (
            <span className="graph__seg" role="group" aria-label="图上编辑开关">
              <button
                className={`graph__seg-btn ${!editable ? 'graph__seg-btn--on' : ''}`}
                onClick={() => onToggleEditable(false)}
                title="只旋转缩放、单击选中；不会误改到任何东西"
              >
                浏览
              </button>
              <button
                className={`graph__seg-btn ${editable ? 'graph__seg-btn--on' : ''}`}
                onClick={() => onToggleEditable(true)}
                title="拖动节点改位置、双击（或右键）改名、双击空白新建、拖到另一个节点建立关联"
              >
                编辑
              </button>
            </span>
          )}
          {onToggleLinkMode && editable && (
            <button
              className={`btn btn--sm ${linkMode ? 'btn--on' : ''}`}
              onClick={onToggleLinkMode}
              title="开启后，从一个节点拖到另一个节点即可建立关联"
            >
              连线模式
            </button>
          )}
          <span className="graph__hint faint fs-xs">
            {editable
              ? '双击节点改它 · 双击空白新建 · 拖到另一个节点连线'
              : '浏览态：拖动旋转 · 滚轮缩放 · 单击选中'}
          </span>
        </div>
      )}
      {linkMode && (
        <div className="graph__mode-tip">连线模式：从一个节点拖到另一个节点 · 再点一次按钮可退出</div>
      )}
    </div>
  )
}
