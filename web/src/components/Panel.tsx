/**
 * 面板容器。
 *
 * P1 换成 dockview 时，这个组件会被删掉或变成 dockview 面板的壳，
 * 但所有业务面板（EntityList / EntityDetail / PasteImport …）都不动 ——
 * 这是「P1 第一步就上 dockview 骨架」这条路线图要求的前提。
 *
 * 2026-10-04 追加 `collapsible`：设置 / 后台这类**长页面**一屏竖十几个面板，
 * 用户滚不到底。加一条 `collapsible` 就变成统一的「限高区块」——
 * 默认只露标题行（带摘要 + 操作按钮），点标题行才展开正文。
 * 视觉样式只有这一份，各页面不必各写一套。
 */

import { useId, type ReactNode } from 'react'
import { ALWAYS_OPEN, setAllSectionsOpen, useSectionOpen } from '../lib/sections'

interface Props {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  /** 内容区是否去掉默认留白（例如整块表格、日志框） */
  flush?: boolean
  /** 做成一格「限高区块」：标题行可点开合，收起时只留标题 + 摘要 + 操作按钮 */
  collapsible?: boolean
  /**
   * 默认是否展开（仅在 collapsible 时有效）。不填 = 跟随 collapsible 取反：
   * 做成区块就默认**收起** —— 这正是「别再一长溜」的目的。
   * 想让它一进来就摊开的区块（如后台的「索引」）显式写一个 defaultOpen 即可。
   */
  defaultOpen?: boolean
  /**
   * 开合状态的持久化标识，全局唯一。强烈建议显式传，如 `admin:index`。
   * 不传则退化为「本次挂载内可开合，但不跨刷新记忆」。
   */
  sectionId?: string
  /** 收起时也显示在标题右侧的摘要，如「3 项」「就绪」「12.4 MB」 */
  summary?: ReactNode
}

export function Panel({
  title,
  actions,
  children,
  className = '',
  flush = false,
  collapsible = false,
  defaultOpen = !collapsible,
  sectionId,
  summary,
}: Props) {
  const autoId = useId()
  // hooks 必须无条件调用。折叠区块若漏传 sectionId，给一个**本次挂载内唯一**的
  // 兜底 id，免得几个漏传的区块共用一个 key 变成「点一个全开」的联动怪象；
  // 非折叠面板挂哨兵 id，等同于永远展开。
  const key = collapsible ? (sectionId ?? `auto:${autoId}`) : ALWAYS_OPEN
  const [open, setOpen] = useSectionOpen(key, defaultOpen)
  const isOpen = !collapsible || open

  const cls = [
    'panel',
    className,
    collapsible ? 'panel--collapsible' : '',
    collapsible && !isOpen ? 'panel--collapsed' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const headless = !title && !actions && summary == null

  return (
    <section className={cls}>
      {!headless &&
        (collapsible ? (
          <header className="panel__header panel__header--toggle">
            <button
              type="button"
              className="panel__toggle"
              onClick={() => setOpen(!isOpen)}
              aria-expanded={isOpen}
              title={isOpen ? '收起这一块' : '展开这一块'}
            >
              <span className="panel__caret" aria-hidden>
                ▾
              </span>
              {title && <span className="panel__title">{title}</span>}
              {summary != null && <span className="panel__summary">{summary}</span>}
            </button>
            <div className="grow" />
            {/* 操作按钮放在 toggle 外面：HTML 不允许 button 套 button，
                而且这样收起时按钮依然可点（例如「重建索引」不必先展开）。 */}
            {actions && <div className="row panel__actions">{actions}</div>}
          </header>
        ) : (
          <header className="panel__header">
            {title && <div className="panel__title">{title}</div>}
            <div className="grow" />
            {actions && <div className="row">{actions}</div>}
          </header>
        ))}
      {/* 收起时用 display:none 而不是卸载 —— 内部表单填了一半、组件 state
          都要保住，收起再展开不该白填。见 app.css 的 .panel--collapsed 规则。 */}
      <div className="panel__body" style={flush ? { padding: 0 } : undefined}>
        {children}
      </div>
    </section>
  )
}

/**
 * 「全部展开 / 全部收起」——长页面顶部放一条。
 *
 * 只影响当前会话已经渲染过的区块（见 lib/sections.ts 的注释），
 * 不会把没打开过的页面也悄悄写成一堆收起。
 */
export function SectionControls({ what = '区块' }: { what?: string }) {
  return (
    <div className="section-tools">
      <span className="faint fs-xs">{what}</span>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => setAllSectionsOpen(true)}
        title="展开页面上所有区块"
      >
        全部展开
      </button>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => setAllSectionsOpen(false)}
        title="收起页面上所有区块，只看标题行"
      >
        全部收起
      </button>
    </div>
  )
}

/**
 * 面板标题栏右上角的 ✕。
 *
 * 专给「选中 / 明细」这类**跟着图上选中态生灭**的面板用 —— P11-2️⃣② 之前，
 * 选中一个节点后侧栏就卡在那儿，用户找不到「退出来」的入口（图上的 Esc /
 * 点空白不好被发现），只能关掉整个面板重开。给一张显式的 ✕ 最省心。
 */
export function PanelClose({ onClick, title = '取消选中' }: { onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      className="btn btn--ghost btn--icon panel__close"
      onClick={onClick}
      title={title}
      aria-label={title}
    >
      ✕
    </button>
  )
}
