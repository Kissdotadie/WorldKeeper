/**
 * 面板注册表。
 *
 * 每个界面在这里登记成一个 dockview 面板 —— 于是「Adobe 式自由布局」是**白送的**：
 * 视图组件一行都不用改，能摆成什么样完全由 dockview 决定。
 *
 * 三条约束：
 * 1. `components` 与 `PANEL_DEFS` 必须是**模块级常量**。
 *    dockview 靠对象引用判断要不要重建面板，每次渲染新建对象会让面板疯狂重挂。
 * 2. 视图需要的动作（新建实体、重建索引…）通过 `ActionsCtx` 拿，
 *    不能塞进 props —— 那会破坏第 1 条。
 * 3. 视图一律走 `lazy()` 按需加载（P11-B1），并且内容要过 `Gate` ——
 *    只加载还不够：dockview 会把布局里**所有**面板都建出来，
 *    不拦一道的话打开页面就把 15 个视图全下下来了，按需加载等于白做。
 */

import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useState,
  type FunctionComponent,
  type ReactNode,
} from 'react'
import type { IDockviewPanelProps } from 'dockview'

import { useApp, type View } from '../state/store'
import { Sidebar } from '../components/Sidebar'
import { EntityGrid } from '../components/EntityGrid'
import { EntityDetail } from '../components/EntityDetail'
import type { EntityDetail as Detail } from '../api/types'

// --------------------------------------------------------------------------
// 视图按需加载（P11-B1 前端分包）
//
// ⚠️ `lazy()` 必须在**模块级**调用一次 —— 组件引用要稳定，
// 在渲染里新建会让 dockview 认为「组件换了」而反复重挂面板。
// --------------------------------------------------------------------------

const DashboardView = lazy(() => import('../views/DashboardView'))
const ImportView = lazy(() => import('../views/ImportView'))
const AdminView = lazy(() => import('../views/AdminView'))
const SkillsView = lazy(() => import('../views/SkillsView').then((m) => ({ default: m.SkillsView })))
const ToolboxView = lazy(() => import('../views/ToolboxView'))
const CatalogView = lazy(() => import('../views/CatalogView'))
const DocView = lazy(() => import('../views/DocView'))
const RelationView = lazy(() => import('../views/RelationView'))
const TimelineView = lazy(() => import('../views/TimelineView'))
const RosterView = lazy(() => import('../views/RosterView'))
const AppearanceView = lazy(() => import('../views/AppearanceView'))
const AssetsView = lazy(() => import('../views/AssetsView'))
const SupportPanel = lazy(() =>
  import('../components/SupportPanel').then((m) => ({ default: m.SupportPanel })),
)
const MethodologyView = lazy(() => import('../views/MethodologyView'))
const ChapterView = lazy(() => import('../views/ChapterView'))
const ForeshadowView = lazy(() => import('../views/ForeshadowView'))
const JobPanel = lazy(() =>
  import('../components/JobPanel').then((m) => ({ default: m.JobPanel })),
)

/** 懒加载 / 未激活时的占位 */
function Loading() {
  return <div className="dock__loading">正在载入视图…</div>
}

/**
 * 内容闸门：面板**第一次被激活**之后才真正挂载里面的视图。
 *
 * 为什么必须有这道闸：布局存档把 15 个视图当成同一组的 15 个 tab，
 * dockview 会为每个 tab 都创建内容组件 —— 于是「按需加载」变成了
 * 「打开页面就把全部视图下载完」（实测首屏从 591KB 涨回 2141KB）。
 *
 * 一旦激活过就永久挂载（`seen` 不回退）—— 切回来时滚动位置、
 * 粘贴框里的内容、图上的选中状态都还在，跟以前一样。
 */
