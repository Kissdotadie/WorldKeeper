import { useEffect, useRef, useState } from 'react'
import { useApp } from '../state/store'
import { modKey } from '../lib/format'
import { JobChip } from './JobChip'
import { UndoChip } from './UndoChip'
import { UpdateChip } from './UpdateChip'
import { LayoutMenu } from './LayoutMenu'
import { useShortcuts } from '../lib/shortcuts'
import type { LayoutsApi } from '../shell/useLayouts'

interface Props {
  onNewEntity: () => void
  layouts: LayoutsApi
  /** 顶栏「快捷」菜单：原先是汇总页里的一块卡片，挪上来是为了在任何界面都能一键到 */
  onNewBook: () => void
  onRebuild: () => void
  rebuilding?: boolean
}

/** 敲字到「真的开始筛」之间的等待。
 *  搜索词一动，世界观/关系网/时间线那几张图都要重算 —— 每敲一个字母算一次太亏，
 *  输入框本身仍然是即时的，只是把广播往后压一压。 */
const TYPE_DELAY = 180

export function TopBar({ onNewEntity, layouts, onNewBook, onRebuild, rebuilding }: Props) {
  const {
    query, setQuery, theme, toggleTheme, fontScale, setFontScale,
    sidebarOpen, toggleSidebar, view, requestView, books, bookId, switchBook,
    refresh, notify, dataVersion,
  } = useApp()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [spin, setSpin] = useState(false)
  // 「快捷」下拉：从汇总页的「快捷操作」卡片挪上来的那几个动作
  const [actionsOpen, setActionsOpen] = useState(false)
  const actionsBox = useRef<HTMLDivElement>(null)

  // 点空白处收起下拉（与布局菜单同一个套路）
  useEffect(() => {
    if (!actionsOpen) return
    const onDown = (e: MouseEvent) => {
      if (actionsBox.current && !actionsBox.current.contains(e.target as Node)) setActionsOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [actionsOpen])

  // 手动刷新（P11-1️⃣①）。
  // 正常情况下不需要点它 —— 写操作会自动广播失效（dataVersion），各视图自己就更新了。
  // 留着它是为了两个场景：① 外部改了 md 文件（工具不知道）；② 万一哪个视图还有漏网的依赖，
  // 有个「立刻重取一遍」的明确出口，不用去按浏览器的 F5。
  const onRefresh = async () => {
    setBusy(true)
    setSpin(true)
    try {
      await refresh()
      notify('ok', '已重新读取数据')
    } finally {
      setBusy(false)
      window.setTimeout(() => setSpin(false), 420)
    }
  }

  // 数据版本变了就顺手转一下图标，给个「确实刷新了」的反馈
  useEffect(() => {
    setSpin(true)
    const t = window.setTimeout(() => setSpin(false), 420)
    return () => window.clearTimeout(t)
  }, [dataVersion])

  // 输入框自己先显示，广播给全局的延后 —— 打字手感不受影响
  const [draft, setDraft] = useState(query)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const viewRef = useRef(view)
  viewRef.current = view
  const timer = useRef<number | undefined>(undefined)

  // 外部改了搜索词（点「搜索：xxx ✕」清除、换书重置）时，输入框跟上
  useEffect(() => {
    if (query !== draftRef.current) setDraft(query)
  }, [query])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const onQuery = (v: string, immediate = false) => {
    setDraft(v)
    window.clearTimeout(timer.current)
    const push = () => {
      setQuery(v)
      if (v && viewRef.current !== 'entities') requestView('entities')
    }
    if (immediate) push()
    else timer.current = window.setTimeout(push, TYPE_DELAY)
  }

  // Ctrl/⌘+K 聚焦搜索、Esc（在搜索框里）清空 —— 统一走注册层（P11-A2）
  useShortcuts([
    {
      id: 'search.focus', keys: 'Ctrl+K', scope: 'global', desc: '聚焦搜索框',
      run: (e) => {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      },
    },
    {
      id: 'search.clear', keys: 'Esc', scope: 'global', desc: '清空搜索并移开焦点',
      when: () => document.activeElement === inputRef.current,
      run: () => {
        onQuery('', true)
        inputRef.current?.blur()
      },
    },
  ])

  return (
    <header className="topbar">
      {view === 'entities' && (
        <button
          className="btn btn--ghost btn--icon"
          onClick={toggleSidebar}
          title={sidebarOpen ? '收起侧栏' : '展开侧栏'}
          aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}
        >
          {sidebarOpen ? '⟨' : '⟩'}
        </button>
      )}

      <div className="topbar__brand">世界观查询器</div>

      <select
        className="select"
        style={{ width: 'auto', minWidth: 130 }}
        value={bookId ?? ''}
        onChange={(e) => switchBook(e.target.value)}
        aria-label="当前书目"
      >
        {books.length === 0 && <option value="">没有书目</option>}
        {books.map((b) => (
          <option key={b.book_id} value={b.book_id}>
            {b.title}
          </option>
        ))}
      </select>

      <div className="search">
        <span className="search__icon">⌕</span>
        <input
          ref={inputRef}
          className="search__input"
          type="search"
          value={draft}
          placeholder={`搜索实体（${modKey()}+K）`}
          title="多个词用空格隔开，会要求每个词都命中；一到两个字的短词也能搜到正文里的内容"
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            // Esc 收回焦点：搜索框是个临时落脚点，键盘用户按 Esc 该能退出，
            // 而不是被困在里面 —— 不然接着按的快捷键全被输入框吃掉。
            if (e.key === 'Escape') e.currentTarget.blur()
          }}
          aria-label="搜索实体"
        />
        {draft && (
          <button className="search__clear" onClick={() => onQuery('', true)} aria-label="清空搜索">
            ✕
          </button>
        )}
      </div>

      <div className="grow" />

      {/* 有长任务在跑时出现（P11-A3）：长活儿最大的问题是「不知情」，
          切到别的面板就不知道还要等多久、能不能走开。点它跳任务中心。 */}
      <JobChip />

      {/* 有东西可撤/可重做时才出现（P11-A1）。快捷键是隐形的，
          得有个看得见的地方告诉人「刚才那一步能撤」。 */}
      <UndoChip />

      {/* 有新版本时才出现（P11-C1）：只提示，点一下去看下载页/详情，绝不自动替换 */}
      <UpdateChip />

      <LayoutMenu layouts={layouts} />

      <button
        className="btn btn--ghost btn--sm"
        onClick={() => layouts.closeAll()}
        title="把工作区里的面板全部收起来（左侧导航还在，点一下就能重新打开）"
      >
        全部关闭
      </button>

      <button className="btn btn--primary btn--sm" onClick={() => onNewEntity()}>
        ＋ 新建实体
      </button>

      {/* 快捷操作：原本在汇总页占一整块卡片，写多了以后人根本滚不到那儿。
          挪进顶栏做成下拉 —— 在任何界面都够得着，汇总页也清爽了。 */}
      <div className="menu" ref={actionsBox}>
        <button
          className={`btn btn--ghost btn--sm menu__trigger ${actionsOpen ? 'menu__trigger--open' : ''}`}
          onClick={() => setActionsOpen((o) => !o)}
          title="常用动作：新建 / 导入 / 重建索引"
          aria-expanded={actionsOpen}
        >
          快捷<span className="menu__caret">▾</span>
        </button>
        {actionsOpen && (
          <div className="menu__panel" role="menu">
            <div className="menu__label">常用动作</div>
            <div className="menu__row">
              <button className="menu__pick" onClick={() => { setActionsOpen(false); onNewEntity() }}>
                <span className="menu__pick-name">新建实体</span>
                <span className="faint fs-xs">Ctrl+N</span>
              </button>
            </div>
            <div className="menu__row">
              <button className="menu__pick" onClick={() => { setActionsOpen(false); requestView('text') }}>
                <span className="menu__pick-name">批量导入</span>
                <span className="faint fs-xs">Ctrl+I</span>
              </button>
            </div>
            <div className="menu__row">
              <button className="menu__pick" onClick={() => { setActionsOpen(false); onNewBook() }}>
                <span className="menu__pick-name">新建书目</span>
              </button>
            </div>
            <div className="menu__row">
              <button
                className="menu__pick"
                disabled={rebuilding}
                onClick={() => { setActionsOpen(false); onRebuild() }}
              >
                <span className="menu__pick-name">{rebuilding ? '重建中…' : '重建索引'}</span>
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="topbar__group">
        <label className="slider" title="整体字号">
          A
          <input
            type="range"
            min={0.8}
            max={1.5}
            step={0.05}
            value={fontScale}
            onChange={(e) => setFontScale(Number(e.target.value))}
            aria-label="字号缩放"
          />
          <span className="mono" style={{ width: 30 }}>
            {Math.round(fontScale * 100)}%
          </span>
        </label>
        <button
          className="btn btn--ghost btn--icon"
          onClick={() => void onRefresh()}
          disabled={busy}
          title="重新读取数据（外部改过 md 文件、或想让界面强制重取时用）"
          aria-label="重新读取数据"
        >
          <span className={`refresh-ico ${spin ? 'refresh-ico--spin' : ''}`}>↻</span>
        </button>
        <button
          className="btn btn--ghost btn--icon"
          onClick={toggleTheme}
          title={theme === 'dark' ? '切到浅色' : '切到深色'}
          aria-label="切换深浅色"
        >
          {theme === 'dark' ? '☾' : '☀'}
        </button>
        <button
          className="btn btn--ghost btn--icon"
          onClick={() => requestView('settings')}
          title="设置（外观 / 后台）"
          aria-label="设置"
        >
          ✦
        </button>
      </div>
    </header>
  )
}
