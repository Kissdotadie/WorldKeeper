/** 2D 图谱的公共类型。 */

export interface GNode {
  id: string
  name: string
  type: string
  degree?: number
  /** 指向「还没录入的实体」的虚线节点 */
  unresolved?: boolean
  status?: string | null
  first_appear?: string | null
  /** 实体自带的图标（素材相对路径，如 `icons/knight.png`） */
  icon?: string | null
  /** 手动指定半径，覆盖按连接数推导的默认值（样式系统用） */
  size?: number
  /** 手动指定填充色，覆盖按类型推导的默认色（样式系统用） */
  color?: string
  /** 标签，供「按标签批量应用样式」用 */
  tags?: string[]
}

export interface GEdge {
  source: string
  target: string
  kind?: string | null
}

export interface Pt {
  x: number
  y: number
}

export type LayoutKind = 'force' | 'radial' | 'tree' | 'circle' | 'timeline' | 'fishbone'

export const LAYOUT_LABELS: { key: LayoutKind; label: string; hint: string }[] = [
  { key: 'force', label: '力导向', hint: '自然聚类，看整体结构' },
  { key: 'radial', label: '放射', hint: '思维导图式，根在中心向外发散' },
  { key: 'tree', label: '树形', hint: '组织架构式，按层级左右排开' },
  { key: 'circle', label: '环形', hint: '等距排列，看谁和谁有联系' },
  { key: 'timeline', label: '时间轴', hint: '按首现章节从左到右排开' },
  { key: 'fishbone', label: '鱼骨', hint: '一条主脊，支线上下分开' },
]

/** 节点半径：连接越多越大，但夹在合理区间内；手动指定优先。 */
export function nodeRadius(node: GNode): number {
  if (node.size != null) return Math.max(3, Math.min(80, node.size))
  const d = node.degree ?? 0
  return Math.max(6, Math.min(20, 6 + d * 1.15))
}

/** 节点填充色：手动指定优先，其次按类型取主题变量。 */
export function nodeColor(node: GNode): string {
  if (node.unresolved) return 'transparent'
  if (node.color) return node.color
  return typeColorVar(node.type)
}

export function typeColorVar(type: string, unresolved?: boolean): string {
  if (unresolved || !type) return 'var(--text-faint)'
  return `var(--type-${type}, var(--text-muted))`
}

export function shortName(name: string, max = 6): string {
  return name.length > max ? `${name.slice(0, max)}…` : name
}
