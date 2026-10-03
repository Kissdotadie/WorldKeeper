/** 表格视图：一眼扫全的清单形态，和卡片并排供切换。
 *
 * 行是「窗口化」渲染的 —— 库里几百条实体时，全量铺 DOM 会让整页滚动掉帧。
 * 这里只渲染视口内的行，上下各垫一个空行撑出滚动高度（见 lib/useVirtualWindow）。
 * 代价是行必须等高，所以这一版把摘要压成了单行。
 */

import { useCallback, useMemo, useState } from 'react'
import { useApp } from '../state/store'
import { useVirtualWindow } from '../lib/useVirtualWindow'
import { Highlight, spansOf, termsOf } from './Highlight'
import { stripLinks, shortTime } from '../lib/format'
import { assetUrlOf } from '../api/client'
import type { EntityMeta, TypeOption } from '../api/types'

type Col = 'type' | 'name' | 'aliases' | 'tags' | 'summary' | 'updated'

const COLS: { key: Col; label: string; sortable?: boolean; width?: string }[] = [
  { key: 'type', label: '类型', sortable: true, width: '72px' },
  { key: 'name', label: '名称', sortable: true, width: '160px' },
  { key: 'aliases', label: '别名', width: '150px' },
  { key: 'tags', label: '标签', width: '150px' },
  { key: 'summary', label: '摘要' },
  { key: 'updated', label: '更新', sortable: true, width: '110px' },
]

interface Props {
  items: EntityMeta[]
  /** 外部滚动容器的 ref —— 窗口化要知道「现在滚到哪了」 */
  scrollRef: React.RefObject<HTMLDivElement | null>
}

export function EntityTable({ items, scrollRef }: Props) {
  const { types, selectedId, select, setTagFilter, tagFilter, query } = useApp()
  // 高亮直接用全局搜索框里那个词 —— 这张表本来就是被它筛出来的。
  // 桌面端列表是在内存里筛已加载的实体（千条量级、即时反馈），
  // 所以高亮也就地算，不走接口。
  const terms = useMemo(() => termsOf(query), [query])
  const [sortKey, setSortKey] = useState<Col>('name')
  const [asc, setAsc] = useState(true)
  // 行高由真实渲染出来的第一行量出来 —— 这样改字号、改字体也自动跟上
  const [rowH, setRowH] = useState(34)

  const labelOf = (key: string) => types.find((t: TypeOption) => t.key === key)?.label ?? key

  const sorted = useMemo(() => {
    const dir = asc ? 1 : -1
    return [...items].sort((a, b) => {
      if (sortKey === 'updated') return dir * (a.updated_at ?? '').localeCompare(b.updated_at ?? '')
      if (sortKey === 'type') return dir * (a.type.localeCompare(b.type) || a.name.localeCompare(b.name, 'zh-Hans-CN'))
      return dir * a.name.localeCompare(b.name, 'zh-Hans-CN')
    })
  }, [items, sortKey, asc])

  const { first, last, padTop, padBottom } = useVirtualWindow(scrollRef, sorted.length, rowH)
  const slice = sorted.slice(first, last)

  // 量第一行：元素被复用时不回调，只有真换了才会再量 —— 幂等，不会抖动
  const measureRef = useCallback((el: HTMLTableRowElement | null) => {
    if (!el) return
    const h = Math.round(el.getBoundingClientRect().height)
    if (h > 0) setRowH((cur) => (Math.abs(cur - h) > 1 ? h : cur))
  }, [])

  const toggleSort = (key: Col) => {
    if (sortKey === key) setAsc(!asc)
    else {
      setSortKey(key)
      setAsc(true)
    }
  }

  const label = (e: EntityMeta) => (
    <>
      <td data-entity-type={e.type}>
        <span className="chip chip--type" style={{ height: 18, fontSize: 'var(--fs-xs)' }}>
          <span className="chip__dot" />
          {labelOf(e.type)}
        </span>
      </td>
      <td className="etable__name">
        {e.icon && <img className="etable__thumb" src={assetUrlOf(e.icon)} alt="" />}
        <Highlight text={e.name} spans={spansOf(e.name, terms)} />
        {e.first_appear && <span className="faint fs-xs" style={{ marginLeft: 6 }}>{e.first_appear}</span>}
      </td>
      <td className="muted fs-sm etable__tcell">
        {e.aliases?.length ? e.aliases.join('、') : <span className="faint">—</span>}
      </td>
      <td>
        {e.tags?.length ? (
          <span className="row" style={{ gap: 4, flexWrap: 'nowrap', overflow: 'hidden' }}>
            {e.tags.slice(0, 3).map((t) => (
              <button
                key={t}
                className={`chip ${tagFilter === t ? 'chip--accent' : ''}`}
                style={{ height: 18, fontSize: 'var(--fs-xs)', cursor: 'pointer', border: 0, flex: 'none' }}
                onClick={(ev) => {
                  ev.stopPropagation()
                  setTagFilter(tagFilter === t ? null : t)
                }}
              >
                {t}
              </button>
            ))}
            {e.tags.length > 3 && <span className="faint fs-xs">+{e.tags.length - 3}</span>}
          </span>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td className="muted fs-sm">
        <span className="etable__summary" title={e.summary ? stripLinks(e.summary) : undefined}>
          {e.summary ? (
            /* stripLinks 会删掉 [[ ]] 四个字符，所以区间要在**处理后的字符串**上重算 */
            <Highlight text={stripLinks(e.summary)} spans={spansOf(stripLinks(e.summary), terms)} />
          ) : (
            '—'
          )}
        </span>
      </td>
      <td className="faint fs-xs">{shortTime(e.updated_at)}</td>
    </>
  )

  return (
    <div className="table-wrap">
      <table className="etable">
        <thead>
          <tr>
            {COLS.map((c) => (
              <th
                key={c.key}
                style={c.width ? { width: c.width } : undefined}
                className={c.sortable ? 'etable__th--sort' : ''}
                onClick={c.sortable ? () => toggleSort(c.key) : undefined}
              >
                {c.label}
                {sortKey === c.key && <span className="etable__arrow">{asc ? '▲' : '▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {padTop > 0 && (
            <tr className="etable__spacer" aria-hidden="true">
              <td colSpan={COLS.length} style={{ height: padTop }} />
            </tr>
          )}
          {slice.map((e, i) => (
            <tr
              key={e.id}
              ref={i === 0 ? measureRef : undefined}
              className={selectedId === e.id ? 'etable__tr--active' : ''}
              onClick={() => select(e.id)}
            >
              {label(e)}
            </tr>
          ))}
          {padBottom > 0 && (
            <tr className="etable__spacer" aria-hidden="true">
              <td colSpan={COLS.length} style={{ height: padBottom }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
