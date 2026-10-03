/**
 * 纪年轴 —— 历史观的「故事内时间」视图（用户 2026-10-04 拍板：做成真正的纪年轴）。
 *
 * 与「时间线」（叙事序，第 N 章）互为两轨：
 *   时间线回答「这段剧情发生在第几章」；
 *   纪年轴回答「这件事发生在架空世界的哪一年」。
 *
 * 真源不变：还是 `world/chronology.md` 的那张 Markdown 表（时间/事件/关联/备注），
 * 这里只是把第一列的「时间」**解析成可排序的键**再渲染成竖轴：
 *   「显和帝143年秋」→ year=143, season=秋(1.8)
 *   「昭宁元年」      → 「元年」按第 1 年计
 *   没有数字的        → 归入「未标年」组，排在最后，不打乱有年份的顺序
 *
 * 折叠：按年分组，点组头收起 / 展开（纯界面状态，本地 state 就够 ——
 * 年份组通常不超过二三十个，不值得为它进 localStorage）。
 *
 * 「关联」列照旧走 LinkText：[[裴渊]] 点一下就跳档案，出处永不丢失。
 */

import { useMemo, useState } from 'react'
import type { DocData } from '../api/types'
import { LinkText } from './LinkText'

/** 季节 / 月份 → 年内排序小数。春 1.2 < 夏 1.5 < 秋 1.8 < 冬 2.1，月份按真实序。 */
const SEASON: [RegExp, number][] = [
  [/正月|一月|1月/, 1.0],
  [/二月|2月/, 2.0],
  [/三月|3月/, 3.0],
  [/四月|4月/, 4.0],
  [/五月|5月/, 5.0],
  [/六月|6月/, 6.0],
  [/七月|7月/, 7.0],
  [/八月|8月/, 8.0],
  [/九月|9月/, 9.0],
  [/十月|10月/, 10.0],
  [/十一月|冬月|11月/, 11.0],
  [/十二月|腊月|12月/, 12.0],
  [/初春|早春|春/, 1.2],
  [/立夏|初夏|夏/, 1.5],
  [/初秋|秋/, 1.8],
  [/初冬|冬/, 2.1],
  [/岁末|年末|年底|除/, 2.4],
]

export interface ParsedTime {
  /** 第一个数字当「年」。解析不出就是 null（归「未标年」） */
  year: number | null
  /** 年内细排序用的小数（0 = 只有年） */
  season: number
}

/** 「显和帝143年秋」→ { year: 143, season: 1.8 } */
export function parseTime(raw: string): ParsedTime {
  const s = raw.trim()
  let year: number | null = null
  const m = s.match(/(\d+)/)
  if (m) year = parseInt(m[1], 10)
  else if (/元年|第一年/.test(s)) year = 1

  let season = 0
  for (const [re, v] of SEASON) {
    if (re.test(s)) {
      season = v
      break
    }
  }
  return { year, season }
}

/** 按列名猜各列的语义（猜不中按位置兜底：0时间 1事件 2关联 3备注） */
function pickColumns(columns: string[]) {
  const find = (re: RegExp, fallback: number) => {
    const i = columns.findIndex((c) => re.test(c))
    return i >= 0 ? i : fallback
  }
  return {
    time: find(/时间|年代|纪年|年月|年/, 0),
    event: find(/事件|大事|发生|事/, 1),
    links: find(/关联|人物|相关|涉及/, 2),
    note: find(/备注|说明|注/, 3),
  }
}

interface Group {
  /** 组头显示的年份文本；null = 未标年 */
  label: string
  year: number | null
  items: { time: string; cells: string[]; season: number; idx: number }[]
}

export function ChronologyAxis({ doc }: { doc: DocData }) {
  const cols = useMemo(() => pickColumns(doc.columns), [doc.columns])

  const groups = useMemo<Group[]>(() => {
    if (!doc.rows.length) return []
    const map = new Map<string, Group>()
    doc.rows.forEach((row, idx) => {
      const time = (row[cols.time] ?? '').trim()
      const { year, season } = parseTime(time)
      const label = year === null ? '未标年' : `${year} 年`
      let g = map.get(label)
      if (!g) {
        g = { label, year, items: [] }
        map.set(label, g)
      }
      g.items.push({ time, cells: row, season, idx })
    })
    const list = [...map.values()]
    // 年份升序，「未标年」永远垫底；同年内按季节
    list.sort((a, b) => {
      if (a.year === null) return 1
      if (b.year === null) return -1
      if (a.year !== b.year) return a.year - b.year
      return 0
    })
    for (const g of list) g.items.sort((a, b) => a.season - b.season)
    return list
  }, [doc, cols])

  // 折叠状态：本地 state。Set 里存的是「收起」的组（默认全展开）
  const [folded, setFolded] = useState<Set<string>>(() => new Set())
  const toggle = (label: string) =>
    setFolded((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })

  if (!doc.rows.length) {
    return (
      <div className="chrono chrono--empty">
        <p className="faint fs-sm" style={{ textAlign: 'center', maxWidth: 460, lineHeight: 1.75 }}>
          表格还是空的 —— 在第一列写「显和帝143年秋」这样的故事内时间，
          这里就会自动按年排成一根轴。点「编辑源码」开始填。
        </p>
      </div>
    )
  }

  return (
    <div className="chrono">
      <div className="row row--wrap doc__meta">
        <span className="chip">{groups.length} 个年份组</span>
        <span className="chip">{doc.rows.length} 条纪年</span>
        <div className="grow" />
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => setFolded(new Set(groups.map((g) => g.label)))}
          title="只看年份行"
        >
          全部收起
        </button>
        <button className="btn btn--ghost btn--sm" onClick={() => setFolded(new Set())} title="摊开所有年份">
          全部展开
        </button>
      </div>

      <div className="chrono__body">
        {groups.map((g) => {
          const closed = folded.has(g.label)
          return (
            <section key={g.label} className={`chrono__group ${closed ? 'chrono__group--closed' : ''}`}>
              <button
                type="button"
                className="chrono__head"
                onClick={() => toggle(g.label)}
                aria-expanded={!closed}
                title={closed ? '展开这一年' : '收起这一年'}
              >
                <span className="chrono__caret" aria-hidden>
                  ▾
                </span>
                <span className="chrono__year">{g.label}</span>
                <span className="chrono__count">{g.items.length} 条</span>
              </button>
              <ul className="chrono__list">
                {g.items.map((it) => (
                  <li key={it.idx} className="chrono__item">
                    <span className="chrono__dot" aria-hidden />
                    <span className="chrono__time">{it.time || '—'}</span>
                    <span className="chrono__event">
                      {it.cells[cols.event] ? <LinkText text={it.cells[cols.event]} /> : <span className="faint">—</span>}
                    </span>
                    {it.cells[cols.links] && (
                      <span className="chrono__links">
                        <LinkText text={it.cells[cols.links]} />
                      </span>
                    )}
                    {it.cells[cols.note] && <span className="chrono__note faint fs-xs">{it.cells[cols.note]}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>

      <p className="faint fs-xs doc__note">
        排序只看第一列里**出现的第一个数字**和季节/月份词 —— 写法随意，能认出来就行。
        「未标年」的条目排在最后，补上年份后自动归位。真源仍是 world/{doc.name}.md。
      </p>
    </div>
  )
}
