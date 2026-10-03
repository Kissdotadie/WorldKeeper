/**
 * 极简「行窗口化」。
 *
 * 只做一件事：给定「总行数 + 行高 + 滚动位置」，算出该渲染哪一段，以及
 * 上下各垫多高的空行。库里几百上千条实体时，全量铺 DOM 会让整个界面滚动掉帧
 * —— 而表格行是等高的，窗口化本质上就是一个除法，不需要引依赖（也少一层协议审查）。
 *
 * 用法：把滚动容器的 ref 传进来，自己渲染 `[first, last)` 那一段。
 */

import { useEffect, useState, type RefObject } from 'react'

export interface VirtualWindow {
  /** 该渲染的第一行下标（含） */
  first: number
  /** 该渲染的最后一行下标（不含） */
  last: number
  /** 上方占位高度 */
  padTop: number
  /** 下方占位高度 */
  padBottom: number
}

export function useVirtualWindow(
  scrollRef: RefObject<HTMLElement | null>,
  count: number,
  rowHeight: number,
  overscan = 8,
): VirtualWindow {
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(0)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    // 滚动事件高频触发，用 rAF 压到每帧最多一次 setState
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        setScrollTop(el.scrollTop)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })

    const sync = () => setViewH(el.clientHeight)
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)

    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [scrollRef])

  // 行高为 0 或未测得时先按 1 兜底，免得除零算出 NaN
  const rh = rowHeight > 0 ? rowHeight : 1

  const first = Math.max(0, Math.floor(scrollTop / rh) - overscan)
  const last = Math.min(count, Math.ceil((scrollTop + viewH) / rh) + overscan)
  const total = count * rh

  return {
    first,
    last,
    padTop: first * rh,
    padBottom: Math.max(0, total - last * rh),
  }
}
