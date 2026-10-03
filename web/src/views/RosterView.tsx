/**
 * 名册录（独立界面）。
 *
 * 不只为人物 —— 换个类型它就是地点志、势力志。
 * 自录场景最容易出的问题是「录了一堆名字，再也没补过」，
 * 所以这里每条都带一个**完备度**：缺摘要 / 缺标签 / 缺关联，一眼能找出来。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api/client'
import type { RosterData, RosterItem, TypeOption } from '../api/types'
import { useApp } from '../state/store'
import { useActions } from '../shell/panels'
import { Panel } from '../components/Panel'
import { StateGate } from '../components/Toast'
import { Highlight, spansOf, termsOf } from '../components/Highlight'
import { stripLinks } from '../lib/format'
import { useVirtualBlocks } from '../lib/useVirtualBlocks'

type GroupBy = 'none' | 'tag' | 'faction'
type Mode = 'cards' | 'table'

export function RosterView() {
  const { bookId, types, openEntity, query, setView, dataVersion, requestView } = useApp()
  const { onNewEntity } = useActions()
  const [type, setType] = useState('character')
  const [groupBy, setGroupBy] = useState<GroupBy>('none')
  const [mode, setMode] = useState<Mode>('cards')
  const [onlyIncomplete, setOnlyIncomplete] = useState(false)

  const [data, setData] = useState<RosterData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!bookId) return
    let alive = true
    setLoading(true)
    setError(null)
    api
      .getRoster(bookId, type, groupBy)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [bookId, type, groupBy, dataVersion])

  // 与后端 store._terms 同一口径：空白分词、词间 AND（以前拿整串当子串找，
  // 搜两个词就永远空手，而手机端同一个词却能搜到）
  const terms = useMemo(() => termsOf(query), [query])

  const items = useMemo(() => {
    let list = data?.items ?? []
    if (onlyIncomplete) list = list.filter((i) => i.completeness < 4)
    if (terms.length) {
      list = list.filter((i) => {
        const hay = [i.name, i.summary ?? '', ...i.aliases, ...i.tags].join('\n').toLowerCase()
        return terms.every((t) => hay.includes(t.toLowerCase()))
      })
    }
    return list
  }, [data, onlyIncomplete, terms])

  const byId = useMemo(() => new Map((data?.items ?? []).map((i) => [i.id, i])), [data])

  /** 分成「分组视图」与「平铺视图」两种渲染结构 */
  const groups: { name: string; items: RosterItem[] }[] = useMemo(() => {
    if (groupBy === 'none' || !data) return [{ name: '', items }]
    const ids = new Set(items.map((i) => i.id))
    const out: { name: string; items: RosterItem[] }[] = []
    for (const [name, memberIds] of Object.entries(data.groups)) {
      const list = memberIds.filter((id) => ids.has(id)).map((id) => byId.get(id)!).filter(Boolean)
      if (list.length) out.push({ name, items: list })
    }
    return out.length ? out : [{ name: '', items }]
  }, [groupBy, data, items, byId])

  const incomplete = (data?.items ?? []).filter((i) => i.completeness < 4).length

  // ---------------------------------------------------------------- 虚拟滚动（P11-B3）
  // 卡片流是**动态高度**那一档：一行几张卡由容器宽度决定、卡片高度随内容变，
  // 所以不能像表格那样「行数 × 行高」一除了事。这里把内容摊成
  // 「分组头 / 卡片行」两种块，**逐块**量自己的高度（见 useVirtualBlocks 头注释：
  // 按 kind 量一次的版本因为各行高矮不一被打回去了），只渲染视口里的那一段。
  const cardsRef = useRef<HTMLDivElement | null>(null)
  /** 一行几张卡。从**真实渲染出来的栅格**量列数，保证和 CSS 的 auto-fill 完全一致 */
  const [cols, setCols] = useState(3)

  type VBlock = { kind: 'head' | 'row'; name?: string; count?: number; items: RosterItem[]; key: string }
  const blocks = useMemo<VBlock[]>(() => {
    if (mode !== 'cards') return []
    const out: VBlock[] = []
    const n = Math.max(1, cols)
    for (const g of groups) {
      if (g.name) out.push({ kind: 'head', name: g.name, count: g.items.length, items: [], key: `h:${g.name}` })
      for (let i = 0; i < g.items.length; i += n) {
        out.push({
          kind: 'row',
          items: g.items.slice(i, i + n),
          // key 用「组名 + 行首条目的实体 id」：同数据下稳定，换列数/筛选后自然换新
          key: `r:${g.name || '_'}:${g.items[i]?.id ?? i}`,
        })
      }
    }
    return out
  }, [mode, groups, cols])

  const vw = useVirtualBlocks(cardsRef, blocks, {
    // 没量到之前的估高。给得接近真实值，第一帧的滚动条就不会跳。
    estimate: { head: 46, row: 150 },
  })
  const visibleBlocks = blocks.slice(vw.first, vw.last)

  // 列数跟着已渲染的栅格走：窗口换了一批块就重新读一次 gridTemplateColumns。
  // 列数稳住之后 setCols 原值返回，不再引发渲染。
  useEffect(() => {
    const g = cardsRef.current?.querySelector('.roster__grid')
    if (!g) return
    const n = getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean).length
    if (n > 0) setCols((c) => (c === n ? c : n))
  }, [vw.first, vw.last, blocks])

  return (
    <div className="roster">
      <Panel
        title={`${data?.type_label ?? '实体'}名册`}
        actions={
          <>
            <select
              className="select"
              style={{ width: 'auto', minHeight: 'var(--control-h-sm)' }}
              value={type}
              onChange={(e) => setType(e.target.value)}
              aria-label="名册类型"
            >
              {types.map((t: TypeOption) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
            <label className="fs-xs muted row" style={{ gap: 4 }}>
              分组
              <select
                className="select"
                style={{ width: 'auto', minHeight: 'var(--control-h-sm)' }}
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value as GroupBy)}
              >
                <option value="none">不分组</option>
                <option value="faction">按势力</option>
                <option value="tag">按标签</option>
              </select>
            </label>
            <label className="row fs-xs muted" style={{ gap: 4, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={onlyIncomplete}
                onChange={(e) => setOnlyIncomplete(e.target.checked)}
              />
              只看待补全
            </label>
            <div className="seg">
              <button className={`seg__item ${mode === 'cards' ? 'seg__item--on' : ''}`} onClick={() => setMode('cards')}>
                名册
              </button>
              <button className={`seg__item ${mode === 'table' ? 'seg__item--on' : ''}`} onClick={() => setMode('table')}>
                表格
              </button>
            </div>
            <button
              className="btn btn--primary btn--sm"
              onClick={() => onNewEntity(type)}
              title={`新建一条${data?.type_label ?? ''}，表单会预选当前类型`}
            >
              ＋ 新建
            </button>
          </>
        }
      >
        <StateGate
          loading={loading}
          error={error}
          empty={items.length === 0}
          emptyTitle={onlyIncomplete ? '没有待补全的条目' : '这本名册还是空的'}
          emptyHint={
            onlyIncomplete
              ? '这一类的条目都登记得挺完整。'
              : `还没有「${data?.type_label ?? ''}」类的实体。成批的从「正文 → 导入」进来跑抽取，零星的点右上角新建。`
          }
          emptyAction={
            onlyIncomplete ? undefined : (
              <>
                <button className="btn btn--primary btn--sm" onClick={() => onNewEntity(type)}>
                  ＋ 手录一条
                </button>
                <button className="btn btn--sm" onClick={() => requestView('text', 'text:import')}>
                  去「正文」导入章节 →
                </button>
              </>
            )
          }
        >
          {data && (
            <>
              <div className="row row--wrap" style={{ marginBottom: 'var(--p-space-3)' }}>
                <span className="chip">{items.length} 条</span>
                <span className="chip">平均完备度 {data.average_completeness} / 4</span>
                {incomplete > 0 && (
                  <button
                    className="chip"
                    style={{ border: 0, cursor: 'pointer', color: 'var(--warn)' }}
                    onClick={() => setOnlyIncomplete(true)}
                  >
                    {incomplete} 条待补全
                  </button>
                )}
                <div className="grow" />
                <span className="faint fs-xs">
                  完备度 = 有摘要 + 有标签 +（有别名或出场记录）+ 有关系
                </span>
              </div>

              {/* 卡片流走虚拟化：整串内容摊成块、只渲染视口里的那一段。
                  注意它必须在 groups.map **外面** —— 卡片流的分块里已经按组
                  拆好了（见上面的 blocks），再嵌进每组循环就会每组渲染一遍整串。 */}
              {mode === 'cards' ? (
                <div ref={cardsRef}>
                  {/* 上下各垫一块空 div 撑出真实滚动高度 —— 视口外一张卡都不渲染 */}
                  <div style={{ height: vw.padTop }} aria-hidden />
                  {visibleBlocks.map((b) =>
                    b.kind === 'head' ? (
                      <div
                        key={b.key}
                        className="row roster__vhead"
                        ref={vw.refFor(b.key)}
                        style={{ marginTop: 'var(--p-space-5)', marginBottom: 'var(--p-space-2)' }}
                      >
                        <h3 className="fs-sm">{b.name}</h3>
                        <span className="faint fs-xs">{b.count}</span>
                      </div>
                    ) : (
                      <div key={b.key} className="roster__grid" ref={vw.refFor(b.key)}>
                        {b.items.map((it) => (
                          <RosterCard key={it.id} item={it} onOpen={() => openEntity(it.id)} terms={terms} />
                        ))}
                      </div>
                    ),
                  )}
                  <div style={{ height: vw.padBottom }} aria-hidden />
                </div>
              ) : (
                /* 表格分支才按组循环（表格行数有限，不必虚拟化 ——
                   定高窗口化那档已经在 EntityTable 里做过了） */
                groups.map((g) => (
                  <section key={g.name || '_all'} style={{ marginBottom: 'var(--p-space-5)' }}>
                    {g.name && (
                      <div className="row" style={{ marginBottom: 'var(--p-space-2)' }}>
                        <h3 className="fs-sm">{g.name}</h3>
                        <span className="faint fs-xs">{g.items.length}</span>
                      </div>
                    )}
                    <div className="table-wrap">
                      <table className="etable">
                        <thead>
                          <tr>
                            <th style={{ width: '150px' }}>名称</th>
                            <th style={{ width: '150px' }}>别名</th>
                            <th style={{ width: '150px' }}>标签</th>
                            <th style={{ width: '80px' }}>首现</th>
                            <th style={{ width: '80px' }}>状态</th>
                            <th style={{ width: '70px' }}>出场</th>
                            <th style={{ width: '70px' }}>关系</th>
                            <th style={{ width: '90px' }}>完备度</th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.items.map((it) => (
                            <tr key={it.id} data-entity-type={it.type} onClick={() => openEntity(it.id)}>
                              <td className="etable__name">
                                {it.icon && <img className="etable__thumb" src={api.assetUrlOf(it.icon)} alt="" />}
                                <Highlight text={it.name} spans={spansOf(it.name, terms)} />
                              </td>
                              <td className="muted fs-sm">{it.aliases.join('、') || <span className="faint">—</span>}</td>
                              <td className="muted fs-sm">{it.tags.join('、') || <span className="faint">—</span>}</td>
                              <td className="faint fs-xs">{it.first_appear || '—'}</td>
                              <td className="fs-sm">{it.status || <span className="faint">—</span>}</td>
                              <td className="mono fs-xs">{it.appearance_count}</td>
                              <td className="mono fs-xs">{it.relation_count}</td>
                              <td>
                                <ScoreBar score={it.completeness} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                ))
              )}

              <p className="faint fs-xs">
                想把名册换成别的类型？左上角下拉切一下，地点、势力、物品都是同一套逻辑。
                名册只读；要改内容去实体详情里改。
                <button className="btn btn--ghost btn--sm" style={{ marginLeft: 6 }} onClick={() => setView('entities')}>
                  去实体界面 →
                </button>
              </p>
            </>
          )}
        </StateGate>
      </Panel>
    </div>
  )
}

function RosterCard({ item, onOpen, terms = [] }: { item: RosterItem; onOpen: () => void; terms?: string[] }) {
  return (
    <article className="rcard" data-entity-type={item.type} onClick={onOpen} tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen() }}>
      {/* 有图的实体给卡片一层「快照背景」—— 极低透明度，不抢文字的可读性 */}
      {item.icon && (
        <div
          className="rcard__bg"
          style={{ backgroundImage: `url(${api.assetUrlOf(item.icon)})` }}
          aria-hidden
        />
      )}
      <div className="rcard__head">
        {item.icon && <img className="rcard__avatar" src={api.assetUrlOf(item.icon)} alt="" />}
        <span className="rcard__name">
          <Highlight text={item.name} spans={spansOf(item.name, terms)} />
        </span>
        <ScoreBar score={item.completeness} />
      </div>

      {item.aliases.length > 0 && (
        <div className="faint fs-xs">又称 {item.aliases.join('、')}</div>
      )}

      <div className="rcard__summary">
        {item.summary ? (
          /* stripLinks 会删字符 → 区间要在处理后的字符串上重算 */
          <Highlight text={stripLinks(item.summary)} spans={spansOf(stripLinks(item.summary), terms)} />
        ) : (
          <span className="faint">还没有摘要</span>
        )}
      </div>

      <div className="rcard__foot">
        {item.first_appear && <span className="chip">首现 {item.first_appear}</span>}
        {item.status && <span className="chip">{item.status}</span>}
        {item.appearance_count > 0 && <span className="chip">出场 {item.appearance_count}</span>}
        {item.relation_count > 0 && <span className="chip">关系 {item.relation_count}</span>}
        {item.tags.slice(0, 2).map((t) => (
          <span key={t} className="chip chip--accent">#{t}</span>
        ))}
      </div>
    </article>
  )
}

function ScoreBar({ score }: { score: number }) {
  return (
    <span className="score" title={`完备度 ${score} / 4`}>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={`score__pip ${i < score ? 'score__pip--on' : ''} ${
            score <= 1 ? 'score__pip--low' : score === 2 ? 'score__pip--mid' : ''
          }`}
        />
      ))}
    </span>
  )
}

export default RosterView
