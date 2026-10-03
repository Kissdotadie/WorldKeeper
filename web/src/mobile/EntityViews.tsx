/**
 * 移动端：搜索 / 名册 / 实体卡片。
 *
 * 三条硬规矩：
 * 1. **只读** —— 这一层没有任何写操作，落盘审核留在 PC 端
 * 2. **数据层 100% 复用** —— 实体清单直接取 store 里那份（PC 端拉的同一份），
 *    额外数据才走 api 客户端，不另起一套数据通道
 * 3. **不做三维、不做拖拽** —— 手机上这些只会变成卡顿
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api/client'
import type { EntityDetail, SearchHit } from '../api/types'
import { Highlight, spansOf, termsOf } from '../components/Highlight'
import { groupByType, shortTime, stripLinks } from '../lib/format'
import { useApp } from '../state/store'
import { Empty, ErrBox, Loading, SectionTitle, TypeChip, labelerOf, linkify } from './parts'
import { go } from './router'
import { useResource } from './useResource'

// --------------------------------------------------------------------------
// 搜索
// --------------------------------------------------------------------------

/**
 * 搜索历史：**只记「真的搜到并点进去」的词** —— 打了一半又删掉的不算数。
 * 纯界面状态，落 localStorage（与新手引导的 done 标记同一性质，不进偏好文件）。
 */
const HIST_KEY = 'wkv.msearch.history'
const HIST_MAX = 8

function loadHist(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HIST_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').slice(0, HIST_MAX) : []
  } catch {
    return []
  }
}

