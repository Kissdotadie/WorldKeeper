/** 实体体检 —— 把规则抽取误捞的非名词片段筛出来，人工勾选后批量删除。
 *
 * 三条自我约束：
 * 1. **判定只是建议**。分两档：`high` 默认勾上（「不不不」「哎呀」这种几乎不可能是人名），
 *    `mid` 一律不勾、只列出来 —— 作者可能真有理由（「士兵」代表整支队伍）。
 * 2. **删除前一定快照**。后端先备份到 `snapshots/` 再删，这里把路径原样显示出来，
 *    让人知道后悔的时候去哪儿找。
 * 3. **绝不碰正文**。删的是档案文件，章节一个字不动。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '../api/client'
import type { LintResult } from '../api/types'
import { useApp } from '../state/store'
import { Panel } from '../components/Panel'

/** 问题分类的中文名 —— 后端给的是英文 kind，直接摆到界面上太生硬。 */
const KIND_LABEL: Record<string, string> = {
  interjection: '语气词',
  redup: '叠字拟声',
  interrogative: '疑问词',
  adverb: '副词',
  verb_phrase: '动词短语',
  particle: '语气助词',
  plural: '复数泛称',
  degree: '程度短语',
  negation: '否定片段',
  pronoun: '代词泛称',
  generic: '通用名词',
  bad_prefix: '量词碎片',
  bad_head: '虚词开头',
  bad_tail: '虚词收尾',
  fragment: '句子碎片',
  pronoun_tail: '代词收尾',
  interj_head: '语气词开头',
  adv_head: '副词开头',
  adv_tail: '副词收尾',
  verb_redup: '动作叠用',
  glued: '粘着人名',
  too_short: '太短',
  too_long: '太长',
  charset: '非法字符',
  empty: '空名',
}

export function EntityAuditPanel() {
  const { bookId, notify, refresh } = useApp()
  const [data, setData] = useState<LintResult | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [lastSnap, setLastSnap] = useState<string | null>(null)

  const run = useCallback(
    async (autoCheck: boolean) => {
      if (!bookId) {
        setData(null)
        return
      }
      setBusy(true)
      setErr(null)
      try {
        const r = await api.adminLint(bookId)
        setData(r)
        // 默认只勾「确定是垃圾」那档
        setChecked(new Set(autoCheck ? r.items.filter((i) => i.severity === 'high').map((i) => i.id) : []))
      } catch (e) {
        setData(null)
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [bookId],
  )

  useEffect(() => {
    void run(true)
  }, [run])

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const highItems = useMemo(() => data?.items.filter((i) => i.severity === 'high') ?? [], [data])

  const doDelete = async () => {
    if (!bookId || checked.size === 0) return
    const picked = (data?.items ?? []).filter((i) => checked.has(i.id))
    const preview = picked.slice(0, 8).map((i) => i.name).join('、')
    const more = picked.length > 8 ? ` 等 ${picked.length} 条` : ''
    if (
      !window.confirm(
        `确定删除这 ${picked.length} 条实体？\n\n${preview}${more}\n\n` +
          '删除前会自动备份到 snapshots/，档案文件被移除；章节正文一个字不动。',
      )
    ) {
      return
    }
    setBusy(true)
    try {
      const r = await api.adminLintDelete(bookId, [...checked])
      setLastSnap(r.snapshot?.dir ?? null)
      notify('ok', `已删除 ${r.deleted} 条${r.failed.length ? `，${r.failed.length} 条失败` : ''}`)
      await refresh()
      await run(true)
    } catch (e) {
      notify('err', `删除失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      title="实体体检"
      className="admin__audit"
      collapsible
      sectionId="admin:audit"
      actions={
        <button className="btn btn--sm" onClick={() => void run(false)} disabled={busy || !bookId}>
          {busy && <span className="spinner" />}
          重新扫描
        </button>
      }
    >
      <div className="notice" style={{ marginBottom: 'var(--p-space-3)' }}>
        <div>
          规则抽取难免把<b>非名词性的片段</b>也捞成实体（「低头」「赶紧」「为什么」）。
          这里按名字的形态筛一遍 —— <b>判定只是建议</b>，删不删你说了算。删除前会自动
          快照到 <code>snapshots/</code>，档案随时能捞回来，<b>章节正文一个字不动</b>。
        </div>
      </div>

      {!bookId && <div className="empty__title fs-sm">先选一本书</div>}
      {err && (
        <div className="notice notice--warn" style={{ marginBottom: 'var(--p-space-3)' }}>
          读取失败：{err}
        </div>
      )}

      {data && bookId && (
        <>
          <div className="audit__bar">
            <span className="chip">{data.total} 条实体</span>
            <span className="chip chip--accent">{data.high} 条确定</span>
            <span className="chip">{data.mid} 条可疑</span>
            <span className="faint fs-xs">已勾选 {checked.size} 条</span>
          </div>

          {data.flagged === 0 ? (
            <div className="empty">
              <div className="empty__title">没筛出可疑的名字</div>
              <div className="fs-sm" style={{ maxWidth: 420 }}>
                这一本书的实体名看起来都像正经专名。索引刚重建过的话，这个结论才可信。
              </div>
            </div>
          ) : (
            <>
              <div className="audit__tools">
                <button className="btn btn--sm" onClick={() => setChecked(new Set(highItems.map((i) => i.id)))}>
                  全选「确定」（{highItems.length}）
                </button>
                <button className="btn btn--sm" onClick={() => setChecked(new Set(data.items.map((i) => i.id)))}>
                  全选全部（{data.flagged}）
                </button>
                <button className="btn btn--sm" onClick={() => setChecked(new Set())}>
                  清空
                </button>
                <button
                  className="btn btn--primary btn--sm"
                  onClick={doDelete}
                  disabled={checked.size === 0 || busy}
                >
                  删除勾选的 {checked.size} 条
                </button>
              </div>

              <ul className="audit__list">
                {data.items.map((it) => (
                  <li key={it.id} className={`audit__row audit__row--${it.severity}`}>
                    <label className="audit__pick">
                      <input type="checkbox" checked={checked.has(it.id)} onChange={() => toggle(it.id)} />
                      <span className="audit__name">{it.name}</span>
                    </label>
                    <span className={`audit__sev audit__sev--${it.severity}`}>
                      {it.severity === 'high' ? '确定' : '可疑'}
                    </span>
                    <span className="chip">{KIND_LABEL[it.kind] ?? it.kind}</span>
                    <span className="audit__reason faint fs-xs">{it.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {lastSnap && (
            <div className="notice notice--ok" style={{ marginTop: 'var(--p-space-3)' }}>
              上一批删除已备份到 <code className="mono" style={{ wordBreak: 'break-all' }}>{lastSnap}</code>
              {' '}—— 需要时把里面的文件按原路径拷回 <code>books/&lt;书目&gt;/entities/</code> 即可。
            </div>
          )}
        </>
      )}
    </Panel>
  )
}
