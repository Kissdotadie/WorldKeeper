import type { EntityMeta } from '../api/types'

/** 把 ISO 时间显示成「9月30日 17:42」。 */
export function shortTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 无标签时给一个稳定但不好看的占位。 */
export function typeColorVar(type: string): string {
  return `var(--type-${type}, var(--text-muted))`
}

/** 按类型分组，组内按名字排序。 */
export function groupByType(items: EntityMeta[]): Map<string, EntityMeta[]> {
  const map = new Map<string, EntityMeta[]>()
  for (const item of items) {
    const bucket = map.get(item.type)
    if (bucket) bucket.push(item)
    else map.set(item.type, [item])
  }
  for (const bucket of map.values()) {
    bucket.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }
  return map
}

/** 把「主角, 武道」这类输入拆成数组。 */
export function splitList(text: string): string[] {
  return text
    .split(/[,，、;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 把 [[双链]] 标记去掉，只留显示名。 */
export function stripLinks(text: string): string {
  return text.replace(/\[\[([^[\]]+)\]\]/g, '$1')
}

/** 提取一行里的 [[双链]] 目标名。 */
export function extractLinks(text: string): string[] {
  const out: string[] = []
  const re = /\[\[([^[\]]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const name = m[1].trim()
    if (name) out.push(name)
  }
  return out
}

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
}

export function modKey(): string {
  return isMac() ? '⌘' : 'Ctrl'
}
