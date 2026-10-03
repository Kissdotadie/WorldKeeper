/** 实体浏览：筛选条 + 卡片/表格两种视图 + 分组卡片区。
 *
 * 两条性能约束（库里 400+ 条实体时才看得出来）：
 * 1. 筛选条常驻不滚 —— 滚动下放给 `.egrid__body`，顺便给表格的窗口化一个确定高度的滚动口；
 * 2. 卡片不是一次全铺 —— 卡片高度参差，窗口化容易错位，所以走「渐进加载」：
 *    先给 CARD_PAGE 张，滚到底再追加。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../state/store'
import { EntityCard } from './EntityCard'
import { EntityTable } from './EntityTable'
import { StateGate } from './Toast'
import { termsOf } from './Highlight'
import { groupByType } from '../lib/format'
import type { EntityMeta, TypeOption } from '../api/types'

type Sort = 'name' | 'updated' | 'type'
type Mode = 'cards' | 'table'

const MODE_KEY = 'wkv.entityMode'
/** 卡片视图一次给多少张 */
const CARD_PAGE = 60

export function EntityGrid() {
  const {
    entities, types, loading, selectedId, select,
    typeFilter, setTypeFilter, tagFilter, setTagFilter, query, setQuery,
  } = useApp()
  const [sort, setSort] = useState<Sort>('name')
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem(MODE_KEY) as Mode) || 'table')
  const [budget, setBudget] = useState(CARD_PAGE)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  // 与后端 store._terms 同一口径：空白分词、词间 AND。
  // 以前这里拿整串当子串找，于是搜「裴渊 韦崇」（两个词）在桌面端永远空手，
  // 而同一个词在手机端却能搜到 —— 同一次输入两处答案不同，最费解。
  const terms = useMemo(() => termsOf(query), [query])

  const visible = useMemo(() => {
    let out = entities
    if (typeFilter) out = out.filter((e) => e.type === typeFilter)
    if (tagFilter) out = out.filter((e) => e.tags?.includes(tagFilter))
    if (terms.length) {
      out = out.filter((e) => {
        const hay = [
          e.name,
          e.summary ?? '',
          ...(e.aliases ?? []),
          ...(e.tags ?? []),
        ].join('\n').toLowerCase()
        return terms.every((t) => hay.includes(t.toLowerCase()))
      })
    }
    const byName = (a: EntityMeta, b: EntityMeta) => a.name.localeCompare(b.name, 'zh-Hans-CN')
    return [...out].sort((a, b) => {
      if (sort === 'updated') return (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
      if (sort === 'type') return a.type.localeCompare(b.type) || byName(a, b)
      return byName(a, b)
    })
  }, [entities, typeFilter, tagFilter, query, sort])

  const grouped = useMemo(() => groupByType(visible), [visible])
  const labelOf = (key: string) => types.find((t: TypeOption) => t.key === key)?.label ?? key
  const filtered = Boolean(typeFilter || tagFilter || query.trim())

  // 筛选 / 排序一变就回到顶部、回到第一页
  // （否则会停在一个已经没有内容的滚动位置，看着像「筛没了」）
  useEffect(() => {
    setBudget(CARD_PAGE)
    bodyRef.current?.scrollTo({ top: 0 })
  }, [typeFilter, tagFilter, query, sort, mode])

  // 滚到底自动追加：哨兵进入视口就多给一页
  useEffect(() => {
    const el = sentinelRef.current
    const root = bodyRef.current
    if (!el || !root) return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setBudget((b) => (b >= visible.length ? b : b + CARD_PAGE))
      },
      { root, rootMargin: '300px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [visible.length, budget, mode])

  /** 分组视图里每个类型该渲染多少张（按类型顺序依次装填预算） */
  const sliced = useMemo(() => {
    const m = new Map<string, { show: EntityMeta[]; rest: number }>()
    let left = budget
    for (const t of types) {
      const items = grouped.get(t.key)
      if (!items?.length) continue
      const take = Math.max(0, Math.min(items.length, left))
      left -= take
      m.set(t.key, { show: items.slice(0, take), rest: items.length - take })
    }
    return m
  }, [grouped, types, budget])

  const switchMode = (m: Mode) => {
    setMode(m)
    try { localStorage.setItem(MODE_KEY, m) } catch { /* 隐私模式下写不了，忽略 */ }
  }

  const cardOf = (e: EntityMeta, label: string) => (
    <EntityCard key={e.id} entity={e} active={selectedId === e.id} label={label} onOpen={select} terms={terms} />
  )

  const flat = visible.slice(0, budget)
  const remaining = visible.length - Math.min(budget, visible.length)

  return (
    <div className="egrid">
      {/* ---- 筛选条（常驻） ---- */}
      <div className="row row--wrap" style={{ marginBottom: 'var(--p-space-3)' }}>
        <button
          className={`chip ${!typeFilter ? 'chip--accent' : ''}`}
          style={{ cursor: 'pointer', border: 0 }}
          onClick={() => setTypeFilter(null)}
        >
          全部 {entities.length}
        </button>
        {types.map((t: TypeOption) => {
          const n = entities.filter((e) => e.type === t.key).length
          if (!n) return null
          return (
            <button
              key={t.key}
              data-entity-type={t.key}
              className={`chip chip--type ${typeFilter === t.key ? 'chip--accent' : ''}`}
              style={{ cursor: 'pointer', border: 0 }}
              onClick={() => setTypeFilter(typeFilter === t.key ? null : t.key)}
            >
              <span className="chip__dot" />
              {t.label} {n}
            </button>
          )
        })}

        <div className="grow" />

        {tagFilter && (
          <button className="chip chip--accent" style={{ border: 0, cursor: 'pointer' }}
            onClick={() => setTagFilter(null)}>
            标签：{tagFilter} ✕
          </button>
        )}
        {query.trim() && (
          <button className="chip" style={{ border: 0, cursor: 'pointer' }} onClick={() => setQuery('')}>
            搜索：{query} ✕
          </button>
        )}

        <label className="fs-xs muted row" style={{ gap: 4 }}>
          排序
          <select
            className="select"
            style={{ width: 'auto', minHeight: 'var(--control-h-sm)' }}
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
          >
            <option value="name">名称</option>
            <option value="updated">最近改动</option>
            <option value="type">类型</option>
          </select>
        </label>

        <div className="seg" role="tablist" aria-label="视图切换">
          <button
            className={`seg__item ${mode === 'table' ? 'seg__item--on' : ''}`}
            onClick={() => switchMode('table')}
            title="表格：一屏看全，适合对照"
          >
            ▤ 表格
          </button>
          <button
            className={`seg__item ${mode === 'cards' ? 'seg__item--on' : ''}`}
            onClick={() => switchMode('cards')}
            title="卡片：大块展示摘要"
          >
            ▦ 卡片
          </button>
        </div>
      </div>

      {/* 录入指引常驻显示 —— 之前只写在空态里，库一满就永远看不到了 */}
      {visible.length > 0 && (
        <div className="entry-hint" style={{ flex: 'none' }}>
          <span className="faint fs-xs">
            想补录或新增？右上角「＋ 新建实体」逐条录；批量贴设定表去左侧「导入」，先过清单再落盘。
          </span>
        </div>
      )}

      {/* ---- 内容区（唯一滚动口） ---- */}
      <div className="egrid__body" ref={bodyRef}>
        <StateGate
          loading={loading}
          empty={visible.length === 0}
          emptyTitle={filtered ? '没有符合条件的实体' : '这本书还没有实体'}
          emptyHint={
            filtered
              ? '换个关键词，或者点上面的「全部」清除筛选。'
              : '左侧「导入」界面把设定表整段贴进来，一次录入一批；也可以右上角「新建实体」逐条来。'
          }
        >
          {mode === 'table' ? (
            <EntityTable items={visible} scrollRef={bodyRef} />
          ) : filtered && !typeFilter ? (
            <div className="cards">{flat.map((e) => cardOf(e, labelOf(e.type)))}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--p-space-5)' }}>
              {types.map((t: TypeOption) => {
                const bucket = sliced.get(t.key)
                if (!bucket || (!bucket.show.length && !bucket.rest)) return null
                return (
                  <section key={t.key} data-entity-type={t.key}>
                    <div className="row" style={{ marginBottom: 'var(--p-space-2)' }}>
                      <span className="dot" />
                      <h3 className="fs-sm">{t.label}</h3>
                      <span className="faint fs-xs">{grouped.get(t.key)?.length ?? 0}</span>
                      {bucket.rest > 0 && (
                        <button
                          className="chip"
                          style={{ border: 0, cursor: 'pointer' }}
                          onClick={() => setBudget((b) => b + bucket.rest)}
                        >
                          还有 {bucket.rest} 条 · 展开
                        </button>
                      )}
                    </div>
                    <div className="cards">{bucket.show.map((e) => cardOf(e, t.label))}</div>
                  </section>
                )
              })}
            </div>
          )}
          {mode === 'cards' && remaining > 0 && (
            <div className="egrid__more faint fs-xs" ref={sentinelRef}>
              下滑继续加载 · 还有 {remaining} 条
            </div>
          )}
        </StateGate>
      </div>
    </div>
  )
}
