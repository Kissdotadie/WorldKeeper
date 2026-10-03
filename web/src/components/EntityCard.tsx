import type { EntityMeta } from '../api/types'
import { Highlight, spansOf } from './Highlight'
import { stripLinks } from '../lib/format'

interface Props {
  entity: EntityMeta
  active: boolean
  label: string
  onOpen: (id: string) => void
  /** 搜索词（已切好词）。给了就把命中的地方标出来 —— 「哪些卡片是我要找的」一眼可辨。 */
  terms?: string[]
}

export function EntityCard({ entity, active, label, onOpen, terms }: Props) {
  return (
    <article
      className={`card ${active ? 'card--active' : ''}`}
      data-entity-type={entity.type}
      onClick={() => onOpen(entity.id)}
      tabIndex={0}
      role="button"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(entity.id)
        }
      }}
    >
      <div className="row">
        <span className="chip chip--type">
          <span className="chip__dot" />
          {label}
        </span>
        <div className="grow" />
        <span className="faint fs-xs mono">{entity.id}</span>
      </div>

      <div className="card__name">
        <Highlight text={entity.name} spans={spansOf(entity.name, terms ?? [])} />
      </div>

      <div className="card__summary">
        {entity.summary ? (
          /* stripLinks 会删字符 → 区间要在处理后的字符串上重算 */
          <Highlight text={stripLinks(entity.summary)} spans={spansOf(stripLinks(entity.summary), terms ?? [])} />
        ) : (
          <span className="faint">暂无摘要</span>
        )}
      </div>

      <div className="card__foot">
        {entity.tags?.slice(0, 3).map((t) => (
          <span key={t} className="chip">#{t}</span>
        ))}
        {entity.first_appear && <span className="chip">首现 · {entity.first_appear}</span>}
        {entity.status && <span className="chip">{entity.status}</span>}
      </div>
    </article>
  )
}