function Gate({ api, children }: { api: IDockviewPanelProps['api']; children: ReactNode }) {
  const [seen, setSeen] = useState(() => api.isVisible || api.isActive)

  useEffect(() => {
    // 订阅之前很可能已经是可见的（挂载时机早于布局结算），所以先补判一次
    if (api.isVisible || api.isActive) setSeen(true)
    const g1 = api.onDidVisibilityChange((e) => {
      if (e.isVisible) setSeen(true)
    })
    const g2 = api.onDidActiveChange((e) => {
      if (e.isActive) setSeen(true)
    })
    return () => {
      g1.dispose()
      g2.dispose()
    }
  }, [api])

  return <Suspense fallback={<Loading />}>{seen ? children : <Loading />}</Suspense>
}

// --------------------------------------------------------------------------
// 面板所需的动作（由 Shell 提供，避免走 props 破坏组件字典的稳定性）
// --------------------------------------------------------------------------

export interface ShellActions {
  /** 打开新建实体表单；给类型 key 时表单预选该类型（分类视图里的局部新建用） */
  onNewEntity: (defaultType?: string) => void
  onNewBook: () => void
  onEditEntity: (d: Detail) => void
  onRebuild: () => void
  rebuilding: boolean
}

const ActionsCtx = createContext<ShellActions | null>(null)

export function ActionsProvider({ value, children }: { value: ShellActions; children: ReactNode }) {
  return <ActionsCtx.Provider value={value}>{children}</ActionsCtx.Provider>
}

export function useActions(): ShellActions {
  const v = useContext(ActionsCtx)
  if (!v) throw new Error('面板必须在 ActionsProvider 内渲染')
  return v
}

// --------------------------------------------------------------------------
// 面板定义
// --------------------------------------------------------------------------

export interface PanelDef {
  title: string
  /** 鼠标悬停在 tab 上显示的说明 */
  hint: string
  /** 默认布局里建议的尺寸（相对权重） */
  weight: number
}

export const PANEL_DEFS: Record<View, PanelDef> = {
  dashboard: { title: '汇总', hint: '一页看全：统计、分布、最近改动', weight: 2 },
  world: { title: '世界观', hint: '设定类实体（概念/境界/器物）的思维导图', weight: 2 },
  geo: { title: '地理观', hint: '地点按标签聚成树', weight: 2 },
  roster: { title: '名册录', hint: '整册名册，带登记完备度', weight: 2 },
  relation: { title: '关系网', hint: '双链关系图，四种布局', weight: 2 },
  methodology: { title: '方法论', hint: '哲学观、意识形态、戒律 —— 谁信奉什么', weight: 2 },
  timeline: { title: '时间线', hint: '叙事序（第几章）', weight: 2 },
  history: { title: '历史观', hint: '故事内纪年表', weight: 2 },
  plot: { title: '剧情线', hint: '卷 / 章节 / 事件 / 状态', weight: 2 },
  foreshadow: { title: '伏笔看板', hint: '埋下去就要记得收', weight: 2 },
  entities: { title: '全部实体', hint: '录入与浏览的主界面', weight: 3 },
  text: { title: '正文', hint: '导入章节原文、跑抽取、审候选', weight: 2 },
  skills: { title: '技能中心', hint: '提示词模板库 —— 选章节，读一遍，出分析', weight: 2 },
  toolbox: { title: '工具箱', hint: '免费对话 / 图片生成的网页入口合集', weight: 2 },
  settings: { title: '设置', hint: '外观、主题、字体、索引与日志', weight: 2 },
  jobs: { title: '任务中心', hint: '长活儿的进度、停止与续跑', weight: 2 },
}

/** 导航条上的顺序（也是默认布局里打开的顺序参考）—— 与 NavRail 的分组顺序保持一致。
 *  `skills` 不在列（P11-1️⃣③）：技能中心并进了工具箱的「AI 技能」页签，
 *  侧栏不再给它单独一个入口；但面板本体保留，旧布局存档里的 skills 页签照样能开。 */
export const PANEL_ORDER: View[] = [
  'dashboard',
  'world',
  'geo',
  'roster',
  'methodology',
  'history',
  'timeline',
  'plot',
  'foreshadow',
  'relation',
  'entities',
  'text',
  'toolbox',
  'settings',
  'jobs',
]

// --------------------------------------------------------------------------
// 各面板的实现
// --------------------------------------------------------------------------

