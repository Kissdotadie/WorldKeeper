/**
 * 连线路径与折线圆角 —— **2D 图谱与「样式包缩略预览」共用同一套几何**。
 *
 * 为什么单独建这个文件（P11-1️⃣⑤）：预览要是自己另写一份画法，
 * 就会出现「缩略图里是括号，点下去变成折线」这种事。用户看到的和用到的
 * 必须是同一份代码，所以把它从 `Graph2D.tsx` 里搬出来，两边都 import。
 *
 * 五种形态（`EdgeCurve`）：
 * - `straight` 直线
 * - `curve`    二次贝塞尔，控制点从中点往垂直方向拱出去
 * - `elbow`    折线：每条边各自一根竖段，成扇状
 * - `bracket`  括号：同父的子边共用一根竖脊，合流成一对大括号
 * - `step`     正交阶梯：水平竖直交替递进
 */

import type { GraphSpec } from './styles'
import type { Pt } from './types'

export type EdgeCurve = GraphSpec['edge']['curve']

/** 折线圆角。相邻拐点太近时圆角自动缩小，不会画出一团麻花。 */
export function roundedPolyline(pts: Pt[], radius = 12): string {
  if (pts.length < 2) return ''
  const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y)
  const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1]
    const c = pts[i]
    const n = pts[i + 1]
    const dpc = dist(p, c)
    const dcn = dist(c, n)
    // 拐点两边的可用长度各一半取小
    const r = Math.min(radius, dpc / 2, dcn / 2)
    if (r < 0.6) {
      d += ` L ${c.x.toFixed(2)} ${c.y.toFixed(2)}`
      continue
    }
    const a = lerp(c, p, r / (dpc || 1))
    const b = lerp(c, n, r / (dcn || 1))
    d += ` L ${a.x.toFixed(2)} ${a.y.toFixed(2)} Q ${c.x.toFixed(2)} ${c.y.toFixed(2)} ${b.x.toFixed(2)} ${b.y.toFixed(2)}`
  }
  const last = pts[pts.length - 1]
  d += ` L ${last.x.toFixed(2)} ${last.y.toFixed(2)}`
  return d
}

/**
 * 连线的 `d`。五种形态各一个公式，别让它们在 JSX 里缠成一团。
 *
 * @param spineX 括号式的共用竖脊 x（由父节点分组算出，见 Graph2D 的 bracketSpine）；
 *               其余形态忽略它。**同一根脊要喂给同父的所有子边** —— 这是括号与折线的
 *               唯一区别：折线每条边各自取中点，子节点一多就成了扇子。
 */
export function edgePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  curve: EdgeCurve,
  spineX?: number,
): string {
  if (curve === 'curve') {
    // 控制点取中点再往垂直方向拱出去一点，拱的幅度按长度比例给 ——
    // 短连线几乎是直线，长连线才有明显的弧。
    const mx = (x1 + x2) / 2
    const my = (y1 + y2) / 2
    const nx = -(y2 - y1)
    const ny = x2 - x1
    const len = Math.hypot(nx, ny) || 1
    const k = Math.min(70, len * 0.16)
    return `M ${x1} ${y1} Q ${mx + (nx / len) * k} ${my + (ny / len) * k} ${x2} ${y2}`
  }
  if (curve === 'elbow') {
    const mid = (x1 + x2) / 2
    return roundedPolyline(
      [{ x: x1, y: y1 }, { x: mid, y: y1 }, { x: mid, y: y2 }, { x: x2, y: y2 }],
      10,
    )
  }
  if (curve === 'bracket') {
    const sx = spineX ?? (x1 + x2) / 2
    return roundedPolyline(
      [{ x: x1, y: y1 }, { x: sx, y: y1 }, { x: sx, y: y2 }, { x: x2, y: y2 }],
      14,
    )
  }
  if (curve === 'step') {
    // 竖直方向切成 n 段，水平方向首尾各半格、中间整格 ——
    // 走完的总位移正好等于起点到终点的位移。
    const dy = y2 - y1
    const n = Math.max(2, Math.min(5, Math.round(Math.abs(dy) / 55)))
    const hx = x2 - x1
    const pts: Pt[] = [{ x: x1, y: y1 }]
    let cx = x1
    for (let i = 0; i < n; i++) {
      cx += i === 0 || i === n - 1 ? hx / (2 * n) : hx / n
      pts.push({ x: cx, y: y1 + (dy * (i + 1)) / n })
    }
    pts.push({ x: x2, y: y2 })
    return roundedPolyline(pts, 8)
  }
  return `M ${x1} ${y1} L ${x2} ${y2}`
}
