/**
 * 变高「块」窗口化 —— 虚拟滚动的**动态高度档**（P11-B3）。
 *
 * 什么时候用它：一屏里每一「块」的高度**不一样**，或者高度要**等渲染出来才知道**
 * （卡片栅格：一行几张卡由容器宽度决定、卡片本身高度也随内容变）。
 * 这种情况 `useVirtualWindow` 那套「总高 = 行数 × 行高」的除法不成立 ——
 * 它只有**定高**那一档，给表格用。
 *
 * ## 它怎么算（不猜，量）
 * 1. 把内容摊成**一串块**（`blocks`），每块有 `kind` 和稳定的 `key`；
 * 2. 每块**各自量**自己的外高（含 margin），按 `key` 存进一张表；
 *    没量到之前用 `estimate[kind]` 兜底。
 * 3. 每块的偏移 = 前面所有块的高度累加；只渲染视口里（上下各多留
 *    `overscan` 块）的那一段，上下各垫一个空 div 撑高度。
 *
 * ## 为什么逐块量、而不是按 kind 量一次
 * 第一版按 kind 量「第一块」—— 上线即翻车：卡片行的高度**本来就不一样**
 * （有的卡有别名、有的摘更长），A 行量到 120 写进共享槽、B 行量到 102
 * 又覆盖回去，内联 ref 每次渲染都重挂，就这样无限乒乓，
 * 50 次嵌套更新后 React 直接 #185 罢工（真书 366 条一打开就崩）。
 * 逐块量之后每块只对自己的高度负责，天然收敛。
 *
 * ## 量测为什么在 rAF 里做
 * ref 回调在 commit 期触发，在那里 setState 属于「嵌套更新」——
 * 哪怕只更新一次也会被 React 计数。挪进 rAF 就是普通的异步更新，
 * 从机制上杜绝 #185 这一整类事故。
 *
 * ## 一个必须知道的取舍
 * 内容一换（切类型、改筛选、改分组），块的 key 就变了，量高表随之作废，
 * 中间有一帧用的是估高，表现为滚动条跳一下。这是所有虚拟列表都有的现象；
 * `estimate` 给准一点能减轻。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'

export interface VirtualWindow {
  /** 该渲染的第一块下标（含） */
  first: number
  /** 该渲染的最后一块下标（不含） */
  last: number
  /** 上方占位高度 */
  padTop: number
  /** 下方占位高度 */
  padBottom: number
  /** 全部块的总高（撑滚动条用，也可用来核对量得准不准） */
  totalHeight: number
}

export interface BlockLike {
  kind: string
  /** 块的稳定标识：量出来的高度按它存。内容一换 key 就换，量高表随之作废 */
  key: string
}

/** 从任意元素往上找最近的滚动容器（面板体是 `.panel__body`：overflow auto） */
function resolveScroller(anchor: HTMLElement | null): HTMLElement | null {
  let p = anchor?.parentElement ?? null
  while (p) {
    const oy = getComputedStyle(p).overflowY
    if (oy === 'auto' || oy === 'scroll') return p
    p = p.parentElement
  }
  return null
}

