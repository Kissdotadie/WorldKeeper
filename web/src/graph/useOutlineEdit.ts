/**
 * 「自由结构」的公共接线层。
 *
 * 世界观那一页（CatalogView）先做出了 WPS 式编辑，后来方法论、关系网、
 * 时间线、历史观都要同一套东西。与其把那一百多行复制四遍（复制三遍必出
 * 分叉），不如把「结构状态的读写 + 六个编辑动作 + 派生给图的数据」抽到这里，
 * 各视图只负责**说清楚自己有哪些节点**。
 *
 * 三条不变式（与独立实现时完全一致）：
 * 1. 结构是**装饰层**，落 `view/scene.json` 的 `outlines[sceneKey]`，
 *    后端整份存 JSON 不解析字段 —— 所以这里零后端改动（铁律 2/5）。
 * 2. 实体节点在结构里只记「谁挂在谁下面」，实体档案一个字不动（铁律 1）。
 * 3. 没挂进结构的实体照常画、默默消失是不允许的 —— `knownIds` 交给视图，
 *    让它把没进结构的节点摆进「孤儿行」。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import * as api from '../api/client'
import { useApp } from '../state/store'
import {
  isVirtualOutlineId,
  newOutline,
  newVirtualId,
  outlineAttach,
  outlineDetach,
  outlineInsertSibling,
  outlineParentOf,
  outlineRename,
  outlineReparent,
  type OutlineState,
} from './outline'
import type { OutlineEditApi } from './Graph2D'
import type { GEdge, GNode } from './types'

/** 骨架节点的类型标记 —— 与 CatalogView 保持一致，样式系统认这两个 */
export const OUTLINE_ROOT_TYPE = '__root'
export const OUTLINE_FREE_TYPE = '__tag'

export interface OutlineEditor {
  /** 结构模式开着没有 */
  on: boolean
  toggle: () => void
  /** 当前结构（没开或还没建过时为 null） */
  outline: OutlineState | null
  /** 改结构：立刻上屏 + 防抖落盘 */
  persist: (next: OutlineState) => void
  /** 整体替换（导入用）：同步上屏并**立即**落盘，不等防抖 */
  replace: (next: OutlineState) => void
  /** 给 Graph2D 的布局层（树的形状由结构决定） */
  hierarchy: { root: string; children: Map<string, string[]> } | null
  /** 给 Graph2D 的编辑层（选中浮条、快捷键、拖拽换父） */
  editApi: OutlineEditApi | undefined
  /** 结构骨架转成图的节点与边（不含实体 —— 实体由视图自己并进来） */
  skeleton: () => { nodes: GNode[]; edges: GEdge[] }
  /** 结构里出现过的全部 id，视图用来区分「挂着」与「孤儿」 */
  knownIds: Set<string>
  /** 节点显示名：自由节点取结构里的名字，实体节点由视图兜底 */
  nameOf: (id: string) => string | null
  /** 节点描述（导入大纲时识别出的「说明」），交给 Graph2D 画在名字下面 */
  noteOf: (id: string) => string
}

export interface UseOutlineEditOptions {
  /** `view/scene.json` 里 `outlines` 的键，例如 `catalog-location` */
  sceneKey: string
  /** 根节点默认名 / 空结构时的占位 */
  title: string
  /** 外层选中状态：新建节点后要让图上真的选中它，否则快捷键没有作用对象 */
  onSelect?: (id: string | null) => void
}

