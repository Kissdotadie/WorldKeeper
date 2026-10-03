import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { MobileApp, NO_REDIRECT_KEY } from './mobile/MobileApp'
import { AppProvider } from './state/store'

import './styles/tokens.css'
import './styles/base.css'
import './styles/app.css'
import './styles/mobile.css'

const el = document.getElementById('root')
if (!el) throw new Error('找不到 #root 挂载点')

/** `/m` 走移动端只读壳，其余走 PC 端 dockview 壳。两者共用同一个 AppProvider。 */
const isMobileRoute = /^\/m(\/|$)/.test(window.location.pathname)

/**
 * 手机上误开电脑版地址 → 自动转 `/m`。
 *
 * 判据刻意收得紧（`pointer: coarse` + 窄屏）：**只看宽度会把桌面浏览器拖窄
 * 窗口这种情况也卷进来**，那很讨厌。用户点过手机版右上角的「电脑版」之后
 * 会写一个开关，之后不再跳 —— 否则两边互相踢，谁也别想用。
 */
function maybeRedirectToMobile(): void {
  if (isMobileRoute) return
  if (!window.matchMedia('(pointer: coarse) and (max-width: 820px)').matches) return
  try {
    if (localStorage.getItem(NO_REDIRECT_KEY) === '1') return
  } catch {
    /* 隐私模式下读不到，那就跳 —— 跳错了用户点一下「电脑版」也能回来 */
  }
  window.location.replace('/m')
}

maybeRedirectToMobile()

createRoot(el).render(
  <StrictMode>
    {isMobileRoute ? (
      <AppProvider>
        <MobileApp />
      </AppProvider>
    ) : (
      <App />
    )}
  </StrictMode>,
)
