/** 外部改动提示条（P11-A5）。
 *
 * Markdown 是唯一真源，所以你可以随时用别的编辑器改档案。工具原本不知道 ——
 * 索引还是老的，界面显示旧内容，直到你恰好重建索引。这条横幅就是把那件事说出来。
 *
 * 三条自我约束：
 * 1. **只报不改**。这条不会自己去重建索引或改文件；重扫是显式按钮。
 * 2. **区分「内容变了」与「只改了时间戳」**。复制、同步盘、回收站还原都会改 mtime
 *    而内容一模一样 —— 那种一律不当回事（否则每次同步完都报一屏，很快就没人看了）。
 * 3. **不拦路**。可以「先不管」，本条会话内不再出现；但换了书会重新判断。
 */

import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type { FingerprintStatus } from '../api/types'
import { useApp } from '../state/store'

const KIND_LABEL: Record<string, string> = {
  added: '新增',
  removed: '已消失',
  modified: '内容变了',
  touched: '只改了时间戳',
}

export function FingerprintBanner({ onRebuild, rebuilding }: {
  onRebuild: () => void
  rebuilding: boolean
}) {
  const { bookId, notify, dataVersion } = useApp()
  const [fp, setFp] = useState<FingerprintStatus | null>(null)
  const [busy, setBusy] = useState(false)
  // 按书目记住「先不管」——换一本书要重新判断
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!bookId) {
      setFp(null)
      return
    }
    let alive = true
    api
      .getFingerprint(bookId)
      .then((r) => alive && setFp(r))
      // 指纹是附加能力：取不到就当没有，绝不弹错把页面弄脏
      .catch(() => alive && setFp(null))
    return () => {
      alive = false
    }
  }, [bookId, dataVersion])

  if (!fp || !bookId) return null
  const hidden = dismissed.has(bookId)
  const bad = fp.content_changed > 0

  // 只在「内容真变了」且没被忽略时，才用告警条
  if (!bad || hidden) {
    // 时间戳变了但内容没动 —— 说一句就好，不用拦人（这是同步盘的日常）
    if (fp.meta_only > 0 && !hidden) {
      return (
        <div className="fp-note faint fs-xs">
          有 {fp.meta_only} 个文件的时间戳变了，但内容与记录一致（复制/同步盘常见），无需处理。
        </div>
      )
    }
    return null
  }

  const take = async () => {
    setBusy(true)
    try {
      await api.refreshFingerprint(bookId)
      notify('ok', '已按磁盘现状更新记录')
      setFp(await api.getFingerprint(bookId))
    } catch (e) {
      notify('err', `更新记录失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="board__alert board__alert--warn" role="status">
      <div className="board__alert-main">
        <b>检测到 {fp.content_changed} 个文件在工具外被改动过</b>
        <span className="faint fs-xs">
          档案与正文是 Markdown，你随时可以用别的编辑器改 —— 这没问题。
          改动发生在「上次记录」（{fp.stored_at || '未知时间'}）之后，所以<b>界面上显示的可能还是旧内容</b>。
          正文与档案一个字都不会被动。
        </span>
        <ul className="fp-list">
          {fp.changed
            .filter((c) => c.content_changed)
            .slice(0, 6)
            .map((c) => (
              <li key={c.path} className="fp-list__row">
                <span className="chip">{KIND_LABEL[c.kind] ?? c.kind}</span>
                <span className="mono fs-xs fp-list__path">{c.path}</span>
              </li>
            ))}
          {fp.truncated || fp.content_changed > 6 ? (
            <li className="faint fs-xs">…共 {fp.content_changed} 个</li>
          ) : null}
        </ul>
      </div>
      <div className="board__alert-act">
        <button className="board__alert-btn" onClick={onRebuild} disabled={rebuilding}>
          {rebuilding ? '重扫中…' : '重新扫描（重建索引）'}
        </button>
        <button className="board__alert-btn" onClick={() => void take()} disabled={busy}>
          {busy ? '处理中…' : '按现状接受'}
        </button>
        <button
          className="board__alert-btn board__alert-btn--quiet"
          onClick={() => setDismissed((s) => new Set(s).add(bookId))}
          disabled={busy}
        >
          先不管
        </button>
      </div>
    </div>
  )
}
