/**
 * 应用状态。
 *
 * 用最朴素的 Context 就够了 —— P1 的数据量（一本书几百条实体）不需要引入状态库。
 *
 * 两条规矩：
 * 1. **任何写操作都先请求后端，成功后重新拉取**。前端不自己维护一份缓存副本，
 *    否则「Markdown 是唯一真源」这条规矩会在前端先被破坏。
 * 2. **外观的真源是 `preferences.json`，不是 localStorage**。
 *    localStorage 只当首屏缓存用（避免刷新时闪一下默认色），
 *    否则手机端和桌面端的外观会各说各话。
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
import type {
  AssetsData,
  Book,
  Decoration,
  EntityMeta,
  GraphSpec,
  NodeStylePatch,
  Prefs,
  Stats,
  StylePack,
  StylesData,
  StyleRule,
  ThemeSpec,
  TypeOption,
  UiPrefs,
} from '../api/types'
import {
  applyBackground,
  applyFonts,
  applyTheme,
  injectFontFaces,
  readPrefsCache,
  writePrefsCache,
} from '../lib/appearance'

export type Theme = 'dark' | 'light'

/**
 * 界面路由。
 *
 * 前九个是「看小说世界」的界面（都是派生视图，各有 2D 思维导图或等价的图形呈现），
 * 后三个是「管数据 / 管外观」的界面。
 */
export type View =
  | 'dashboard' // 汇总
  | 'world' // 世界观
  | 'geo' // 地理观
  | 'roster' // 名册录（整册名册，不限于人物）
  | 'relation' // 关系网
  | 'methodology' // 方法论
  | 'timeline' // 时间线
  | 'history' // 历史观
  | 'plot' // 剧情线
  | 'foreshadow' // 伏笔看板
  | 'entities' // 全部实体
  | 'text' // 正文（章节原文 + 导入）
  | 'skills' // 技能中心（提示词模板库，只读正文产分析）
  | 'toolbox' // 工具箱（免费对话 / 图片生成入口合集）
  | 'settings' // 设置（外观 + 后台）
  | 'jobs' // 任务中心（异步任务的进度 / 停止 / 续跑，P11-A3）

/** 导航条顺序，同时也是 Ctrl+1…9 的顺序 */
export const VIEW_ORDER: View[] = [
  'dashboard',
  'world',
  'geo',
  'roster',
  'methodology',
  'history',
  'timeline',
  'plot',
  'foreshadow',
]

export interface Toast {
  id: number
  kind: 'ok' | 'err' | 'info'
  text: string
}

interface AppValue {
  // 界面路由
  view: View
  setView: (v: View) => void
  /**
   * 打开某个界面 —— **每次都真的请求一次**，哪怕它已经是当前界面。
   *
   * 为什么需要它：面板可以被关掉，而 `view` 这个状态还停在原值。
   * 此时再点同一个入口，`setView` 值没变 → React 不重渲 → 外壳那个
   * 「view 变了就打开面板」的 effect 不跑 → 点了没反应。
   * 所以凡是「用户主动要打开某个界面」的地方都走这里，`setView` 只留给
   * 「面板自己报告我是谁」这种同步场景。
   */
  requestView: (v: View, intent?: string) => void
  /** requestView 的自增令牌 —— 告诉外壳「又一次请求来了」 */
  viewTick: number
  /**
   * `requestView` 捎带的「进去以后干什么」的意图（N8）。
   *
   * 例：`requestView('text', 'text:import')` —— 打开「正文」并直接切到「导入」页签。
   * 「世界观空着 → 去导入章节」这种跳转，落到面板上但停在错的页签等于白跳。
   *
   * 存成对象 + 自增序号，是为了保证每次请求都是**新引用**：消费方的 effect 依赖它，
   * 同值重复设置不会触发重渲 —— 那是这类「跨面板传话」最常见的死法。
   */
  viewIntent: { kind: string; n: number } | null
  /**
   * 数据版本号（P11-1️⃣①）。**任何写操作成功**都会 +1（含实体增删改、导入、
   * 抽取落盘、地图/样式保存…），`refresh()` 也 +1。
   *
   * 用处：派生视图只要把 `dataVersion` 放进自己取数 effect 的依赖里，
   * 就自动跟着失效 —— 修掉「删了实体，名册录还留着它」那类幽灵条目。
   */
  dataVersion: number
  /** 打开某个实体的详情（自动切到实体界面） */
  openEntity: (id: string) => void

  // 数据
  books: Book[]
  bookId: string | null
  entities: EntityMeta[]
  stats: Stats | null
  tags: string[]
  types: TypeOption[]
  loading: boolean
  bootError: string | null

