/** 类型显示名 + 自定义类型（后台）。
 *
 * 两件事，都在这一个面板：
 *
 * 1. **显示名**：8 种实体类型在**界面上**叫什么。能改的只有「显示成什么字」，
 *    底层 key、文件目录、ID 前缀、图上按类型分簇全都不跟着动 —— 那些是结构。
 *
 * 2. **自定义类型**（P7.6）：内置 8 类不够用（种族、船、阵法……）就开新部门。
 *    一个自定义类型 = 显示名 + 英文短名（key，同时是目录名）+ ID 前缀 + 颜色。
 *    名下有实体时不许删 —— 档案变孤儿比类型多一点严重得多。
 *
 * 都按**书目**存（book.yaml），写仙侠和写科幻的两本书各是各的。
 */

import { useCallback, useEffect, useState } from 'react'
import * as api from '../api/client'
import { useApp } from '../state/store'
import type { EntityTypesData } from '../api/types'
import { Panel } from './Panel'

export function TypeLabelsPanel() {
  const { bookId, types, notify, refresh, dataVersion } = useApp()
  // 输入框的值。空串 = 「这个我不改」，存的时候就不提交它
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)

  // ---- 自定义类型（P7.6） ----
  const [reg, setReg] = useState<EntityTypesData | null>(null)
  const [form, setForm] = useState({ label: '', key: '', prefix: '', color: '' })
  const [formBusy, setFormBusy] = useState(false)

  const loadRegistry = useCallback(async () => {
    if (!bookId) return
    try {
      setReg(await api.listEntityTypes(bookId))
    } catch {
      setReg(null) // 拉不到不挡显示名那一半
    }
  }, [bookId, dataVersion])

  useEffect(() => {
    setDraft({})
    setDirty(false)
    setForm({ label: '', key: '', prefix: '', color: '' })
    void loadRegistry()
  }, [bookId, loadRegistry])

  const save = async () => {
    if (!bookId) return
    // 只提交真正改过的：和内置名一样的、空着的都不提交
    const changed: Record<string, string> = {}
    for (const t of types) {
      const v = (draft[t.key] ?? '').trim()
      if (v && v !== t.label) changed[t.key] = v
    }
    setBusy(true)
    try {
      const r = await api.saveTypeLabels(bookId, changed)
      const renamed = Object.entries(changed)
        .map(([k, v]) => `${r.builtin[k] ?? k}→${v}`)
        .join('、')
      notify('ok', renamed ? `显示名已改：${renamed}` : '显示名已恢复内置')
      setDraft({})
      setDirty(false)
      // types 存在 store 里，重新拉一遍实体列表才会带新名字
      await refresh()
    } catch (e) {
      notify('err', `没存上：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const addType = async () => {
    if (!bookId || !form.label.trim() || !form.key.trim()) return
    setFormBusy(true)
    try {
      const t = await api.addEntityType(bookId, {
        label: form.label.trim(),
        key: form.key.trim(),
        prefix: form.prefix.trim() || undefined,
        color: form.color.trim() || undefined,
      })
      notify('ok', `已新增类型「${t.label}」（${t.key}，编号前缀 ${t.prefix}-）`)
      setForm({ label: '', key: '', prefix: '', color: '' })
      await Promise.all([loadRegistry(), refresh()])
    } catch (e) {
      notify('err', `没建成：${(e as Error).message}`)
    } finally {
      setFormBusy(false)
    }
  }

  const removeType = async (key: string, label: string, count: number) => {
    if (!bookId) return
    const tip = count
      ? `「${label}」名下还有 ${count} 个实体，必须先移走或删光才能删类型。`
      : `确定删除类型「${label}」（${key}）？它名下没有实体，删了不留痕。`
    if (!window.confirm(tip)) return
    try {
      await api.removeEntityType(bookId, key)
      notify('ok', `已删除类型「${label}」`)
      await Promise.all([loadRegistry(), refresh()])
    } catch (e) {
      notify('err', `没删掉：${(e as Error).message}`)
    }
  }

  const customs = reg?.types.filter((t) => !t.builtin) ?? []

  return (
    <Panel
      title="类型与显示名"
      collapsible
      sectionId="admin:typelabels"
      actions={
        <>
          {dirty && (
            <button className="btn btn--sm" onClick={() => { setDraft({}); setDirty(false) }} disabled={busy}>
              放弃改动
            </button>
          )}
          <button className="btn btn--primary btn--sm" onClick={save} disabled={busy || !bookId}>
            {busy && <span className="spinner" />}
            保存显示名
          </button>
        </>
      }
    >
      {!bookId ? (
        <div className="notice">
          <div>先在顶栏选一本书 —— 类型是<b>按书目</b>存的，不同书可以各是各的。</div>
        </div>
      ) : (
        <>
          <div className="notice" style={{ marginBottom: 'var(--p-space-3)' }}>
            <div>
              上面这排改的只是<b>界面上的字</b>。文件放哪个目录、编号前缀、图上按类型分簇，全都不跟着动 ——
              所以随时可改、随时可改回，不存在迁移问题。留空 = 用内置名。
            </div>
          </div>
          <div className="tlgrid">
            {types.map((t) => (
              <label key={t.key} className="tlgrid__row">
                <span className="tlgrid__key">{t.key}</span>
                <span className="tlgrid__builtin">{t.label}</span>
                <input
                  className="input tlgrid__input"
                  value={draft[t.key] ?? ''}
                  placeholder={t.label}
                  maxLength={24}
                  onChange={(e) => {
                    setDraft((d) => ({ ...d, [t.key]: e.target.value }))
                    setDirty(true)
                  }}
                />
              </label>
            ))}
          </div>
          <div className="faint fs-xs" style={{ marginTop: 'var(--p-space-2)' }}>
            底层 key（第一列）永远不会变，实体档案里写的也是它 —— 显示名只在这一层「翻译」。
          </div>

          {/* ---------------- 自定义类型（P7.6） ---------------- */}
          <div className="cty__divider" />
          <div className="cty__head">
            <b>自定义类型</b>
            <span className="faint fs-xs">
              {reg ? `已建 ${customs.length} / ${reg.max_custom} 个` : '…'}
            </span>
          </div>
          <div className="faint fs-xs" style={{ marginBottom: 'var(--p-space-2)' }}>
            内置 8 类不够用（种族、船、阵法……）就开新部门：每类有自己的目录、编号前缀和颜色，
            录入下拉、图谱配色、AI 抽取全部自动认识它。删除前必须先移走名下的实体。
          </div>

          {customs.length > 0 && (
            <div className="cty__list">
              {customs.map((t) => (
                <div key={t.key} className="cty__row">
                  <i className="cty__dot" style={{ background: t.color ?? 'var(--text-muted)' }} />
                  <span className="cty__label">{t.label}</span>
                  <code className="cty__key">{t.key}</code>
                  <span className="cty__meta">前缀 {t.prefix}-</span>
                  <span className="cty__meta">{t.count} 个实体</span>
                  <button
                    className="btn btn--sm cty__del"
                    onClick={() => removeType(t.key, t.label, t.count)}
                    title={t.count ? '名下还有实体，先移走或删光' : '删除这个类型'}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="cty__form">
            <input
              className="input cty__in cty__in--label"
              placeholder="显示名（如：种族）"
              maxLength={12}
              value={form.label}
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            />
            <input
              className="input cty__in cty__in--key"
              placeholder="英文短名（如 species）"
              maxLength={16}
              value={form.key}
              onChange={(e) => setForm((f) => ({ ...f, key: e.target.value.toLowerCase() }))}
            />
            <input
              className="input cty__in cty__in--prefix"
              placeholder="编号前缀（留空自动）"
              maxLength={5}
              value={form.prefix}
              onChange={(e) => setForm((f) => ({ ...f, prefix: e.target.value.toLowerCase() }))}
            />
            <input
              className="input cty__in cty__in--color"
              type="color"
              title="颜色（留空则用文本框填 #RRGGBB）"
              value={/^#[0-9a-fA-F]{6}$/.test(form.color) ? form.color : '#7fc8a9'}
              onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
            />
            <button
              className="btn btn--primary btn--sm"
              disabled={formBusy || !form.label.trim() || !form.key.trim()}
              onClick={addType}
            >
              {formBusy && <span className="spinner" />}
              新增类型
            </button>
          </div>
          <div className="faint fs-xs" style={{ marginTop: 4 }}>
            英文短名会用作存储目录（entities/英文短名/），建好后不能改；编号前缀全库唯一，撞了会拒绝。
          </div>
        </>
      )}
    </Panel>
  )
}

export default TypeLabelsPanel
