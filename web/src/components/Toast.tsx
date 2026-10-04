import { useRef } from 'react'
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
  /**
   * 已经显示过内容之后，**后台重新取数不该把孩子卸载掉**。
   *
   * 这是「写一次结构就重建一次画布」的元凶：所有写操作成功都会广播一次
   * （见 client.ts 的 announceMutation），各视图的 load() 随即 setLoading(true)，
   * 于是这里的加载分支把孩子整棵卸载 —— 思维导图上表现成加一个子级，
   * 922 个节点全部重排、视野重新适配、正在改的名字也没了，像是画面被刷新了。
   * 内容其实一直都在，只是被拆了重装。
   *
   * 现在：首次加载照旧给完整加载态；之后的重取只挂一条「刷新中」的小角标。
   */
  const shownOnce = useRef(false)
  if (!loading && !error) shownOnce.current = true
  const keep = shownOnce.current

  if (loading && !keep) {
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
  if (loading && keep) {
    // 后台重取期间就让孩子留在原地（不加角标：面板里没有可靠的定位上下文，
    // 硬塞一个悬浮层要么到处乱飘、要么挤动布局，反而添乱）。
    // 刷新很快，且内容本来就是旧数据 —— 不提示比闪一下更好。
    return <>{children}</>
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
