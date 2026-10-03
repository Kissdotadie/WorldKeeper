/**
 * 可视化样式系统（P5）—— 类型、色板、以及「这个节点到底该画成什么样」。
 *
 * **三份数据合起来决定一个节点的长相**，优先级从高到低：
 *
 *   1. `view/nodes.json` 里对这个节点的单独设定   ← 手动调过的，永远赢
 *   2. 样式包里的批量规则（先按标签、再按类型）
 *   3. 样式包里的整体设定（形状 / 配色 / 大小）
 *   4. 内置默认（按类型上色、圆的、大小按连接数）
 *
 * 为什么单节点最高：样式包是「一键换整套」的东西，如果不让手动设定赢，
 * 那这个按钮在用户心里的名字就会变成「一键毁掉我调了半小时的那个节点」。
 * 反过来，按标签优先于按类型 —— 标签是用户自己打的、更具体，类型是系统分的。
 *
 * 这里全是**纯函数**，不碰 React 也不发请求 —— 图上的节点可能有几百上千个，
 * 解析必须是同步的、可预测的，而且能单独测。
 */

import type { GNode } from './types'

// ---------------------------------------------------------------------------
// 存档格式（与 `app/styles_builtin.py`、`app/api/styles.py` 逐字段对应）
// ---------------------------------------------------------------------------

export type NodeShape = 'auto' | 'circle' | 'square' | 'diamond' | 'hex' | 'capsule' | 'image'
export type PaletteId = 'type' | 'theme' | 'dark-gold' | 'vivid' | 'mono' | 'pastel'
/**
 * 连线形态（P9 扩到五种）。
 *
 * - `straight` 直线
 * - `curve`    贝塞尔曲线（拱出去的弧）
 * - `elbow`    折线：每条边各自一根竖段，成扇状
 * - `bracket`  括号：**同一父节点的子边共用一根竖脊**，合流成一对大括号把子节点括起来；
 *              子节点多时最清爽（这正是「数量过多堆在一起」的解药）
 * - `step`     阶梯：正交阶梯，水平竖直交替递进，层级感最强
 *
 * 形状与配色一样进样式包 —— 换一套包整张图跟着变形。三维图不受影响
 * （连线形态是 2D 的概念，3D 里只有管状线）。
 */
export type EdgeCurve = 'straight' | 'curve' | 'elbow' | 'bracket' | 'step'
export type BackgroundKind = 'none' | 'grid' | 'stars' | 'solid'

export interface GraphSpec {
  layout: 'force' | 'radial' | 'tree' | 'circle' | 'timeline' | 'fishbone'
  shape: NodeShape
  palette: PaletteId
  sizeScale: number
  edge: { curve: EdgeCurve; dashed: boolean; arrow: boolean; width: number }
  label: { show: boolean; scale: number }
  background: BackgroundKind
}

/** 单节点 / 单条规则上能改的那几样。缺的字段 = 不改。 */
export interface NodeStylePatch {
  shape?: Exclude<NodeShape, 'auto'>
  fill?: string
  stroke?: string
  size?: number
  image?: string
  label?: boolean
  highlight?: boolean
}

export interface StyleRule {
  match: { by: 'type' | 'tag'; value: string }
  style: NodeStylePatch
}

export interface StylePack {
  schema?: number
  id: string
  name: string
  desc?: string
  builtin?: boolean
  modified?: boolean
  graph: GraphSpec
  rules: StyleRule[]
}

/**
 * 样式包预览用的那一小撮图形参数（后端 `pack_meta()` 的 `spec` 字段）。
 *
 * 卡片墙上的缩略图只需要这些 —— 布局、形状、配色、连线、背景，
 * 够画一张 1 父 2 子的迷你图，不用把整份 rules 拖到前端。
 */
export interface PackPreviewSpec {
  shape: NodeShape
  palette: PaletteId
  sizeScale: number
  edgeCurve: EdgeCurve
  edgeDashed: boolean
  edgeArrow: boolean
  background: BackgroundKind
  showLabel: boolean
}

export interface PackMeta {
  id: string
  name: string
  desc?: string
  builtin?: boolean
  modified?: boolean
  layout?: string
  /** 缩略预览参数（P11-1️⃣⑤）。老接口没有这个字段时按默认长相画 */
  spec?: PackPreviewSpec
}

export interface StylesData {
  active: string
  packs: PackMeta[]
  active_pack: StylePack
  shapes: string[]
  palettes: string[]
  layouts: string[]
  edge_curves: string[]
  backgrounds: string[]
  dir?: string
}

// ---------------------------------------------------------------------------
// 贴纸（`view/decorations.json`）
// ---------------------------------------------------------------------------

/**
 * 一张贴纸。
 *
 * 坐标是**视图坐标**（相对图容器左上角的像素），不是数据坐标 ——
 * 贴纸是「我在这一屏的这个地方标了一下」，跟着图缩放没有意义，
 * 反而是按屏幕定位才能保证「换个布局它还在原来的位置」。
 */
