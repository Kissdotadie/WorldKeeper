/**
 * 「这张图能直接改」的引导浮层（P11-2️⃣①）。
 *
 * 只在一张图上弹一次。三条手势一句话讲完，不写说明书：
 * 双击节点 = 改它、双击空白 = 新建、拖到另一个节点 = 连线。
 *
 * 两个出口：
 * - 「知道了」→ 记住，以后不再弹，编辑保持开着
 * - 「先只看看」→ 记住，并把这张图切到**浏览**态（用户明说了不想要编辑）
 */

import { markGraphGuideSeen } from '../lib/graphGuide'

const ROWS: { icon: string; text: string }[] = [
  { icon: '⇱', text: '双击节点 —— 就地改名称、类型、标签、摘要' },
  { icon: '＋', text: '双击空白 —— 就在那个位置新建一个实体' },
  { icon: '⇢', text: '从一个节点拖到另一个节点 —— 建立关联（回写正文的双链）' },
]

export function GraphEditGuide({
  onDismiss,
  onBrowseOnly,
}: {
  /** 关掉（保留编辑能力） */
  onDismiss: () => void
  /** 关掉并切到浏览态 */
  onBrowseOnly?: () => void
}) {
  const close = (browseOnly: boolean) => {
    markGraphGuideSeen()
    if (browseOnly) onBrowseOnly?.()
    onDismiss()
  }

  return (
    <div className="gguide" role="dialog" aria-label="图上直接编辑的用法">
      <div className="gguide__title">这张图可以直接改</div>
      <ul className="gguide__rows">
        {ROWS.map((r) => (
          <li key={r.text}>
            <span className="gguide__icon">{r.icon}</span>
            <span>{r.text}</span>
          </li>
        ))}
      </ul>
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <button className="btn btn--primary btn--sm" onClick={() => close(false)}>
          知道了
        </button>
        {onBrowseOnly && (
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => close(true)}
            title="把这张图切到「浏览」，只平移缩放不误改；随时能在工具条切回编辑"
          >
            先只看看
          </button>
        )}
      </div>
    </div>
  )
}
