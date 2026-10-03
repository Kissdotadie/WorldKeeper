/**
 * 顶栏的布局菜单：切换 / 保存 / 删除布局预设。
 *
 * 放在顶栏而不是某个界面里，是因为「我现在怎么摆的」是**全局状态**，
 * 跟你看的是哪个面板无关。
 */

import { useEffect, useRef, useState } from 'react'
import { useApp } from '../state/store'
import { useShortcuts } from '../lib/shortcuts'
import type { LayoutsApi } from '../shell/useLayouts'

export function LayoutMenu({ layouts }: { layouts: LayoutsApi }) {
  const { notify } = useApp()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const box = useRef<HTMLDivElement>(null)

  // 点空白处关掉（空间判断，留在本地）；Esc 走全局注册表（P11-A2），
  // 优先级 50：菜单比图上的常规动作优先，但让位给浮层与弹窗。
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useShortcuts(
    [
      {
        id: 'layoutmenu.esc',
        keys: 'Esc',
        scope: 'global',
        desc: '关闭布局菜单',
        priority: 50,
        when: () => open,
        run: () => setOpen(false),
      },
    ],
    [open],
  )

  const presets = (layouts.layouts?.layouts ?? []).filter((l) => !l.name.startsWith('__'))
  const canSave = name.trim().length > 0

  const save = () => {
    if (!canSave) return
    void layouts.saveAs(name)
    setName('')
    setOpen(false)
  }

  return (
    <div className="menu" ref={box}>
      <button
        className={`btn btn--ghost btn--sm menu__trigger ${open ? 'menu__trigger--open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="布局：切换、保存、恢复默认"
        aria-expanded={open}
      >
        <span className="menu__trigger-text">
          布局{layouts.activeName ? `：${layouts.activeName}` : ''}
        </span>
        {layouts.dirty && <span className="menu__dirty" title="有改动（会自动记住）" />}
        <span className="menu__caret">▾</span>
      </button>

      {open && (
        <div className="menu__panel" role="menu">
          <div className="menu__label">切换预设</div>
          {presets.length === 0 ? (
            <div className="menu__empty">还没有保存过预设。摆好之后在下面起个名字。</div>
          ) : (
            presets.map((p) => (
              <div
                key={p.name}
                className={`menu__row ${layouts.activeName === p.name ? 'menu__row--on' : ''}`}
              >
                <button
                  className="menu__pick"
                  onClick={() => {
                    void layouts.applyPreset(p.name)
                    setOpen(false)
                  }}
                >
                  <span className="menu__pick-name">{p.name}</span>
                  {p.panel_count != null && (
                    <span className="faint fs-xs">{p.panel_count} 个面板</span>
                  )}
                </button>
                <button
                  className="menu__del"
                  title={`删除「${p.name}」`}
                  onClick={() => void layouts.removePreset(p.name)}
                >
                  ✕
                </button>
              </div>
            ))
          )}

          <hr className="hr" />

          <div className="menu__label">保存当前布局</div>
          <div className="row">
            <input
              className="input"
              placeholder="写作 / 校对 / 大纲…"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save()
              }}
            />
            <button className="btn btn--primary btn--sm" disabled={!canSave} onClick={save}>
              保存
            </button>
          </div>

          <hr className="hr" />

          <button
            className="menu__action"
            onClick={() => {
              void layouts.resetToDefault()
              setOpen(false)
            }}
          >
            恢复默认布局
          </button>
          <button
            className="menu__action"
            onClick={() => {
              void layouts.refresh()
              notify('info', '布局列表已重新读取')
            }}
          >
            重新读取布局列表
          </button>

          <p className="faint fs-xs menu__foot">
            拖标签页可以停靠到任意位置，拖分隔线可以改大小，拖到面板边缘会拆出新的一格。
            日常改动会自动记住（不进预设）；只有点「保存」才会存成具名预设。
          </p>
        </div>
      )}
    </div>
  )
}

export default LayoutMenu
