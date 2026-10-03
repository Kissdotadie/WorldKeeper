/**
 * 外观（独立界面）：主题、明暗、字号、字体、背景。
 *
 * 一条原则贯穿全篇：**改了立刻生效，不用点保存**。
 * 所有控件都是「改偏好 → store 乐观更新 → 防抖落盘」，
 * 你拖滑杆的时候看到的就是最终效果。
 *
 * 默认配色不是这里定的 —— 那是 tokens.css 的三层令牌。
 * 这里只负责往 DOM 上盖一层变量，所以换个主题不会牵动任何组件代码。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api/client'
import type { AppearanceWhere, AssetItem, BackgroundKind, ThemePack } from '../api/types'
import { assetUrl } from '../lib/appearance'
import { useAppUi, useToast } from '../state/store'
import { Panel, SectionControls } from '../components/Panel'
import { StateGate } from '../components/Toast'

const FONT_ACCEPT = '.ttf,.otf,.woff,.woff2'
const IMG_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.svg,.avif'

const BG_KINDS: { key: BackgroundKind; label: string; hint: string }[] = [
  { key: 'none', label: '无', hint: '用主题自带的底色' },
  { key: 'color', label: '纯色', hint: '选一个底色' },
  { key: 'gradient', label: '渐变', hint: '两个颜色 + 角度' },
  { key: 'image', label: '图片', hint: '从素材库里挑一张' },
]

export function AppearanceView() {
  // 只订阅「外观」这一块：拖动字号/不透明度滑杆时，其他界面的图不必跟着重算
  const { ui, setUi, resetUi, themes, assets, reloadAppearance, theme, fontScale, inBookScope, bookHasOverride, applyUiToGlobal } = useAppUi()
  const { notify } = useToast()

  const [packs, setPacks] = useState<Record<string, ThemePack>>({})
  const [where, setWhere] = useState<AppearanceWhere | null>(null)
  const [busy, setBusy] = useState(false)

  const fontInput = useRef<HTMLInputElement>(null)
  const bgInput = useRef<HTMLInputElement>(null)
  const themeInput = useRef<HTMLInputElement>(null)

  // 主题预览需要每套主题的真实色值，一次拉全
  useEffect(() => {
    let alive = true
    void Promise.all(
      themes.map((t) =>
        api
          .getTheme(t.name)
          .then((p) => [t.name, p] as const)
          .catch(() => null),
      ),
    ).then((rows) => {
      if (!alive) return
      const out: Record<string, ThemePack> = {}
      for (const r of rows) if (r) out[r[0]] = r[1]
      setPacks(out)
    })
    return () => {
      alive = false
    }
  }, [themes])

  useEffect(() => {
    api.appearanceWhere().then(setWhere).catch(() => setWhere(null))
  }, [assets, themes])

  const fonts = assets?.assets?.fonts ?? []
  const backgrounds = assets?.assets?.backgrounds ?? []
  const bg = ui.background

  const activePack = packs[ui.theme]

  const tileStyle = (p?: ThemePack) => {
    const v = p?.vars?.[theme] ?? {}
    return {
      background: v['--bg-app'] ?? 'var(--bg-app)',
      borderColor: v['--border-default'] ?? 'var(--border-default)',
    }
  }
  const barStyle = (p?: ThemePack) => {
    const v = p?.vars?.[theme] ?? {}
    return { background: v['--bg-surface'] ?? 'var(--bg-surface)' }
  }
  const accentStyle = (p?: ThemePack) => {
    const v = p?.vars?.[theme] ?? {}
    return { background: v['--accent'] ?? 'var(--accent)' }
  }

  // ---- 上传 ----
  const uploadFont = async (file: File) => {
    setBusy(true)
    try {
      const item = await api.uploadAsset('fonts', file)
      await reloadAppearance()
      notify('ok', `字体「${item.stem}」已加入素材库`)
    } catch (e) {
      notify('err', `上传失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const uploadBg = async (file: File) => {
    setBusy(true)
    try {
      const item = await api.uploadAsset('backgrounds', file)
      await reloadAppearance()
      setUi({ background: { ...bg, kind: 'image', image: item.name } })
      notify('ok', `背景「${item.stem}」已加入素材库并设为当前背景`)
    } catch (e) {
      notify('err', `上传失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const removeAsset = async (kind: string, item: AssetItem) => {
    try {
      await api.deleteAsset(kind, item.name)
      // 删掉的正好在用，就退回默认，免得界面引用一个不存在的文件
      if (kind === 'fonts') {
        if (ui.font_ui === item.stem) setUi({ font_ui: '' })
        if (ui.font_mono === item.stem) setUi({ font_mono: '' })
      }
      if (kind === 'backgrounds' && bg.image === item.name) {
        setUi({ background: { ...bg, image: '', kind: 'none' } })
      }
      await reloadAppearance()
      notify('ok', `已删除「${item.stem}」`)
    } catch (e) {
      notify('err', `删除失败：${(e as Error).message}`)
    }
  }

  // ---- 主题 ----
  const saveAsTheme = async () => {
    const src = activePack
    if (!src) {
      notify('err', '当前主题还没读出来，稍等一下再试')
      return
    }
    const name = window.prompt('把当前主题另存为（改完可在 config/themes/ 里编辑 JSON）：', `${src.name} 副本`)
    if (!name?.trim()) return
    try {
      await api.saveTheme(name.trim(), { ...src, name: name.trim(), builtin: false })
      await reloadAppearance()
      setUi({ theme: name.trim() })
      notify('ok', `已保存主题「${name.trim()}」`)
    } catch (e) {
      notify('err', `保存失败：${(e as Error).message}`)
    }
  }

  const importThemeFile = async (file: File) => {
    try {
      const r = await api.importTheme(file)
      await reloadAppearance()
      setUi({ theme: r.name })
      notify('ok', `已导入主题「${r.name}」`)
    } catch (e) {
      notify('err', `导入失败：${(e as Error).message}`)
    }
  }

  const removeTheme = async (name: string) => {
    if (!window.confirm(`删除主题「${name}」？这只是删掉配色文件，实体数据不受影响。`)) return
    try {
      await api.deleteTheme(name)
      await reloadAppearance()
      if (ui.theme === name) setUi({ theme: '默认' })
      notify('ok', `已删除主题「${name}」`)
    } catch (e) {
      notify('err', `删除失败：${(e as Error).message}`)
    }
  }

  const bgPreviewStyle = useMemo(() => {
    const img = assetUrl('backgrounds', bg.image)
    switch (bg.kind) {
      case 'color':
        return { background: bg.color || 'var(--bg-sunken)' }
      case 'gradient':
        return {
          background: `linear-gradient(${bg.angle}deg, ${bg.from || '#000'}, ${bg.to || '#fff'})`,
        }
      case 'image':
        return bg.image
          ? { backgroundImage: `url("${img}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
          : { background: 'var(--bg-sunken)' }
      default:
        return { background: 'var(--bg-sunken)' }
    }
  }, [bg])

  return (
    <div className="appearance">
      <div className="appearance__tools">
        <SectionControls what="外观区块" />
      </div>
      <div className="appearance__main">
        {/* ---------------- 作用域（P11-C2 多书独立外观）---------------- */}
        {inBookScope && (
          <div className="notice" style={{ marginBottom: 'var(--p-space-3)' }}>
            <div className="row row--wrap" style={{ gap: 'var(--p-space-2)', alignItems: 'center' }}>
              <span>
                现在改的是<b>这本书自己的外观</b>
                {bookHasOverride ? '（已有独立设置）' : '（第一次改动就会生成）'}
                —— 别的书不受影响。
              </span>
              <div className="grow" />
              <button className="btn btn--sm" onClick={() => void applyUiToGlobal()} title="把这本书现在的装扮存成全局默认，并让这本书改回跟随全局">
                存为全局默认
              </button>
              {bookHasOverride && (
                <button className="btn btn--ghost btn--sm" onClick={resetUi} title="清掉这本书的独立设置，改回跟随全局">
                  改回跟随全局
                </button>
              )}
            </div>
          </div>
        )}

        {/* ---------------- 主题 ---------------- */}
        <Panel
          title="主题"
          collapsible
          defaultOpen
          sectionId="appearance:theme"
          actions={
            <>
              <button className="btn btn--sm" onClick={saveAsTheme} disabled={!activePack}>
                另存为…
              </button>
              <button className="btn btn--sm" onClick={() => themeInput.current?.click()}>
                导入 JSON
              </button>
              <input
                ref={themeInput}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void importThemeFile(f)
                  e.target.value = ''
                }}
              />
            </>
          }
        >
          <div className="themes">
            {themes.map((t) => (
              <div key={t.name} className={`thm ${ui.theme === t.name ? 'thm--on' : ''}`}>
                <button className="thm__hit" onClick={() => setUi({ theme: t.name })} title={t.description}>
                  <span className="thm__preview" style={tileStyle(packs[t.name])}>
                    <span className="thm__chrome" style={barStyle(packs[t.name])}>
                      <span className="thm__dot" style={accentStyle(packs[t.name])} />
                      <span className="thm__line" style={accentStyle(packs[t.name])} />
                      <span className="thm__line thm__line--dim" />
                    </span>
                  </span>
                  <span className="thm__name">
                    {t.name}
                    {t.builtin && <span className="chip chip--type">内置</span>}
                  </span>
                  <span className="thm__desc">{t.description || '没有说明'}</span>
                </button>
                <div className="thm__tools">
                  <a className="thm__tool" href={api.themeExportUrl(t.name)} download>
                    导出
                  </a>
                  {!t.builtin && (
                    <button className="thm__tool" onClick={() => void removeTheme(t.name)}>
                      删除
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <p className="faint fs-xs" style={{ marginTop: 'var(--p-space-3)', lineHeight: 1.7 }}>
            内置主题是<b>只读</b>的：想改就先「另存为」，然后在 <code>config/themes/</code> 里编辑那份 JSON。
            文件只有两个块 —— <code>dark</code> 与 <code>light</code>，里面就是 CSS 变量名到值的映射。
            换主题不需要重启，也不会碰任何实体数据。
          </p>
        </Panel>

        {/* ---------------- 明暗与字号 ---------------- */}
        <Panel title="明暗与字号" collapsible sectionId="appearance:size">
          <div className="appearance__row">
            <div className="appearance__label">
              明暗模式
              <span className="faint fs-xs">深色写正文、浅色看设定，随你</span>
            </div>
            <div className="seg">
              <button
                className={`seg__item ${theme === 'dark' ? 'seg__item--on' : ''}`}
                onClick={() => setUi({ mode: 'dark' })}
              >
                深色
              </button>
              <button
                className={`seg__item ${theme === 'light' ? 'seg__item--on' : ''}`}
                onClick={() => setUi({ mode: 'light' })}
              >
                浅色
              </button>
            </div>
          </div>

          <div className="appearance__row">
            <div className="appearance__label">
              整体字号
              <span className="faint fs-xs">
                所有面板的字号会跟着变；面板本身变窄时还会再自动缩一档
              </span>
            </div>
            <div className="row">
              <input
                className="slider-input"
                type="range"
                min={0.8}
                max={1.5}
                step={0.05}
                value={fontScale}
                onChange={(e) => setUi({ font_scale: Number(e.target.value) })}
                aria-label="整体字号"
              />
              <span className="mono fs-sm" style={{ width: 46 }}>
                {Math.round(fontScale * 100)}%
              </span>
            </div>
          </div>

          <div className="appearance__row">
            <div className="appearance__label">
              快捷档位
              <span className="faint fs-xs">不知道调多少就先试一档</span>
            </div>
            <div className="row row--wrap">
              {[
                { label: '紧凑', v: 0.9 },
                { label: '标准', v: 1 },
                { label: '舒适', v: 1.15 },
                { label: '大字', v: 1.35 },
              ].map((p) => (
                <button
                  key={p.label}
                  className={`btn btn--sm ${Math.abs(fontScale - p.v) < 0.01 ? 'btn--primary' : ''}`}
                  onClick={() => setUi({ font_scale: p.v })}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </Panel>

        {/* ---------------- 字体 ---------------- */}
        <Panel
          title="字体"
          collapsible
          sectionId="appearance:font"
          actions={
            <button className="btn btn--primary btn--sm" onClick={() => fontInput.current?.click()} disabled={busy}>
              上传字体
            </button>
          }
        >
          <input
            ref={fontInput}
            type="file"
            accept={FONT_ACCEPT}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void uploadFont(f)
              e.target.value = ''
            }}
          />

          <div className="appearance__row">
            <div className="appearance__label">
              界面字体
              <span className="faint fs-xs">面板标题、正文、表单都用它</span>
            </div>
            <select
              className="select"
              value={ui.font_ui}
              onChange={(e) => setUi({ font_ui: e.target.value })}
              aria-label="界面字体"
            >
              <option value="">系统默认</option>
              {fonts.map((f) => (
                <option key={f.name} value={f.stem}>
                  {f.stem}
                </option>
              ))}
            </select>
          </div>

          <div className="appearance__row">
            <div className="appearance__label">
              等宽字体
              <span className="faint fs-xs">日志、路径、Markdown 源码用它</span>
            </div>
            <select
              className="select"
              value={ui.font_mono}
              onChange={(e) => setUi({ font_mono: e.target.value })}
              aria-label="等宽字体"
            >
              <option value="">系统默认</option>
              {fonts.map((f) => (
                <option key={f.name} value={f.stem}>
                  {f.stem}
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginTop: 'var(--p-space-3)' }}>
            <div className="detail__section-title" style={{ marginBottom: 6 }}>
              素材库里的字体（{fonts.length}）
            </div>
            {fonts.length === 0 ? (
              <div className="faint fs-sm">
                还没有上传过字体。支持 {FONT_ACCEPT.replace(/\./g, '').toUpperCase()}，
                上传后立刻出现在上面的下拉里。
              </div>
            ) : (
              <div className="assets">
                {fonts.map((f) => (
                  <div key={f.name} className="asset" style={{ fontFamily: `"wkv-${f.stem}", var(--p-font-sans)` }}>
                    <span className="asset__name">{f.stem}</span>
                    <span className="faint fs-xs">{(f.size / 1024).toFixed(0)} KB</span>
                    <button className="asset__x" onClick={() => void removeAsset('fonts', f)} title="删除">
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Panel>

        {/* ---------------- 背景 ---------------- */}
        <Panel
          title="背景"
          collapsible
          sectionId="appearance:bg"
          actions={
            <button className="btn btn--primary btn--sm" onClick={() => bgInput.current?.click()} disabled={busy}>
              上传图片
            </button>
          }
        >
          <input
            ref={bgInput}
            type="file"
            accept={IMG_ACCEPT}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void uploadBg(f)
              e.target.value = ''
            }}
          />

          <div className="seg" style={{ marginBottom: 'var(--p-space-3)' }}>
            {BG_KINDS.map((k) => (
              <button
                key={k.key}
                className={`seg__item ${bg.kind === k.key ? 'seg__item--on' : ''}`}
                onClick={() => setUi({ background: { ...bg, kind: k.key } })}
                title={k.hint}
              >
                {k.label}
              </button>
            ))}
          </div>

          {bg.kind === 'color' && (
            <div className="appearance__row">
              <div className="appearance__label">底色</div>
              <div className="row">
                <input
                  type="color"
                  className="colorpick"
                  value={bg.color || '#101318'}
                  onChange={(e) => setUi({ background: { ...bg, color: e.target.value } })}
                />
                <span className="mono fs-xs muted">{bg.color || '#101318'}</span>
              </div>
            </div>
          )}

          {bg.kind === 'gradient' && (
            <>
              <div className="appearance__row">
                <div className="appearance__label">起色 / 止色</div>
                <div className="row">
                  <input
                    type="color"
                    className="colorpick"
                    value={bg.from || '#0b1020'}
                    onChange={(e) => setUi({ background: { ...bg, from: e.target.value } })}
                  />
                  <input
                    type="color"
                    className="colorpick"
                    value={bg.to || '#1b2a4a'}
                    onChange={(e) => setUi({ background: { ...bg, to: e.target.value } })}
                  />
                </div>
              </div>
              <div className="appearance__row">
                <div className="appearance__label">角度</div>
                <div className="row">
                  <input
                    className="slider-input"
                    type="range"
                    min={0}
                    max={360}
                    step={5}
                    value={bg.angle}
                    onChange={(e) => setUi({ background: { ...bg, angle: Number(e.target.value) } })}
                  />
                  <span className="mono fs-xs muted" style={{ width: 40 }}>
                    {bg.angle}°
                  </span>
                </div>
              </div>
            </>
          )}

          {bg.kind === 'image' && (
            <div className="appearance__row">
              <div className="appearance__label">
                选一张
                <span className="faint fs-xs">先「上传图片」，再从素材库里挑</span>
              </div>
              {backgrounds.length === 0 ? (
                <div className="faint fs-sm">素材库里还没有背景图。</div>
              ) : (
                <div className="bg-grid">
                  {backgrounds.map((b) => (
                    <div key={b.name} className={`bg-thumb ${bg.image === b.name ? 'bg-thumb--on' : ''}`}>
                      <button
                        className="bg-thumb__hit"
                        style={{ backgroundImage: `url("${b.url}")` }}
                        title={b.stem}
                        onClick={() => setUi({ background: { ...bg, image: b.name } })}
                      />
                      <button className="asset__x" onClick={() => void removeAsset('backgrounds', b)} title="删除">
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {bg.kind !== 'none' && (
            <>
              <div className="appearance__row">
                <div className="appearance__label">
                  图片适配
                  <span className="faint fs-xs">平铺适合小花纹</span>
                </div>
                <div className="seg">
                  {[
                    { k: 'cover', l: '铺满' },
                    { k: 'contain', l: '完整' },
                    { k: 'repeat', l: '平铺' },
                  ].map((f) => (
                    <button
                      key={f.k}
                      className={`seg__item ${bg.fit === f.k ? 'seg__item--on' : ''}`}
                      onClick={() => setUi({ background: { ...bg, fit: f.k as typeof bg.fit } })}
                    >
                      {f.l}
                    </button>
                  ))}
                </div>
              </div>

              <div className="appearance__row">
                <div className="appearance__label">
                  模糊
                  <span className="faint fs-xs">糊一点，字更清楚</span>
                </div>
                <div className="row">
                  <input
                    className="slider-input"
                    type="range"
                    min={0}
                    max={24}
                    step={1}
                    value={bg.blur}
                    onChange={(e) => setUi({ background: { ...bg, blur: Number(e.target.value) } })}
                  />
                  <span className="mono fs-xs muted" style={{ width: 40 }}>
                    {bg.blur}px
                  </span>
                </div>
              </div>

              <div className="appearance__row">
                <div className="appearance__label">
                  压暗
                  <span className="faint fs-xs">背景太花就往上调</span>
                </div>
                <div className="row">
                  <input
                    className="slider-input"
                    type="range"
                    min={0}
                    max={0.9}
                    step={0.05}
                    value={bg.dim}
                    onChange={(e) => setUi({ background: { ...bg, dim: Number(e.target.value) } })}
                  />
                  <span className="mono fs-xs muted" style={{ width: 40 }}>
                    {Math.round(bg.dim * 100)}%
                  </span>
                </div>
              </div>

              <div className="appearance__row">
                <div className="appearance__label">
                  面板不透明度
                  <span className="faint fs-xs">直接拖，看着舒服为止</span>
                </div>
                <div className="row">
                  <input
                    className="slider-input"
                    type="range"
                    min={0.5}
                    max={1}
                    step={0.02}
                    value={ui.panel_alpha}
                    onChange={(e) => setUi({ panel_alpha: Number(e.target.value) })}
                  />
                  <span className="mono fs-xs muted" style={{ width: 40 }}>
                    {Math.round(ui.panel_alpha * 100)}%
                  </span>
                </div>
              </div>

              <div className="appearance__row">
                <div className="appearance__label">
                  面板毛玻璃
                  <span className="faint fs-xs">顶栏 / 侧栏 / 弹窗背后做虚化。好看，但吃性能，默认关</span>
                </div>
                <div className="row">
                  <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={Boolean(ui.panel_blur)}
                      onChange={(e) => setUi({ panel_blur: e.target.checked })}
                    />
                    <span className="fs-sm">{ui.panel_blur ? '开（更费显卡）' : '关（更流畅）'}</span>
                  </label>
                </div>
              </div>
            </>
          )}

          <p className="faint fs-xs" style={{ marginTop: 'var(--p-space-3)', lineHeight: 1.7 }}>
            背景图存在 <code>data/assets/backgrounds/</code>。
            它和实体数据是**两个目录** —— 哪天觉得背景碍事，把整个 assets 删掉就行，档案一条不少。
          </p>
        </Panel>
      </div>

      {/* ---------------- 右栏 ---------------- */}
      <div className="appearance__side">
        <Panel title="当前生效" collapsible sectionId="appearance:preview">
          <div className="now" style={bgPreviewStyle}>
            <span className="now__panel">
              <span className="now__title" style={{ background: 'var(--accent)' }} />
              <span className="now__text" />
              <span className="now__text now__text--dim" />
            </span>
          </div>
          <div className="kv" style={{ marginTop: 'var(--p-space-3)' }}>
            <div className="kv__k">主题</div>
            <div className="kv__v">{ui.theme}</div>
            <div className="kv__k">模式</div>
            <div className="kv__v">{theme === 'dark' ? '深色' : '浅色'}</div>
            <div className="kv__k">字号</div>
            <div className="kv__v">{Math.round(fontScale * 100)}%</div>
            <div className="kv__k">界面字体</div>
            <div className="kv__v">{ui.font_ui || '系统默认'}</div>
            <div className="kv__k">等宽字体</div>
            <div className="kv__v">{ui.font_mono || '系统默认'}</div>
            <div className="kv__k">背景</div>
            <div className="kv__v">
              {BG_KINDS.find((k) => k.key === bg.kind)?.label}
              {bg.kind === 'image' && bg.image ? `：${bg.image}` : ''}
            </div>
          </div>
          <button className="btn btn--sm" style={{ marginTop: 'var(--p-space-3)' }} onClick={resetUi}>
            恢复出厂外观
          </button>
          <p className="faint fs-xs" style={{ marginTop: 6, lineHeight: 1.6 }}>
            只重置外观，不动布局，也不动任何实体数据。
          </p>
        </Panel>

        <Panel title="文件都在哪" collapsible sectionId="appearance:paths">
          <StateGate empty={false}>
            <div className="kv">
              <div className="kv__k">偏好</div>
              <div className="kv__v mono fs-xs" style={{ wordBreak: 'break-all' }}>
                {where?.preferences_file ?? '—'}
              </div>
              <div className="kv__k">主题包</div>
              <div className="kv__v mono fs-xs" style={{ wordBreak: 'break-all' }}>
                {where?.themes_dir ?? '—'}
              </div>
              <div className="kv__k">素材库</div>
              <div className="kv__v mono fs-xs" style={{ wordBreak: 'break-all' }}>
                {where?.assets_dir ?? '—'}
              </div>
            </div>
            {where && (
              <div className="row row--wrap" style={{ marginTop: 'var(--p-space-3)' }}>
                {Object.entries(where.kinds).map(([k, v]) => (
                  <span key={k} className="chip">
                    {k} {v.count}
                  </span>
                ))}
              </div>
            )}
            <p className="faint fs-xs" style={{ marginTop: 'var(--p-space-3)', lineHeight: 1.7 }}>
              {where?.free_hint ?? ''}
            </p>
          </StateGate>
        </Panel>
      </div>
    </div>
  )
}

export default AppearanceView
