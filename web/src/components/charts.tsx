/** 图元库（P4.7）—— 汇总页数据看板用的四个零件，全部**纯 CSS / SVG，零依赖**。
 *
 * 为什么不引 ECharts / recharts：这一页的图形简单到用不上图表库（环形、柱、
 * 色带、数字），而图表库的体积、它自己的主题系统、以及「一进页面就起一个常驻
 * 渲染循环」的脾气，恰好都是我们要躲开的东西。这里的四个零件加起来不到 300 行，
 * 且**全部在挂载时播一次就静止**——没有任何常驻的 rAF。
 *
 * 铁律：**动画只为「读得出来」服务，不为炫技服务**。
 * - 所有动效都尊重 `prefers-reduced-motion`（系统开了减少动效就直接出终值）
 * - 数字滚动只跑一次、跑完即停；柱子的长高是一次 CSS transition，不是逐帧
 * - 交互高亮全交给 CSS（`:hover`），不进 React 状态的地方就别进
 */

import { useEffect, useRef, useState } from 'react'
import { typeColorVar } from '../lib/format'

// ---------------------------------------------------------------------------
// 1. 大数字
// ---------------------------------------------------------------------------

/** 数字滚动：从当前位置滚到目标值，跑完就停（不常驻）。
 *  用 easeOutCubic —— 前快后慢，收尾时能「看清最终数字」。 */
export function CountUp({
  value,
  ms = 900,
  className,
  format,
}: {
  value: number
  ms?: number
  className?: string
  /** 怎么把数字变成字。**取整由它自己负责** —— 见下面那条注释。 */
  format?: (n: number) => string
}) {
  const [shown, setShown] = useState(value)
  const fromRef = useRef(value)
  const rafRef = useRef(0)

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const from = fromRef.current
    const to = value
    if (reduce || from === to) {
      setShown(to)
      fromRef.current = to
      return
    }
    const t0 = performance.now()
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms)
      const e = 1 - Math.pow(1 - k, 3)
      const v = from + (to - from) * e
      setShown(v)
      if (k < 1) rafRef.current = requestAnimationFrame(step)
      else fromRef.current = to
    }
    rafRef.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(rafRef.current)
  }, [value, ms])

  // ⚠️ 不要在这里统一舍入。默认格式器自己 `Math.round`（避免 405.99999 这种
  // 中间态），但带小数的指标必须拿到**原始值** —— 在组件里先 round 一次，
  // 平均完备度 3.01 会被压成 3.00，而且怎么调都看不出来错在哪。
  const fmt = format ?? ((n: number) => Math.round(n).toLocaleString('zh-CN'))
  return <span className={className}>{fmt(shown)}</span>
}

// ---------------------------------------------------------------------------
// 2. 环形分布
// ---------------------------------------------------------------------------

export interface Slice {
  key: string
  label: string
  value: number
  /** 实体类型 key：给了就用全局类型色（`--type-*`），保证和别处一致 */
  entityType?: string
  color?: string
}

/** 一条色/弧取什么颜色：显式色 > 实体类型色 > 中性色。
 *  刻意不给「按序号轮换调色板」—— 同一个类型在环形图、色带、排行榜里
 *  必须是同一个颜色，否则这张板子就成了每个图各说各话。 */
function sliceColor(s: Slice): string {
  if (s.color) return s.color
  if (s.entityType) return typeColorVar(s.entityType)
  return 'var(--text-muted)'
}

/** 环形分布。用 stroke-dasharray 画弧 —— 比拼 path 的弧线少一堆三角函数和
 *  浮点误差，改宽度也不用重算。总数为 0 时画一圈灰底，不留空。 */
