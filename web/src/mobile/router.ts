/**
 * 移动端极简路由。
 *
 * 只用 hash，不碰后端路由表 —— 理由很实际：这个前端可能跑在
 * Vite dev server（5173）也可能由 FastAPI 托管，路径形态两边不一致，
 * 而 hash 在两边都一定生效、刷新一定不 404。
 *
 * 入口是 `/m`，内部路由长这样：
 *   /m#/                 搜索
 *   /m#/roster           名册
 *   /m#/timeline         时间线
 *   /m#/foreshadow       伏笔
 *   /m#/chapters         章节
 *   /m#/chapter/12       某一章正文
 *   /m#/entity/char-0001 实体卡片
 */

export type MTab = 'search' | 'roster' | 'timeline' | 'foreshadow' | 'chapters'

export type MRoute =
  | { name: MTab }
  | { name: 'chapter'; no: number }
  | { name: 'entity'; id: string }

/** 底部标签栏顺序。同时也是「按序号跳转」的顺序。 */
export const M_TABS: { key: MTab; label: string; icon: string }[] = [
  { key: 'search', label: '搜索', icon: '🔍' },
  { key: 'roster', label: '名册', icon: '📇' },
  { key: 'timeline', label: '时间线', icon: '🕰' },
  { key: 'foreshadow', label: '伏笔', icon: '🪢' },
  { key: 'chapters', label: '章节', icon: '📖' },
]

/** 把 hash 解析成路由。认不出来的都退回搜索 —— 手机上手输地址是常态，别给 404。 */
export function parseHash(hash: string): MRoute {
  const raw = (hash || '').replace(/^#\/?/, '').replace(/\/+$/, '')
  if (!raw) return { name: 'search' }
  const [head, ...rest] = raw.split('/')
  const tail = rest.join('/')
  switch (head) {
    case 'roster':
    case 'timeline':
    case 'foreshadow':
    case 'chapters':
      return { name: head }
    case 'chapter': {
      const no = Number(tail)
      return Number.isFinite(no) && no > 0 ? { name: 'chapter', no } : { name: 'chapters' }
    }
    case 'entity':
      return tail ? { name: 'entity', id: decodeURIComponent(tail) } : { name: 'search' }
    default:
      return { name: 'search' }
  }
}

export function routeToHash(r: MRoute): string {
  switch (r.name) {
    case 'chapter':
      return `#/chapter/${r.no}`
    case 'entity':
      return `#/entity/${encodeURIComponent(r.id)}`
    case 'search':
      return '#/'
    default:
      return `#/${r.name}`
  }
}

/** 当前路由属于哪个标签页（子页面沿用来源标签，底栏不跳）。 */
export function tabOf(r: MRoute): MTab | null {
  return r.name === 'chapter' || r.name === 'entity' ? null : r.name
}

/**
 * 跳转。改 hash 就够 —— `hashchange` 会触发顶层重渲。
 *
 * 之所以不做 pushState：这个前端既可能跑在 Vite dev server，也可能被
 * FastAPI 直接托管，两边的路径基址不同；hash 在两边都一定生效。
 */
export function go(r: MRoute): void {
  const next = routeToHash(r)
  if (window.location.hash === next) return
  window.location.hash = next
}

/** 返回上一页。没有历史就退回某个标签页 —— 手机上手势返回不该掉出应用。 */
export function back(fallback: MRoute = { name: 'search' }): void {
  if (window.history.length > 1) window.history.back()
  else go(fallback)
}

