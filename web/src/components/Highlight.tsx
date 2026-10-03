/** 命中高亮：按后端给的下标区间把文字包成 `<mark>`。
 *
 * **为什么不用 `dangerouslySetInnerHTML`**：片段来自用户自己写的正文/摘要。
 * 一旦把后端返回的字符串当 HTML 塞进去，正文里一句 `<img src=x onerror=...>`
 * 就成了注入面 —— 而这个工具的正文是**作者的稿子**，不是可信模板。
 * 所以后端只返回「纯文本片段 + 命中区间」，这里按区间切片、用 React 节点渲染，
 * 全程不碰 innerHTML。
 *
 * 顺带一个好处：作者在摘要里真写了 `<mark>` 四个字，也只是四个字，
 * 不会被误当成标记。
 */

import type { ReactElement } from 'react'

/** 命中区间：[起, 止)，相对 text 的字符下标。 */
export type Span = [number, number]

export function Highlight({
  text,
  spans,
  className,
}: {
  text: string
  spans?: Span[] | null
  className?: string
}): ReactElement {
  const body = text ?? ''
  const list = (spans ?? []).filter(([a, b]) => a >= 0 && b > a && a < body.length)
  if (!list.length) return <span className={className}>{body}</span>

  const nodes: (string | ReactElement)[] = []
  let at = 0
  list.forEach(([a, b], i) => {
    const start = Math.max(at, Math.min(a, body.length))
    const end = Math.max(start, Math.min(b, body.length))
    if (start > at) nodes.push(body.slice(at, start))
    if (end > start) nodes.push(<mark key={i}>{body.slice(start, end)}</mark>)
    at = end
  })
  if (at < body.length) nodes.push(body.slice(at))
  return <span className={className}>{nodes}</span>
}

/** 「把这段文字里的这些词标出来」—— 给**前端自己过滤**的列表用。
 *
 * 桌面端列表是拿已加载的实体在内存里筛的（千条量级，即时反馈，不用等接口），
 * 那条路没有后端 spans 可用，所以在这里就地算一份。
 * 口径与后端一致：按词分别找、允许大小写不敏感、重叠合并。
 */
export function spansOf(text: string, terms: string[]): Span[] {
  const body = text ?? ''
  const low = body.toLowerCase()
  const hits: Span[] = []
  for (const t of terms) {
    const tl = (t ?? '').toLowerCase()
    if (!tl) continue
    let i = low.indexOf(tl)
    while (i >= 0) {
      hits.push([i, i + tl.length])
      i = low.indexOf(tl, i + 1)
    }
  }
  hits.sort((x, y) => x[0] - y[0] || x[1] - y[1])
  const merged: Span[] = []
  for (const [a, b] of hits) {
    const last = merged[merged.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }
  return merged
}

/** 查询串 → 词。与后端 `store._terms` 同一口径：空白分词。 */
export function termsOf(query: string): string[] {
  return (query ?? '').split(/\s+/).filter(Boolean)
}