export function Donut({
  slices,
  size = 176,
  thickness = 20,
  onPick,
}: {
  slices: Slice[]
  size?: number
  thickness?: number
  onPick?: (s: Slice) => void
}) {
  const [hover, setHover] = useState<string | null>(null)
  const total = slices.reduce((a, s) => a + s.value, 0)
  const r = (size - thickness) / 2
  const C = 2 * Math.PI * r
  const cx = size / 2

  // 悬停时把其余弧压暗，而不是把当前弧加亮 —— 加亮会让颜色偏离类型色，
  // 压暗则保证「选中的那条颜色永远是它在色带里的那条颜色」。
  const dim = (key: string) => (hover && hover !== key ? 0.18 : 1)

  let acc = 0
  const arcs = slices
    .filter((s) => s.value > 0)
    .map((s) => {
      const len = total ? (s.value / total) * C : 0
      // 相邻弧之间留 1px 缝，边界看得清（不是靠描边，是靠留白）
      const seg = { ...s, offset: acc, len: Math.max(0, len - 1) }
      acc += len
      return seg
    })

  const hit = slices.find((s) => s.key === hover)

  return (
    <div className="donut" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="类型分布环形图">
        <g transform={`rotate(-90 ${cx} ${cx})`}>
          <circle
            cx={cx}
            cy={cx}
            r={r}
            fill="none"
            strokeWidth={thickness}
            style={{ stroke: 'var(--border-subtle)' }}
          />
          {arcs.map((a) => (
            <circle
              key={a.key}
              cx={cx}
              cy={cx}
              r={r}
              fill="none"
              strokeWidth={hover === a.key ? thickness + 3 : thickness}
              strokeDasharray={`${a.len} ${C - a.len}`}
              strokeDashoffset={-a.offset}
              style={{
                stroke: sliceColor(a),
                opacity: dim(a.key),
                transition: 'opacity .18s ease, stroke-width .18s ease',
                cursor: onPick ? 'pointer' : undefined,
              }}
              onMouseEnter={() => setHover(a.key)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onPick?.(a)}
            />
          ))}
        </g>
      </svg>
      <div className="donut__center">
        <div className="donut__num mono">
          {total === 0 ? '—' : (hit?.value ?? total).toLocaleString('zh-CN')}
        </div>
        <div className="donut__label ellipsis">{total === 0 ? '暂无数据' : (hit?.label ?? '合计')}</div>
        {hit && total > 0 && (
          <div className="donut__pct mono">{((hit.value / total) * 100).toFixed(1)}%</div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 3. 柱 / 条
// ---------------------------------------------------------------------------

export interface BarItem {
  key: string
  label: string
  value: number
  entityType?: string
  /** 悬停时补一句说明（例如「完备 4 分：摘要+标签+出场+关系」） */
  hint?: string
}

/** 柱状（col）与条形（row）共用一个零件。
 *
 *  两种朝向各有一处「必须有」的细节：
 *  - col：**纵轴从 0 起**并标一个刻度上限 —— 不这么干，5 和 4 看起来会差一倍
 *  - row：数值右对齐等宽字体，扫一眼就能比大小 */
export function Bars({
  items,
  layout = 'col',
  onPick,
  colorOf,
  height = 108,
}: {
  items: BarItem[]
  layout?: 'col' | 'row'
  onPick?: (b: BarItem) => void
  colorOf?: (b: BarItem) => string
  height?: number
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce) {
      setMounted(true)
      return
    }
    const id = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const max = Math.max(1, ...items.map((i) => i.value))
  const color = (b: BarItem) =>
    colorOf?.(b) ?? (b.entityType ? typeColorVar(b.entityType) : 'var(--accent)')

  if (layout === 'row') {
    return (
      <div className="bars bars--row">
        {items.map((b) => (
          <button
            key={b.key}
            className="bars__row"
            onClick={() => onPick?.(b)}
            title={b.hint ?? `${b.label}：${b.value}`}
          >
            <span className="bars__row-label ellipsis">{b.label}</span>
            <span className="bars__row-track">
              <span
                className="bars__row-fill"
                style={{
                  width: mounted ? `${(b.value / max) * 100}%` : 0,
                  background: color(b),
                }}
              />
            </span>
            <span className="bars__row-num mono">{b.value.toLocaleString('zh-CN')}</span>
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="bars bars--col" style={{ height }}>
      <div className="bars__axis">
        <span className="bars__axis-max mono">{max.toLocaleString('zh-CN')}</span>
        <span className="bars__axis-zero mono">0</span>
      </div>
      <div className="bars__plot">
        {/* 轴线只在柱子这一层：标签必须落在轴线**下面**，塞进柱子内部的话
            横轴会从标签上方划过去，读起来像是标签压在数据里。 */}
        <div className="bars__cols">
          {items.map((b) => (
            <button
              key={b.key}
              className="bars__col"
              onClick={() => onPick?.(b)}
              title={b.hint ?? `${b.label}：${b.value}`}
            >
              <span className="bars__col-num mono">{b.value.toLocaleString('zh-CN')}</span>
              <span className="bars__col-track">
                <span
                  className="bars__col-fill"
                  style={{
                    height: mounted ? `${(b.value / max) * 100}%` : 0,
                    background: color(b),
                  }}
                />
              </span>
            </button>
          ))}
        </div>
        <div className="bars__labels">
          {items.map((b) => (
            <span key={b.key} className="bars__label" title={b.hint ?? b.label}>
              {b.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 4. 色带（100% 堆叠条）
// ---------------------------------------------------------------------------

/** 一条通栏色带：宽度即占比，扫一眼读出结构。
 *  类型占比、完备度分布、每章体量都用它 —— 同一套读法，学一次就够。 */
export function Band({
  items,
  onPick,
  thickness = 10,
  showLegend = false,
}: {
  items: Slice[]
  onPick?: (s: Slice) => void
  thickness?: number
  showLegend?: boolean
}) {
  const [hover, setHover] = useState<string | null>(null)
  const total = items.reduce((a, s) => a + s.value, 0)
  if (total === 0) return <div className="band band--empty" style={{ height: thickness }} />

  return (
    <div className="bandwrap">
      <div className="band" style={{ height: thickness }}>
        {items.map((s) => {
          if (s.value <= 0) return null
          const pct = (s.value / total) * 100
          return (
            <span
              key={s.key}
              className="band__seg"
              style={{
                width: `${pct}%`,
                background: sliceColor(s),
                opacity: hover && hover !== s.key ? 0.25 : 1,
              }}
              onMouseEnter={() => setHover(s.key)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onPick?.(s)}
              title={`${s.label} ${s.value} 条 · ${pct.toFixed(1)}%`}
            />
          )
        })}
      </div>
      {showLegend && (
        <div className="band__legend">
          {items
            .filter((s) => s.value > 0)
            .map((s) => (
              <button
                key={s.key}
                className="band__item"
                onMouseEnter={() => setHover(s.key)}
                onMouseLeave={() => setHover(null)}
                onClick={() => onPick?.(s)}
              >
                <span
                  className="band__dot"
                  style={{ background: sliceColor(s) }}
                />
                <span className="band__name ellipsis">{s.label}</span>
                <span className="band__num mono">{s.value.toLocaleString('zh-CN')}</span>
                <span className="band__pct mono">{((s.value / total) * 100).toFixed(1)}%</span>
              </button>
            ))}
        </div>
      )}
    </div>
  )
}
