import { useToast } from '../state/store'

export function Toasts() {
  const { toasts, dismissToast } = useToast()
  if (!toasts.length) return null
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast--${t.kind}`}
          role="status"
          onClick={() => dismissToast(t.id)}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}

/** 统一的加载/错误/空 三态壳子。 */
export function StateGate({
  loading,
  error,
  empty,
  emptyTitle,
  emptyHint,
  emptyAction,
  children,
}: {
  loading?: boolean
  error?: string | null
  empty?: boolean
  emptyTitle?: string
  emptyHint?: string
  /**
   * 空状态下的出口按钮（各视角的「去导入」「去手录」）。
   *
   * 为什么需要：八个视角都不提供自己的录入入口 —— 设定一律是实体，
   * 实体在「全部实体」里建、正文在「正文」里导入。这件事实现在只写在
   * emptyHint 的**文字**里，用户扫一眼根本读不出「那我该点哪儿」。
   * 于是空态必须同时给出可以直接点的下一跳。
   */
  emptyAction?: React.ReactNode
  children: React.ReactNode
}) {
  if (loading) {
    return (
      <div className="empty">
        <div className="row">
          <span className="spinner" />
          <span>加载中…</span>
        </div>
      </div>
    )
  }
  if (error) {
    return (
      <div className="empty">
        <div className="empty__title" style={{ color: 'var(--danger)' }}>
          出错了
        </div>
        <div className="fs-sm">{error}</div>
      </div>
    )
  }
  if (empty) {
    return (
      <div className="empty">
        <div className="empty__title">{emptyTitle ?? '这里还是空的'}</div>
        {emptyHint && <div className="fs-sm" style={{ maxWidth: 460, lineHeight: 1.75 }}>{emptyHint}</div>}
        {emptyAction && (
          <div className="empty__actions">{emptyAction}</div>
        )}
      </div>
    )
  }
  return <>{children}</>
}
