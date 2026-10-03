/**
 * 全局快捷键注册层（P11-A2，第二梯队口子 #16）。
 *
 * 为什么要有它：以前各组件零散地 `window.addEventListener('keydown', …)` ——
 * TopBar 一份、App 一份、以后图上再加一份。结果就是：
 * ① 没人知道全局一共有哪些快捷键（帮助页没法生成）；
 * ② 两个组件抢同一个键没人发现；
 * ③ 「只在图上生效」这类作用域无从谈起。
 *
 * 用法：
 *   // 组件里声明自己的键（卸载自动注销）
 *   useShortcut({ id: 'graph.esc', keys: 'Esc', scope: 'graph', desc: '取消选中', run: () => onSelect(null) })
 *
 *   // 声明「我现在处于某个作用域」
 *   useShortcutScope('graph')
 *
 *   // 生成帮助页的键位表（P11-B2 直接吃这份数据）
 *   listShortcuts()
 */

import { useEffect } from 'react'

export type ShortcutScope = 'global' | 'graph' | 'map' | 'text' | 'form'

export interface ShortcutDef {
  /** 稳定 id。注销 / 冲突提示 / 帮助表都用它，别用运行时生成的 */
  id: string
  /** 人类可读的键位写法：`Ctrl+K` / `Esc` / `Ctrl+Shift+P` / `?` */
  keys: string
  /** 作用域：global 任何时候都生效；其余只在对应作用域激活时生效 */
  scope: ShortcutScope
  /** 干什么用的一句话（帮助表直接展示） */
  desc: string
  /** 命中时执行。想阻止浏览器默认行为就自己调 e.preventDefault() */
  run: (e: KeyboardEvent) => void
  /** 可选门槛：返回 false 就不触发（例如「仅当搜索框聚焦时」） */
  when?: () => boolean
  /**
   * 优先级，越大越先执行。默认 0。
   *
   * 为什么需要它：`Esc` 是**所有人的**键 —— 关弹窗、关浮层、退出放点模式、
   * 取消图上选中，四个都想要。以前各组件自己往 window 挂监听，
   * 按一下 Esc 会同时触发好几件事（关掉浮层的同时把选中也取消了）。
   * 有了优先级，同一按只有**一个**处理者，且顺序是明确的：
   * 浮层（100+）> 一次性模式（10）> 常规动作（0）。
   */
  priority?: number
  /**
   * 是否允许在输入框里触发。默认 false（除了 `Esc`）。
   *
   * 不带修饰键的键（`Delete`、`?`）在输入框里触发会把字吃掉；
   * 极少数确实要在输入框里生效的（比如「输入框里按 Esc 取消整条编辑」）
   * 显式打开这个开关。
   */
  inInput?: boolean
}

interface Compiled {
  def: ShortcutDef
  /** 归一化后的键位串，用于匹配与查冲突 */
  combo: string
  /** 是否带修饰键 —— 不带的键（如 `?`、`Esc`）在输入框里默认不触发 */
  bare: boolean
  /** 注册序号，用来实现「后注册者优先」（浮层叠浮层时的自然顺序） */
  seq: number
  /** 注册时的作用域 —— 解绑时用来判断要不要删掉这个 scope */
  scope: ShortcutScope
}

const registry = new Map<number, Compiled>()
let seqCounter = 0

// ---------------------------------------------------------------------------
// 键位归一化
// ---------------------------------------------------------------------------

const ALIAS: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
  ins: 'insert',
  ret: 'enter',
  return: 'enter',
  space: ' ',
  ' ': ' ',
  arrowup: 'arrowup',
  arrowdown: 'arrowdown',
  arrowleft: 'arrowleft',
  arrowright: 'arrowright',
}

function comboOf(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('mod') // mac 的 ⌘ 与 win 的 Ctrl 等价
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  parts.push(e.key.toLowerCase())
  return parts.join('+')
}

/** 把 `Ctrl+Shift+P` 这类写法归一化成与 comboOf 同一种串 */
function normalize(keys: string): { combo: string; bare: boolean } {
  const parts = keys
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  const out: string[] = []
  let mod = false
  let key = ''
  for (const raw of parts) {
    const p = raw.toLowerCase()
    if (p === 'ctrl' || p === 'cmd' || p === 'meta' || p === 'mod') {
      out.push('mod')
      mod = true
    } else if (p === 'alt' || p === 'option') {
      out.push('alt')
      mod = true
    } else if (p === 'shift') {
      out.push('shift')
      mod = true
    } else {
      key = ALIAS[p] ?? p
    }
  }
  if (!key && parts.length) key = parts[parts.length - 1].toLowerCase()
  out.push(key)
  return { combo: out.join('+'), bare: !mod }
}

