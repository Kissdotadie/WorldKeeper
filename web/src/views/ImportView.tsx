/** 导入界面（独立页）：左边贴内容、右边过清单，确认后才落盘。 */

import { useMemo, useState } from 'react'
import * as api from '../api/client'
import type { PasteDraft, PastePreview, TypeOption } from '../api/types'
import { useApp } from '../state/store'
import { Panel } from '../components/Panel'
import { splitList } from '../lib/format'
import { genreSample } from '../lib/genre'

const GENERIC_SAMPLE = `姓名 | 别名 | 简介 | 标签
主角名 | 昵称、称号 | 一句话摘要，以后搜索主要靠它。 | 主角
配角名 | 称呼 | 一句话摘要。 | 配角`

export function ImportView() {
  const { bookId, types, notify, refresh, setView, openEntity, currentBook } = useApp()

  // 「填入示例」跟着题材走 —— 写科幻就给科幻的人物，不再满屏刀光剑影
  const sample = currentBook?.genre ? genreSample(currentBook.genre).paste : GENERIC_SAMPLE

  const [text, setText] = useState('')
  const [mode, setMode] = useState<'auto' | 'table' | 'list' | 'plain'>('auto')
  const [type, setType] = useState('character')
  const [extraTags, setExtraTags] = useState('')
  const [onDuplicate, setOnDuplicate] = useState<'skip' | 'create'>('skip')

  const [preview, setPreview] = useState<PastePreview | null>(null)
  const [keep, setKeep] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null)

  const doPreview = async () => {
    if (!bookId || !text.trim()) return
    setBusy('preview')
    try {
      const res = await api.previewPaste(bookId, { text, mode, type, tags: splitList(extraTags) })
      setPreview(res)
      setKeep(new Set(res.drafts.map((d, i) => (d.exists ? -1 : i)).filter((i) => i >= 0)))
    } catch (e) {
      notify('err', `解析失败：${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const doCommit = async () => {
    if (!bookId || !preview) return
    const drafts = preview.drafts
      .filter((_, i) => keep.has(i))
      .map((d: PasteDraft) => ({
        name: d.name,
        summary: d.summary ?? '',
        aliases: d.aliases ?? [],
        tags: d.tags ?? [],
        attributes: d.attributes ?? [],
      }))
    if (!drafts.length) {
      notify('info', '一条都没勾选，没什么可导入的')
      return
    }
    setBusy('commit')
    try {
      const res = await api.commitPaste(bookId, {
        text, mode, type, tags: splitList(extraTags), drafts, on_duplicate: onDuplicate,
      })
      const extra = res.skipped.length ? `，跳过同名 ${res.skipped.length} 条` : ''
      notify('ok', `已导入 ${res.created} 条${extra}`)
      await refresh()
      setPreview(null)
      setText('')
      if (res.items[0]) {
        openEntity(res.items[0].id)
      } else {
        setView('entities')
      }
    } catch (e) {
      notify('err', `导入失败：${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const selectedCount = keep.size
  const conflictCount = useMemo(() => preview?.drafts.filter((d) => d.exists).length ?? 0, [preview])
  const toggle = (i: number) =>
    setKeep((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  return (
    <div className="import">
      {/* ---- 左：粘贴 ---- */}
      <Panel
        title="① 把设定表整段贴进来"
        actions={
          <button className="btn btn--sm" onClick={() => setText(sample)}>
            填入示例{currentBook?.genre ? `（${currentBook.genre}）` : ''}
          </button>
        }
      >
        <div className="form-grid">
          <div className="field">
            <label className="field__label" htmlFor="p-type">按什么类型导入</label>
            <select id="p-type" className="select" value={type} onChange={(e) => setType(e.target.value)}>
              {types.map((t: TypeOption) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="p-mode">格式</label>
            <select id="p-mode" className="select" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="auto">自动识别</option>
              <option value="table">表格（竖线或制表符）</option>
              <option value="list">列表（- 名字：描述）</option>
              <option value="plain">每行一个名字</option>
            </select>
          </div>
          <div className="field form-grid--full">
            <label className="field__label" htmlFor="p-tags">统一追加标签</label>
            <input id="p-tags" className="input" value={extraTags} placeholder="例如：卷一"
              onChange={(e) => setExtraTags(e.target.value)} />
          </div>
        </div>

        <div className="field" style={{ marginTop: 'var(--p-space-3)' }}>
          <label className="field__label" htmlFor="p-text">粘贴内容 —— Excel / Markdown 表格 / 列表都行</label>
          <textarea
            id="p-text"
            className="textarea"
            style={{ minHeight: '46vh', fontFamily: 'var(--p-font-mono)', resize: 'vertical' }}
            value={text}
            placeholder={sample}
            onChange={(e) => setText(e.target.value)}
          />
        </div>

        <div className="row" style={{ marginTop: 'var(--p-space-3)' }}>
          <span className="faint fs-xs grow">
            表头认「名称 / 姓名 / 名」「摘要 / 简介」「别名」「标签」，其余列自动进「属性」
          </span>
          <button className="btn btn--primary" onClick={doPreview} disabled={busy !== null || !text.trim()}>
            {busy === 'preview' && <span className="spinner" />}
            解析预览 →
          </button>
        </div>
      </Panel>

      {/* ---- 右：待确认清单 ---- */}
      <Panel
        title="② 过一遍清单再落盘"
        actions={
          preview && (
            <div className="row">
              <button className="btn btn--sm" onClick={() => setKeep(new Set(preview.drafts.map((_, i) => i)))}>全选</button>
              <button className="btn btn--sm" onClick={() => setKeep(new Set())}>全不选</button>
              <button className="btn btn--sm"
                onClick={() => setKeep(new Set(preview.drafts.map((d, i) => (d.exists ? -1 : i)).filter((i) => i >= 0)))}>
                只选不冲突的
              </button>
            </div>
          )
        }
      >
        {!preview ? (
          <div className="empty">
            <div className="empty__title">还没有解析结果</div>
            <div className="fs-sm" style={{ maxWidth: 380 }}>
              左边贴好内容点「解析预览」，这里会出现一份待确认清单。
              <b> 不会静默落盘</b> —— 只有你勾选的条目才会写进档案。
            </div>
          </div>
        ) : (
          <>
            {preview.warnings.length > 0 && (
              <div className="notice notice--warn" style={{ marginBottom: 'var(--p-space-3)' }}>
                <div>{preview.warnings.map((w, i) => <div key={i}>{w}</div>)}</div>
              </div>
            )}

            <div className="row row--wrap" style={{ marginBottom: 'var(--p-space-3)' }}>
              <span className="chip chip--accent">识别为 {modeLabel(preview.mode)}</span>
              <span className="chip">{preview.count} 条待确认</span>
              {conflictCount > 0 && <span className="chip" style={{ color: 'var(--warn)' }}>{conflictCount} 条重名</span>}
              <div className="grow" />
              {conflictCount > 0 && (
                <label className="fs-xs muted row" style={{ gap: 4 }}>
                  同名
                  <select className="select" style={{ width: 'auto', minHeight: 'var(--control-h-sm)' }}
                    value={onDuplicate} onChange={(e) => setOnDuplicate(e.target.value as typeof onDuplicate)}>
                    <option value="skip">跳过已有（推荐）</option>
                    <option value="create">照样新建一份</option>
                  </select>
                </label>
              )}
            </div>

            <div className="review-list" style={{ maxHeight: '52vh', overflow: 'auto' }}>
              {preview.drafts.map((d, i) => {
                const on = keep.has(i)
                return (
                  <label key={i}
                    className={`review-item ${d.exists ? 'review-item--conflict' : ''} ${on ? '' : 'review-item--skip'}`}
                    style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={on} onChange={() => toggle(i)} style={{ marginTop: 3 }} />
                    <div className="grow">
                      <div className="row">
                        <span className="review-item__title">{d.name}</span>
                        {d.exists && <span className="chip chip--accent">已存在</span>}
                      </div>
                      {d.summary && <div className="fs-sm muted">{d.summary}</div>}
                      <div className="review-item__meta">
                        {d.aliases?.map((a) => <span key={a} className="chip">又称 {a}</span>)}
                        {d.tags?.map((t) => <span key={t} className="chip chip--accent">#{t}</span>)}
                        {d.attributes?.map(([k, v], j) => <span key={j} className="chip">{k}：{v}</span>)}
                      </div>
                    </div>
                  </label>
                )
              })}
            </div>

            <div className="row" style={{ marginTop: 'var(--p-space-3)' }}>
              <span className="faint fs-xs grow">已勾选 {selectedCount} / {preview.count} 条</span>
              <button className="btn" onClick={() => setPreview(null)} disabled={busy !== null}>
                ← 重新粘贴
              </button>
              <button className="btn btn--primary" onClick={doCommit} disabled={busy !== null || selectedCount === 0}>
                {busy === 'commit' && <span className="spinner" />}
                确认导入 {selectedCount} 条
              </button>
            </div>
          </>
        )}
      </Panel>
    </div>
  )
}

function modeLabel(mode: string): string {
  return { table: '表格', list: '列表', plain: '纯行', empty: '空内容' }[mode] ?? mode
}

export default ImportView
