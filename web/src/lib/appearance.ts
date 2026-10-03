/**
 * 外观的应用逻辑：把「偏好」翻译成 DOM 上的 CSS 变量与 @font-face。
 *
 * 为什么全部走 CSS 变量？
 * tokens.css 是三层结构（palette → semantic → component），
 * 主题包只需要覆盖第一、二层，组件层一行都不用改。
 * 这是 P5「换一层变量就整体换肤」能成立的前提。
 */

import type { AssetItem, BackgroundPref, Prefs, ThemePack, UiPrefs } from '../api/types'

const LS_PREFS = 'wkv.prefsCache'

// --------------------------------------------------------------------------
// 主题
// --------------------------------------------------------------------------

/** 当前由主题写进 DOM 的变量名 —— 换主题时要先把它们清干净 */
const themeVars = new Set<string>()

export function applyTheme(pack: ThemePack | null, mode: 'dark' | 'light'): void {
  const root = document.documentElement
  for (const k of themeVars) root.style.removeProperty(k)
  themeVars.clear()

  const vars = pack?.vars?.[mode]
  if (!vars) return
  for (const [k, v] of Object.entries(vars)) {
    if (!k.startsWith('--')) continue
    root.style.setProperty(k, v)
    themeVars.add(k)
  }
}

// --------------------------------------------------------------------------
// 字体
// --------------------------------------------------------------------------

const FONTFACE_ID = 'wkv-font-faces'

/** 素材名 → CSS font-family 名。加前缀避免和系统字体撞名。 */
export const fontFamilyOf = (stem: string) => `wkv-${stem}`

/** 把 data/assets/fonts/ 下的字体注入成 @font-face。整段替换，不做增量。 */
export function injectFontFaces(fonts: AssetItem[]): void {
  let el = document.getElementById(FONTFACE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = FONTFACE_ID
    document.head.appendChild(el)
  }
  const css = fonts
    .map(
      (f) =>
        `@font-face{font-family:"${fontFamilyOf(f.stem)}";src:url("${f.url}");font-display:swap;}`,
    )
    .join('\n')
  if (el.textContent !== css) el.textContent = css
}

/**
 * 设/清 `--font-ui` 与 `--font-mono`。
 * 传空串表示「用内置字体」—— 删掉变量即可退回 tokens.css 里的 base，不必记原值。
 */
export function applyFonts(ui: string, mono: string): void {
  const root = document.documentElement
  if (ui) root.style.setProperty('--font-ui', `"${fontFamilyOf(ui)}"`)
  else root.style.removeProperty('--font-ui')

  if (mono) root.style.setProperty('--font-mono', `"${fontFamilyOf(mono)}"`)
  else root.style.removeProperty('--font-mono')
}

// --------------------------------------------------------------------------
// 背景
// --------------------------------------------------------------------------

export function assetUrl(kind: string, name: string): string {
  return `/api/assets/${encodeURIComponent(kind)}/${encodeURIComponent(name)}/raw`
}

/** 把背景偏好翻成一个 CSS background-image 值 */
export function backgroundImageValue(bg: BackgroundPref): string {
  switch (bg.kind) {
    case 'color':
      return bg.color || 'none'
    case 'gradient':
      return `linear-gradient(${bg.angle}deg, ${bg.from || 'var(--bg-sunken)'}, ${
        bg.to || 'var(--bg-app)'
      })`
    case 'image':
      return bg.image ? `url("${assetUrl('backgrounds', bg.image)}")` : 'none'
    default:
      return 'none'
  }
}

export function applyBackground(bg: BackgroundPref, panelAlpha: number, panelBlur = false): void {
  const root = document.documentElement
  const on = bg.kind !== 'none' && backgroundImageValue(bg) !== 'none'

  root.style.setProperty('--app-bg-image', on ? backgroundImageValue(bg) : 'none')
  root.style.setProperty('--app-bg-blur', `${on ? bg.blur || 0 : 0}px`)
  root.style.setProperty('--app-bg-dim', String(on ? bg.dim : 0))
  root.style.setProperty(
    '--app-bg-size',
    bg.fit === 'contain' ? 'contain' : bg.fit === 'repeat' ? 'auto' : 'cover',
  )
  root.style.setProperty('--app-bg-repeat', bg.fit === 'repeat' ? 'repeat' : 'no-repeat')
  root.style.setProperty('--panel-alpha', String(on ? panelAlpha : 1))
  root.dataset.hasBg = on ? 'on' : 'off'
  // 毛玻璃是 opt-in 的：CSS 那边只在 data-panel-blur='on' 时才挂 backdrop-filter
  root.dataset.panelBlur = panelBlur ? 'on' : 'off'
}

// --------------------------------------------------------------------------
// 首屏缓存（只为了让刷新时不闪，真源永远是 preferences.json）
// --------------------------------------------------------------------------

interface Cache {
  ui?: UiPrefs
}

export function readPrefsCache(): Prefs | null {
  try {
    const raw = localStorage.getItem(LS_PREFS)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Cache
    if (!parsed?.ui) return null
    return { ui: parsed.ui as UiPrefs }
  } catch {
    return null
  }
}

export function writePrefsCache(prefs: Prefs): void {
  try {
    localStorage.setItem(LS_PREFS, JSON.stringify({ ui: prefs.ui }))
  } catch {
    /* 忽略 */
  }
}