function DashboardPanel(p: IDockviewPanelProps) {
  const a = useActions()
  return (
    <Gate api={p.api}>
      <div className="dock__scroll">
        <DashboardView
          onNewEntity={a.onNewEntity}
          onNewBook={a.onNewBook}
          onRebuild={a.onRebuild}
          rebuilding={a.rebuilding}
        />
      </div>
    </Gate>
  )
}

function WorldPanel(p: IDockviewPanelProps) {
  return (
    <Gate api={p.api}>
      <CatalogView
        title="世界观"
        types={['concept', 'realm', 'item']}
        groupByTag
        note="概念、境界、器物这三类构成为「世界的规矩」。这里没有单独的录入入口 —— 设定也是实体，在「全部实体」里建，建完自动出现在这张图上。"
        emptyHint="还没有任何设定类实体。去「全部实体」里新建一条，类型选「概念」或「境界」，这里就会长出思维导图。"
      />
    </Gate>
  )
}

function GeoPanel(p: IDockviewPanelProps) {
  return (
    <Gate api={p.api}>
      <CatalogView
        title="地理观"
        types={['location']}
        groupByTag
        enableMap
        note="地图是「地点画在哪」，实体是「地点是什么」—— 摆位存 view/maps/，删掉只丢摆法，地点一个字不动。地图可以层层下钻：世界图 → 区域图 → 城市图；地点之间的从属与相邻仍然靠双链表达。"
        emptyHint="还没有地点实体。在图上双击空白就能直接建一个，或者去「全部实体」里新建、类型选「地点」。"
      />
    </Gate>
  )
}

function RelationPanel(p: IDockviewPanelProps) {
  return (
    <Gate api={p.api}>
      <RelationView />
    </Gate>
  )
}

function TimelinePanel(p: IDockviewPanelProps) {
  return (
    <Gate api={p.api}>
      <TimelineView />
    </Gate>
  )
}

function RosterPanel(p: IDockviewPanelProps) {
  return (
    <Gate api={p.api}>
      <RosterView />
    </Gate>
  )
}

function HistoryPanel(p: IDockviewPanelProps) {
  return (
    <Gate api={p.api}>
      <DocView
        name="chronology"
        title="历史观 · 纪年表"
        note="这是**故事内时间**那一轨（明显帝143年秋），和「时间线」的**叙事序**（第几章）互为补充。两边都写好，才看得出「哪一章在讲哪一年」。"
      />
    </Gate>
  )
}

function PlotPanel(p: IDockviewPanelProps) {
  return (
    <Gate api={p.api}>
      <DocView
        name="plot"
        title="剧情线"
        groupColumn={3}
        note="现阶段手填大纲。等章节正文导入（P2/P3）之后，这里会由 AI 抽取的事件自动补全，你只需要校对与排序。"
      />
    </Gate>
  )
}

function ForeshadowPanel(p: IDockviewPanelProps) {
  return (
    <Gate api={p.api}>
      <div className="dock__scroll">
        <ForeshadowView />
      </div>
    </Gate>
  )
}

function EntitiesPanel(p: IDockviewPanelProps) {
  const { selectedId, select, sidebarOpen } = useApp()
  const a = useActions()
  return (
    <Gate api={p.api}>
      <div className="entity-panel">
        {sidebarOpen && (
          <div className="entity-panel__side">
            <Sidebar />
          </div>
        )}
        <div className="entity-panel__main">
          {/* 列表用隐藏而不是卸载 —— 否则每次点开一条实体再返回，
              滚动位置和「加载到第几页」都会丢。 */}
          <div className="epane__stack" hidden={Boolean(selectedId)}>
            <EntityGrid />
          </div>
          {selectedId && (
            <div className="epane__scroll">
              <EntityDetail
                entityId={selectedId}
                onBack={() => select(null)}
                onEdit={(d) => a.onEditEntity(d)}
              />
            </div>
          )}
        </div>
      </div>
    </Gate>
  )
}

/** 正文：章节原文与导入本来就是「把稿子弄进来」的前后两步，
 *  拆成两条导航项只会让你在两个入口之间来回跳。 */
