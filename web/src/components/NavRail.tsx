/**
 * 左侧导航条 —— 每个界面一个入口，按「看什么」分成三组。
 *
 * 分组不是为了好看：中间那一组是**你写小说时真正会翻的东西**，
 * 上下两组分别是「一眼看全」和「工具自身的维护入口」。
 *
 * 中间这组是「设定」与「关联」合并来的 —— 原来分成两组时，
 * 找「时间线」要在两组之间来回扫，而它们本来就是同一件事的不同切面。
 *
 * 合并后本叫「设定」，但「设定」是**名词**，说的是内容；这一组装的是
 * 小说写作用的活件（世界观、名册、时间线、伏笔……），是**你每天开工的地方**。
 * 改叫「工作台」，说的是这组是干活用的台面，不是一堆静态资料。
 */

import { useApp, type View } from '../state/store'

interface Item {
  key: View
  label: string
  icon: React.ReactNode
}

const stroke = { fill: 'none', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

const GROUPS: { title: string; items: Item[] }[] = [
  {
    title: '总览',
    items: [
      {
        key: 'dashboard',
        label: '汇总',
        icon: (
          <svg viewBox="0 0 20 20" {...stroke}>
            <rect x="2.5" y="2.5" width="6.5" height="6.5" rx="1.2" />
            <rect x="11" y="2.5" width="6.5" height="6.5" rx="1.2" />
            <rect x="2.5" y="11" width="6.5" height="6.5" rx="1.2" />
            <rect x="11" y="11" width="6.5" height="6.5" rx="1.2" />
          </svg>
        ),
      },
    ],
  },
  {
    title: '工作台',
    items: [
      {
        key: 'world',
        label: '世界观',
        icon: (
          <svg viewBox="0 0 20 20" {...stroke}>
            <circle cx="10" cy="10" r="7.3" />
            <ellipse cx="10" cy="10" rx="3.2" ry="7.3" />
            <path d="M2.9 7.4h14.2M2.9 12.6h14.2" />
          </svg>
        ),
      },
      {
        key: 'geo',
        label: '地理观',
        icon: (
          <svg viewBox="0 0 20 20" {...stroke}>
            <path d="M2.6 5.6 7.4 3.4l5.2 2.2 4.8-2.2v11l-4.8 2.2-5.2-2.2-4.8 2.2z" />
            <path d="M7.4 3.4v11M12.6 5.6v11" />
          </svg>
        ),
      },
      {
        key: 'roster',
        label: '名册录',
        icon: (
          <svg viewBox="0 0 20 20" {...stroke}>
            <rect x="3" y="2.6" width="14" height="14.8" rx="1.6" />
            <circle cx="10" cy="8.2" r="2.5" />
            <path d="M5.8 15.4c.6-2.4 2.3-3.5 4.2-3.5s3.6 1.1 4.2 3.5" />
          </svg>
        ),
      },
      {
        key: 'methodology',
        label: '方法论',
        // 眼睛（P11-1️⃣④，用户点名）：方法论 = 「这套世界怎么看」。
        // 原图形（一团脑纹）在小尺寸下糊成一坨，认不出是什么。
        icon: (
          <svg viewBox="0 0 20 20" {...stroke}>
            <path d="M1.9 10c2.5-4 5.4-6 8.1-6s5.6 2 8.1 6c-2.5 4-5.4 6-8.1 6s-5.6-2-8.1-6z" />
            <circle cx="10" cy="10" r="2.7" />
          </svg>
        ),
      },
      {
        key: 'history',
        label: '历史观',
        icon: (
          <svg viewBox="0 0 20 20" {...stroke}>
            <path d="M4.4 3.4h11.2M4.4 16.6h11.2" />
            <path d="M5.6 3.4c0 3.6 4.4 4.2 4.4 6.6s-4.4 3-4.4 6.6" />
            <path d="M14.4 3.4c0 3.6-4.4 4.2-4.4 6.6s4.4 3 4.4 6.6" />
          </svg>
        ),
      },
      {
        key: 'timeline',
        label: '时间线',
        icon: (
          <svg viewBox="0 0 20 20" {...stroke}>
            <path d="M2.6 10h14.8" />
            <circle cx="6.2" cy="10" r="1.9" />
            <circle cx="13.4" cy="10" r="1.9" />
            <path d="M6.2 4.2v3.9M13.4 12v3.8" />
          </svg>
        ),
      },
      {
        key: 'plot',
        label: '剧情线',
        icon: (
          <svg viewBox="0 0 20 20" {...stroke}>
            <path d="M3.4 15.4c2.6 0 3.4-10.8 6.6-10.8s4 7.2 6.6 7.2" />
            <circle cx="3.4" cy="15.4" r="1.7" />
            <circle cx="10" cy="6.4" r="1.7" />
            <circle cx="16.6" cy="11.8" r="1.7" />
          </svg>
        ),
      },
      {
        key: 'foreshadow',
        label: '伏笔',
        icon: (
          <svg viewBox="0 0 20 20" {...stroke}>
            <circle cx="10" cy="10" r="6.4" />
            <circle cx="10" cy="10" r="2.2" />
            <path d="M10 1.8v2.4M10 15.8v2.4M1.8 10h2.4M15.8 10h2.4" />
          </svg>
        ),
      },
      {
        key: 'relation',
        label: '关系网',
        icon: (
          <svg viewBox="0 0 20 20" {...stroke}>
            <circle cx="10" cy="4.4" r="2.4" />
            <circle cx="4.2" cy="15" r="2.4" />
            <circle cx="15.8" cy="15" r="2.4" />
            <path d="M8.6 6.5 5.6 12.8M11.4 6.5l3 6.3M6.6 15h6.8" />
          </svg>
        ),
      },
    ],
  },
  {
    title: '管理',
    items: [
      {
        key: 'entities',
        label: '全部实体',
        icon: (
          <svg viewBox="0 0 20 20" {...stroke}>
            <circle cx="10" cy="6.2" r="3.2" />
            <path d="M3.5 17.5c.8-3.4 3.4-5.3 6.5-5.3s5.7 1.9 6.5 5.3" />
          </svg>
        ),
      },
      {
        key: 'text',
        label: '正文',
        icon: (
          <svg viewBox="0 0 20 20" {...stroke}>
            <path d="M4.4 2.8h8.2L16 6.2v11H4.4z" />
            <path d="M12.4 2.9v3.5H16" />
            <path d="M7 10.2h6M7 13h4.4" />
          </svg>
        ),
      },
      {
        // 技能中心已并入工具箱的「AI 技能」页签（P11-1️⃣③）——
        // 侧栏少一项，矮窗口下底部的入口就不用滚着够。
        // 面板本体还在（panels.tsx 的 skills），旧布局存档里的页签照样能开。
        key: 'toolbox',
        label: '工具箱',
        icon: (
          <svg viewBox="0 0 20 20" {...stroke}>
            <path d="M3.4 8.2h13.2v8.4H3.4z" />
            <path d="M7.6 8V5.6a2.4 2.4 0 0 1 4.8 0V8" />
            <path d="M3.4 11.6h13.2" />
          </svg>
        ),
      },
      {
        key: 'settings',
        label: '设置',
        icon: (
          <svg viewBox="0 0 20 20" {...stroke}>
            <circle cx="10" cy="10" r="2.6" />
            <path d="M10 2.5v2.4M10 15.1v2.4M2.5 10h2.4M15.1 10h2.4M4.7 4.7l1.7 1.7M13.6 13.6l1.7 1.7M15.3 4.7l-1.7 1.7M6.4 13.6l-1.7 1.7" />
          </svg>
        ),
      },
      {
        // 长活儿（批量抽取 / 批量导入 / 重建索引）的进度与续跑都在这里。
        // 有任务在跑时顶栏会出现一条常驻小条，点它就是跳到这一页。
        key: 'jobs',
        label: '任务',
        icon: (
          <svg viewBox="0 0 20 20" {...stroke}>
            <rect x="2.8" y="3.2" width="14.4" height="13.6" rx="1.8" />
            <path d="M6.2 7.6h7.6" />
            <path d="M6.2 10.8h5" />
            <path d="M6.2 14h6.2" />
            <circle cx="15.4" cy="14.2" r="2.6" />
            <path d="M15.4 13v1.2l.9.7" />
          </svg>
        ),
      },
    ],
  },
]

export function NavRail() {
  // 用 requestView 而不是 setView：面板可能已经被关掉了，此时光设 view 不会重开
  const { view, requestView } = useApp()

  return (
    <nav className="rail" aria-label="主导航">
      {GROUPS.map((g) => (
        <div className="rail__group" key={g.title}>
          <div className="rail__group-title">{g.title}</div>
          {g.items.map((it) => (
            <button
              key={it.key}
              className={`rail__item ${view === it.key ? 'rail__item--active' : ''}`}
              onClick={() => requestView(it.key)}
              title={it.label}
              aria-current={view === it.key ? 'page' : undefined}
            >
              <span className="rail__icon">{it.icon}</span>
              <span className="rail__label">{it.label}</span>
            </button>
          ))}
        </div>
      ))}
    </nav>
  )
}

export default NavRail
