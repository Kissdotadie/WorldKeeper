/**
 * 移动端外壳（P6）。
 *
 * 定位很清楚：**躺在沙发上查设定用**，不是把 PC 端塞进小屏幕。
 * 所以这一层只做「查」：搜索、实体卡、时间线、伏笔、章节。不做三维场景、
 * 不做面板拖拽、不做贴纸编辑、不做变更落盘审核 —— 那些活儿屏幕小一点就没法干。
 *
 * 数据层与业务逻辑 100% 复用：实体清单、书目、外观主题都直接取
 * `AppProvider` 里 PC 端在用的那一份，不另起一套通道。
 *
 * 布局用「固定全屏 + 内部滚动」而不是给 body 加滚动条：
 * PC 端的 base.css 里 body 是 overflow:hidden（dockview 自己管滚动），
 * 这里要是去改 body 的规矩，等于让两个布局互相拆台。
 */

import { useEffect, useState } from 'react'
import { useApp } from '../state/store'
import { TypeColorStyle } from '../components/TypeColorStyle'
import { EntityView, RosterView, SearchView } from './EntityViews'
import { ChapterReadView, ChaptersView, ForeshadowView, TimelineView } from './LoreViews'
import { M_TABS, back, go, parseHash, tabOf, type MTab, type MRoute } from './router'

/** 手机版上「切回电脑版」写进 localStorage 的键 —— 桌面端壳会读它。 */
export const NO_REDIRECT_KEY = 'wkv:mobile-redirect-off'

function titleOf(r: MRoute): string {
  switch (r.name) {
    case 'search':
      return '搜索'
    case 'roster':
      return '名册'
    case 'timeline':
      return '时间线'
    case 'foreshadow':
      return '伏笔看板'
    case 'chapters':
      return '章节索引'
    case 'chapter':
      return `第 ${r.no} 章`
    case 'entity':
      return '实体卡片'
  }
}

export function MobileApp() {
  const { bookId, books, loading, bootError, switchBook, stats } = useApp()
  const [route, setRoute] = useState<MRoute>(() => parseHash(window.location.hash))
  // 子页面（实体卡 / 正文）没有自己的标签，底栏高亮沿用进来时那一页
  const [tab, setTab] = useState<MTab>(() => tabOf(parseHash(window.location.hash)) ?? 'search')

  useEffect(() => {
    const onHash = () => {
      const r = parseHash(window.location.hash)
      setRoute(r)
      const t = tabOf(r)
      if (t) setTab(t)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // 进去就滚到顶：从章节列表点进正文，停在半截是最常见的糟糕体验
  useEffect(() => {
    window.scrollTo(0, 0)
    document.querySelector('.mob__body')?.scrollTo(0, 0)
  }, [route])

  const sub = route.name === 'entity' || route.name === 'chapter'

  return (
    <div className="mob">
      <TypeColorStyle />
      <header className="mob__bar">
        {sub ? (
          <button className="mob__back" onClick={() => back({ name: tab })} aria-label="返回">
            ←
          </button>
        ) : (
          <span className="mob__logo">🌏</span>
        )}
        <div className="mob__title">
          <b>{titleOf(route)}</b>
          <span className="mob__sub">
            {books.length > 1 && !sub ? (
              <select
                className="mob__book"
                value={bookId ?? ''}
                onChange={(e) => switchBook(e.target.value)}
              >
                {books.map((b) => (
                  <option key={b.book_id} value={b.book_id}>
                    {b.title}
                  </option>
                ))}
              </select>
            ) : (
              (books.find((b) => b.book_id === bookId)?.title ?? '—')
            )}
            {stats ? ` · ${stats.total} 条实体` : ''}
          </span>
        </div>
        <button
          className="mob__pc"
          onClick={() => {
            // 记一笔，免得电脑版壳又把手机踹回来（死循环）
            try {
              localStorage.setItem(NO_REDIRECT_KEY, '1')
            } catch {
              /* 隐私模式下写不了，退化成下一次还会跳 */
            }
            window.location.href = '/'
          }}
        >
          电脑版
        </button>
      </header>

      <main className="mob__body">
        {bootError ? (
          <div className="merr">
            <div className="merr__text">连不上后端：{bootError}</div>
            <div className="faint fs-sm">
              确认电脑上那个黑窗口还开着（它不能关），手机和电脑要在同一个 WiFi。
            </div>
          </div>
        ) : loading && !bookId ? (
          <div className="mload">读取中……</div>
        ) : !bookId ? (
          <div className="mempty">
            <div className="mempty__title">还没有书目</div>
            <div className="mempty__hint">先在电脑上建一本书</div>
          </div>
        ) : route.name === 'entity' ? (
          <EntityView id={route.id} />
        ) : route.name === 'chapter' ? (
          <ChapterReadView no={route.no} />
        ) : route.name === 'roster' ? (
          <RosterView />
        ) : route.name === 'timeline' ? (
          <TimelineView />
        ) : route.name === 'foreshadow' ? (
          <ForeshadowView />
        ) : route.name === 'chapters' ? (
          <ChaptersView />
        ) : (
          <SearchView />
        )}
      </main>

      <nav className="mob__tabs">
        {M_TABS.map((t) => (
          <button
            key={t.key}
            className={`mob__tab ${tab === t.key ? 'is-on' : ''}`}
            onClick={() => go({ name: t.key })}
          >
            <span className="mob__tab-i">{t.icon}</span>
            <span className="mob__tab-l">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}
