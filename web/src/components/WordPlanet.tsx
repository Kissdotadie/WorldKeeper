/**
 * 词汇星球（P9 ⑧）：把整本书的**高频关键字**与**枢纽实体**投影到一颗匀速自转的球上。
 *
 * 为什么手写 canvas 而不是上 three：
 * - 它只是汇总页里一块装饰性的数据图，不是可以走进去的三维场景；为一个
 *   六十来个词拉起 three 的初始化不值当
 * - 颜色来自 CSS 变量，canvas 里必须先解析成具体色值 —— 和 `charts.tsx` 一套路子
 * - 面板多开时同页还挂着别的图，再塞一个 WebGL 上下文会顶到浏览器上限
 *
 * 与汇总页那条「不动画到底」的关系：这一块**必须一直转**（用户点名要「不断转动
 * 的星球」），但只在可见时转 —— 面板切走、页签隐藏、滚出视野就停 rAF，
 * 不在后台烧电。系统开了「减少动态效果」就整个静止，只出一帧。
 *
 * 球面分布用斐波那契（黄金角）撒点：随机撒会结块，经纬网格会露出条文，
 * 斐波那契是唯一既均匀又看不出规律的做法。
 */

import { useEffect, useMemo, useRef } from 'react'

export interface PlanetWord {
  key: string
  text: string
  /** 权重，决定字号（标签用出现次数，实体用连接数，类型用占比） */
  weight: number
  /** CSS 颜色，可以是 `var(--type-character)` —— 组件内部会解析成具体值 */
  color: string
  kind: 'type' | 'tag' | 'entity'
  /** kind='entity' 时带上实体 id，点击才能跳过去 */
  entityId?: string
}

interface Props {
  words: PlanetWord[]
  size?: number
  /**
   * 主题/配色指纹。它一变，缓存下来的颜色就要重取 —— 切主题时 CSS 变量
   * 换了值，而 canvas 拿到的是**当时**的字符串，不重取就成了旧主题的颜色。
   */
  colorKey?: string
  onPick?: (w: PlanetWord) => void
}

/** 黄金角 —— 斐波那契球面分布的步进 */
const GOLDEN = Math.PI * (3 - Math.sqrt(5))

/** 挂在 `window.__planet` 上的调试快照（自动验收用） */
interface PlanetDebug {
  angle: number
  words: { x: number; y: number; text: string; kind: PlanetWord['kind'] }[]
}

/** 一圈转多久（秒）。太快看不清词，太慢像卡住了。 */
const SPIN_SECONDS = 26