  /**
   * 可视化样式（P5）。
   *
   * 为什么放在**全局**而不是每个图各自一份：同一个实体在关系网、世界观、
   * 地理观里都出现，它长什么样不该因为你在哪个面板看它而不同。而且这些
   * 面板在 dockview 里可以同时开着 —— 各自持一份状态必然会出现「在这个
   * 面板改了，那个面板还是老样子」。
   */
  styles: StylesData | null
  /** 单节点覆盖（`view/nodes.json`）；**切样式包也冲不掉它** */
  nodeStyles: Record<string, NodeStylePatch>
  /** 样式变动令牌：+1 就让所有图重算一次外观 */
  styleToken: number
  setPack: (id: string) => Promise<void>
  /** 内存立刻生效、落盘防抖 —— 所以返回 void，不用等 */
  patchPackGraph: (patch: Partial<GraphSpec>) => void
  patchPackRules: (rules: StyleRule[]) => void
  patchPackMeta: (patch: { name?: string; desc?: string }) => void
  newPack: (name: string, from?: string) => Promise<void>
  removePack: (id: string) => Promise<void>
  /** 从 JSON 导入，一律存成**新包**，不覆盖现有的 */
  importPack: (raw: unknown) => Promise<void>
  /** 改一个节点的外观；patch 传空对象（或 clearNodeStyle）就是恢复默认 */
  setNodeStyle: (entityId: string, patch: NodeStylePatch) => Promise<void>

  /**
   * 贴纸（`view/decorations.json`）。
   *
   * 和样式一样放全局：贴纸虽然**按视图分区**（关系网贴的和世界观贴的是两回事），
   * 但整份文件是一个 —— 面板可以同时开着，各自持一份的话，
   * A 面板存盘会把 B 面板刚加的贴纸整段抹掉。
   */
  decorations: Record<string, Decoration[]>
  /**
   * 写某个视图的贴纸；内存立刻生效、落盘防抖（同样式包的理由）。
   *
   * 收**更新函数**而不只是数组：一次拖动里可能连着改两下，
   * 每次都从闭包里那份旧数组算，第二下就会把第一下抹掉。
   */
  setSceneDecorations: (
    sceneKey: string,
    next: Decoration[] | ((cur: Decoration[]) => Decoration[]),
  ) => void

  // 选择
  selectedId: string | null
  select: (id: string | null) => void
  typeFilter: string | null
  setTypeFilter: (t: string | null) => void
  tagFilter: string | null
  setTagFilter: (t: string | null) => void
  query: string
  setQuery: (q: string) => void

  // 外观（真源在 preferences.json）
  prefs: Prefs | null
  /** 局部更新外观偏好；乐观更新 + 防抖落盘 */
  setUi: (patch: Partial<UiPrefs>) => void
  resetUi: () => void
  themes: ThemeSpec[]
  assets: AssetsData | null
  reloadAppearance: () => Promise<void>

  // 兼容旧调用点的便捷读法
  theme: Theme
  toggleTheme: () => void
  fontScale: number
  setFontScale: (v: number) => void
  sidebarOpen: boolean
  toggleSidebar: () => void

  // 动作
  switchBook: (id: string) => void
  refresh: () => Promise<void>
  /**
   * 重拉书目清单。
   *
   * 书目清单原本只在启动时拉一次，于是「新建了一本书」或「删掉一本书」之后
   * 顶栏的下拉还是老样子 —— 得刷新浏览器才看得见。更糟的是删掉**当前正在看的**
   * 那本书时，`bookId` 还指着它，各视图会一路 404。这个方法把两件事一起办了：
   * 重拉清单，并且当前书已不在清单里时自动切到还有的第一本。
   */
  reloadBooks: () => Promise<Book[]>
  createBook: (id: string, title: string, author: string, genre?: string) => Promise<void>
  /** 改书目元数据（书名/作者/题材/封面）。只动 book.yaml。 */
  updateBookMeta: (patch: { title?: string; author?: string; genre?: string; cover?: string }) => Promise<void>
  /** 当前选中的书目（含题材/封面），没有选中时为 null */
  currentBook: Book | null
  notify: (kind: Toast['kind'], text: string) => void
  toasts: Toast[]
  dismissToast: (id: number) => void
}

const Ctx = createContext<AppValue | null>(null)

/**
 * 两个「窄」上下文。
 *
 * 为什么拆出来：`useApp()` 的 value 把外观、数据、选择、提示全打在一个包里，
 * 于是「拖一下字号滑杆」「弹一条提示」都会让所有界面组件重跑一遍 ——
 * 包括那几张要重算几百个节点的图。
 * 拆开之后，只有真正关心这块状态的组件才会重渲，`useApp()` 的语义一个字没变。
 */