export function SearchView() {
  const { bookId, entities, stats, types } = useApp()
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const [hist, setHist] = useState<string[]>(loadHist)
  const inputRef = useRef<HTMLInputElement>(null)
  const label = labelerOf(types)
  // 与后端同一口径：空白分词，词间是 AND
  const terms = useMemo(() => termsOf(q), [q])

  /** 记一条历史：去重置顶、截断到上限，同步落 localStorage */
  const rememberTerm = (t: string) => {
    const term = t.trim()
    if (!term) return
    setHist((prev) => {
      const next = [term, ...prev.filter((x) => x !== term)].slice(0, HIST_MAX)
      try {
        localStorage.setItem(HIST_KEY, JSON.stringify(next))
      } catch {
        /* 隐私模式写不了就只留本次会话 */
      }
      return next
    })
  }

  const removeHist = (t: string) => {
    setHist((prev) => {
      const next = prev.filter((x) => x !== t)
      try {
        localStorage.setItem(HIST_KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }

  const clearHist = () => {
    setHist([])
    try {
      localStorage.removeItem(HIST_KEY)
    } catch {
      /* ignore */
    }
  }

  /** 点结果：记历史 + **收起键盘** —— 不收的话实体卡下半截被输入法挡着 */
  const openHit = (id: string) => {
    rememberTerm(q)
    inputRef.current?.blur()
    go({ name: 'entity', id })
  }

  // 防抖 220ms：手机上打字快，每敲一下就发一次请求会白烧流量
  useEffect(() => {
    const term = q.trim()
    if (!bookId || !term) {
      setHits([])
      setBusy(false)
      return
    }
    setBusy(true)
    const timer = window.setTimeout(() => {
      api
        .search(bookId, term, 40)
        .then((r) => setHits(r.items))
        .catch(() => setHits([]))
        .finally(() => setBusy(false))
    }, 220)
    return () => window.clearTimeout(timer)
  }, [q, bookId])

  const recent = useMemo(
    () =>
      [...entities]
        .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
        .slice(0, 12),
    [entities],
  )

  const byType = useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of entities) counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
    return types
      .map((t) => ({ ...t, n: counts.get(t.key) ?? 0 }))
      .filter((t) => t.n > 0)
      .sort((a, b) => b.n - a.n)
  }, [entities, types])

  return (
    <div className="mpane">
      <div className="msearch">
        <span className="msearch__icon">🔍</span>
        <input
          ref={inputRef}
          className="msearch__in"
          type="search"
          value={q}
          placeholder="搜人物、地点、势力、概念……"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            // 手机上回车 = 「我就要搜这个词」：记历史 + 键盘收起，好看着结果翻
            if (e.key === 'Enter') {
              rememberTerm(q)
              inputRef.current?.blur()
            }
          }}
          enterKeyHint="search"
          autoComplete="off"
        />
        {q && (
          <button className="msearch__x" onClick={() => setQ('')} aria-label="清空">
            ✕
          </button>
        )}
      </div>

      {!q.trim() ? (
        <>
          {hist.length > 0 && (
            <>
              <SectionTitle
                right={
                  <button className="msec__clear" onClick={clearHist}>
                    清空
                  </button>
                }
              >
                最近搜索
              </SectionTitle>
              <div className="mchips mchips--wrap">
                {hist.map((t) => (
                  <span key={t} className="mchip mchip--btn mhist" onClick={() => setQ(t)}>
                    🕘 {t}
                    <i
                      className="mhist__x"
                      role="button"
                      aria-label={`删除历史「${t}」`}
                      onClick={(e) => {
                        e.stopPropagation()
                        removeHist(t)
                      }}
                    >
                      ✕
                    </i>
                  </span>
                ))}
              </div>
            </>
          )}
          <div className="mtiles">
            <div className="mtile">
              <b>{stats?.total ?? entities.length}</b>
              <span>实体</span>
            </div>
            <div className="mtile">
              <b>{stats?.relations ?? 0}</b>
              <span>关联</span>
            </div>
            <div className="mtile">
              <b>{byType.length}</b>
              <span>类型</span>
            </div>
          </div>

          {byType.length > 0 && (
            <>
              <SectionTitle>按类型</SectionTitle>
              <div className="mchips">
                {byType.map((t) => (
                  <button
                    key={t.key}
                    className="mchip mchip--btn"
                    data-entity-type={t.key}
                    onClick={() => go({ name: 'roster' })}
                  >
                    <i className="mchip__dot" />
                    {t.label}
                    <em>{t.n}</em>
                  </button>
                ))}
              </div>
            </>
          )}

          <SectionTitle>最近改动</SectionTitle>
          <div className="mlist">
            {recent.map((e) => (
              <button key={e.id} className="mrow" onClick={() => go({ name: 'entity', id: e.id })}>
                <span className="mrow__name" data-entity-type={e.type}>
                  {e.name}
                </span>
                <span className="mrow__meta">
                  {label(e.type)} · {shortTime(e.updated_at)}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : busy && hits.length === 0 ? (
        <Loading />
      ) : hits.length === 0 ? (
        <Empty icon="🫧" title="没搜到" hint="换个词试试，或者去「名册」一页页翻" />
      ) : (
        <>
          <SectionTitle right={`${hits.length} 条`}>搜索结果</SectionTitle>
          <div className="mlist">
            {hits.map((h) => (
              <button
                key={h.id}
                className="mrow"
                onClick={() => openHit(h.id)}
              >
                <div className="mrow__head">
                  <span className="mrow__name" data-entity-type={h.type}>
                    <Highlight text={h.name} spans={spansOf(h.name, terms)} />
                  </span>
                  <TypeChip type={h.type} label={label(h.type)} />
                </div>
                {h.summary || h.snippet ? (
                  <div className="mrow__sum">
                    {/* 名称里命中了就看名字（高亮已在上面），否则展示片段。
                        片段先过 stripLinks 去掉 [[双链]] 标记 —— 那一步会删字符，
                        所以**不能**再用后端给的 spans（它是相对未处理片段的），
                        必须在最终要显示的字符串上重算一遍区间。 */}
                    {spansOf(h.name, terms).length || !h.snippet ? (
                      stripLinks(h.summary || h.snippet || '')
                    ) : (
                      <Highlight text={stripLinks(h.snippet)} spans={spansOf(stripLinks(h.snippet), terms)} />
                    )}
                  </div>
                ) : null}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------
// 名册
// --------------------------------------------------------------------------

const PAGE = 60

export function RosterView() {
  const { entities, types } = useApp()
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const label = labelerOf(types)

  const tags = useMemo(() => {
    const n = new Map<string, number>()
    for (const e of entities) for (const t of e.tags ?? []) n.set(t, (n.get(t) ?? 0) + 1)
    return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  }, [entities])

  const filtered = useMemo(
    () =>
      entities.filter(
        (e) =>
          (!typeFilter || e.type === typeFilter) &&
          (!tagFilter || (e.tags ?? []).includes(tagFilter)),
      ),
    [entities, typeFilter, tagFilter],
  )

  const groups = useMemo(() => {
    const m = groupByType(filtered)
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [filtered])

  const byType = useMemo(() => {
    const n = new Map<string, number>()
    for (const e of entities) n.set(e.type, (n.get(e.type) ?? 0) + 1)
    return types.map((t) => ({ ...t, n: n.get(t.key) ?? 0 })).filter((t) => t.n > 0)
  }, [entities, types])

  return (
    <div className="mpane">
      <div className="mchips mchips--scroll">
        <button
          className={`mchip mchip--btn ${typeFilter === null ? 'is-on' : ''}`}
          onClick={() => setTypeFilter(null)}
        >
          全部 <em>{entities.length}</em>
        </button>
        {byType.map((t) => (
          <button
            key={t.key}
            className={`mchip mchip--btn ${typeFilter === t.key ? 'is-on' : ''}`}
            data-entity-type={t.key}
            onClick={() => setTypeFilter(typeFilter === t.key ? null : t.key)}
          >
            <i className="mchip__dot" />
            {t.label}
            <em>{t.n}</em>
          </button>
        ))}
      </div>

      {tags.length > 0 && (
        <div className="mchips mchips--scroll">
          {tags.map(([t, n]) => (
            <button
              key={t}
              className={`mchip mchip--btn ${tagFilter === t ? 'is-on' : ''}`}
              onClick={() => setTagFilter(tagFilter === t ? null : t)}
            >
              #{t} <em>{n}</em>
            </button>
          ))}
        </div>
      )}

      {groups.length === 0 ? (
        <Empty icon="📇" title="这个条件下没有实体" />
      ) : (
        groups.map(([type, list]) => {
          const open = expanded[type]
          const shown = open ? list : list.slice(0, PAGE)
          return (
            <section key={type}>
              <SectionTitle right={`${list.length} 条`}>{label(type)}</SectionTitle>
              <div className="mlist">
                {shown.map((e) => (
                  <button
                    key={e.id}
                    className="mrow"
                    onClick={() => go({ name: 'entity', id: e.id })}
                  >
                    <div className="mrow__head">
                      <span className="mrow__name" data-entity-type={e.type}>
                        {e.name}
                      </span>
                      {e.first_appear && <span className="mrow__tag">首现 {e.first_appear}</span>}
                    </div>
                    {e.summary && <div className="mrow__sum">{stripLinks(e.summary)}</div>}
                  </button>
                ))}
                {!open && list.length > PAGE && (
                  <button
                    className="mrow mrow--more"
                    onClick={() => setExpanded((s) => ({ ...s, [type]: true }))}
                  >
                    还有 {list.length - PAGE} 条，点开全部
                  </button>
                )}
              </div>
            </section>
          )
        })
      )}
    </div>
  )
}

// --------------------------------------------------------------------------
// 实体卡片
// --------------------------------------------------------------------------

export function EntityView({ id }: { id: string }) {
  const { bookId, entities, types } = useApp()
  const label = labelerOf(types)
  const res = useResource<EntityDetail>(
    bookId ? `${bookId}:entity:${id}` : null,
    () => api.getEntity(bookId as string, id),
  )

  const idOfName = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of entities) m.set(e.name, e.id)
    return m
  }, [entities])

  const pickName = (name: string) => {
    const target = idOfName.get(name)
    if (target) go({ name: 'entity', id: target })
  }

  if (res.loading && !res.data) return <Loading />
  if (res.error) return <ErrBox text={res.error} onRetry={res.reload} />
  const d = res.data
  if (!d) return <Empty title="找不到这个实体" />

  return (
    <div className="mpane">
      <div className="mcard-top" data-entity-type={d.type}>
        {d.icon && <img className="mcard-icon" src={api.assetUrlOf(d.icon)} alt="" />}
        <div className="mcard-title">
          <h1>{d.name}</h1>
          <div className="mcard-sub">
            <TypeChip type={d.type} label={d.type_label || label(d.type)} />
            {d.status && <span className="mchip">{d.status}</span>}
            {d.first_appear && <span className="mchip">首现 · {d.first_appear}</span>}
          </div>
        </div>
      </div>

      {(d.aliases.length > 0 || d.tags.length > 0 || d.methodologies.length > 0) && (
        <div className="mchips mchips--wrap">
          {d.aliases.map((a) => (
            <span key={`a${a}`} className="mchip mchip--dim">
              别名 · {a}
            </span>
          ))}
          {d.tags.map((t) => (
            <span key={`t${t}`} className="mchip mchip--dim">
              #{t}
            </span>
          ))}
          {d.methodologies.map((m) => (
            <span key={`m${m}`} className="mchip mchip--dim">
              {m}
            </span>
          ))}
        </div>
      )}

      <SectionTitle>摘要</SectionTitle>
      <div className="mtext">
        {d.body.摘要 && d.body.摘要 !== '待补充' ? (
          linkify(d.body.摘要, pickName, 's')
        ) : (
          <span className="faint">还没有摘要</span>
        )}
      </div>

      {d.body.属性.length > 0 && (
        <>
          <SectionTitle>属性</SectionTitle>
          <div className="mkv">
            {d.body.属性.map(([k, v], i) => (
              <div key={`${k}${i}`} className="mkv__row">
                <span className="mkv__k">{k}</span>
                <span className="mkv__v">{stripLinks(v)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {d.appearances.length > 0 && (
        <>
          <SectionTitle right={`${d.appearances.length} 章`}>出场记录</SectionTitle>
          <div className="mlist">
            {d.appearances.map((a, i) => {
              const no = Number(a.chapter)
              return (
                <button
                  key={`${a.chapter}${i}`}
                  className="mrow"
                  disabled={!Number.isFinite(no) || no <= 0}
                  onClick={() => go({ name: 'chapter', no })}
                >
                  <div className="mrow__head">
                    <span className="mrow__name">第 {a.chapter} 章</span>
                    {a.note && <span className="mrow__tag">{a.note}</span>}
                  </div>
                </button>
              )
            })}
          </div>
        </>
      )}

      {d.relations.length > 0 && (
        <>
          <SectionTitle right={`${d.relations.length} 条`}>关联</SectionTitle>
          <div className="mlist">
            {d.relations.map((r, i) => (
              <button
                key={`${r.to_name}${i}`}
                className="mrow"
                onClick={() => {
                  const target = r.to_id ?? idOfName.get(r.to_name)
                  if (target) go({ name: 'entity', id: target })
                }}
              >
                <div className="mrow__head">
                  <span className="mrow__name">{r.to_name}</span>
                  {r.kind && <span className="mrow__tag">{r.kind}</span>}
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {d.body.待补充.length > 0 && (
        <>
          <SectionTitle>待补充</SectionTitle>
          <div className="mtext">
            {d.body.待补充.map((t, i) => (
              <div key={i}>· {stripLinks(t)}</div>
            ))}
          </div>
        </>
      )}

      <SectionTitle>出处</SectionTitle>
      <div className="mtext faint fs-sm">
        <div>录入方式：{d.provenance?.method || '—'}</div>
        {(d.provenance?.sources ?? []).slice(0, 12).map((s, i) => (
          <div key={i}>
            · 第 {s.chapter ?? '?'} 章{s.paragraph ? ` 第 ${s.paragraph} 段` : ''}
            {s.note ? ` —— ${s.note}` : ''}
          </div>
        ))}
        {(d.provenance?.sources?.length ?? 0) === 0 && <div>· 没有记出处</div>}
      </div>

      <div className="mpane__foot">
        <span className="faint fs-xs mono">{d.id}</span>
        <span className="faint fs-xs">更新于 {shortTime(d.updated_at)}</span>
      </div>
    </div>
  )
}