// ---------------------------------------------------------------------------
// 唯一的 keydown 监听（惰性安装一次，之后注册/注销都不再动 window）
// ---------------------------------------------------------------------------

let installed = false

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

function ensureListener(): void {
  if (installed) return
  installed = true
  window.addEventListener(
    'keydown',
    (e: KeyboardEvent) => {
      const combo = comboOf(e)
      // 候选收集 → 排序 → 只跑一个。以前是「按 Map 顺序取第一个」，
      // 那等于把优先级交给了注册顺序这个偶然因素。
      const hits: Compiled[] = []
      for (const c of registry.values()) {
        if (c.combo !== combo) continue
        if (c.def.scope !== 'global' && !activeScopes.has(c.def.scope)) continue
        // 不带修饰键的键（Esc 除外）在打字时不触发 —— 按 `?` 会把字吃掉。
        // Esc 单独放行：它是「取消/关闭」的通用语义，在输入框里也该管用。
        const bare = c.bare && c.combo !== 'escape'
        if (bare && !c.def.inInput && isTypingTarget(e.target)) continue
        if (c.def.when && !c.def.when()) continue
        hits.push(c)
      }
      if (!hits.length) return
      hits.sort((a, b) => {
        const pa = a.def.priority ?? 0
        const pb = b.def.priority ?? 0
        if (pa !== pb) return pb - pa
        return b.seq - a.seq // 同优先级：后注册的赢（后开的浮层压在前一个上面）
      })
      hits[0].def.run(e)
    },
    { capture: true }, // 抢在业务自己的 keydown 之前，行为可预期
  )
}

// ---------------------------------------------------------------------------
// 注册 / 注销 / 冲突检测
// ---------------------------------------------------------------------------

export function registerShortcut(def: ShortcutDef): () => void {
  ensureListener()
  const { combo, bare } = normalize(def.keys)
  const priority = def.priority ?? 0
  // 只有「同键位 + 同作用域 + 同优先级」才算真冲突 —— 那是没法确定该跑谁的。
  // 优先级不同是**有意的**分层（浮层 > 一次性模式 > 常规动作），不该报警。
  for (const c of registry.values()) {
    if (c.combo === combo && c.def.scope === def.scope && (c.def.priority ?? 0) === priority) {
      // 不抛错 —— 一个键位冲突不该把整个界面炸掉，但必须让人看见
      console.warn(
        `[快捷键冲突] ${def.keys}（${def.scope}，priority ${priority}）` +
          `已被 ${c.def.id} 占用，新的「${def.id}」不生效`,
      )
      return () => undefined
    }
  }
  const seq = ++seqCounter
  registry.set(seq, { def, combo, bare, seq, scope: def.scope })
  catalog.set(def.id, { def, active: true })
  return () => {
    registry.delete(seq)
    // 只把「还没被别的实例接回去的」标成不活跃 —— 同一组件重挂时
    // 会先注销再注册，顺序反了就会把活的说成死的
    const cur = catalog.get(def.id)
    if (cur && cur.def === def) cur.active = false
  }
}

/** 去重后的键位表（帮助页用）。同一个 id 只留最新一次注册。 */
export function listShortcuts(): ShortcutDef[] {
  const byId = new Map<string, ShortcutDef>()
  for (const c of registry.values()) byId.set(c.def.id, c.def)
  return [...byId.values()].sort(
    (a, b) => a.scope.localeCompare(b.scope) || a.keys.localeCompare(b.keys),
  )
}

/** 真冲突（同键位 + 同作用域 + 同优先级）的 id 分组，帮助页/自检用它报红。 */
export function shortcutConflicts(): { keys: string; scope: ShortcutScope; ids: string[] }[] {
  const groups = new Map<string, { keys: string; scope: ShortcutScope; ids: string[] }>()
  for (const c of registry.values()) {
    const k = `${c.def.scope}::${c.combo}::${c.def.priority ?? 0}`
    const g = groups.get(k) ?? { keys: c.def.keys, scope: c.def.scope, ids: [] }
    g.ids.push(c.def.id)
    groups.set(k, g)
  }
  return [...groups.values()].filter((g) => g.ids.length > 1)
}