function TextPanel(p: IDockviewPanelProps) {
  const { viewIntent } = useApp()
  const [seg, setSeg] = useState<'chapters' | 'import'>('chapters')
  // 只挂载**访问过**的页签：切走再切回来内容还在（不卸载），
  // 但没点过的那一页不会白白下载（P11-B1）
  const [visited, setVisited] = useState<Set<string>>(() => new Set(['chapters']))
  const go = useCallback((k: 'chapters' | 'import') => {
    setSeg(k)
    setVisited((prev) => (prev.has(k) ? prev : new Set(prev).add(k)))
  }, [])
  /**
   * 接住别处跳过来的意图（N8）。
   *
   * 「世界观空着 → 去「正文」导入章节」这类跳转，如果只打开面板却停在
   * 「章节原文」页签，用户还得自己再点一下 —— 等于跳了个寂寞。
   * viewIntent 每次都是新对象，所以这里一定跑得到。
   */
  useEffect(() => {
    if (viewIntent?.kind === 'text:import') go('import')
  }, [viewIntent, go])
  return (
    <Gate api={p.api}>
      <div className="dock__scroll">
        <div className="seg panel-seg" role="tablist" aria-label="正文">
          {([['chapters', '章节原文'], ['import', '导入']] as const).map(([k, label]) => (
            <button
              key={k}
              className={`seg__item ${seg === k ? 'seg__item--on' : ''}`}
              onClick={() => go(k)}
            >
              {label}
            </button>
          ))}
        </div>
        {/* 用 display 切换而不是卸载：切走再切回来，粘贴框里的内容还在 */}
        <div style={{ display: seg === 'chapters' ? undefined : 'none' }}>
          {visited.has('chapters') && (
            <Suspense fallback={<Loading />}>
              <ChapterView />
            </Suspense>
          )}
        </div>
        <div style={{ display: seg === 'import' ? undefined : 'none' }}>
          {visited.has('import') && (
            <Suspense fallback={<Loading />}>
              <ImportView />
            </Suspense>
          )}
        </div>
      </div>
    </Gate>
  )
}

/** 技能中心：提示词模板库（只读正文产分析，不改正文） */
function SkillsPanel(p: IDockviewPanelProps) {
  return (
    <Gate api={p.api}>
      <div className="dock__scroll">
        <SkillsView />
      </div>
    </Gate>
  )
}

/** 工具箱：外部入口 + AI 技能 合并成一格（P11-1️⃣③）。
 *
 * 为什么要合并：侧栏是固定单列，15 个入口在 1024 宽 / 矮窗口下底部的
 * 「技能中心」「工具箱」要滚动才够得着。技能中心本质是工具箱的一种
 * （都是「干活用的外部能力」），并成一格的两张页签，侧栏少一项，
 * 大多数窗口高度就不用滚了。`SkillsView` 原样嵌进来，一行没改。
 */
function ToolboxPanel(p: IDockviewPanelProps) {
  const [seg, setSeg] = useState<'links' | 'skills'>('links')
  const [visited, setVisited] = useState<Set<string>>(() => new Set(['links']))
  const go = (k: 'links' | 'skills') => {
    setSeg(k)
    setVisited((prev) => (prev.has(k) ? prev : new Set(prev).add(k)))
  }
  return (
    <Gate api={p.api}>
      <div className="dock__scroll">
        <div className="seg panel-seg" role="tablist" aria-label="工具箱">
          {([['links', '外部入口'], ['skills', 'AI 技能']] as const).map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={seg === k}
              className={`seg__item ${seg === k ? 'seg__item--on' : ''}`}
              onClick={() => go(k)}
            >
              {label}
            </button>
          ))}
        </div>
        {/* 没点过的页签不下载 —— AI 技能那一页 30KB+，为看一眼收藏夹没必要全下 */}
        {(['links', 'skills'] as const).map((k) =>
          visited.has(k) ? (
            <div key={k} style={{ display: seg === k ? undefined : 'none' }}>
              <Suspense fallback={<Loading />}>
                {k === 'links' && <ToolboxView />}
                {k === 'skills' && <SkillsView />}
              </Suspense>
            </div>
          ) : null,
        )}
      </div>
    </Gate>
  )
}