export function useVirtualBlocks<B extends BlockLike>(
  anchorRef: RefObject<HTMLElement | null>,
  blocks: B[],
  opts: {
    /** 各 kind 的**估**高（量到之前的兜底；给得接近真实值，第一帧的滚动条就不会跳） */
    estimate: Record<string, number>
    overscan?: number
  },
): VirtualWindow & {
  /** 给块挂 ref：`ref={vw.refFor(b.key)}`。回调按 key 缓存，只在挂载/卸载时触发 */
  refFor: (key: string) => (el: HTMLElement | null) => void
} {
  const { estimate, overscan = 3 } = opts
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(0)
  /** 逐块实测外高（含 margin）。放 ref 不放 state：量测批量落地后用 version 戳统一触发重算 */
  const heights = useRef(new Map<string, number>())
  const [version, setVersion] = useState(0)

  // 滚动容器挂载后才知道（面板可能刚被拖出来），所以存 state 触发重算。
  // blocks 变了也重找一次：面板可能被关掉重开，旧的容器已经不在文档里了。
  useEffect(() => {
    setScroller((cur) => {
      const next = resolveScroller(anchorRef.current)
      return next === cur ? cur : next
    })
  }, [anchorRef, blocks])

  useEffect(() => {
    if (!scroller) return
    // 「滚动条出现 → 变窄 → 列数变 → 总高变 → 滚动条消失」是个经典反馈环。
    // scrollbar-gutter 把槽位永远留住，宽度不再随滚动条有无而抖。
    try { scroller.style.scrollbarGutter = 'stable' } catch { /* 老浏览器忽略 */ }
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        setScrollTop(scroller.scrollTop)
      })
    }
    const sync = () => {
      setViewH(scroller.clientHeight)
      setScrollTop(scroller.scrollTop)
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(scroller)
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      ro.disconnect()
      scroller.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [scroller])

  // ---------------------------------------------------------------- 量测
  const els = useRef(new Map<string, HTMLElement>())
  const rafPending = useRef(0)

  const runMeasure = useCallback(() => {
    rafPending.current = 0
    let changed = false
    for (const [key, el] of els.current) {
      if (!el.isConnected) continue
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      // 外高要含上下 margin —— getBoundingClientRect 不算 margin，
      // 而块与块的间隔正是用 margin 做的，漏掉它总高就会越算越短
      const h = r.height + parseFloat(cs.marginTop || '0') + parseFloat(cs.marginBottom || '0')
      if (h > 0 && Math.abs((heights.current.get(key) ?? 0) - h) > 1) {
        heights.current.set(key, Math.round(h))
        changed = true
      }
    }
    if (changed) setVersion((v) => v + 1)
  }, [])

  const refCache = useRef(new Map<string, (el: HTMLElement | null) => void>())
  const refFor = useCallback((key: string) => {
    let cb = refCache.current.get(key)
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        if (el) {
          els.current.set(key, el)
          if (!rafPending.current) rafPending.current = requestAnimationFrame(runMeasure)
        } else {
          els.current.delete(key)
        }
      }
      refCache.current.set(key, cb)
    }
    return cb
  }, [runMeasure])

  // 块换了（筛选/分组/换类型）之后，量高表和 ref 缓存里只剩当前块用得上的
  const keys = useMemo(() => new Set(blocks.map((b) => b.key)), [blocks])
  useEffect(() => {
    for (const k of heights.current.keys()) if (!keys.has(k)) heights.current.delete(k)
    for (const k of refCache.current.keys()) {
      if (!keys.has(k)) {
        refCache.current.delete(k)
        els.current.delete(k)
      }
    }
  }, [keys])

  // ---------------------------------------------------------------- 前缀高度表
  const starts = new Array<number>(blocks.length + 1)
  starts[0] = 0
  let acc = 0
  for (let i = 0; i < blocks.length; i++) {
    const h = heights.current.get(blocks[i].key) ?? estimate[blocks[i].kind] ?? 0
    acc += (h > 0 ? h : 1)
    starts[i + 1] = acc
  }
  void version // 量高落地后靠它触发本组件重算

  const totalHeight = starts[blocks.length] ?? 0
  // 视口上下各多留几块。用第一块的块高做尺度（它总是已渲染、量得到的那个）
  const unit = (starts[1] ?? 0) || 120
  const top = Math.max(0, scrollTop - overscan * unit)
  const bottom = scrollTop + (viewH || 600) + overscan * unit

  // 线性扫。几千块也就几千次比较，不值得为它上二分再引入边界 bug。
  let first = 0
  while (first < blocks.length && starts[first + 1] <= top) first++
  let last = first
  while (last < blocks.length && starts[last] < bottom) last++
  if (last <= first && blocks.length) last = Math.min(blocks.length, first + 1)

  return {
    first,
    last,
    padTop: starts[first] ?? 0,
    padBottom: Math.max(0, totalHeight - (starts[last] ?? 0)),
    totalHeight,
    refFor,
  }
}