/**
 * 帮助页的展示结构：按作用域分组，作用域按「全局 → 图 → 地图 → 文本 → 表单」的
 * 常用程度排，组内按优先级从高到低。
 *
 * `Esc` 这类被多层占用的键，这里只展示**当前实际会生效**的那一条 ——
 * 帮助页写的应该是「按下去会发生什么」，不是「代码里注册了几个」。
 */
export function shortcutTable(): { scope: ShortcutScope; label: string; items: ShortcutDef[] }[] {
  const groups = new Map<ShortcutScope, Map<string, Compiled>>()
  for (const c of registry.values()) {
    const g = groups.get(c.def.scope) ?? new Map<string, Compiled>()
    const prev = g.get(c.combo)
    if (!prev || (c.def.priority ?? 0) > (prev.def.priority ?? 0) || c.seq > prev.seq) {
      g.set(c.combo, c)
    }
    groups.set(c.def.scope, g)
  }
  const order: ShortcutScope[] = ['global', 'graph', 'map', 'text', 'form']
  return order
    .filter((s) => groups.has(s))
    .map((s) => ({
      scope: s,
      label: SCOPE_LABEL[s],
      items: [...groups.get(s)!.values()]
        .map((c) => c.def)
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.keys.localeCompare(b.keys)),
    }))
}

const SCOPE_LABEL: Record<ShortcutScope, string> = {
  global: '全局',
  graph: '图（关系网 / 世界观 / 方法论 / 时间线 / 伏笔 / 地图上的节点）',
  map: '地图',
  text: '正文',
  form: '表单',
}

/**
 * 本会话里**出现过的**全部快捷键（含此刻未激活的）。
 *
 * 为什么不能直接用 `shortcutTable()` 当帮助页：快捷键是随组件挂载注册的，
 * 后台面板打开时那些图视图根本没挂载 —— 只看 live 注册表，帮助页会缺一大半，
 * 而且缺哪几条取决于你恰好开过什么，属于「越看越糊涂」。
 * 所以留一份粘性目录：注册过就记住，注销只标记 active=false。
 *
 * `active` 的含义要如实展示：false 不是「坏了」，而是「得先打开对应视图」。
 */
export function shortcutCatalog(): {
  scope: ShortcutScope
  label: string
  items: (ShortcutDef & { active: boolean })[]
}[] {
  const groups = new Map<ShortcutScope, Map<string, ShortcutDef & { active: boolean }>>()
  const put = (def: ShortcutDef, active: boolean) => {
    const g = groups.get(def.scope) ?? new Map()
    const prev = g.get(def.id)
    // 同一会话里重复注册（组件反复挂卸）时，active 以「最新一次」为准
    g.set(def.id, { ...def, active: prev ? prev.active || active : active })
    groups.set(def.scope, g)
  }
  for (const e of catalog.values()) put(e.def, e.active)
  const order: ShortcutScope[] = ['global', 'graph', 'map', 'text', 'form']
  return order
    .filter((s) => groups.has(s))
    .map((s) => ({
      scope: s,
      label: SCOPE_LABEL[s],
      items: [...groups.get(s)!.values()].sort(
        (a, b) =>
          Number(b.active) - Number(a.active) ||
          (b.priority ?? 0) - (a.priority ?? 0) ||
          a.keys.localeCompare(b.keys),
      ),
    }))
}

/** 会话目录：id → 最近一次见的定义 + 此刻是否活着 */
const catalog = new Map<string, { def: ShortcutDef; active: boolean }>()

// ---------------------------------------------------------------------------
// React 接口
// ---------------------------------------------------------------------------

/** 注册一组快捷键，组件卸载自动注销。deps 变化时重新注册。 */
export function useShortcuts(defs: ShortcutDef[], deps: unknown[] = []): void {
  useEffect(() => {
    const offs = defs.map((d) => registerShortcut(d))
    return () => offs.forEach((off) => off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

const activeScopes = new Set<string>()

/** 声明「本组件活着期间，某某作用域是激活的」（图视图声明 graph，地图声明 map…） */
export function useShortcutScope(scope: ShortcutScope): void {
  useEffect(() => {
    activeScopes.add(scope)
    return () => {
      activeScopes.delete(scope)
    }
  }, [scope])
}