export interface UiApi {
  prefs: Prefs | null
  /** 展开好的外观偏好（书目覆盖 > prefs.ui > 出厂值） */
  ui: UiPrefs
  setUi: (patch: Partial<UiPrefs>) => void
  resetUi: () => void
  /** 开着书时为 true：改外观会写进这本书（book.yaml），不影响别的书 */
  inBookScope: boolean
  /** 这本书有没有自己的独立设置（false = 正在跟随全局） */
  bookHasOverride: boolean
  /** 把当前生效的外观存成全局默认（并让这本书改回跟随全局） */
  applyUiToGlobal: () => Promise<void>
  themes: ThemeSpec[]
  assets: AssetsData | null
  reloadAppearance: () => Promise<void>
  theme: Theme
  toggleTheme: () => void
  fontScale: number
  setFontScale: (v: number) => void
  sidebarOpen: boolean
  toggleSidebar: () => void
}

export interface ToastApi {
  notify: (kind: Toast['kind'], text: string) => void
  toasts: Toast[]
  dismissToast: (id: number) => void
}

const UiCtx = createContext<UiApi | null>(null)
const ToastCtx = createContext<ToastApi | null>(null)

const LS = { book: 'wkv.bookId' }

function readLS(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function writeLS(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 隐私模式下写不了，忽略即可，不影响使用 */
  }
}

