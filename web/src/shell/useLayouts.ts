/**
 * 布局存档逻辑：多套预设、一键切换、以及「上次的样子」。
 *
 * 三层优先级（打开界面时）：
 *   1. `__last`  —— 上次关窗时的样子（自动快照，不污染具名预设）
 *   2. `active`  —— 你上次显式选中的预设
 *   3. 内置默认布局
 *
 * 为什么不直接把改动写回当前预设？因为你切到「写作」预设之后随手拖两下，
 * 预设就被弄脏了，下次再切过去已经不是你要的那个东西。
 * 所以具名预设只在点「保存」时才更新，日常改动进 `__last`。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DockviewApi } from 'dockview'
import * as client from '../api/client'
import type { LayoutList } from '../api/types'
import type { Toast } from '../state/store'
import { PANEL_DEFS, componentNameFor } from './panels'
import type { View } from '../state/store'

/** 自动快照的保留槽位 —— 以 __ 开头，不会出现在预设列表里 */
export const LAST_SLOT = '__last'

/**
 * 旧面板 id → 新面板 id。
 *
 * 「章节原文 + 导入」并成了「正文」，「外观 + 后台」并成了「设置」。
 * 老布局存档里那四个 id 已经不存在了，直接喂给 dockview 会抛错 →
 * 整份布局退回默认，你摆好的面板位置全白费。
 * 所以读进来之前先做一次就地改名 + 去重。
 */
const PANEL_ID_ALIAS: Record<string, string> = {
  chapters: 'text',
  import: 'text',
  appearance: 'settings',
  admin: 'settings',
}

/** 把一份 dockview 序列化布局里的旧面板 id 换成新的（原对象就地改） */
function migrateLayout(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const lay = raw as { panels?: Record<string, Record<string, unknown>>; grid?: unknown }
  if (!lay.panels) return raw

  const rename = (id: string) => PANEL_ID_ALIAS[id] ?? id

  // ---- 1) panels 字典：改名 + 去重（合并后同名只留第一个） ----
  // 标题也一并换成新面板的规范名 —— 否则「正文」会顶着旧的「导入」两个字。
  const next: Record<string, Record<string, unknown>> = {}
  for (const [id, def] of Object.entries(lay.panels)) {
    const to = rename(id)
    if (next[to]) continue
    const title = PANEL_DEFS[to as View]?.title
    next[to] = { ...def, id: to, contentComponent: to, ...(title ? { title } : {}) }
  }
  lay.panels = next

  // ---- 2) grid 树：叶子节点里的 views / activeView 引用 ----
  const fixLeaf = (leaf: { data?: { views?: unknown; activeView?: unknown } }) => {
    const d = leaf.data
    if (!d || !Array.isArray(d.views)) return
    const seen = new Set<string>()
    const renamed: string[] = []
    for (const v of d.views as string[]) {
      const to = rename(v)
      if (seen.has(to)) continue
      seen.add(to)
      renamed.push(to)
    }
    d.views = renamed
    const active = typeof d.activeView === 'string' ? rename(d.activeView) : undefined
    d.activeView = active && renamed.includes(active) ? active : renamed[0]
  }
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (!node || typeof node !== 'object') return
    const n = node as { type?: string; data?: unknown }
    if (n.type === 'leaf') fixLeaf(n as { data?: { views?: unknown; activeView?: unknown } })
    else if (Array.isArray(n.data)) (n.data as unknown[]).forEach(walk)
  }
  // ⚠️ 必须从 root 开始：grid 本身是 {root, width, height} 的包装，
  // 只 walk grid 的话根本进不到树里，views 里的旧 id 就改不到 ——
  // 面板字典改了、引用没改，fromJSON 读到悬空引用直接抛错。
  const grid = lay.grid as { root?: unknown } | undefined
  if (grid?.root) walk(grid.root)

  return lay
}

interface Options {
  bookId: string | null
  apiRef: React.MutableRefObject<DockviewApi | null>
  /** onReady 后 +1，用来触发首次加载 */
  readyTick: number
  notify: (kind: Toast['kind'], text: string) => void
}

