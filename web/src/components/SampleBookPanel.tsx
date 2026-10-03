/** 示例书（P11-7️⃣③）—— 一键生成一本「各视图都有东西可看」的小书。
 *
 * 为什么值得占一块面板：空库打开会让人对着空白发懵 ——
 * 不知道一个「实体」该长什么样、双链该怎么写、伏笔与时间线怎么配合。
 * 说明书解决不了这个，看到一份像样的样本才行。
 *
 * 三件必须说清楚的事：
 * 1. **示例书是一本普通的书**，走同一套数据规范，不是藏在程序目录里的预置数据；
 * 2. **正文是工具自带的演示文字**，内容写在程序里、不调用任何模型，
 *    也绝不碰你库里一个字。示例书的 book.yaml 里带 `sample: true`；
 * 3. **整本删掉不留痕** —— 删除前自动整本快照，界面把快照路径给你。
 */

import { useCallback, useEffect, useState } from 'react'
import * as api from '../api/client'
import type { Book, SampleBookStatus } from '../api/types'
import { useApp } from '../state/store'
import { Panel } from '../components/Panel'

export function SampleBookPanel() {
  const { bookId, notify, refresh, reloadBooks, switchBook, requestView } = useApp()
  const [st, setSt] = useState<SampleBookStatus | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [snap, setSnap] = useState<string | null>(null)
  const [dangerOpen, setDangerOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [curTitle, setCurTitle] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await api.sampleBookStatus()
      setSt(r)
      setName((n) => n || r.default_id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 「删除当前书目」要拿书名做确认 —— 书名只有后端知道，进面板时问一次
  useEffect(() => {
    if (!bookId) {
      setCurTitle('')
      return
    }
    let alive = true
    api
      .listBooks()
      .then((r) => {
        if (!alive) return
        const me = r.books.find((b) => b.book_id === bookId)
        setCurTitle(me?.title || bookId)
      })
      .catch(() => alive && setCurTitle(bookId))
    return () => {
      alive = false
    }
  }, [bookId])

  const make = async () => {
    const id = name.trim()
    if (!id) return
    setBusy(true)
    setErr(null)
    setDone(null)
    try {
      const r = await api.makeSampleBook(id, st?.default_title || '')
      // 先把书目清单重拉一遍，再切过去 —— 顺序反了的话 `switchBook` 会对着
      // 一份还没有这本书的清单切，顶栏下拉里找不到它。
      await reloadBooks()
      switchBook(r.book_id)
      setDone(
        `已生成「${r.title}」：${r.entities} 条实体 · ${r.chapters} 章正文 · ` +
          `${r.docs} 份世界观档案 · ${r.maps} 张地图。已切到这本示例书，去各视图看看。`,
      )
      // 生成后界面会切到总览（切书必然换视图），面板里那条回执当场就看不到了 ——
      // 所以关键数字也得进浮层提示，它跨视图存活。
      notify('ok', `示例书已生成：${r.entities} 条实体 · ${r.chapters} 章 · ${r.docs} 份档案 · ${r.maps} 张地图`)
      await load()
      requestView('dashboard' as never)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const removeBook = async (target: string, title: string) => {
    if (
      !window.confirm(
        `确定把整本书「${title}」删掉？\n\n` +
          `会删掉它的全部实体档案、章节正文、世界观文档、地图与视图摆位。\n` +
          `删除前会自动整本快照到 snapshots/，后悔了能从那儿整体捞回来。`,
      )
    ) {
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const r = await api.deleteBook(target, title)
      setSnap(r.snapshot?.dir ?? null)
      // 快照路径是「后悔了怎么捞」的唯一线索，必须进浮层提示 ——
      // 面板那条通知在切书/切视图之后就不一定看得见了。
      notify('ok', r.snapshot?.dir
        ? `已删掉「${r.title}」；整本快照在 ${r.snapshot.dir}`
        : `已删掉「${r.title}」`)
      setTyped('')
      setDangerOpen(false)
      // 删掉的若正是「当前书目」，`refresh` 里的 `reloadBooks` 会把它从顶栏摘掉
      // 并自动切到还有的第一本 —— 否则 bookId 还指着一本不存在的书，各视图一路 404。
      await refresh()
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const samples: Book[] = st?.samples ?? []
  const taken = new Set(st?.taken ?? [])
  const nameTaken = taken.has(name.trim())

  return (
    <Panel title="示例书" className="admin__sample" collapsible sectionId="admin:sample">
      <div className="notice" style={{ marginBottom: 'var(--p-space-3)' }}>
        <div>
          一键生成一本<b>「各视图都有东西可看」</b>的小书：十几条实体、双链关系网、
          一张地图、三章正文、伏笔与纪年表、六份世界观档案。
          它是一本<b>普通的书</b>（走同一套数据规范，存在你的数据目录里，不是预置在程序里的），
          看够了随时整本删掉。
          <br />
          里面的正文是工具自带的<b>演示文字</b> —— 内容写在程序里、不调用任何模型，
          也不会碰你库里任何一个字。
        </div>
      </div>

      <div className="audit__tools">
        <label className="field__label fs-xs" htmlFor="sample-id">
          书目 ID
        </label>
        <input
          id="sample-id"
          className="input"
          style={{ maxWidth: 260 }}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={st?.default_id ?? '示例书'}
          disabled={busy}
        />
        <button
          className="btn btn--primary btn--sm"
          onClick={() => void make()}
          disabled={busy || !name.trim() || nameTaken}
        >
          {busy && <span className="spinner" />}
          新建示例书
        </button>
        {nameTaken && <span className="faint fs-xs">这个名字已被占用，换一个</span>}
      </div>

      {done && <div className="notice notice--ok" style={{ marginBottom: 'var(--p-space-3)' }}>{done}</div>}
      {err && <div className="notice notice--warn" style={{ marginBottom: 'var(--p-space-3)' }}>{err}</div>}
      {snap && (
        <div className="notice notice--ok" style={{ marginBottom: 'var(--p-space-3)' }}>
          上一批删除已整本快照到{' '}
          <code className="mono" style={{ wordBreak: 'break-all' }}>{snap}</code>
          {' '}—— 需要时把里面的 <code>entities/</code>、<code>chapters/</code>、
          <code>world/</code> 拷回 <code>books/&lt;书目&gt;/</code> 即可整体复原。
        </div>
      )}

      {samples.length > 0 && (
        <ul className="audit__list" style={{ marginBottom: 'var(--p-space-3)' }}>
          {samples.map((b) => (
            <li key={b.book_id} className="audit__row">
              <span className="audit__name">{b.title}</span>
              <span className="chip">示例</span>
              <span className="chip">{b.entity_count} 条实体</span>
              <span className="faint fs-xs grow">{b.book_id}</span>
              <button
                className="btn btn--sm"
                onClick={() => void removeBook(b.book_id, b.title || b.book_id)}
                disabled={busy}
              >
                删掉这本
              </button>
            </li>
          ))}
        </ul>
      )}

      <details
        className="danger"
        open={dangerOpen}
        onToggle={(e) => setDangerOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="fs-sm">删除当前书目（危险）</summary>
        <div className="fs-xs faint" style={{ margin: 'var(--p-space-2) 0' }}>
          整本删除<b>不可撤销</b>。为了防手滑，要先把书名原样敲一遍。
          删除前会自动整本快照，随后可以按原路径拷回恢复。
        </div>
        {bookId && (
          <>
            <div className="fs-xs" style={{ marginBottom: 'var(--p-space-2)' }}>
              当前书目：<b>{curTitle || bookId}</b>
            </div>
            <div className="audit__tools">
              <input
                className="input"
                style={{ maxWidth: 260 }}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="在这里敲书名"
                disabled={busy}
              />
              <button
                className="btn btn--danger btn--sm"
                disabled={busy || !typed.trim() || typed.trim() !== (curTitle || bookId)}
                onClick={() => void removeBook(bookId, typed.trim())}
              >
                确实删除
              </button>
            </div>
          </>
        )}
        {!bookId && <div className="faint fs-xs">当前没选书。</div>}
      </details>
    </Panel>
  )
}

export default SampleBookPanel
