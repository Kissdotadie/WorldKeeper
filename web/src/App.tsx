/**
 * 应用外壳。
 *
 * 结构：顶栏 + 左侧导航条 + 中间 dockview 工作区。
 *
 * 「哪个界面」和「界面怎么摆」是两件独立的事：
 * - **rail 决定打开哪个面板**（openView：已有就激活，没有就加进当前组）
 * - **dockview 决定面板怎么摆**（拖拽、拆分、缩放、存成预设）
 *
 * 两者通过 `view` 这个单一状态互相同步，谁都不会压着谁。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DockviewApi, DockviewReadyEvent } from 'dockview'
import { AppProvider, useApp, VIEW_ORDER, type View } from './state/store'
import { JobsProvider, useJobs } from './state/jobs'
import { UndoProvider } from './state/undo'
import { PANEL_DEFS } from './shell/panels'
import { NavRail } from './components/NavRail'
import { TopBar } from './components/TopBar'
import { DonateAlertBar } from './components/DonateAlertBar'
import { EntityForm } from './components/EntityForm'
import { BookCreateModal } from './components/BookCreateModal'
import { WelcomeGuide } from './components/WelcomeGuide'
import { Toasts } from './components/Toast'
import { TypeColorStyle } from './components/TypeColorStyle'
import { DockShell } from './shell/DockShell'
import { ActionsProvider, type ShellActions } from './shell/panels'
import { useLayouts } from './shell/useLayouts'
import type { EntityDetail as Detail } from './api/types'
import { useShortcuts } from './lib/shortcuts'

type Overlay =
  | { kind: 'none' }
  | { kind: 'form'; editing: Detail | null; defaultType?: string }
  | { kind: 'book' }

function Shell() {
  const {
    view, setView, requestView, viewTick, bookId, books, bootError, loading, notify, refresh, openEntity,
  } = useApp()

  const apiRef = useRef<DockviewApi | null>(null)
  const [readyTick, setReadyTick] = useState(0)
  const [overlay, setOverlay] = useState<Overlay>({ kind: 'none' })

  const layouts = useLayouts({ bookId, apiRef, readyTick, notify })
  const { openView, noteChange } = layouts

  const close = useCallback(() => setOverlay({ kind: 'none' }), [])

  // 重建索引改走异步任务（P11-A3）——以前是同步等它跑完，大书要十几秒，
  // 期间整个界面像卡死。现在排成任务、顶栏有进度条、可以随时走开，
  // 而且不用自己盯着：它跑完会来通知。
  const {
    active: activeJob, submitRebuild, waitFor: waitJob,
  } = useJobs()
  const rebuilding = activeJob.running?.kind === 'rebuild'

  const rebuild = useCallback(async () => {
    try {
      const job = await submitRebuild(bookId ?? undefined)
      notify('info', `已排入任务中心：${job.title}`)
      const done = await waitJob(job.id)
      if (done.status === 'done') {
        const n = Number(done.result?.total_entities ?? 0)
        notify('ok', done.result?.books ? `重建完成：共 ${n} 条实体` : `重建完成：${n} 条实体`)
        await refresh()
      } else if (done.status === 'cancelled') {
        notify('info', '重建已停止（索引要么是旧的、要么已重建完，没有中间状态）')
      } else {
        notify('err', `重建失败：${done.error ?? done.message}`)
      }
    } catch (e) {
      notify('err', `重建没能排上队：${(e as Error).message}`)
    }
  }, [bookId, notify, refresh, submitRebuild, waitJob])

  // ---- dockview 就绪：在这里订阅布局事件 ----
  // 用 ref 兜住回调，避免每次渲染都重新订阅（dockview 的订阅是 addEventListener 语义）
  const noteChangeRef = useRef(noteChange)
  noteChangeRef.current = noteChange
  const activeChangeRef = useRef<(id: string | null) => void>(() => undefined)

  const handleReady = useCallback((e: DockviewReadyEvent) => {
    apiRef.current = e.api
    e.api.onDidLayoutChange(() => noteChangeRef.current())
    e.api.onDidActivePanelChange((panel) => activeChangeRef.current(panel?.id ?? null))
    setReadyTick((t) => t + 1)
  }, [])

  // ---- 界面切换 → 打开或激活对应面板 ----
  // `viewTick` 是「用户又点了一次入口」的令牌。没有它的话，面板被关掉之后
  // `view` 还停在原值，再点同一个入口值没变、effect 不跑，点了没反应。
  useEffect(() => {
    if (!readyTick) return
    const dapi = apiRef.current
    if (!dapi) return
    if (dapi.activePanel?.id === view) return
    openView(view)
  }, [view, viewTick, readyTick, openView])

  // ---- 点面板标签 → 同步导航条高亮 ----
  const handleActiveChange = useCallback(
    (id: string | null) => {
      if (!id) return
      setView(id as View)
    },
    [setView],
  )
  activeChangeRef.current = handleActiveChange

  // ---- 面板需要的动作（走 Context，避免破坏组件字典的稳定性） ----
  const actions = useMemo<ShellActions>(
    () => ({
      onNewEntity: (defaultType) => setOverlay({ kind: 'form', editing: null, defaultType }),
      onNewBook: () => setOverlay({ kind: 'book' }),
      onEditEntity: (d) => setOverlay({ kind: 'form', editing: d }),
      onRebuild: rebuild,
      rebuilding,
    }),
    [rebuild, rebuilding],
  )

  // ---- 全局快捷键 ----
  // 统一走注册层（P11-A2）：键位表可枚举（给帮助页用）、冲突有提示、
  // 不再各组件零散绑 keydown。视图切换的 1~9 与导航顺序共用一份 PANEL_ORDER。
  useShortcuts(
    [
      { id: 'app.new-entity', keys: 'Ctrl+N', scope: 'global', desc: '新建实体',
        run: (e) => { e.preventDefault(); setOverlay({ kind: 'form', editing: null }) } },
      { id: 'app.text', keys: 'Ctrl+I', scope: 'global', desc: '打开正文',
        run: (e) => { e.preventDefault(); requestView('text') } },
      { id: 'app.jobs', keys: 'Ctrl+J', scope: 'global', desc: '打开任务中心',
        run: (e) => { e.preventDefault(); requestView('jobs') } },
      ...VIEW_ORDER.map((v, i) => ({
        id: `app.view-${v}`,
        keys: `Ctrl+${i + 1}`,
        scope: 'global' as const,
        desc: `切到「${PANEL_DEFS[v].title}」`,
        run: (e: KeyboardEvent) => { e.preventDefault(); requestView(v) },
      })),
    ],
    [requestView],
  )

  return (
    <div className="shell shell--rail">
      <TypeColorStyle />
      <TopBar
        onNewEntity={() => setOverlay({ kind: 'form', editing: null })}
        onNewBook={() => setOverlay({ kind: 'book' })}
        onRebuild={rebuild}
        rebuilding={rebuilding}
        layouts={layouts}
      />

      <DonateAlertBar />

      <NavRail />

      <main className="main">
        {bootError ? (
          <div className="main__pad">
            <div className="notice notice--danger">
              <div>
                <b>连不上后端。</b>
                <div className="fs-sm" style={{ marginTop: 4 }}>{bootError}</div>
                <div className="fs-xs" style={{ marginTop: 6 }}>
                  确认后端已经在跑（启动脚本会打印访问地址），然后刷新本页。
                </div>
              </div>
            </div>
          </div>
        ) : !loading && books.length === 0 ? (
          <div className="empty">
            <div className="empty__title">还没有任何书目</div>
            <div className="fs-sm" style={{ maxWidth: 460 }}>
              先建一本书。之后所有实体都挂在它下面 —— 多本书并行时数据互不干扰。
            </div>
            <button className="btn btn--primary" onClick={() => setOverlay({ kind: 'book' })}>
              ＋ 新建书目
            </button>
          </div>
        ) : !bookId ? (
          <div className="empty">
            <div className="empty__title">请选择一本书</div>
          </div>
        ) : (
          <ActionsProvider value={actions}>
            <DockShell onReady={handleReady} />
          </ActionsProvider>
        )}
      </main>

      {overlay.kind === 'form' && (
        <EntityForm
          editing={overlay.editing}
          defaultType={overlay.defaultType}
          onClose={close}
          onSaved={(id) => openEntity(id)}
        />
      )}
      {overlay.kind === 'book' && <BookCreateModal onClose={close} />}

      {/* 新手引导（P11-B2）：首次访问出现，跳过后不再提示 */}
      <WelcomeGuide />

      <Toasts />
    </div>
  )
}

export default function App() {
  return (
    <AppProvider>
      {/* 任务状态放在 Shell 之上：切视图、切书、关掉面板，后台活儿照跑，
          进度也照显示（顶栏那条常驻小条就是从这儿读的）。 */}
      <JobsProvider>
        {/* 撤销栈（P11-A1）也放 Shell 之上：换视图不该把「刚做的那一步」丢掉。
            换**书**才清空 —— 跨书的旧快照盖不到新书的实体上。 */}
        <UndoProvider>
          <Shell />
        </UndoProvider>
      </JobsProvider>
    </AppProvider>
  )
}