export interface LayoutsApi {
  layouts: LayoutList | null
  dirty: boolean
  activeName: string
  refresh: () => Promise<void>
  openView: (v: View, opts?: { focus?: boolean }) => void
  /** 一键把工作区里的面板全部收起来（导航条不动，点一下就能再打开） */
  closeAll: () => void
  buildDefault: () => void
  saveAs: (name: string) => Promise<void>
  applyPreset: (name: string) => Promise<void>
  removePreset: (name: string) => Promise<void>
  resetToDefault: () => Promise<void>
  /** 供 onDidLayoutChange 调用 */
  noteChange: () => void
  /** 渲染期间的抑制开关（程序化改布局时用） */
  setSuppressed: (v: boolean) => void
}

export function useLayouts({ bookId, apiRef, readyTick, notify }: Options): LayoutsApi {
  const [layouts, setLayouts] = useState<LayoutList | null>(null)
  const [dirty, setDirty] = useState(false)

  // 这些用 ref，避免把回调 identity 绑到 state 上（dockview 的事件订阅会因此反复重挂）
  const suppress = useRef(false)
  const bookIdRef = useRef(bookId)
  const snapTimer = useRef<number | undefined>(undefined)
  bookIdRef.current = bookId

  const setSuppressed = useCallback((v: boolean) => {
    suppress.current = v
  }, [])

  /**
   * 一键收工。
   *
   * 不叫「恢复默认布局」：那是**换一套摆法**（汇总 + 全部实体），
   * 这里是**把桌面清空**。两个动作长得很像但意图完全不同 ——
   * 摆了一屏面板想从零开始时，你要的是空的，不是别人给你摆好的。
   */
  const closeAll = useCallback(() => {
    const api = apiRef.current
    if (!api) return
    if (api.panels.length === 0) {
      notify('info', '面板已经全是关着的了')
      return
    }
    const n = api.panels.length
    suppress.current = true
    api.clear()
    // clear 期间是抑制状态，布局变化事件被丢掉了 ——
    // 所以「关光了」这件事得自己补一次落盘，否则下次打开又全回来了。
    window.setTimeout(() => {
      suppress.current = false
      setDirty(true)
      const id = bookIdRef.current
      if (id) client.saveLayout(id, LAST_SLOT, api.toJSON()).catch(() => undefined)
    }, 0)
    notify('info', `已收起 ${n} 个面板 —— 点左侧任意入口就打开`)
  }, [apiRef, notify])

  /** 内置默认布局：左边汇总、右边全部实体 —— 一眼能看出「这两个框是能拖的」 */
  const buildDefault = useCallback(() => {
    const api = apiRef.current
    if (!api) return
    suppress.current = true
    api.clear()
    api.addPanel({
      id: 'dashboard',
      component: 'dashboard',
      title: PANEL_DEFS.dashboard.title,
    })
    api.addPanel({
      id: 'entities',
      component: 'entities',
      title: PANEL_DEFS.entities.title,
      position: { referencePanel: 'dashboard', direction: 'right' },
    })
    // 右侧那一列别太窄 —— 里面还塞着一个类型树侧栏
    const g = api.getPanel('entities')
    if (g?.group) g.group.api.setSize({ width: 720 })
    suppress.current = false
  }, [apiRef])

  const applySerialized = useCallback(
    (layout: unknown): boolean => {
      const api = apiRef.current
      if (!api) return false
      const w = window as unknown as Record<string, unknown>
      try {
        suppress.current = true
        api.clear()
        // 布局 JSON 由 dockview 自己生成自己消费，这里不做校验 —— 坏了就退回默认
        api.fromJSON(migrateLayout(layout) as Parameters<DockviewApi['fromJSON']>[0])
        w.__layoutErr = null
        return true
      } catch (e) {
        // 布局坏掉不该无声无息：把错误留个口子，排查时在控制台读 window.__layoutErr
        w.__layoutErr = String((e as Error)?.stack ?? e)
        return false
      } finally {
        // 让 dockview 把这一轮事件发完再解除抑制
        window.setTimeout(() => {
          suppress.current = false
        }, 0)
      }
    },
    [apiRef],
  )

  const refresh = useCallback(async () => {
    const id = bookIdRef.current
    if (!id) {
      setLayouts(null)
      return
    }
    try {
      setLayouts(await client.listLayouts(id))
    } catch {
      setLayouts(null)
    }
  }, [])

  // ---- 加载：书变了 / dockview 就绪了就换布局 ----
  useEffect(() => {
    const api = apiRef.current
    if (!api || !bookId) return
    let alive = true

    void (async () => {
      let list: LayoutList
      try {
        list = await client.listLayouts(bookId)
      } catch {
        if (alive) buildDefault()
        return
      }
      if (!alive) return
      setLayouts(list)

      const tryLoad = async (name: string): Promise<boolean> => {
        if (!name) return false
        try {
          const r = await client.getLayout(bookId, name)
          return applySerialized(r.layout)
        } catch {
          return false
        }
      }

      const ok = (await tryLoad(LAST_SLOT)) || (await tryLoad(list.active))
      if (!alive) return
      if (!ok) buildDefault()
      setDirty(false)
    })()

    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, readyTick])

  /** 打开某个界面：已有就激活，没有就加进当前活动组 */
  const openView = useCallback<LayoutsApi['openView']>(
    (v, opts) => {
      const api = apiRef.current
      if (!api) return
      const existing = api.getPanel(v)
      if (existing) {
        if (opts?.focus !== false) existing.api.setActive()
        return
      }
      const def = PANEL_DEFS[v]
      const reference = api.activePanel ?? api.panels[api.panels.length - 1]
      try {
        const panel = api.addPanel({
          id: v,
          component: componentNameFor(v),
          title: def.title,
          position: reference ? { referencePanel: reference.id } : undefined,
        })
        if (opts?.focus !== false) panel.api.setActive()
      } catch (e) {
        notify('err', `打开「${def.title}」失败：${(e as Error).message}`)
      }
    },
    [apiRef, notify],
  )

  /** 自动快照：handle 每次改动都进 __last，但不碰具名预设 */
  const noteChange = useCallback(() => {
    if (suppress.current) return
    setDirty(true)
    window.clearTimeout(snapTimer.current)
    snapTimer.current = window.setTimeout(() => {
      const id = bookIdRef.current
      const api = apiRef.current
      if (!id || !api) return
      client.saveLayout(id, LAST_SLOT, api.toJSON()).catch(() => undefined)
    }, 900)
  }, [apiRef])

  const saveAs = useCallback(
    async (name: string) => {
      const id = bookIdRef.current
      const api = apiRef.current
      const key = name.trim()
      if (!id || !api || !key) return
      try {
        await client.saveLayout(id, key, api.toJSON())
        await refresh()
        setDirty(false)
        notify('ok', `布局已保存为「${key}」`)
      } catch (e) {
        notify('err', `保存布局失败：${(e as Error).message}`)
      }
    },
    [apiRef, notify, refresh],
  )

  const applyPreset = useCallback(
    async (name: string) => {
      const id = bookIdRef.current
      if (!id) return
      try {
        const r = await client.getLayout(id, name)
        if (!applySerialized(r.layout)) {
          notify('err', `「${name}」这份布局读不出来（可能来自旧版本），已忽略`)
          return
        }
        await client.setActiveLayout(id, name)
        await refresh()
        setDirty(false)
        notify('ok', `已切到布局「${name}」`)
      } catch (e) {
        notify('err', `切换布局失败：${(e as Error).message}`)
      }
    },
    [applySerialized, notify, refresh],
  )

  const removePreset = useCallback(
    async (name: string) => {
      const id = bookIdRef.current
      if (!id) return
      try {
        await client.deleteLayout(id, name)
        await refresh()
        notify('ok', `已删除布局「${name}」`)
      } catch (e) {
        notify('err', `删除布局失败：${(e as Error).message}`)
      }
    },
    [notify, refresh],
  )

  const resetToDefault = useCallback(async () => {
    const id = bookIdRef.current
    buildDefault()
    if (id) {
      try {
        await client.setActiveLayout(id, '')
        await client.saveLayout(id, LAST_SLOT, apiRef.current?.toJSON() ?? {})
      } catch {
        /* 落盘失败不影响这次的重排 */
      }
    }
    await refresh()
    setDirty(false)
    notify('ok', '已恢复默认布局')
  }, [apiRef, buildDefault, notify, refresh])

  return {
    layouts,
    dirty,
    // `__` 开头的是内部槽位，别显示给用户看
    activeName: layouts?.active && !layouts.active.startsWith('__') ? layouts.active : '',
    refresh,
    openView,
    closeAll,
    buildDefault,
    saveAs,
    applyPreset,
    removePreset,
    resetToDefault,
    noteChange,
    setSuppressed,
  }
}
