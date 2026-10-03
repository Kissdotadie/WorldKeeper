import { useState } from 'react'
import { useApp } from '../state/store'
import { Modal } from './Modal'
import { GENRES, genreSample } from '../lib/genre'

interface Props {
  onClose: () => void
}

export function BookCreateModal({ onClose }: Props) {
  const { createBook, notify } = useApp()
  const [bookId, setBookId] = useState('')
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [genre, setGenre] = useState('')
  const [busy, setBusy] = useState(false)

  // 书名占位跟着题材走 —— 玄幻书别给你看「明宪纪」
  const sample = genreSample(genre)

  const submit = async () => {
    const id = bookId.trim()
    if (!id) return
    setBusy(true)
    try {
      await createBook(id, title.trim() || id, author.trim(), genre)
      notify('ok', `已创建书目「${title.trim() || id}」`)
      onClose()
    } catch (e) {
      notify('err', `创建失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="新建书目"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={busy || !bookId.trim()}>
            {busy && <span className="spinner" />}
            创建
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="field">
          <label className="field__label" htmlFor="b-id">目录名 *（英文或中文都行，建后不改）</label>
          <input
            id="b-id"
            className="input"
            value={bookId}
            autoFocus
            placeholder="例如：xuantianji"
            onChange={(e) => setBookId(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="b-title">书名</label>
          <input
            id="b-title"
            className="input"
            value={title}
            placeholder={`例如：${sample.bookTitle}`}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="b-genre">题材（决定录入界面的示例文案，随时可改）</label>
          <select id="b-genre" className="select" value={genre} onChange={(e) => setGenre(e.target.value)}>
            <option value="">先不选（用通用示例）</option>
            {GENRES.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="b-author">作者</label>
          <input
            id="b-author"
            className="input"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          />
        </div>
      </div>

      <div className="notice" style={{ marginTop: 'var(--p-space-3)' }}>
        <div>
          会在数据目录下生成 <span className="mono fs-xs">books/&lt;目录名&gt;/</span>，
          里头分好 entities（按类型分子目录）、world、view、chapters。
          正文目录 <span className="mono fs-xs">chapters/</span> 工具只读不写。
        </div>
      </div>
    </Modal>
  )
}
