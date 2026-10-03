/**
 * 新手引导（P11-B2）。
 *
 * 一分钟五步的欢迎卡片：第一次打开时出现，**可跳过且跳过就不再提示**
 * （记在 localStorage —— 这是纯界面状态，不值得进偏好文件）。
 * 在 设置 → 后台 → 快捷键面板 点「重看新手引导」可以随时再叫出来。
 *
 * 为什么是卡片而不是高亮定位的「导游」：外壳是 dockview，面板可以被拖走、
 * 关掉、换布局，定位式引导和它打架；卡片只讲「去哪儿找」，不押着用户点哪。
 */

import { useCallback, useEffect, useState } from 'react'

const DONE_KEY = 'wkv.guide.done'

/** 设置→后台 里的「重看新手引导」按钮会派发这个事件 */
export const GUIDE_REOPEN_EVENT = 'wkv:guide-reopen'

const STEPS: { title: string; lines: string[] }[] = [
  {
    title: '欢迎 👋',
    lines: [
      '这是跑在你自己电脑上的小说世界观知识库。',
      '所有设定都是 Markdown 档案 —— 那是唯一的真源；索引坏了、删了随时一键重建，你的字永远都在。',
    ],
  },
  {
    title: '第一步：建一本书',
    lines: [
      '所有实体都挂在「书」下面，多本书并行时数据互不干扰。',
      '顶栏下拉可以换书；右上角「＋ 新建实体」录第一条设定，或者去「正文」批量导入章节。',
    ],
  },
  {
    title: '认认门',
    lines: [
      '左侧导航条是全部界面：名册录、时间线、关系网、伏笔看板……',
      '面板可以拖拽、拆分、关掉；摆好了在顶栏「布局」里存一份，下次一键还原。',
      '外观（主题/字体/背景）在设置里改，还可以每本书各配一套。',
    ],
  },
  {
    title: '编辑的三个捷径',
    lines: [
      '图上双击节点 → 就地编辑浮层；改错了 Ctrl+Z 就能撤。',
      '删掉的书会先自动快照，误删可以从快照里捞回来。',
      '录入久了会有「待补全」标记 —— 名册里一眼能找出还欠着的设定。',
    ],
  },
  {
    title: '忘了就翻表',
    lines: [
      '快捷键表在 设置 → 后台，它由代码直接生成，和实际行为不会漂移。',
      '长任务（批量导入 / AI 抽取）在任务中心看进度，Ctrl+J 随时叫出来。',
      '这条引导可以随时在快捷键面板里重看。',
    ],
  },
]

export function WelcomeGuide() {
  const [step, setStep] = useState(0)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    // 首次访问才弹。读缓存要等 books 起来吗？不必 —— 引导不依赖书目状态。
    if (!localStorage.getItem(DONE_KEY)) setOpen(true)
    const onReopen = () => {
      setStep(0)
      setOpen(true)
    }
    window.addEventListener(GUIDE_REOPEN_EVENT, onReopen)
    return () => window.removeEventListener(GUIDE_REOPEN_EVENT, onReopen)
  }, [])

  const finish = useCallback(() => {
    localStorage.setItem(DONE_KEY, '1')
    setOpen(false)
  }, [])

  if (!open) return null

  const s = STEPS[step]
  const last = step === STEPS.length - 1

  return (
    <div className="modal-backdrop" style={{ zIndex: 200 }} role="dialog" aria-modal aria-label="新手引导">
      <div className="modal" style={{ width: 'min(560px, 100%)' }}>
        <div className="modal__header">
          <div className="modal__title">
            新手引导 · {step + 1}/{STEPS.length} · {s.title}
          </div>
        </div>
        <div style={{ padding: 'var(--p-space-4)', overflowY: 'auto' }}>
          {s.lines.map((l, i) => (
            <p key={i} className={i === 0 ? '' : 'muted fs-sm'} style={{ marginTop: i === 0 ? 0 : 'var(--p-space-2)', lineHeight: 1.7 }}>
              {l}
            </p>
          ))}
        </div>
        <div
          className="modal__footer"
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--p-space-2)' }}
        >
          <div className="row" style={{ gap: 6 }}>
            {STEPS.map((_, i) => (
              <span
                key={i}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  background: i === step ? 'var(--accent)' : 'var(--border-strong)',
                }}
              />
            ))}
          </div>
          <div className="grow" />
          <button className="btn btn--ghost btn--sm" onClick={finish}>
            跳过，不再提示
          </button>
          {!last && (
            <button className="btn btn--sm" disabled={step === 0} onClick={() => setStep((v) => v - 1)}>
              上一步
            </button>
          )}
          <button className="btn btn--primary btn--sm" onClick={() => (last ? finish() : setStep((v) => v + 1))}>
            {last ? '开始使用' : '下一步'}
          </button>
        </div>
      </div>
    </div>
  )
}
