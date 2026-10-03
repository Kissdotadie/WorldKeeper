/**
 * 地图层级里几件**要跨组件对齐**的小事。
 *
 * 之所以单独一个文件：`portal` 的记号、层级标签的配色、树的缩进封顶，
 * 这三样在「画布」和「左栏/右栏」里都要用同一套判定 ——
 * 各写一份就会出现「左栏写 ▼、图上写 ⇄」这种自相矛盾。
 */

import type { MapDoc } from '../api/types'

// --------------------------------------------------------------------------
// 门户（pin.portal）：区分「往下钻」和「横向跨空间」
// --------------------------------------------------------------------------

/**
 * 一条门户的三种亲缘关系。
 *
 * 原来所有门户都画 `⊞`，于是「钻进去（尺度变小）」和「横跨到另一界」
 * 在图上长得一模一样 —— 点之前不知道会发生什么。
 *
 * - `down` 目标是当前图的**子孙**（星座图 → 北境图）：进到更里面，尺度变小
 * - `up`   目标是当前图的**祖先**（北境图 → 星座图）：退回更外面
 * - `side` 两者无直系关系（凡界 ↔ 神界 ↔ 地狱）：换一界，尺度不变
 *
 * 「上钻」主要是面包屑的活儿，但门户也可能指回上层，那时记号必须说实话。
 */
export type PortalKind = 'down' | 'up' | 'side'

export const PORTAL_META: Record<PortalKind, { glyph: string; short: string; hint: string }> = {
  down: { glyph: '▼', short: '钻进去', hint: '跳到下一层（更小尺度的图）' },
  up: { glyph: '▲', short: '回外层', hint: '跳回上一层（更大尺度的图）' },
  side: { glyph: '⇄', short: '跨空间', hint: '跳到同一层级的另一张图（世界之间互通）' },
}

/** 从 `from` 出发，看 `to` 是它的子孙、祖先，还是旁系。 */
export function portalKindOf(
  maps: Record<string, MapDoc>,
  fromId: string | null | undefined,
  toId: string | null | undefined,
): PortalKind | null {
  if (!fromId || !toId || fromId === toId) return null

  /** 沿 parent 往上爬，看能不能爬到 who。带 guard 防手改出的环 */
  const ancestorsOf = (id: string): Set<string> => {
    const out = new Set<string>()
    let cur: string | undefined = maps[id]?.parent ?? undefined
    let guard = 0
    while (cur && guard++ < 64) {
      if (out.has(cur)) break
      out.add(cur)
      cur = maps[cur]?.parent ?? undefined
    }
    return out
  }

  if (ancestorsOf(toId).has(fromId)) return 'down'
  if (ancestorsOf(fromId).has(toId)) return 'up'
  return 'side'
}

// --------------------------------------------------------------------------
// 层级标签：自由文本 → 稳定配色
// --------------------------------------------------------------------------

/**
 * 层级文本 → 色相。同一条文本永远同一个颜色（哈希决定），
 * 于是「房间」在左栏任何位置都是同一种颜色，扫一眼就能认。
 *
 * 只给**边框与底衬**上色，文字仍用主题文字色 —— 这样明暗两套主题都读得清，
 * 不必为配色维护两份色板。
 */
export function levelHue(level: string): number {
  let h = 0
  for (let i = 0; i < level.length; i++) h = (h * 31 + level.charCodeAt(i)) % 360
  return h
}

export function levelTint(level: string, alpha: number): string {
  return `hsl(${levelHue(level)} 52% 52% / ${alpha})`
}

// --------------------------------------------------------------------------
// 树的缩进
// --------------------------------------------------------------------------

/** 每层缩进像素 */
export const TREE_INDENT = 14

/**
 * 缩进封顶的层数。第 5 层往后不再往右挪 ——
 * 左栏只有 220px，7 层按 14px/层 要吃 98px，标题就没地方了。
 * 深层的层级关系改由「层级标签」和面包屑表达。
 */
export const TREE_MAX_INDENT_DEPTH = 4

export function treePadLeft(depth: number): number {
  return 6 + Math.min(depth, TREE_MAX_INDENT_DEPTH) * TREE_INDENT
}
