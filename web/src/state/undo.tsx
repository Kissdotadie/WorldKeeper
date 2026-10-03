/**
 * 撤销 / 重做（P11-A1，第二梯队口子 #14）。
 *
 * ## 为什么要有它
 * 拖节点、改属性、删关联这三条写入路径都天然期望能撤销。这个能力**必须早做**：
 * 后期再加要回头改所有状态写入点，属重构级；所以先立骨架，把写入点收口。
 *
 * ## 三条设计取舍（先说清楚，免得后面误改）
 *
 * **1. 栈在内存里，不落盘。**
 * 撤销栈是「这一次操作的手感」，不是知识库内容 —— 按项目的铁律，真源只有
 * Markdown，索引可抛弃，操作栈更不该进档案。刷新页面栈就清空，这是**如实**的
 * （宁可不给，也不给一个跨会话的假承诺）。要跨会话得先做 P11 第三梯队的
 * 「视图状态持久化」，那是另一件事。
 *
 * **2. 一步 = 一个操作对象（`undo` + `redo` 两个闭包），不是 diff。**
 * 反向操作里带的是**旧快照**（旧 payload / 旧的节点坐标），撤销就是「把旧快照
 * 覆盖回去」。闭包由调用方给，所以这个模块不需要知道「属性」「关联」「坐标」
 * 各自长什么样 —— 加新的可撤销动作不用动这里。
 *
 * **3. 撤销前要问一句「这一条还是我改完时的样子吗」。**
 * 撤销是拿旧快照**整条覆盖**回去。如果这期间别的东西（AI 抽取落盘、你在编辑器里
 * 手改了 md）又动过这一条，直接盖回去会把那些改动一起抹掉，而且是**静默**的。
 * 所以每次都先读回来比一下：不一致就**拒绝**并说明原因。宁可少撤一步，
 * 也不能悄悄吃掉别人的改动。
 *
 * ## 四个必须守住的细节
 * - **重入**：撤销本身也是一次写入。执行期间任何 `push` 都必须被忽略，
 *   否则「撤销触发的写入」又被记成一条新操作，栈会越滚越大且再也退不出去。
 * - **换书清空**：跨书撤销没有意义（A 书的旧快照盖不到 B 书的实体上）。
 * - **合并**：拖节点会连续触发、改摘要会边打边存 —— 同 `mergeKey` 且在
 *   `MERGE_MS` 内视为**同一步**（保留最早的 `undo`、刷新 `redo`），
 *   否则「拖三下要点三次撤销」。
 * - **失败要放回去**：撤销失败不能把这条丢掉（用户还得能重试），
 *   所以是「取出 → 执行 → 失败则塞回原位」。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import * as api from '../api/client'
import type { EntityPayload, SceneState } from '../api/client'
import { useShortcuts } from '../lib/shortcuts'
import { useApp } from './store'

/** 栈深上限。再往前的「手感」已经没人记得了，留着只占内存。 */
export const UNDO_CAP = 60
/** 同 mergeKey 的两步在这个窗口内视为一步 */
export const MERGE_MS = 2000

export interface UndoOp {
  /** 一次性 id，只做调试与 React key 用 */
  id: string
  /** 说人话的动作名：「改属性：裴渊」「删关联：裴渊 → 中州」 */
  label: string
  /** 属于哪本书。换书就作废 */
  bookId: string
  undo: () => Promise<void>
  redo: () => Promise<void>
  /** 同一件事的连续触发（拖节点 / 连续改同一字段）→ 合成一步 */
  mergeKey?: string
  at: number
}

export interface UndoApi {
  push: (op: Omit<UndoOp, 'id' | 'at'>) => void
  /**
   * 记录一次**实体写入**：先落盘，再入栈。
   *
   * `before` = 改之前那条的完整 payload，`after` = 这次要发的 payload。
   * 两者都由调用方按 `EntityPayload` 的全量口径给（后端是全量覆盖）。
   */
  recordEntity: (args: {
    bookId: string
    entityId: string
    before: EntityPayload
    after: EntityPayload
    label: string
    mergeKey?: string
  }) => Promise<void>
  /** 记录一次**节点坐标移动**：撤销 = 把这个节点放回原处（只动它一个） */
  recordNodePosition: (args: {
    bookId: string
    sceneKey: string
    nodeId: string
    before: { x: number; y: number; z: number } | null
    after: { x: number; y: number; z: number }
  }) => void
  undo: () => Promise<void>
  redo: () => Promise<void>
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
  /** 栈里有几步（界面自检/测试用） */
  depth: number
  clear: () => void
}

const Ctx = createContext<UndoApi | null>(null)

export function useUndo(): UndoApi {
  const v = useContext(Ctx)
  if (!v) throw new Error('useUndo 必须在 <UndoProvider> 里用')
  return v
}

