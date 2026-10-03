/**
 * 顶栏的常驻任务小条（P11-A3）。
 *
 * 只干一件事：**有活儿在跑时让它在视野里**。长任务最大的问题是「不知情」——
 * 跑着的时候人切去别的面板了，不知道还要等多久，也不知道能不能走开。
 * 一条随时可见的进度条把这个问题解决掉：点它直接跳到任务中心。
 *
 * 单独放一个文件而不并进 JobPanel.tsx：顶栏是首屏的一部分，
 * 而任务中心是懒加载的 —— 放一起会把整页代码拖进首屏包（P11-B1 就白做了）。
 */

import { useJobs } from '../state/jobs'
import { useApp } from '../state/store'

export function JobChip() {
  const { active, watch } = useJobs()
  const { requestView } = useApp()
  const j = active.running
  if (!j) return null
  return (
    <button
      className="jobchip"
      title={`${j.title} — ${j.message}（点开看任务中心）`}
      onClick={() => {
        watch(j.id)
        requestView('jobs')
      }}
    >
      <span className="jobchip__spin" aria-hidden />
      <span className="jobchip__label">
        {j.kind_label}
        {j.total ? ` ${j.done}/${j.total}` : ''}
      </span>
      <span className="jobchip__bar" aria-hidden>
        <span className="jobchip__fill" style={{ width: `${j.percent}%` }} />
      </span>
      <span className="jobchip__pct tnum">{j.percent}%</span>
    </button>
  )
}