/** `var(--x)` → 具体色值。非变量（`#abc` / `rgb()`）原样返回。 */
function resolveColor(css: string, cache: Map<string, string>): string {
  const key = css.trim()
  const hit = cache.get(key)
  if (hit) return hit
  const m = /^var\((--[a-zA-Z0-9_-]+)/.exec(key)
  let out = key
  if (m) {
    out = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || '#8fa3d4'
  }
  cache.set(key, out)
  return out
}

export function WordPlanet({ words, size = 340, colorKey = '', onPick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // 上一帧每个词的屏幕位置 —— 点击命中判定用，不参与渲染
  const hitsRef = useRef<{ x: number; y: number; w: PlanetWord }[]>([])

  // 颜色缓存挂 colorKey：主题一换整个重来
  const colors = useMemo(() => {
    const cache = new Map<string, string>()
    void colorKey
    return words.map((w) => resolveColor(w.color, cache))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words, colorKey])

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || !words.length) return
    const ctx = cv.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 1.5) // 与 P4.5.5 一致：像素比封顶
    cv.width = Math.round(size * dpr)
    cv.height = Math.round(size * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const family = getComputedStyle(document.body).fontFamily || 'sans-serif'
    const ringColor = resolveColor('var(--border-strong)', new Map())
    const glowColor = resolveColor('var(--accent)', new Map())

    const cx = size / 2
    const cy = size / 2
    const R = size * 0.4
    const scaleBase = size / 340
    const maxW = Math.max(1, ...words.map((w) => w.weight))
    const tilt = 0.42 // 略微前倾，比正对着看更像一颗球

    // 单位球面撒点
    const pts = words.map((_, i) => {
      const y = words.length === 1 ? 0 : 1 - (i / (words.length - 1)) * 2
      const r = Math.sqrt(Math.max(0, 1 - y * y))
      const th = i * GOLDEN
      return { x: Math.cos(th) * r, y, z: Math.sin(th) * r }
    })

    let raf = 0
    let angle = 0
    let last = performance.now()
    let visible = true

    const frame = (t: number) => {
      const dt = Math.min(0.06, (t - last) / 1000)
      last = t
      if (!reduce) angle += (dt * Math.PI * 2) / SPIN_SECONDS

      ctx.clearRect(0, 0, size, size)

      // 球体轮廓 + 一点点辉光，让「星球」这件事一眼看出来
      ctx.globalAlpha = 0.16
      ctx.strokeStyle = ringColor
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(cx, cy, R * 1.03, 0, Math.PI * 2)
      ctx.stroke()
      const glow = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.25)
      glow.addColorStop(0, glowColor)
      glow.addColorStop(1, 'transparent')
      ctx.globalAlpha = 0.07
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(cx, cy, R * 1.25, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1

      const ca = Math.cos(angle)
      const sa = Math.sin(angle)
      const ct = Math.cos(tilt)
      const st = Math.sin(tilt)

      // 先自转（Y 轴）再前倾（X 轴），最后按 z 排序 —— 近的词画在上面
      const order = pts
        .map((p, i) => {
          const x1 = p.x * ca + p.z * sa
          const z1 = -p.x * sa + p.z * ca
          return { i, x: x1, y: p.y * ct - z1 * st, z: p.y * st + z1 * ct }
        })
        .sort((a, b) => a.z - b.z)

      const hits: { x: number; y: number; w: PlanetWord }[] = []
      for (const p of order) {
        const depth = 2.4 / (2.4 - p.z) // 越靠前越大
        const sx = cx + p.x * R * depth
        const sy = cy + p.y * R * depth
        const w = words[p.i]
        const near = (p.z + 1) / 2 // 0=最远 1=最近
        const fs = (8 + (w.weight / maxW) * 9) * scaleBase * (0.72 + depth * 0.34)
        const weight = w.kind === 'tag' ? 400 : 600

        ctx.globalAlpha = 0.2 + near * 0.8
        ctx.fillStyle = colors[p.i]
        ctx.font = `${weight} ${fs.toFixed(1)}px ${family}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(w.text, sx, sy)
        hits.push({ x: sx, y: sy, w })
      }
      ctx.globalAlpha = 1
      hitsRef.current = hits
      // 调试口（同 Graph3D 的 `__g3dState`）：外面能读到每个词这一帧落在哪，
      // 自动验收才算得出「点这个词会不会跳对地方」、以及球到底转没转。
      ;(window as unknown as { __planet?: PlanetDebug }).__planet = {
        angle,
        words: hits.map((h) => ({ x: h.x, y: h.y, text: h.w.text, kind: h.w.kind })),
      }

      if (visible && !document.hidden) raf = requestAnimationFrame(frame)
    }

    raf = requestAnimationFrame(frame)

    // 只在可见时转：面板被切走就停
    const io = new IntersectionObserver(
      (entries) => {
        const on = entries.some((e) => e.isIntersecting)
        if (on === visible) return
        visible = on
        if (on) {
          last = performance.now()
          raf = requestAnimationFrame(frame)
        } else {
          cancelAnimationFrame(raf)
        }
      },
      { threshold: 0.05 },
    )
    io.observe(cv)

    const onVis = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf)
      } else if (visible) {
        last = performance.now()
        raf = requestAnimationFrame(frame)
      }
    }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      cancelAnimationFrame(raf)
      io.disconnect()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [words, colors, size])

  const pick = (e: React.MouseEvent) => {
    if (!onPick) return
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    let best: { d: number; w: PlanetWord } | null = null
    for (const h of hitsRef.current) {
      const d = Math.hypot(h.x - mx, h.y - my)
      // 命中半径给宽一点：字小的时候人不可能点得准，宁可点错也别点不动
      if (d < 24 && (!best || d < best.d)) best = { d, w: h.w }
    }
    if (best) onPick(best.w)
  }

  return (
    <canvas
      ref={canvasRef}
      className="planet__canvas"
      style={{ width: size, height: size, cursor: onPick ? 'pointer' : 'default' }}
      onClick={pick}
      role="img"
      aria-label="高频关键字与枢纽实体组成的星球"
    />
  )
}

export default WordPlanet
