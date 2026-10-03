/** 书目信息：书名、作者、题材、封面。
 *
 * **位置**（用户 2026-10-03 要求）：「把书目信息放在汇总里，且居于首要位置」。
 * 所以它挂在汇总页抬头正下方、所有数据看板之前 —— 进来看见的第一个内容区块
 * 就是「这是哪本书」。原先在【设置 → 后台】里那一份已撤掉：同一件事只留一个入口。
 *
 * 题材决定录入界面的示例与占位文案（玄幻书别给你看科幻例子），
 * 封面展示在汇总页 —— 两者都只是 book.yaml 里的一行，随时可改。
 */

import { useRef, useState } from 'react'
import * as api from '../api/client'
import { useApp } from '../state/store'
import { GENRES } from '../lib/genre'
import { Panel } from './Panel'

export function BookMetaPanel() {
  const { bookId, currentBook, updateBookMeta, notify } = useApp()
  const [title, setTitle] = useState(currentBook?.title ?? '')
  const [author, setAuthor] = useState(currentBook?.author ?? '')
  const [genre, setGenre] = useState(currentBook?.genre ?? '')
  const [busy, setBusy] = useState(false)
  const coverRef = useRef<HTMLInputElement>(null)
  // key 挂书目 —— 切书时表单回到该书当前值
  const formKey = `${bookId}:${currentBook?.title}:${currentBook?.genre}`

  const save = async () => {
    if (!bookId) return
    setBusy(true)
    try {
      await updateBookMeta({ title: title.trim(), author: author.trim(), genre })
      notify('ok', '书目信息已保存')
    } catch (e) {
      notify('err', `保存失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const uploadCover = async (file: File) => {
    if (!bookId) return
    setBusy(true)
    try {
      const r = await api.uploadAsset('covers', file)
      await updateBookMeta({ cover: `covers/${r.name}` })
      notify('ok', '封面已更新')
    } catch (e) {
      notify('err', `封面上传失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const removeCover = async () => {
    if (!bookId) return
    setBusy(true)
    try {
      await updateBookMeta({ cover: '' })
      notify('ok', '封面已移除（素材库里的图片保留）')
    } catch (e) {
      notify('err', `移除失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  if (!bookId || !currentBook) {
    return (
      <Panel title="书目信息">
        <div className="notice">
          <div>先在顶栏选一本书。</div>
        </div>
      </Panel>
    )
  }

  return (
    <Panel
      key={formKey}
      title="书目信息"
      collapsible
      defaultOpen
      sectionId="dash:bookmeta"
      summary={currentBook.genre || undefined}
      actions={
        <button className="btn btn--primary btn--sm" onClick={save} disabled={busy}>
          {busy && <span className="spinner" />}
          保存
        </button>
      }
    >
      <div className="bookmeta">
        <div className="bookmeta__cover">
          {currentBook.cover ? (
            <>
              <img src={api.assetUrlOf(currentBook.cover)} alt="封面" />
              <button className="btn btn--sm" onClick={removeCover} disabled={busy}>
                移除封面
              </button>
            </>
          ) : (
            <button
              className="btn btn--sm bookmeta__cover-add"
              onClick={() => coverRef.current?.click()}
              disabled={busy}
              title="选一张图当封面（jpg/png/webp）"
            >
              ＋ 上传封面
            </button>
          )}
          <input
            ref={coverRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/avif"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void uploadCover(f)
              e.target.value = ''
            }}
          />
        </div>

        <div className="bookmeta__fields">
          <div className="field">
            <label className="field__label" htmlFor="bm-title">书名</label>
            <input id="bm-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="bm-author">作者</label>
            <input id="bm-author" className="input" value={author} onChange={(e) => setAuthor(e.target.value)} />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="bm-genre">题材（决定录入界面的示例文案）</label>
            <select id="bm-genre" className="select" value={genre} onChange={(e) => setGenre(e.target.value)}>
              <option value="">不设题材（通用示例）</option>
              {GENRES.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </div>
          <div className="faint fs-xs">
            目录名 <span className="mono">{currentBook.book_id}</span> 建后不改 —— 改的只是显示与示例。
          </div>
        </div>
      </div>
    </Panel>
  )
}

export default BookMetaPanel
