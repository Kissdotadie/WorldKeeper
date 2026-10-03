/** 实体界面的侧栏：类型树 + 标签筛选。只在「实体」界面出现。 */

import { useMemo, useState } from 'react'
import { useApp } from '../state/store'
import { groupByType } from '../lib/format'

/** 侧栏是「快速跳转」，不是第二份完整清单 —— 每组只铺这么多。
 *  库里四百条实体的话，全铺出来就是四百个按钮，右侧表格再铺四百行，
 *  两倍的开销换不来什么：剩下的大可去右侧搜索。 */
const PER_GROUP = 40

export function Sidebar() {
  const {
    entities, stats, tags, types,
    typeFilter, setTypeFilter, tagFilter, setTagFilter, selectedId, select,
  } = useApp()

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const grouped = useMemo(() => groupByType(entities), [entities])
  const hasFilter = Boolean(typeFilter || tagFilter)

  return (
    <aside className="sidebar">
      <div className="sidebar__scroll">
        <div className="row" style={{ padding: '0 var(--p-space-3) 6px' }}>
          <span className="field__label">按类型</span>
          <div className="grow" />
          {hasFilter && (
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setTypeFilter(null)
                setTagFilter(null)
              }}
            >
              清除筛选
            </button>
          )}
        </div>

        <ul className="tree">
          {types.map((t) => {
            const items = grouped.get(t.key) ?? []
            const count = stats?.by_type[t.key] ?? items.length
            const open = !collapsed[t.key]
            return (
              <li key={t.key} data-entity-type={t.key}>
                <button
                  className="tree__group"
                  onClick={() => setCollapsed((c) => ({ ...c, [t.key]: open }))}
                  aria-expanded={open}
                >
                  <span className={`tree__caret ${open ? 'tree__caret--open' : ''}`}>▶</span>
                  <span className="dot" />
                  <span>{t.label}</span>
                  <span className="tree__group-count">{count}</span>
                </button>
                {open && (
                  <ul className="tree">
                    {items.length === 0 && (
                      <li className="fs-xs faint" style={{ padding: '2px 0 2px 43px' }}>
                        暂无
                      </li>
                    )}
                    {items.slice(0, PER_GROUP).map((e) => (
                      <li key={e.id}>
                        <button
                          className={`tree__item ${selectedId === e.id ? 'tree__item--active' : ''}`}
                          onClick={() => select(e.id)}
                          title={e.summary ?? ''}
                        >
                          <span className="ellipsis">{e.name}</span>
                        </button>
                      </li>
                    ))}
                    {items.length > PER_GROUP && (
                      <li>
                        <button
                          className="tree__item faint"
                          onClick={() => {
                            setTypeFilter(t.key)
                            setTagFilter(null)
                          }}
                          title="侧栏只铺前 40 条，点这里把这一类筛到右侧列表看全"
                        >
                          <span className="ellipsis">还有 {items.length - PER_GROUP} 条 · 只看这一类</span>
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>

        {tags.length > 0 && (
          <>
            <hr className="hr" style={{ margin: 'var(--p-space-3) var(--p-space-3)' }} />
            <div className="field__label" style={{ padding: '0 var(--p-space-3) 6px' }}>
              按标签
            </div>
            <div
              className="row row--wrap"
              style={{ padding: '0 var(--p-space-3) var(--p-space-4)' }}
            >
              {tags.map((tag) => (
                <button
                  key={tag}
                  className={`chip ${tagFilter === tag ? 'chip--accent' : ''}`}
                  style={{ cursor: 'pointer', border: 0 }}
                  onClick={() => {
                    setTagFilter(tagFilter === tag ? null : tag)
                    setTypeFilter(null)
                  }}
                >
                  {tag}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
