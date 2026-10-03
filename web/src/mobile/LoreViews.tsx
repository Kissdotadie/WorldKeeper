/**
 * 移动端：时间线 / 伏笔看板 / 章节索引 / 正文只读。
 *
 * 正文这一档纯只读 —— 工具从头到尾不改正文一个字，手机上更没必要给编辑口子。
 */

import { useMemo, useState } from 'react'
import * as api from '../api/client'
import type { ChapterData, ChapterListData, DocData, TimelineData } from '../api/types'
import { useApp } from '../state/store'
import { Empty, ErrBox, Loading, SectionTitle, labelerOf } from './parts'
import { go } from './router'
import { useResource } from './useResource'

const scrollTop = () => window.scrollTo({ top: 0, behavior: 'smooth' })

// --------------------------------------------------------------------------
// 时间线
// --------------------------------------------------------------------------

export function TimelineView() {
  const { bookId, entities, types } = useApp()
  const label = labelerOf(types)
  const [only, setOnly] = useState<string | null>(null)
  const res = useResource<TimelineData>(bookId ? `${bookId}:timeline` : null, () =>
    api.getTimeline(bookId as string),
  )
  const idOfName = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of entities) m.set(e.name, e.id)
    return m
  }, [entities])

  if (res.loading && !res.data) return <Loading />
  if (res.error) return <ErrBox text={res.error} onRetry={res.reload} />
  const d = res.data
  if (!d) return <Empty title="没有时间线数据" />

  const chapters = d.chapters
    .map((c) => ({
      ...c,
      entries: c.entries.filter((e) => !only || e.type === only),
    }))
    .filter((c) => c.entries.length > 0)

  return (
    <div className="mpane">
      <div className="mchips mchips--scroll">
        <button className={`mchip mchip--btn ${!only ? 'is-on' : ''}`} onClick={() => setOnly(null)}>
          全部 <em>{d.entry_count}</em>
        </button>
        {d.types.map((t) => (
          <button
            key={t.key}
            className={`mchip mchip--btn ${only === t.key ? 'is-on' : ''}`}
            data-entity-type={t.key}
            onClick={() => setOnly(only === t.key ? null : t.key)}
          >
            <i className="mchip__dot" />
            {t.label}
          </button>
        ))}
      </div>

      {chapters.length === 0 ? (
        <Empty
          icon="🕰"
          title="这条线还是空的"
          hint="实体的「出场记录」填上章节号，这里就会长出来"
        />
      ) : (
        <div className="mrail">
          {chapters.map((c) => (
            <section key={c.chapter} className="mrail__node">
              <div className="mrail__dot" />
              <div className="mrail__head">
                <span className="mrail__ch">{c.chapter}</span>
                <span className="faint fs-xs">{c.entries.length} 条</span>
              </div>
              <div className="mlist">
                {c.entries.map((e, i) => (
                  <button
                    key={`${e.entity_id}${i}`}
                    className="mrow mrow--thin"
                    onClick={() => {
                      const target = e.entity_id || idOfName.get(e.name)
                      if (target) go({ name: 'entity', id: target })
                    }}
                  >
                    {/* 注意：.mrow 是纵向 flex，子元素会被拉成整行宽 ——
                        「首现」这种小标签必须和名字包在同一个横向行里，
                        否则会变成一条难看的横条（实测踩过） */}
                    <div className="mrow__head">
                      <span
                        className="mrow__name"
                        data-entity-type={e.type}
                        title={label(e.type)}
                      >
                        {e.name}
                      </span>
                      {e.kind === 'first' && (
                        <span className="mrow__tag mrow__tag--first">首现</span>
                      )}
                    </div>
                    {e.note && (
                      <span className="mrow__sum mrow__sum--inline">{e.note}</span>
                    )}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------
// 伏笔看板
// --------------------------------------------------------------------------

/** 「已回收」的判定放宽一点 —— 用户可能写「已收回」「已填」这类同义说法。 */
const isDone = (s: string) => /已(回收|收回|填|解决|揭)/.test(s || '')

export function ForeshadowView() {
  const { bookId } = useApp()
  const [showDone, setShowDone] = useState(false)
  const res = useResource<DocData>(bookId ? `${bookId}:doc:foreshadow` : null, () =>
    api.getDoc(bookId as string, 'foreshadow'),
  )

  if (res.loading && !res.data) return <Loading />
  if (res.error) return <ErrBox text={res.error} onRetry={res.reload} />
  const d = res.data
  if (!d) return <Empty title="读不到伏笔看板" />

  // 行可能比列短（手写的 Markdown 表格），一律按下标取、缺的当空串
  const rows = d.rows.map((r, i) => ({
    i,
    text: (r[0] ?? '').trim(),
    planted: (r[1] ?? '').trim(),
    plan: (r[2] ?? '').trim(),
    status: (r[3] ?? '').trim(),
    note: (r[4] ?? '').trim(),
  }))
  const open = rows.filter((r) => r.text && !isDone(r.status))
  const done = rows.filter((r) => r.text && isDone(r.status))
  const shown = showDone ? [...open, ...done] : open

  return (
    <div className="mpane">
      <div className="mchips mchips--scroll">
        <span className="mchip mchip--stat">未回收 {open.length}</span>
        <span className="mchip mchip--stat">已回收 {done.length}</span>
        <button
          className={`mchip mchip--btn ${showDone ? 'is-on' : ''}`}
          onClick={() => setShowDone((v) => !v)}
        >
          {showDone ? '只看未回收' : '连已回收一起看'}
        </button>
      </div>

      {shown.length === 0 ? (
        <Empty
          icon="🪢"
          title={rows.length === 0 ? '还没有伏笔' : '都回收完了'}
          hint={rows.length === 0 ? `在 PC 端的「${d.title}」里手填，或从 AI 抽取的候选里勾选` : ''}
        />
      ) : (
        <div className="mlist">
          {shown.map((r) => (
            <article key={r.i} className={`mfs ${isDone(r.status) ? 'mfs--done' : ''}`}>
              <div className="mfs__text">{r.text}</div>
              <div className="mfs__meta">
                {r.planted && <span className="mchip mchip--dim">埋于 {r.planted}</span>}
                {r.plan && <span className="mchip mchip--dim">计划 {r.plan}</span>}
                <span className={`mchip ${isDone(r.status) ? 'mchip--ok' : 'mchip--warn'}`}>
                  {r.status || '未回收'}
                </span>
              </div>
              {r.note && <div className="mfs__note">{r.note}</div>}
            </article>
          ))}
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------
// 章节索引 / 正文
// --------------------------------------------------------------------------

export function ChaptersView() {
  const { bookId } = useApp()
  const res = useResource<ChapterListData>(bookId ? `${bookId}:chapters` : null, () =>
    api.listChapters(bookId as string),
  )

  if (res.loading && !res.data) return <Loading />
  if (res.error) return <ErrBox text={res.error} onRetry={res.reload} />
  const d = res.data
  if (!d) return <Empty title="读不到章节" />

  if (d.count === 0) {
    return (
      <Empty icon="📖" title="还没有导入正文" hint="在 PC 端的「正文」界面里批量导入 docx / txt" />
    )
  }

  const byVolume = new Map<string, typeof d.items>()
  for (const it of d.items) {
    const key = it.volume || '未分卷'
    const bucket = byVolume.get(key)
    if (bucket) bucket.push(it)
    else byVolume.set(key, [it])
  }

  return (
    <div className="mpane">
      <div className="mtiles">
        <div className="mtile">
          <b>{d.stats.chapters}</b>
          <span>章</span>
        </div>
        <div className="mtile">
          <b>{(d.stats.words / 10000).toFixed(1)}</b>
          <span>万字</span>
        </div>
        <div className="mtile">
          <b>{d.stats.volumes.length}</b>
          <span>卷</span>
        </div>
      </div>

      {[...byVolume.entries()].map(([vol, list]) => (
        <section key={vol}>
          <SectionTitle right={`${list.length} 章`}>{vol}</SectionTitle>
          <div className="mlist">
            {list.map((it) => (
              <button
                key={it.chapter_no}
                className="mrow"
                onClick={() => go({ name: 'chapter', no: it.chapter_no })}
              >
                <div className="mrow__head">
                  <span className="mrow__no">{it.chapter_no}</span>
                  <span className="mrow__name">{it.title || '（无题）'}</span>
                </div>
                <div className="mrow__meta">{it.word_count} 字</div>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export function ChapterReadView({ no }: { no: number }) {
  const { bookId } = useApp()
  const res = useResource<ChapterData>(bookId ? `${bookId}:chapter:${no}` : null, () =>
    api.getChapter(bookId as string, no),
  )
  const listRes = useResource<ChapterListData>(bookId ? `${bookId}:chapters` : null, () =>
    api.listChapters(bookId as string),
  )

  const nav = useMemo(() => {
    const items = listRes.data?.items ?? []
    const i = items.findIndex((x) => x.chapter_no === no)
    return {
      prev: i > 0 ? items[i - 1] : null,
      next: i >= 0 && i < items.length - 1 ? items[i + 1] : null,
    }
  }, [listRes.data, no])

  const paras = useMemo(
    () =>
      (res.data?.text ?? '')
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean),
    [res.data?.text],
  )

  if (res.loading && !res.data) return <Loading />
  if (res.error) return <ErrBox text={res.error} onRetry={res.reload} />
  const d = res.data
  if (!d) return <Empty title={`没有第 ${no} 章`} />

  return (
    <div className="mpane">
      <header className="mread__head">
        <div className="faint fs-xs">{d.volume || '—'}</div>
        <h1>
          第 {d.chapter_no} 章 · {d.title || '（无题）'}
        </h1>
        <div className="faint fs-xs">{d.word_count} 字</div>
      </header>

      <article className="mread">
        {paras.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </article>

      <div className="mread__nav">
        <button
          className="mbtn"
          disabled={!nav.prev}
          onClick={() => {
            if (nav.prev) {
              go({ name: 'chapter', no: nav.prev.chapter_no })
              scrollTop()
            }
          }}
        >
          ← 上一章
        </button>
        <button className="mbtn" onClick={scrollTop}>
          回到顶部
        </button>
        <button
          className="mbtn"
          disabled={!nav.next}
          onClick={() => {
            if (nav.next) {
              go({ name: 'chapter', no: nav.next.chapter_no })
              scrollTop()
            }
          }}
        >
          下一章 →
        </button>
      </div>
    </div>
  )
}