export function useOutlineEdit({ sceneKey, title, onSelect }: UseOutlineEditOptions): OutlineEditor {
  const { bookId } = useApp()

  const [on, setOn] = useState<boolean>(() => {
    try {
      return localStorage.getItem(`wkv.outline.${sceneKey}`) === '1'
    } catch {
      return false
    }
  })
  const [outline, setOutline] = useState<OutlineState | null>(null)
  const [pendingRenameId, setPendingRenameId] = useState<string | null>(null)
  const sceneRef = useRef<api.SceneState | null>(null)
  const saveTimerRef = useRef<number | null>(null)

  // 首次拉一次 scene.json，把已有结构读回来
  useEffect(() => {
    if (!bookId) return
    let alive = true
    api
      .getScene(bookId)
      .then((r) => {
        if (!alive) return
        sceneRef.current = r.scene
        const o = r.scene.outlines?.[sceneKey]
        if (o && o.schema === 1 && typeof o.root === 'string') setOutline(o)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [bookId, sceneKey])

  /** 只改缓存不落盘 —— 导入这种「一次性大批量」用它攒着，最后 replace 一次写 */
  const write = useCallback(
    (next: OutlineState, immediate = false) => {
      setOutline(next)
      if (!bookId) return
      const flush = () => {
        const scene: api.SceneState = { ...(sceneRef.current ?? {}) }
        scene.outlines = { ...(scene.outlines ?? {}), [sceneKey]: next }
        sceneRef.current = scene
        void api.saveScene(bookId, scene).catch(() => undefined)
      }
      if (immediate) {
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
        flush()
        return
      }
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = window.setTimeout(flush, 400)
    },
    [bookId, sceneKey],
  )

  const persist = useCallback((next: OutlineState) => write(next), [write])
  const replace = useCallback((next: OutlineState) => write(next, true), [write])

  const toggle = useCallback(() => {
    const next = !on
    setOn(next)
    try {
      localStorage.setItem(`wkv.outline.${sceneKey}`, next ? '1' : '0')
    } catch {
      /* 隐私模式下写不了，功能照旧 */
    }
    if (next && !outline) {
      // 第一次开：根节点就是界面名 —— 双击就能改名
      persist(newOutline(newVirtualId(), title))
    }
  }, [on, outline, sceneKey, title, persist])

  // ---- 六个编辑动作 ----
  /**
   * 这个 id 在不在结构里。
   *
   * 关系网/地理观这类视图，实体节点**未必**都已经挂进结构 —— 它们平时
   * 就是图上一个个孤立的点。用户选中一个游离实体按 Tab，如果直接
   * `outlineAttach` 会被「父级不在结构里」这道闸拦下来，按了毫无反应
   * （实测：关系网 char-0256，点 ＋子级，节点数 398 → 398）。
   * 正确的手感是世界观那样：先把它收养进结构（挂到根下），再接着做
   * 用户要的那个动作。
   */
  const isKnown = (o: OutlineState, id: string) => {
    if (id === o.root) return true
    if (Object.prototype.hasOwnProperty.call(o.names, id)) return true
    if (Object.prototype.hasOwnProperty.call(o.children, id)) return true
    for (const kids of Object.values(o.children)) if (kids.includes(id)) return true
    return false
  }

  /** 把一个游离节点收养进结构（挂到根下）；已经在里面就原样返回 */
  const adopt = (o: OutlineState, id: string): OutlineState => {
    if (isKnown(o, id)) return o
    const r = outlineAttach(o, o.root, id)
    return r.id ? r.outline : o
  }

  const addChild = useCallback(
    (parentId: string) => {
      if (!outline) return
      const base = adopt(outline, parentId)
      const { outline: next, id } = outlineAttach(base, parentId)
      if (!id) return
      persist(next)
      setPendingRenameId(id)
      onSelect?.(id)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outline, persist, onSelect],
  )

  const addSibling = useCallback(
    (refId: string) => {
      if (!outline) return
      const base = adopt(outline, refId)
      const { outline: next, id } = outlineInsertSibling(base, refId)
      if (!id) return
      persist(next)
      setPendingRenameId(id)
      onSelect?.(id)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outline, persist, onSelect],
  )

  const remove = useCallback(
    (id: string) => {
      if (!outline) return
      persist(outlineDetach(outline, id))
    },
    [outline, persist],
  )

  const rename = useCallback(
    (id: string, name: string) => {
      if (!outline) return
      persist(outlineRename(outline, id, name))
    },
    [outline, persist],
  )

  const reparent = useCallback(
    (childId: string, parentId: string | null) => {
      if (!outline) return
      const next = outlineReparent(outline, childId, parentId)
      if (next !== outline) persist(next)
    },
    [outline, persist],
  )

  const hierarchy = useMemo(() => {
    if (!on || !outline) return null
    return { root: outline.root, children: new Map(Object.entries(outline.children)) }
  }, [on, outline])

  const editApi = useMemo<OutlineEditApi | undefined>(() => {
    if (!on || !outline) return undefined
    return {
      active: true,
      parentIdOf: (id) => outlineParentOf(outline, id),
      isVirtual: (id) => isVirtualOutlineId(id),
      addChild,
      addSibling,
      remove,
      rename,
      reparent,
      pendingRenameId,
      onRenameHandled: () => setPendingRenameId(null),
    }
  }, [on, outline, addChild, addSibling, remove, rename, reparent, pendingRenameId])

  const knownIds = useMemo(() => {
    const s = new Set<string>()
    if (!outline) return s
    s.add(outline.root)
    for (const k of Object.keys(outline.names)) s.add(k)
    for (const [p, kids] of Object.entries(outline.children)) {
      s.add(p)
      for (const k of kids) s.add(k)
    }
    return s
  }, [outline])

  const skeleton = useCallback(() => {
    const nodes: GNode[] = []
    const edges: GEdge[] = []
    if (!outline) return { nodes, edges }
    nodes.push({
      id: outline.root,
      name: outline.names[outline.root] ?? title,
      type: OUTLINE_ROOT_TYPE,
      color: 'var(--accent)',
      size: 20,
    })
    for (const [id, nm] of Object.entries(outline.names)) {
      if (id === outline.root) continue
      nodes.push({ id, name: nm, type: OUTLINE_FREE_TYPE })
    }
    const known = new Set<string>([outline.root, ...Object.keys(outline.names)])
    const seen = new Set<string>()
    const push = (s: string, t: string) => {
      const key = `${s}\u0000${t}`
      if (seen.has(key) || s === t) return
      seen.add(key)
      edges.push({ source: s, target: t, kind: '包含' })
    }
    // 实体节点（不在 free 名单里，但结构里挂了它）也要进 known，否则整棵子树断掉
    for (const [p, kids] of Object.entries(outline.children)) {
      if (!known.has(p) && !isVirtualOutlineId(p)) known.add(p)
      for (const c of kids) if (!isVirtualOutlineId(c)) known.add(c)
    }
    for (const [p, kids] of Object.entries(outline.children)) {
      if (!known.has(p)) continue
      for (const c of kids) {
        if (!known.has(c)) continue
        push(p, c)
      }
    }
    return { nodes, edges }
  }, [outline, title])

  const nameOf = useCallback(
    (id: string) => outline?.names[id] ?? (id === outline?.root ? title : null),
    [outline, title],
  )

  const noteOf = useCallback((id: string) => outline?.notes?.[id] ?? '', [outline])

  return {
    on,
    toggle,
    outline,
    persist,
    replace,
    hierarchy,
    editApi,
    skeleton,
    knownIds,
    nameOf,
    noteOf,
  }
}