/** 设置：外观与后台都是「调这个工具本身」，合并之后导航条清爽一档。 */
function SettingsPanel(p: IDockviewPanelProps) {
  // 默认落在「外观」—— 顶栏那个 ✦ 就是冲它来的，后台是低频的
  const [seg, setSeg] = useState<'appearance' | 'assets' | 'admin' | 'support'>('appearance')
  const [visited, setVisited] = useState<Set<string>>(() => new Set(['appearance']))
  const go = (k: 'appearance' | 'assets' | 'admin' | 'support') => {
    setSeg(k)
    setVisited((prev) => (prev.has(k) ? prev : new Set(prev).add(k)))
  }
  return (
    <Gate api={p.api}>
      <div className="dock__scroll">
        <div className="seg panel-seg" role="tablist" aria-label="设置">
          {(
            [
              ['appearance', '外观'],
              ['assets', '素材库'],
              ['admin', '后台'],
              ['support', '支持作者'],
            ] as const
          ).map(
            ([k, label]) => (
              <button
                key={k}
                className={`seg__item ${seg === k ? 'seg__item--on' : ''}`}
                onClick={() => go(k)}
              >
                {label}
              </button>
            ),
          )}
        </div>
        {/* 同上：没点过的页签不下载 —— 三个子页加起来 60KB，没必要为看一眼外观全下 */}
        {(['appearance', 'assets', 'admin', 'support'] as const).map((k) =>
          visited.has(k) ? (
            <div key={k} style={{ display: seg === k ? undefined : 'none' }}>
              <Suspense fallback={<Loading />}>
                {k === 'appearance' && <AppearanceView />}
                {k === 'assets' && <AssetsView />}
                {k === 'admin' && <AdminView />}
                {k === 'support' && <SupportPanel />}
              </Suspense>
            </div>
          ) : null,
        )}
      </div>
    </Gate>
  )
}

/** 未注册的 panel id（例如布局存档来自旧版本）兜底，不能白屏 */
function UnknownPanel(props: IDockviewPanelProps) {
  return (
    <div className="empty">
      <div className="empty__title">这个面板已经不认识了</div>
      <div className="fs-sm">它可能是旧版本布局留下的（{props.api.id}）。关掉它即可。</div>
    </div>
  )
}

function MethodologyPanel(p: IDockviewPanelProps) {
  return (
    <Gate api={p.api}>
      <div className="dock__scroll">
        <MethodologyView />
      </div>
    </Gate>
  )
}

function JobsPanel(p: IDockviewPanelProps) {
  return (
    <Gate api={p.api}>
      <div className="dock__scroll">
        <JobPanel />
      </div>
    </Gate>
  )
}

/**
 * ⚠️ 模块级常量。dockview 用它判断「组件有没有换」，
 * 每次渲染新建对象会导致所有面板反复重挂、状态全丢。
 */
export const PANEL_COMPONENTS: Record<string, FunctionComponent<IDockviewPanelProps>> = {
  dashboard: DashboardPanel,
  world: WorldPanel,
  geo: GeoPanel,
  roster: RosterPanel,
  relation: RelationPanel,
  methodology: MethodologyPanel,
  timeline: TimelinePanel,
  history: HistoryPanel,
  plot: PlotPanel,
  foreshadow: ForeshadowPanel,
  entities: EntitiesPanel,
  text: TextPanel,
  skills: SkillsPanel,
  toolbox: ToolboxPanel,
  settings: SettingsPanel,
  jobs: JobsPanel,
  // 双保险：旧布局存档里的四个 id 也认得 —— 万一迁移哪天漏了，dockview
  // 也不会因为「不认识组件」抛错把整份布局退回默认，顶多是 tab 名字旧一点
  chapters: TextPanel,
  import: TextPanel,
  appearance: SettingsPanel,
  admin: SettingsPanel,
  __unknown: UnknownPanel,
}

export function componentNameFor(view: string): string {
  return view in PANEL_COMPONENTS ? view : '__unknown'
}
