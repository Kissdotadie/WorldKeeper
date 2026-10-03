/**
 * 样式包缩略预览（P11-1️⃣⑤）。
 *
 * 一张 1 父 2 子的迷你图，把一套样式包的「布局 / 节点形状 / 配色 / 连线形态 /
 * 背景」在方寸之间讲清楚 —— 用户不点也知道点下去会变成什么样。
 *
 * **关键约束：不许自己另写画法。** 预览和真实渲染必须共用同一套代码，
 * 否则迟早出现「缩略图是括号、点下去变折线」这种事。所以这里：
 *   - 布局  → `layouts.ts` 的 `layoutStatic()`（`Graph2D` 用的同一支）
 *   - 节点  → `resolveNode()` + `shapeGeom()`（同一支）
 *   - 连线  → `edgePath.ts` 的 `edgePath()`（同一支）
 * 只有「把算出来的坐标塞进 100×62 的小盒子」这一步是预览独有的。
 *
 * `force` 布局排除在外：它靠 d3-force 迭代，本身带随机性，
 * 这里用一份固定的小样本近似（真实图每次打开位置也不一样，预览不必强求一致）。
 */

import { useMemo } from 'react'
import { edgePath } from '../graph/edgePath'
import { layoutStatic } from '../graph/layouts'
import {
  resolveNode,
  shapeGeom,
  withAlpha,
  type GraphSpec,
  type PackPreviewSpec,
  type StylePack,
} from '../graph/styles'
import { type GEdge, type GNode, type LayoutKind } from '../graph/types'

const VW = 104
const VH = 62
const PAD = 11

/** 三个样例节点：一个根 + 两种不同类型的孩子，配色差异一眼能看出来 */
const MOCK_NODES: GNode[] = [
  { id: '__p', name: '根', type: 'character', degree: 2 },
  { id: '__c1', name: '甲', type: 'location', degree: 1 },
  { id: '__c2', name: '乙', type: 'concept', degree: 1 },
]
const MOCK_EDGES: GEdge[] = [
  { source: '__p', target: '__c1' },
  { source: '__p', target: '__c2' },
]
/** 固定色板按「类型在全部类型里的序号」取色，这里给个稳定的序号 */
const TYPE_INDEX = new Map([
  ['character', 0],
  ['location', 1],
  ['concept', 2],
])

/** force 没有确定性结果，用一份手摆的近似位置 */
const FORCE_APPROX = new Map([
  ['__p', { x: 0, y: 0 }],
  ['__c1', { x: -78, y: 52 }],
  ['__c2', { x: 74, y: 46 }],
])

const DEFAULTS: PackPreviewSpec = {
  shape: 'auto',
  palette: 'type',
  sizeScale: 1,
  edgeCurve: 'straight',
  edgeDashed: false,
  edgeArrow: true,
  background: 'none',
  showLabel: true,
}