// ---------------------------------------------------------------------------
// 「这一条还是我改完时的样子吗」—— 比较口径
// ---------------------------------------------------------------------------

/** 会被 `EntityPayload` 覆盖到的字段。比较只认这些，`updated_at` 这类不参与。 */
const P_FIELDS = [
  'type', 'name', 'aliases', 'tags', 'methodologies',
  'first_appear', 'status', 'icon', 'summary',
] as const

/** 对象键排序后的稳定串 —— 直接 JSON.stringify 会被键序坑到（同一份数据两种串） */
function stable(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${k}:${stable(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/**
 * 这次「真要写进去」的字段名（只比这些，别的字段一概不看）。
 *
 * 为什么按 key 集来比、而不是按整条比：各处调用方给的 payload 覆盖面不同
 * （表单不给 `summary`，浮层不给 `body`）。要是按整条比，一边 `undefined`、
 * 一边有值，**永远不相等**，闸会把每一次撤销都当成「被人改过」拦掉。
 * 只比「这次真正动过的字段」，才是「这一条还是我改完时的样子吗」的正确问法。
 */
function writtenKeys(p: EntityPayload): string[] {
  const keys: string[] = []
  const rec = p as unknown as Record<string, unknown>
  for (const k of P_FIELDS) if (rec[k] !== undefined) keys.push(k)
  if (p.body !== undefined) keys.push('body')
  return keys
}

/** 从「读回来的一条实体」按同一组 key 抽签名（缺字段一律记 null） */
function sigOfEntity(e: Record<string, unknown> | null, keys: string[]): string {
  if (!e) return 'missing'
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = e[k] ?? null
  return stable(out)
}

/** 输入框 / 文本域里按 Ctrl+Z 应该走浏览器自己的文本撤销，不该动知识库 */
function inTyping(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

let opSeq = 0

export function UndoProvider({ children }: { children: ReactNode }) {
  const { bookId, notify, refresh } = useApp()
  const [stack, setStack] = useState<UndoOp[]>([])
  const [cursor, setCursor] = useState(0) // 已撤销到的位置：stack[0..cursor) 是「已做」
  const [busy, setBusy] = useState(false)
  /** 执行撤销/重做期间为 true —— 此时的 push 一律丢弃（见模块注释「重入」） */
  const applyingRef = useRef(false)
  const bookRef = useRef<string | null>(bookId)
  bookRef.current = bookId

  // 换书 → 清空。跨书的旧快照盖不到新书的实体上，留着只会误伤。
  useEffect(() => {
    setStack([])
    setCursor(0)
  }, [bookId])

  const push = useCallback((op: Omit<UndoOp, 'id' | 'at'>) => {
    if (applyingRef.current) return // 撤销/重做自己触发的写入，不记
    setStack((prev) => {
      const list = prev.slice(0, cursor)
      const top = list[list.length - 1]
      const now = Date.now()
      if (op.mergeKey && top && top.mergeKey === op.mergeKey && now - top.at < MERGE_MS) {
        // 合并：**保留最早那份 undo**（要退回的是这一串动作的起点），
        // redo 换成最新的（重做要落到最终状态）
        list[list.length - 1] = { ...top, redo: op.redo, label: op.label, at: now }
        return list
      }
      list.push({ ...op, id: `op${++opSeq}`, at: now })
      if (list.length > UNDO_CAP) list.splice(0, list.length - UNDO_CAP)
      return list
    })
    setCursor((c) => Math.min(c + 1, UNDO_CAP))
  }, [cursor])

  // ---- 三类写入的收口 ----

  const recordEntity = useCallback<UndoApi['recordEntity']>(
    async ({ bookId: bid, entityId, before, after, label, mergeKey }) => {
      const keys = writtenKeys(after)
      /** 只读需要比的那几个字段。用它同时做「改完之后」「撤完之后」两种基准 */
      const sigNow = async () => {
        const cur = await api.getEntity(bid, entityId)
        return sigOfEntity(cur as unknown as Record<string, unknown>, keys)
      }
      /**
       * 基准是**上一次执行完之后读回来的那份**，不是「我发出去的 payload」——
       * 后端会归一化（trim、补空键、key 顺序），拿发出去的比会永远不相等，
       * 等于给每次撤销都判「被人改过」。代价是每执行一步多一次 GET，
       * 换来的是这道闸不依赖任何「字段怎么映射」的假设。
       */
      let expect = ''
      try {
        expect = await sigNow()
      } catch {
        expect = '' // 读不回来就不设闸（宁可让撤销能用），不假装有闸
      }
      const resync = async () => {
        try {
          expect = await sigNow()
        } catch {
          expect = ''
        }
      }
      push({
        label,
        bookId: bid,
        mergeKey,
        undo: async () => {
          if (expect && (await sigNow()) !== expect) {
            throw new Error('这一条在这之后又被改过，撤销会把它一并盖回去 —— 已跳过（先看看它现在是什么样）')
          }
          await api.updateEntity(bid, entityId, before)
          await refresh()
          await resync()
        },
        redo: async () => {
          if (expect && (await sigNow()) !== expect) {
            throw new Error('这一条现在不是撤销后的样子了，重做会覆盖掉别的改动 —— 已跳过')
          }
          await api.updateEntity(bid, entityId, after)
          await refresh()
          await resync()
        },
      })
    },
    [push, refresh],
  )

  const recordNodePosition = useCallback<UndoApi['recordNodePosition']>(
    ({ bookId: bid, sceneKey, nodeId, before, after }) => {
      // 只动被拖的那一个节点：**先读现场景、再改这一个键**。
      // 直接整份覆盖会把别处（另一个图的镜头、别处的坐标）一起退回去。
      const apply = async (pos: { x: number; y: number; z: number } | null) => {
        const cur = await api.getScene(bid)
        const scene: SceneState = cur.scene ?? {}
        const graphs = { ...(scene.graphs ?? {}) }
        const entry = { ...(graphs[sceneKey] ?? {}) }
        const positions = { ...(entry.positions ?? {}) }
        if (pos) positions[nodeId] = pos
        else delete positions[nodeId] // 本来就没有存档 → 撤销 = 把这个键去掉
        graphs[sceneKey] = { ...entry, positions }
        await api.saveScene(bid, { ...scene, graphs })
        await refresh()
      }
      push({
        label: `挪动节点（${nodeId}）`,
        bookId: bid,
        mergeKey: `node:${sceneKey}:${nodeId}`, // 连着拖同一个节点只算一步
        undo: () => apply(before),
        redo: () => apply(after),
      })
    },
    [push, refresh],
  )

  // ---- 执行 ----

  const run = useCallback(
    async (dir: 'undo' | 'redo') => {
      if (applyingRef.current) return
      const op = dir === 'undo' ? stack[cursor - 1] : stack[cursor]
      if (!op) return
      if (op.bookId !== bookRef.current) {
        notify('err', '这一步是另一本书里的操作，当前书里撤不了 —— 已清空撤销栈')
        setStack([])
        setCursor(0)
        return
      }
      applyingRef.current = true
      setBusy(true)
      // 先移动游标：成功了才是真的移动；失败要挪回去
      if (dir === 'undo') setCursor((c) => c - 1)
      else setCursor((c) => c + 1)
      try {
        await (dir === 'undo' ? op.undo() : op.redo())
        notify('info', `${dir === 'undo' ? '已撤销' : '已重做'}：${op.label}`)
      } catch (e) {
        if (dir === 'undo') setCursor((c) => c + 1)
        else setCursor((c) => c - 1)
        notify('err', `${dir === 'undo' ? '撤销' : '重做'}没成功：${(e as Error).message}`)
      } finally {
        applyingRef.current = false
        setBusy(false)
      }
    },
    [stack, cursor, notify],
  )

  const undo = useCallback(() => run('undo'), [run])
  const redo = useCallback(() => run('redo'), [run])
  const clear = useCallback(() => {
    setStack([])
    setCursor(0)
  }, [])

  // ---- 键位（走 A2 的注册层，不再往 window 上零散挂）----
  // `when: !inTyping()` —— 输入框里按 Ctrl+Z 是浏览器自己的文本撤销，
  // 抢过来会把「刚打错的字」变成「把整条实体回滚」，那是灾难。
  useShortcuts(
    [
      {
        id: 'undo.undo', keys: 'Ctrl+Z', scope: 'global', desc: '撤销上一步改动',
        when: () => !inTyping(), run: () => void undo(),
      },
      {
        id: 'undo.redo', keys: 'Ctrl+Shift+Z', scope: 'global', desc: '重做（撤销的反向）',
        when: () => !inTyping(), run: () => void redo(),
      },
      {
        id: 'undo.redo-y', keys: 'Ctrl+Y', scope: 'global', desc: '重做（Windows 习惯键）',
        when: () => !inTyping(), run: () => void redo(),
      },
    ],
    [undo, redo],
  )

  const api_ = useMemo<UndoApi>(
    () => ({
      push,
      recordEntity,
      recordNodePosition,
      undo,
      redo,
      canUndo: cursor > 0 && !busy,
      canRedo: cursor < stack.length && !busy,
      undoLabel: cursor > 0 ? stack[cursor - 1].label : null,
      redoLabel: cursor < stack.length ? stack[cursor].label : null,
      depth: stack.length,
      clear,
    }),
    [push, recordEntity, recordNodePosition, undo, redo, cursor, stack, clear, busy],
  )

  return <Ctx.Provider value={api_}>{children}</Ctx.Provider>
}
