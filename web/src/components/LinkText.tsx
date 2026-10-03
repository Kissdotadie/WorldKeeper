/**
 * 把文本里 `[[双链]]` 渲染成可点的小片段。
 *
 * 这是「出处永不丢失」在界面上的最直接体现 ——
 * 你在纪年表里写 `[[裴渊]]`，点一下就能跳到那份档案；没录的名字也点得动，
 * 会告诉你「它还没录入」并把它填进搜索框，而不是让你自己去猜。
 */

import { useMemo } from 'react'
import { useApp } from '../state/store'

export function LinkText({ text, className = '' }: { text: string; className?: string }) {
  const { entities, openEntity, notify, setQuery, setView } = useApp()

  const byName = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of entities) {
      m.set(e.name, e.id)
      for (const a of e.aliases ?? []) m.set(a, e.id)
    }
    return m
  }, [entities])

  const parts = useMemo(() => {
    const out: { text: string; link: boolean }[] = []
    const re = /\[\[([^[\]]+)\]\]/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ text: text.slice(last, m.index), link: false })
      const name = m[1].trim()
      if (name) out.push({ text: name, link: true })
      last = m.index + m[0].length
    }
    if (last < text.length) out.push({ text: text.slice(last), link: false })
    return out
  }, [text])

  if (!text) return null

  return (
    <span className={className}>
      {parts.map((p, i) =>
        p.link ? (
          <button
            key={i}
            type="button"
            className={`ref ${byName.has(p.text) ? '' : 'ref--missing'}`}
            title={byName.has(p.text) ? `打开「${p.text}」` : `「${p.text}」还没录入`}
            onClick={(e) => {
              e.stopPropagation()
              const id = byName.get(p.text)
              if (id) {
                openEntity(id)
              } else {
                notify('info', `「${p.text}」还没录入，已填进搜索框`)
                setQuery(p.text)
                setView('entities')
              }
            }}
          >
            {p.text}
          </button>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </span>
  )
}

export default LinkText