export function PackThumb({
  spec,
  layout,
  className = '',
}: {
  spec?: PackPreviewSpec
  layout?: string
  className?: string
}) {
  const s = { ...DEFAULTS, ...(spec ?? {}) }

  const view = useMemo(() => {
    // 把预览参数拼成一个**真的样式包**喂给 resolveNode —— 走的就是真实解析路径
    const graph: GraphSpec = {
      layout: (layout as GraphSpec['layout']) || 'tree',
      shape: s.shape,
      palette: s.palette,
      sizeScale: s.sizeScale,
      edge: { curve: s.edgeCurve, dashed: s.edgeDashed, arrow: s.edgeArrow, width: 1.4 },
      label: { show: s.showLabel, scale: 1 },
      background: s.background,
    }
    const pack: StylePack = { id: '__preview', name: '', graph, rules: [] }

    const pos =
      graph.layout === 'force'
        ? FORCE_APPROX
        : layoutStatic(graph.layout as LayoutKind, MOCK_NODES, MOCK_EDGES, '__p')

    const nodes = MOCK_NODES.map((n) => {
      const res = resolveNode(n, pack, undefined, { typeIndex: TYPE_INDEX })
      const p = pos.get(n.id) ?? { x: 0, y: 0 }
      // 半径按**真实推导**来，再乘包里的 sizeScale —— 预览里大小比例也就跟着对
      const r = Math.max(2.6, Math.min(9, 5.4 * res.sizeScale))
      return { id: n.id, type: n.type, x: p.x, y: p.y, r, res }
    })

    // 适应小盒子：取布局包围盒 + 节点半径，等比缩放到 viewBox 内
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of nodes) {
      minX = Math.min(minX, n.x - n.r)
      minY = Math.min(minY, n.y - n.r)
      maxX = Math.max(maxX, n.x + n.r)
      maxY = Math.max(maxY, n.y + n.r)
    }
    if (!Number.isFinite(minX)) {
      minX = -1; minY = -1; maxX = 1; maxY = 1
    }
    const bw = Math.max(1, maxX - minX)
    const bh = Math.max(1, maxY - minY)
    const k = Math.min((VW - PAD * 2) / bw, (VH - PAD * 2) / bh)
    const ox = (VW - bw * k) / 2 - minX * k
    const oy = (VH - bh * k) / 2 - minY * k

    const at = (id: string) => {
      const n = nodes.find((x) => x.id === id)!
      return { x: n.x * k + ox, y: n.y * k + oy }
    }

    // 端点按半径收缩，别让线和箭头钻进节点里 ——
    // 和 Graph2D 里 `ra / rb` 那两个偏移是同一个意思（半径 + 2 / + 6）
    const edges = MOCK_EDGES.map((e) => {
      const na = nodes.find((x) => x.id === e.source)!
      const nb = nodes.find((x) => x.id === e.target)!
      const a = at(e.source)
      const b = at(e.target)
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.hypot(dx, dy) || 1
      const ux = dx / len
      const uy = dy / len
      const ra = na.r * k + 2
      const rb = nb.r * k + 6
      return {
        x1: a.x + ux * ra,
        y1: a.y + uy * ra,
        x2: b.x - ux * rb,
        y2: b.y - uy * rb,
      }
    })

    // 括号式的共用竖脊：同父的子边共用一根 —— 与 Graph2D 的算法同源
    // （父只有一个，所以直接取父到子的水平中点，与 Graph2D 的单边退化情形一致）
    const spineX =
      graph.edge.curve === 'bracket'
        ? (at('__p').x + Math.min(at('__c1').x, at('__c2').x)) / 2
        : undefined

    return { nodes, edges, k, at, spineX, graph }
  }, [s.shape, s.palette, s.sizeScale, s.edgeCurve, s.edgeDashed, s.edgeArrow, s.background, s.showLabel, layout])

  const { nodes, edges, k, at, spineX, graph } = view
  const strokeW = Math.max(1, 1.7 * k) / 1.7

  return (
    <svg
      className={`packthumb ${className}`}
      viewBox={`0 0 ${VW} ${VH}`}
      width="100%"
      height="100%"
      role="img"
      aria-label="样式包缩略预览"
      data-edge-curve={graph.edge.curve}
      data-shape={graph.shape}
    >
      {/* 背景：网格 / 星空 / 纯色 —— 与图上的那三种对应，只是画得更省 */}
      {graph.background === 'grid' && (
        <defs>
          <pattern id="pt-grid" width="9" height="9" patternUnits="userSpaceOnUse">
            <path d="M 9 0 L 0 0 0 9" fill="none" stroke="var(--border-subtle)" strokeWidth="0.7" />
          </pattern>
        </defs>
      )}
      {graph.background === 'grid' && <rect x="0" y="0" width={VW} height={VH} fill="url(#pt-grid)" />}
      {graph.background === 'stars' && (
        <g fill="var(--text-faint)" opacity="0.55">
          {[
            [12, 13], [26, 44], [43, 9], [60, 51], [74, 17], [92, 38], [88, 8], [17, 30],
          ].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={i % 3 === 0 ? 1 : 0.7} />
          ))}
        </g>
      )}
      {graph.background === 'solid' && (
        <rect x="0" y="0" width={VW} height={VH} fill="var(--bg-raised)" rx="4" />
      )}

      {/* 连线 */}
      <g className="packthumb__edges">
        {edges.map((e, i) => {
          return (
            <path
              key={i}
              d={edgePath(e.x1, e.y1, e.x2, e.y2, graph.edge.curve, spineX)}
              fill="none"
              stroke="var(--border-strong)"
              strokeWidth="1.3"
              strokeDasharray={graph.edge.dashed ? '4 3' : undefined}
              markerEnd={graph.edge.arrow ? 'url(#pt-arrow)' : undefined}
            />
          )
        })}
      </g>
      <defs>
        <marker
          id="pt-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border-strong)" />
        </marker>
      </defs>

      {/* 节点 */}
      {nodes.map((n) => {
        const g = shapeGeom(n.res.shape, n.r)
        const fill = n.res.fill
        const stroke = n.res.stroke || withAlpha('var(--text-primary)', 0.28)
        const common = { fill, stroke, strokeWidth: strokeW }
        return (
          <g key={n.id}>
            {g.kind === 'circle' && <circle cx={at(n.id).x} cy={at(n.id).y} r={g.r * k} {...common} />}
            {g.kind === 'rect' && (
              <rect
                x={at(n.id).x - (g.w * k) / 2}
                y={at(n.id).y - (g.h * k) / 2}
                width={g.w * k}
                height={g.h * k}
                rx={g.rx * k}
                {...common}
              />
            )}
            {g.kind === 'poly' && (
              <polygon
                points={g.points
                  .split(' ')
                  .map((p) => {
                    const [px, py] = p.split(',').map(Number)
                    return `${px * k + at(n.id).x},${py * k + at(n.id).y}`
                  })
                  .join(' ')}
                {...common}
              />
            )}
          </g>
        )
      })}
    </svg>
  )
}