export interface Decoration {
  id: string
  /** 素材相对路径，如 `stickers/flag.png` */
  asset: string
  x: number
  y: number
  scale: number
  /** 旋转角度（度） */
  rot: number
  opacity: number
  /** 图层：大的压在上面 */
  z: number
  locked: boolean
  /** 水平翻转 */
  flip?: boolean
}

// ---------------------------------------------------------------------------
// 色板
// ---------------------------------------------------------------------------

export interface PaletteDef {
  id: PaletteId
  name: string
  desc: string
  /** 固定色板才有；`type` / `theme` 走全局 CSS 变量，见 paletteColor() */
  colors: string[]
}

/**
 * 内置配色方案。
 *
 * 色值全部写成**十六进制而不是 CSS 变量**：样式包要能导出给别人，
 * 别人那份主题里没有同名变量，导过去就成了透明色。
 */
export const PALETTES: PaletteDef[] = [
  {
    id: 'type',
    name: '按类型',
    desc: '人物蓝、地点绿、势力金…… 和全站其他地方一致',
    colors: [],
  },
  {
    id: 'theme',
    name: '跟随主题',
    desc: '单一强调色，换 UI 主题时跟着变',
    colors: [],
  },
  {
    id: 'dark-gold',
    name: '暗夜权谋',
    desc: '暗金 + 墨绿，适合朝堂与势力',
    colors: ['#c9a227', '#8c6d1f', '#d9bc6a', '#5f7a5a', '#a8853a', '#6b5b2a'],
  },
  {
    id: 'vivid',
    name: '高对比',
    desc: '饱和度高、彼此拉得开，投屏也看得清',
    colors: ['#ff5c7a', '#ffb347', '#4ade80', '#38bdf8', '#a78bfa', '#f472b6'],
  },
  {
    id: 'mono',
    name: '单色',
    desc: '同一色系深浅变化，弱化颜色、突出结构',
    colors: ['#8fb4ff', '#6a97f5', '#4f7ad6', '#3a5da8', '#27407a', '#a9c6ff'],
  },
  {
    id: 'pastel',
    name: '马卡龙',
    desc: '低饱和浅色，节点多的时候不刺眼',
    colors: ['#f4a7b9', '#9ad0c2', '#f6d186', '#9db4e8', '#c9a7e8', '#8fd0e8'],
  },
]

export const PALETTE_BY_ID = new Map(PALETTES.map((p) => [p.id, p]))

/** 节点形状的选项（给界面用；`auto` 与 `image` 需要额外说明） */
export const SHAPE_LABELS: { key: NodeShape; label: string; hint: string }[] = [
  { key: 'auto', label: '按类型', hint: '人物圆、地点柱、势力方 —— 沿用默认' },
  { key: 'circle', label: '圆形', hint: '最通用' },
  { key: 'square', label: '方形', hint: '组织、机构' },
  { key: 'diamond', label: '菱形', hint: '事件、节点标记' },
  { key: 'hex', label: '六边形', hint: '势力、阵营' },
  { key: 'capsule', label: '胶囊', hint: '时间线索、长名字' },
  { key: 'image', label: '图片', hint: '用素材库里的图当节点' },
]

/**
 * 色板 → 具体颜色。
 *
 * `type` / `theme` 直接返回 CSS 变量（跟随主题，切主题时整张图跟着变）；
 * 固定色板按**类型在所有类型里的序号**取色 —— 同一类型在任何图上都是同一个色，
 * 这一点比「按节点序号轮换」重要得多。
 */
export function paletteColor(
  palette: PaletteId,
  type: string,
  typeIndex: number,
): string {
  if (palette === 'theme') return 'var(--accent)'
  if (palette === 'type') return `var(--type-${type}, var(--text-muted))`
  const def = PALETTE_BY_ID.get(palette)
  if (!def || !def.colors.length) return `var(--type-${type}, var(--text-muted))`
  const i = typeIndex >= 0 ? typeIndex : 0
  return def.colors[i % def.colors.length]
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

export interface ResolvedNode {
  shape: NodeShape
  /** 填充色：CSS 颜色或 `var(--x)` */
  fill: string
  /** 描边色；空串 = 用默认（深色底描边） */
  stroke: string
  /** 单节点写死的半径（像素）。null = 按连接数推导后再乘 sizeScale */
  size: number | null
  /** 大小倍率：包级 × 命中规则的 */
  sizeScale: number
  /** 素材库相对路径（`icons/x.png`）；空串 = 没有图片 */
  image: string
  label: boolean
  highlight: boolean
}

export interface ResolveContext {
  /** 类型 key → 在全部类型里的序号，决定固定色板取哪个色 */
  typeIndex: Map<string, number>
  /** 实体 id → 素材库图片。图上没带 `icon` 的节点从这里取 */
  nodeIcons?: Map<string, string>
}

function patchOf(rule: StyleRule | undefined): NodeStylePatch {
  return rule?.style ?? {}
}

function clampScale(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0.3, Math.min(4, n)) : fallback
}