/** 外观偏好的出厂值 —— 与后端 `_PREF_UI_DEFAULTS` 保持一致 */
export const UI_DEFAULTS: UiPrefs = {
  theme: '默认',
  mode: 'dark',
  font_scale: 1,
  font_ui: '',
  font_mono: '',
  sidebar_open: true,
  panel_alpha: 0.88,
  // 毛玻璃默认关：backdrop-filter 在大面积、多层叠的场景下是实打实的合成开销，
  // 尤其开着背景图时。想要那层朦胧感可以在「外观」里打开。
  panel_blur: false,
  background: {
    kind: 'none',
    color: '',
    from: '',
    to: '',
    angle: 135,
    image: '',
    fit: 'cover',
    blur: 0,
    dim: 0.55,
  },
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View>('dashboard')
  const [viewTick, setViewTick] = useState(0)
  const [viewIntent, setViewIntent] = useState<{ kind: string; n: number } | null>(null)
  /** viewIntent 的序号源：保证每次 requestView 都产出新引用 */
  const intentSeq = useRef(0)
  const [dataVersion, setDataVersion] = useState(0)
  const [books, setBooks] = useState<Book[]>([])
  const [bookId, setBookId] = useState<string | null>(null)
  const [entities, setEntities] = useState<EntityMeta[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [types, setTypes] = useState<TypeOption[]>([])
  const [styles, setStyles] = useState<StylesData | null>(null)
  const [nodeStyles, setNodeStyles] = useState<Record<string, NodeStylePatch>>({})
  const [styleToken, setStyleToken] = useState(0)
  /** 贴纸（`view/decorations.json`），按视图 key 分区 */
  const [decorations, setDecorations] = useState<Record<string, Decoration[]>>({})
  const [loading, setLoading] = useState(true)
  const [bootError, setBootError] = useState<string | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  // 首屏先用缓存里的外观，避免闪一下默认色；随后被后端真源覆盖
  const [prefs, setPrefs] = useState<Prefs | null>(() => readPrefsCache())
  const [themes, setThemes] = useState<ThemeSpec[]>([])
  const [assets, setAssets] = useState<AssetsData | null>(null)
  // 书目独立外观（P11-C2）：打开某本书时拉取**解析后的**完整 ui
  // （书目覆盖 > 全局偏好 > 出厂）。null = 没开书 / 拉取失败（回退全局）
  const [bookUi, setBookUi] = useState<UiPrefs | null>(null)
  const [bookHasOverride, setBookHasOverride] = useState(false)
  /** 累积还没落盘的增量 —— 书路径只把真正改过的键钉进 book.yaml（稀疏覆盖） */
  const pendingUiPatch = useRef<Partial<UiPrefs>>({})

  const [toasts, setToasts] = useState<Toast[]>([])
  const toastSeq = useRef(0)
  const prefsSaveTimer = useRef<number | undefined>(undefined)
  /** 拉取前不要回写，否则会把刚读到的缓存又写回去 */
  const prefsDirty = useRef(false)

  const ui = bookUi ?? prefs?.ui ?? UI_DEFAULTS

  // 换书 → 重拉这本书的外观。拉取失败不该让书打不开，静默回退全局
  useEffect(() => {
    if (!bookId) {
      setBookUi(null)
      setBookHasOverride(false)
      return
    }
    let alive = true
    api
      .getBookAppearance(bookId)
      .then((r) => {
        if (!alive) return
        setBookUi(r.ui)
        setBookHasOverride(r.has_override)
      })
      .catch(() => {
        if (!alive) return
        setBookUi(null)
        setBookHasOverride(false)
      })
    return () => {
      alive = false
    }
  }, [bookId])

  /** 见 AppValue.requestView 的说明 —— 用户主动打开界面一律走这里 */
  const requestView = useCallback((v: View, intent?: string) => {
    // 每次都换一个新对象：消费方靠「引用变了」来触发，同值不会重渲
    setViewIntent(intent ? { kind: intent, n: ++intentSeq.current } : null)
    setView(v)
    setViewTick((t) => t + 1)
  }, [])

  // ---- 提示 ----
  const notify = useCallback((kind: Toast['kind'], text: string) => {
    const id = ++toastSeq.current
    setToasts((prev) => [...prev, { id, kind, text }])
    window.setTimeout(
      () => setToasts((prev) => prev.filter((t) => t.id !== id)),
      kind === 'err' ? 6000 : 3000,
    )
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  // ========================================================================
  // 外观：应用 + 落盘
  // ========================================================================

  // 明暗模式（DOM 上的 data-theme 是所有 CSS 变量的开关）
  useEffect(() => {
    document.documentElement.dataset.theme = ui.mode
  }, [ui.mode])

  // 主题包变量
  useEffect(() => {
    let alive = true
    if (!ui.theme || ui.theme === '默认') {
      applyTheme(null, ui.mode)
      return
    }
    api
      .getTheme(ui.theme)
      .then((pack) => {
        if (alive) applyTheme(pack, ui.mode)
      })
      .catch(() => {
        // 主题文件被删了不该让界面崩，退回默认配色
        if (alive) applyTheme(null, ui.mode)
      })
    return () => {
      alive = false
    }
  }, [ui.theme, ui.mode, themes])

  // 字号
  useEffect(() => {
    document.documentElement.style.setProperty('--font-scale', String(ui.font_scale))
  }, [ui.font_scale])

  // 字体：先注入 @font-face，再改 CSS 变量
  useEffect(() => {
    injectFontFaces(assets?.assets?.fonts ?? [])
    applyFonts(ui.font_ui, ui.font_mono)
  }, [assets, ui.font_ui, ui.font_mono])

  // 背景
  useEffect(() => {
    applyBackground(ui.background, ui.panel_alpha, ui.panel_blur)
  }, [ui.background, ui.panel_alpha, ui.panel_blur])

  // 写回缓存（下次首屏用）
  useEffect(() => {
    if (prefs && prefsDirty.current) writePrefsCache(prefs)
  }, [prefs])

  const patchPrefs = useCallback(
    (patch: Partial<UiPrefs>) => {
      // ---- 乐观更新（落在当前生效的那一层上）----
      if (bookId) {
        setBookUi((prev) => {
          const base = prev ?? prefs?.ui ?? UI_DEFAULTS
          const nextUi: UiPrefs = { ...UI_DEFAULTS, ...base, ...patch }
          if (patch.background) {
            nextUi.background = { ...(base.background ?? UI_DEFAULTS.background), ...patch.background }
          }
          if (nextUi.font_scale) nextUi.font_scale = Math.min(1.6, Math.max(0.75, Number(nextUi.font_scale.toFixed(2))))
          return nextUi
        })
        setBookHasOverride(true)
      } else {
        prefsDirty.current = true
        setPrefs((prev) => {
          const base = prev ?? { ui: UI_DEFAULTS }
          const nextUi: UiPrefs = { ...UI_DEFAULTS, ...base.ui, ...patch }
          if (patch.background) {
            nextUi.background = { ...UI_DEFAULTS.background, ...base.ui?.background, ...patch.background }
          }
          if (nextUi.font_scale) nextUi.font_scale = Math.min(1.6, Math.max(0.75, Number(nextUi.font_scale.toFixed(2))))
          return { ...base, ui: nextUi }
        })
      }

      // ---- 累积增量 + 防抖落盘 ----
      // 书路径只把**改过的键**发出去：book.yaml 里的覆盖保持稀疏，
      // 没动过的键继续跟随全局（改一次全局主题，没单独设置的书跟着换）
      pendingUiPatch.current = { ...pendingUiPatch.current, ...patch }
      if (patch.background) {
        pendingUiPatch.current.background = {
          ...(pendingUiPatch.current.background ?? {}),
          ...patch.background,
        }
      }
      window.clearTimeout(prefsSaveTimer.current)
      prefsSaveTimer.current = window.setTimeout(() => {
        const patchToSend = pendingUiPatch.current
        pendingUiPatch.current = {}
        if (bookId) {
          api
            .saveBookAppearance(bookId, patchToSend)
            .then((r) => {
              setBookUi(r.ui)
              setBookHasOverride(r.has_override)
            })
            .catch((err) => notify('err', `外观保存失败：${(err as Error).message}`))
        } else {
          setPrefs((current) => {
            if (current) {
              api
                .savePrefs({ ui: current.ui })
                .catch((err) => notify('err', `外观保存失败：${(err as Error).message}`))
            }
            return current
          })
        }
      }, 350)
    },
    [bookId, prefs, notify],
  )

  const setUi = useCallback(
    (patch: Partial<UiPrefs>) => {
      patchPrefs(patch)
    },
    [patchPrefs],
  )

  const resetUi = useCallback(() => {
    if (bookId) {
      // 开着书时「恢复出厂」= 清掉这本书的独立设置，改回跟随全局
      // （全局偏好不动 —— 你不会想按一下把所有书的外观都洗掉）
      api
        .resetBookAppearance(bookId)
        .then((r) => {
          setBookUi(r.ui)
          setBookHasOverride(r.has_override)
          notify('ok', '这本书已改回跟随全局外观')
        })
        .catch((err) => notify('err', `重置失败：${(err as Error).message}`))
    } else {
      patchPrefs(UI_DEFAULTS)
      notify('ok', '外观已恢复出厂设置')
    }
  }, [bookId, patchPrefs, notify])

  /** 把当前生效的外观存成**全局默认**（开着书时 = 用这本书的装扮覆盖全局） */
  const applyUiToGlobal = useCallback(async () => {
    const currentUi = bookUi ?? prefs?.ui ?? UI_DEFAULTS
    try {
      await api.savePrefs({ ui: currentUi })
      prefsDirty.current = true
      setPrefs((prev) => ({ ...(prev ?? { ui: UI_DEFAULTS }), ui: currentUi }))
      if (bookId) {
        const r = await api.resetBookAppearance(bookId)
        setBookUi(r.ui)
        setBookHasOverride(r.has_override)
      }
      notify('ok', '已把当前外观存为全局默认')
    } catch (err) {
      notify('err', `保存失败：${(err as Error).message}`)
    }
  }, [bookId, bookUi, prefs, notify])

  const reloadAppearance = useCallback(async () => {
    const [p, t, a] = await Promise.all([api.getPrefs(), api.listThemes(), api.listAssets()])
    setPrefs(p)
    setThemes(t.themes)
    setAssets(a)
  }, [])

  // ========================================================================
  // 书目与实体
  // ========================================================================

  const loadBook = useCallback(async (id: string) => {
    const [listRes, statsRes, tagsRes] = await Promise.all([
      api.listEntities(id),
      api.getStats(id),
      api.getTags(id),
    ])
    setEntities(listRes.items)
    setTypes(listRes.types)
    setStats(statsRes)
    setTags(tagsRes.tags)
    // 样式与贴纸都是**装饰**：拉不到不该让整本书打不开，所以单独兜住
    void Promise.all([
      api.getStyles(id).then(setStyles),
      api.getNodeStyles(id).then((r) => setNodeStyles(r.nodes)),
      api.getDecorations(id).then((r) => {
        decorRef.current = r.scenes ?? {}
        setDecorations(r.scenes ?? {})
      }),
    ]).catch(() => undefined)
  }, [])

  /** 让所有派生视图重取数据。写操作广播与顶栏「刷新」都走这里。 */
  const bumpData = useCallback(() => setDataVersion((v) => v + 1), [])

  // 任何写操作成功 → 广播一次（钩子挂在 API 客户端唯一出口上，见 api/client.ts）
  useEffect(() => api.onDataMutated(bumpData), [bumpData])

  /** 重拉书目清单；当前书已被删掉时自动切到还有的第一本（否则各视图会一路 404）。 */
  const reloadBooks = useCallback(async () => {
    const res = await api.listBooks()
    setBooks(res.books)
    if (bookId && !res.books.some((b) => b.book_id === bookId)) {
      const next = res.books[0]?.book_id ?? null
      setBookId(next)
      setSelectedId(null)
      setTypeFilter(null)
      setTagFilter(null)
      setQuery('')
      setEntities([])
      setStats(null)
      setTags([])
      if (next) {
        writeLS(LS.book, next)
        await loadBook(next)
      } else {
        writeLS(LS.book, '')
      }
    }
    return res.books
  }, [bookId, loadBook])

  const refresh = useCallback(async () => {
    try {
      // 顺序刻意是「先刷新清单，再按清单决定读哪本」。
      // 反过来的话，删掉当前书目之后这一步会拿着闭包里那个**已经不存在**的
      // bookId 去 loadBook，白报一条 404 —— 而书其实好好地换过去了。
      const list = await reloadBooks()
      const stillThere = bookId && list.some((b) => b.book_id === bookId)
      if (stillThere) await loadBook(bookId as string)
      bumpData()
    } catch (err) {
      notify('err', `刷新失败：${(err as Error).message}`)
    }
  }, [bookId, loadBook, notify, bumpData, reloadBooks])

  // ---- 启动 ----
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        // 外观与书目并行拉，谁先回来都不影响
        void reloadAppearance().catch(() => undefined)

        const res = await api.listBooks()
        if (!alive) return
        setBooks(res.books)

        const remembered = readLS(LS.book, '')
        const pick =
          res.books.find((b) => b.book_id === remembered)?.book_id ?? res.books[0]?.book_id ?? null
        setBookId(pick)
        if (pick) {
          writeLS(LS.book, pick)
          await loadBook(pick)
        }
      } catch (err) {
        if (alive) setBootError((err as Error).message)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [loadBook, reloadAppearance])

  const switchBook = useCallback(
    (id: string) => {
      if (id === bookId) return
      setBookId(id)
      writeLS(LS.book, id)
      setSelectedId(null)
      setTypeFilter(null)
      setTagFilter(null)
      setQuery('')
      requestView('dashboard')
      setEntities([])
      setStats(null)
      setTags([])
      setLoading(true)
      loadBook(id)
        .catch((err) => notify('err', `读取书目失败：${(err as Error).message}`))
        .finally(() => setLoading(false))
    },
    [bookId, loadBook, notify, requestView],
  )

  const createBook = useCallback(
    async (id: string, title: string, author: string, genre = '') => {
      const book = await api.createBook(id, title, author, genre)
      await reloadBooks()
      switchBook(book.book_id)
    },
    [reloadBooks, switchBook],
  )

  const updateBookMeta = useCallback(
    async (patch: { title?: string; author?: string; genre?: string; cover?: string }) => {
      if (!bookId) return
      await api.updateBook(bookId, patch)
      // 题材/封面随书目清单走，重拉一遍全界面生效
      const res = await api.listBooks()
      setBooks(res.books)
    },
    [],
  )

  const openEntity = useCallback(
    (id: string) => {
      requestView('entities')
      setSelectedId(id)
    },
    [requestView],
  )

  // ========================================================================
  // 可视化样式（P5）
  //
  // 这里刻意**不**走「先请求后端、成功后再更新内存」那条老规矩，原因是
  // 样式包在界面上是**连续调**的：拖一下大小滑杆、连着点几个形状按钮。
  // 每动一下打一次接口，一是拖滑杆会把接口打爆，二是手感会变成「松手才变」。
  //
  // 改成：**内存立刻改（图马上变形）+ 400ms 防抖后整体落盘**。
  // 存不上只提示，不回滚内存 —— 装饰层的东西，让用户先看到效果比数据一致更值。
  // ========================================================================

  /**
   * 当前生效包的**权威副本**。
   *
   * 为什么要一个 ref 而不是直接读 `styles`：连续两次改动之间 React 可能还
   * 没重渲，闭包里的 `styles` 是旧的，第二次改动会把第一次的覆盖掉。
   * 这个 ref 在每次改动时**同步**更新，连点几下也能正确叠加。
   */
  const packRef = useRef<StylePack | null>(null)
  useEffect(() => {
    packRef.current = styles?.active_pack ?? null
  }, [styles?.active_pack])

  const packSaveTimer = useRef<number | undefined>(undefined)

  /** 样式操作统一兜错：存不上要说话，但不回滚内存 —— 界面别跟着抖 */
  const styleAction = useCallback(
    async (fn: () => Promise<void>, what: string) => {
      try {
        await fn()
      } catch (e) {
        notify('err', `${what}没存上：${(e as Error).message}`)
      }
    },
    [notify],
  )

  /** 防抖落盘。连拖滑杆只在停手之后写一次文件。 */
  const queuePackSave = useCallback(
    (next: StylePack) => {
      if (!bookId) return
      window.clearTimeout(packSaveTimer.current)
      packSaveTimer.current = window.setTimeout(() => {
        void styleAction(async () => {
          const res = await api.saveStylePack(bookId, next)
          setStyles((prev) =>
            prev
              ? {
                  ...prev,
                  // 只有「还是当前这一套」时才用后端返回的换掉内存，
                  // 否则会把用户刚切过去的那一套又改回来
                  active_pack:
                    prev.active_pack.id === res.pack.id ? res.pack : prev.active_pack,
                  packs: prev.packs.map((p) =>
                    p.id === res.pack.id
                      ? {
                          ...p,
                          name: res.pack.name,
                          desc: res.pack.desc ?? '',
                          modified: res.pack.modified,
                          layout: res.pack.graph.layout,
                        }
                      : p,
                  ),
                }
              : prev,
          )
        }, '样式包')
      }, 400)
    },
    [bookId, styleAction],
  )

  /** 就地改当前包：内存立刻生效，落盘排队 */
  const editActivePack = useCallback(
    (mut: (cur: StylePack) => StylePack) => {
      const cur = packRef.current
      if (!cur) return
      const next = mut(cur)
      packRef.current = next
      setStyles((prev) => (prev ? { ...prev, active_pack: next } : prev))
      setStyleToken((t) => t + 1)
      queuePackSave(next)
    },
    [queuePackSave],
  )

  const patchPackGraph = useCallback(
    (patch: Partial<GraphSpec>) =>
      editActivePack((cur) => ({ ...cur, graph: { ...cur.graph, ...patch } })),
    [editActivePack],
  )

  const patchPackRules = useCallback(
    (rules: StyleRule[]) => editActivePack((cur) => ({ ...cur, rules })),
    [editActivePack],
  )

  const patchPackMeta = useCallback(
    (patch: { name?: string; desc?: string }) => editActivePack((cur) => ({ ...cur, ...patch })),
    [editActivePack],
  )

  const reloadStyles = useCallback(
    async (id?: string) => {
      const bid = id ?? bookId
      if (!bid) return
      const [s, n] = await Promise.all([api.getStyles(bid), api.getNodeStyles(bid)])
      setStyles(s)
      setNodeStyles(n.nodes)
      setStyleToken((t) => t + 1)
    },
    [bookId],
  )

  const setPack = useCallback(
    (id: string) =>
      styleAction(async () => {
        if (!bookId) return
        const res = await api.setActivePack(bookId, id)
        setStyles((prev) =>
          prev ? { ...prev, active: res.active, active_pack: res.pack } : prev,
        )
        setStyleToken((t) => t + 1)
      }, '切换样式包'),
    [bookId, styleAction],
  )

  const newPack = useCallback(
    (name: string, from?: string) =>
      styleAction(async () => {
        if (!bookId) return
        await api.createStylePack(bookId, name, from)
        await reloadStyles()
      }, '新建样式包'),
    [bookId, reloadStyles, styleAction],
  )

  const removePack = useCallback(
    (id: string) =>
      styleAction(async () => {
        if (!bookId) return
        await api.deleteStylePack(bookId, id)
        await reloadStyles()
      }, '删除样式包'),
    [bookId, reloadStyles, styleAction],
  )

  /**
   * 导入一个样式包。
   *
   * 分两步：**先新建**（后端生成 id），**再填内容**。
   * 为什么不直接用文件里的 id：id 也是文件名，别人文件里写个 `../x` 就写到别处去了。
   * 一律由后端发号，导入的东西永远是「新增一个」，不会覆盖掉你现成的那几个。
   */
  const importPack = useCallback(
    (raw: unknown) =>
      styleAction(async () => {
        if (!bookId) return
        const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<StylePack>
        const created = await api.createStylePack(bookId, String(src.name || '导入的样式'))
        const merged: StylePack = {
          ...created.pack,
          name: String(src.name || created.pack.name),
          desc: String(src.desc ?? ''),
          graph: { ...created.pack.graph, ...(src.graph ?? {}) },
          rules: Array.isArray(src.rules) ? src.rules : [],
        }
        await api.saveStylePack(bookId, merged)
        await reloadStyles()
      }, '导入样式'),
    [bookId, reloadStyles, styleAction],
  )

  const setNodeStyle = useCallback(
    (entityId: string, patch: NodeStylePatch) =>
      styleAction(async () => {
        if (!bookId) return
        const next: Record<string, NodeStylePatch> = { ...nodeStyles }
        // 空对象 = 恢复默认：直接删掉那条，别在文件里留空壳
        if (!patch || !Object.keys(patch).length) delete next[entityId]
        else next[entityId] = patch
        const res = await api.saveNodeStyles(bookId, next)
        setNodeStyles(res.nodes)
        setStyleToken((t) => t + 1)
      }, '节点外观'),
    [bookId, nodeStyles, styleAction],
  )

  // ---- 贴纸（P5 9.3）----
  // 和样式包同一套理由：拖动贴纸是**连续动作**，一下一个请求会把接口打爆，
  // 手感也会变成「松手才动」。所以内存立刻改、400ms 防抖落盘。
  //
  // 权威副本用 ref：连着拖三下，三次之间 React 可能都没重渲，
  // 闭包里读到的 `decorations` 还是旧的 —— 第二次就会把第一次的改动抹掉。
  const decorRef = useRef<Record<string, Decoration[]>>({})
  const decorSaveTimer = useRef<number | undefined>(undefined)

  const setSceneDecorations = useCallback(
    (sceneKey: string, next: Decoration[] | ((cur: Decoration[]) => Decoration[])) => {
      if (!bookId || !sceneKey) return
      const cur = decorRef.current[sceneKey] ?? []
      const list = typeof next === 'function' ? next(cur) : next
      const all = { ...decorRef.current, [sceneKey]: list }
      decorRef.current = all
      setDecorations(all)
      window.clearTimeout(decorSaveTimer.current)
      decorSaveTimer.current = window.setTimeout(() => {
        void (async () => {
          try {
            await api.saveDecorations(bookId, all)
          } catch (e) {
            // 装饰层的东西：存不上只提示，不回滚内存 —— 让用户先看到效果更值
            notify('err', `贴纸没存上：${(e as Error).message}`)
          }
        })()
      }, 400)
    },
    [bookId, notify],
  )

  // ---- 便捷读法（TopBar 等处沿用旧名字） ----
  const setFontScale = useCallback((v: number) => setUi({ font_scale: v }), [setUi])

  const toggleTheme = useCallback(
    () => setUi({ mode: ui.mode === 'dark' ? 'light' : 'dark' }),
    [setUi, ui.mode],
  )
  const toggleSidebar = useCallback(
    () => setUi({ sidebar_open: !ui.sidebar_open }),
    [setUi, ui.sidebar_open],
  )

  const toastApi = useMemo<ToastApi>(
    () => ({ toasts, notify, dismissToast }),
    [toasts, notify, dismissToast],
  )

  const uiApi = useMemo<UiApi>(
    () => ({
      prefs,
      ui,
      setUi,
      resetUi,
      inBookScope: Boolean(bookId),
      bookHasOverride,
      applyUiToGlobal,
      themes,
      assets,
      reloadAppearance,
      theme: ui.mode,
      toggleTheme,
      fontScale: ui.font_scale,
      setFontScale,
      sidebarOpen: ui.sidebar_open,
      toggleSidebar,
    }),
    [
      prefs, ui, setUi, resetUi, bookId, bookHasOverride, applyUiToGlobal, themes, assets, reloadAppearance,
      toggleTheme, setFontScale, toggleSidebar,
    ],
  )

  const value = useMemo<AppValue>(
    () => ({
      view,
      setView,
      requestView,
      viewTick,
      viewIntent,
      dataVersion,
      openEntity,
      books,
      bookId,
      entities,
      stats,
      tags,
      types,
      styles,
      nodeStyles,
      styleToken,
      setPack,
      patchPackGraph,
      patchPackRules,
      patchPackMeta,
      newPack,
      removePack,
      importPack,
      setNodeStyle,
      decorations,
      setSceneDecorations,
      loading,
      bootError,
      selectedId,
      select: setSelectedId,
      typeFilter,
      setTypeFilter,
      tagFilter,
      setTagFilter,
      query,
      setQuery,
      prefs,
      setUi,
      resetUi,
      themes,
      assets,
      reloadAppearance,
      theme: ui.mode,
      toggleTheme,
      fontScale: ui.font_scale,
      setFontScale,
      sidebarOpen: ui.sidebar_open,
      toggleSidebar,
      switchBook,
      refresh,
      reloadBooks,
      createBook,
      updateBookMeta,
      currentBook: books.find((b) => b.book_id === bookId) ?? null,
      notify,
      toasts,
      dismissToast,
    }),
    [
      view, viewTick, viewIntent, dataVersion, requestView, openEntity, books, bookId, entities, stats, tags, types, loading, bootError,
      styles, nodeStyles, styleToken, setPack, patchPackGraph, patchPackRules, patchPackMeta,
      newPack, removePack, importPack, setNodeStyle, decorations, setSceneDecorations,
      selectedId, typeFilter, tagFilter, query, prefs, setUi, resetUi, themes, assets,
      reloadAppearance, ui.mode, ui.font_scale, ui.sidebar_open, setFontScale,
      switchBook, refresh, reloadBooks, createBook, updateBookMeta, notify, toasts, dismissToast,
      toggleTheme, toggleSidebar,
    ],
  )

  return (
    <ToastCtx.Provider value={toastApi}>
      <UiCtx.Provider value={uiApi}>
        <Ctx.Provider value={value}>{children}</Ctx.Provider>
      </UiCtx.Provider>
    </ToastCtx.Provider>
  )
}

export function useApp(): AppValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp 必须在 AppProvider 内使用')
  return v
}

/** 只要外观相关的状态 —— 拖滑杆、换主题时不会连累别的界面重渲 */
export function useAppUi(): UiApi {
  const v = useContext(UiCtx)
  if (!v) throw new Error('useAppUi 必须在 AppProvider 内使用')
  return v
}

/** 只要提示相关的状态 —— 弹一条提示不该让整棵树重算 */
export function useToast(): ToastApi {
  const v = useContext(ToastCtx)
  if (!v) throw new Error('useToast 必须在 AppProvider 内使用')
  return v
}
