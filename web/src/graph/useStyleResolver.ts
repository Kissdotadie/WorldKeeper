/**
 * 把全局样式状态接成「给一个节点，算出它该画成什么样」的一个函数（P5）。
 *
 * 为什么单独一个文件：`resolveNode()` 是纯函数（好测、无副作用），
 * 但它需要四份数据（当前包、单节点覆盖、类型序号、实体图片）。
 * 这些数据来自 store，而 store 是 React 的东西 —— 把「取数据」和
 * 「算样式」分开，纯函数那份就永远不需要为了测试去搭一个 Provider。
 */

import { useMemo, type ComponentProps } from 'react'
import { useApp } from '../state/store'
import { Graph2D } from './Graph2D'
import {
  resolveNode,
  type BackgroundKind,
  type GraphSpec,
  type ResolvedNode,
  type StylePack,
} from './styles'
import type { GNode, LayoutKind } from './types'

/** 三维能接的那一部分样式。**形状不在里面**，理由见 `useStyleResolver` 里的注释。 */
export interface NodeStyle3D {
  /** 具体色值。三维里 `var()` 不生效，所以这里一定不是 CSS 变量 */
  color: string
  /** 大小倍率 */
  scale: number
}

export interface StyleResolver {
  /** 当前生效的样式包（没加载到就是 null，此时图走内置默认长相） */
  pack: StylePack | null
  /** 有没有真的读到样式包。没有时视图不该把三维投影传下去，否则会顶掉按类型给的几何体 */
  hasPack: boolean
  resolve: (node: GNode) => ResolvedNode
  edge: GraphSpec['edge']
  labelScale: number
  background: BackgroundKind
  /** 样式包规定的布局。视图自己选过布局时以视图为准（手动 > 批量，和节点一个道理） */
  layout: LayoutKind
  /** 三维投影：只给颜色与大小 */
  s3d: (node: GNode) => NodeStyle3D
  /** 手动调过外观的节点 id —— 界面上要能告诉用户「你动过几个」 */
  overriddenIds: string[]
  /** 直接摊给 2D 图用：`<Graph2D {...g2d} />`，省得每个视图抄四行 */
  g2d: Pick<
    ComponentProps<typeof Graph2D>,
    'resolveStyle' | 'edgeStyle' | 'background' | 'labelScale'
  >
}

const FALLBACK_EDGE: GraphSpec['edge'] = {
  curve: 'straight',
  dashed: false,
  arrow: true,
  width: 1,
}

export function useStyleResolver(): StyleResolver {
  const { styles, nodeStyles, entities, types, prefs } = useApp()

  const pack = styles?.active_pack ?? null

  /**
   * 类型序号：决定固定色板给每个类型分哪个色。
   *
   * **必须稳定** —— 序号一抖整张图的配色就全变。所以取后端给的规范顺序
   * （`types` 是 `ENTITY_TYPES` 的顺序），而不是「按当前图里出现的类型排序」：
   * 后者会因为你筛掉了一类而让剩下所有的颜色集体前移一位。
   */
  const typeIndex = useMemo(() => {
    const m = new Map<string, number>()
    types.forEach((t, i) => m.set(t.key, i))
    if (!m.size) {
      // 兜底：类型表还没拉到时，用当前实体里出现过的类型按字母序
      const seen = [...new Set(entities.map((e) => e.type))].sort()
      seen.forEach((t, i) => m.set(t, i))
    }
    return m
  }, [types, entities])

  /** 实体自带的图标（frontmatter 的 `icon`）。图上的节点不一定带这个字段 */
  const nodeIcons = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of entities) if (e.icon) m.set(e.id, e.icon)
    return m
  }, [entities])

  const resolve = useMemo(() => {
    const ctx = { typeIndex, nodeIcons }
    return (node: GNode) => resolveNode(node, pack, nodeStyles[node.id], ctx)
  }, [pack, nodeStyles, typeIndex, nodeIcons])

  const edge = pack?.graph.edge ?? FALLBACK_EDGE
  const labelScale = pack?.graph.label.scale ?? 1
  const background: BackgroundKind = pack?.graph.background ?? 'none'
  const layout = (pack?.graph.layout ?? 'radial') as LayoutKind
  const overriddenIds = useMemo(() => Object.keys(nodeStyles), [nodeStyles])

  /**
   * 三维投影。
   *
   * 只给**颜色与大小**，不给形状 —— 三维里的形状本来就承担「哪类东西」的语义
   * （势力是方块、地点是柱、器物是八面体），而二维里的形状是纯装饰。
   * 把包级的「全部圆形」照搬到三维，等于把「一眼分辨人物/地点/势力」这个能力抹平，
   * 换来一个更差的图。要单个节点变形状，那是「节点自定义」里该管的事，不在这里。
   *
   * 颜色必须解成**具体色值**：`var(--type-x)` 在 canvas / three 里不生效，
   * 会直接渲染成黑色。解析结果按变量名缓存，且只在「包或主题变了」时重算 ——
   * 不能落到每帧去调 `getComputedStyle`（P4.5.5 刚把渲染循环清干净）。
   */
  const themeKey = `${prefs?.ui.mode ?? ''}-${prefs?.ui.theme ?? ''}`
  const s3d = useMemo(() => {
    const cache = new Map<string, string>()
    const concrete = (color: string): string => {
      if (!color.startsWith('var(')) return color
      const hit = cache.get(color)
      if (hit) return hit
      const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(color)
      let out = (m?.[2] ?? '#9ca3af').trim()
      if (m?.[1]) {
        const v = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim()
        if (v) out = v
      }
      cache.set(color, out)
      return out
    }
    return (node: GNode): NodeStyle3D => {
      const st = resolve(node)
      return { color: concrete(st.fill), scale: st.sizeScale }
    }
    // themeKey 是必需的依赖：切主题时 CSS 变量换了值，这里得重解一遍
  }, [resolve, themeKey])

  return {
    pack,
    hasPack: Boolean(pack),
    resolve,
    edge,
    labelScale,
    background,
    layout,
    s3d,
    overriddenIds,
    g2d: { resolveStyle: resolve, edgeStyle: edge, background, labelScale },
  }
}

export default useStyleResolver