/**
 * 把一个节点的最终长相算出来。
 *
 * @param node     图上的节点
 * @param pack     当前样式包（没有就传 null，走内置默认）
 * @param override `view/nodes.json` 里这个节点的单独设定
 */
export function resolveNode(
  node: GNode,
  pack: StylePack | null,
  override: NodeStylePatch | undefined,
  ctx: ResolveContext,
): ResolvedNode {
  const graph = pack?.graph
  const rules = pack?.rules ?? []

  // 标签规则优先于类型规则：标签是用户自己打的，更具体
  const tagHit = rules.find(
    (r) => r.match.by === 'tag' && r.match.value && (node.tags ?? []).includes(r.match.value),
  )
  const typeHit = rules.find((r) => r.match.by === 'type' && r.match.value === node.type)
  const tagStyle = patchOf(tagHit)
  const typeStyle = patchOf(typeHit)
  const ov: NodeStylePatch = override ?? {}

  const idx = ctx.typeIndex.get(node.type) ?? -1
  const palette = graph?.palette ?? 'type'

  // 优先级：单节点 > 标签规则 > 类型规则 > 包默认 > 内置默认
  const shape = ov.shape ?? tagStyle.shape ?? typeStyle.shape ?? graph?.shape ?? 'auto'
  const fill =
    ov.fill ?? tagStyle.fill ?? typeStyle.fill ?? paletteColor(palette, node.type, idx)
  const stroke = ov.stroke ?? tagStyle.stroke ?? typeStyle.stroke ?? ''
  const highlight = ov.highlight ?? tagStyle.highlight ?? typeStyle.highlight ?? false

  // 单节点写死的像素最优先；否则只留倍率，由渲染层乘到基础半径上
  const size = ov.size ?? null
  const sizeScale =
    clampScale(graph?.sizeScale, 1) *
    clampScale((tagStyle as { sizeScale?: number }).sizeScale, 1) *
    clampScale((typeStyle as { sizeScale?: number }).sizeScale, 1)

  // 图片的来源有三处，优先级递减：
  //   节点级覆盖（用户刚亲手设的，必须赢） > 图上的节点自带 icon > 外部映射表
  // 都拿不到、形状又是「图片」时，渲染层退回到按类型配的图标；
  // 连类型图标也没有就退回圆形 —— 不留一个空白洞。
  const image = ov.image ?? node.icon ?? ctx.nodeIcons?.get(node.id) ?? ''
  const label = ov.label ?? graph?.label?.show ?? true

  return {
    shape: shape === 'image' ? 'image' : shape,
    fill,
    stroke,
    size,
    sizeScale,
    image,
    label,
    highlight,
  }
}

// ---------------------------------------------------------------------------
// 颜色工具
// ---------------------------------------------------------------------------

/** `#abc` / `#aabbcc` / `#aabbccdd` → `rgba(...)`；非十六进制（如 var()）原样返回 */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(color.trim())
  if (!m) return color
  let hex = m[1]
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  const a = Math.max(0, Math.min(1, alpha))
  if (hex.length === 8) {
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    return `rgba(${r},${g},${b},${(parseInt(hex.slice(6, 8), 16) / 255) * a})`
  }
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${a})`
}

// ---------------------------------------------------------------------------
// 2D 形状 → SVG
// ---------------------------------------------------------------------------

/** 把 `pts` 的多边形顶点串成 `points` 属性 */
function polyPoints(r: number, sides: number, rot = 0): string {
  const out: string[] = []
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2
    out.push(`${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`)
  }
  return out.join(' ')
}

export type ShapeGeom =
  | { kind: 'circle'; r: number }
  | { kind: 'rect'; w: number; h: number; rx: number }
  | { kind: 'poly'; points: string }

/** 节点形状 → SVG 几何。`auto` 在 2D 里就是圆。 */
export function shapeGeom(shape: NodeShape, r: number): ShapeGeom {
  switch (shape) {
    case 'square':
      // 方形按面积对齐圆：边长 = r * √π ≈ 1.77r，视觉上不会比圆明显变小
      return { kind: 'rect', w: r * 1.78, h: r * 1.78, rx: r * 0.16 }
    case 'capsule':
      return { kind: 'rect', w: r * 2.7, h: r * 1.5, rx: r * 0.75 }
    case 'diamond':
      return { kind: 'poly', points: polyPoints(r * 1.36, 4, -Math.PI / 2) }
    case 'hex':
      return { kind: 'poly', points: polyPoints(r * 1.18, 6, -Math.PI / 2) }
    default:
      return { kind: 'circle', r }
  }
}
