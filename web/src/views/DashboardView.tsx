/** 汇总界面（P4.7 数据看板）：把这本书的"体检报告"一屏摊开。
 *
 * 三件事按优先级排：**一眼看到的数**（大数字）→ **一眼看出的结构**（环形/色带）
 * → **一眼看出的问题**（完备度、度数、待补完）。
 *
 * 两条自我约束：
 * 1. **不放没数据的图**。录入趋势、章节趋势这类只有攒够数据才成立的东西，
 *    数据不够时**不画**，换成有数据的维度 —— 一根孤零零的柱子和一条假的
 *    上升曲线，比空着更糟。下面 `trendReady` 就是这个判断。
 * 2. **不动画到底**。所有动效挂载时播一次就静止，没有常驻 rAF ——
 *    这一页要天天开，它不该是个电老虎。
 */

import { useEffect, useMemo, useState } from 'react'
import * as api from '../api/client'
import type { Overview } from '../api/types'
import { useApp, type View } from '../state/store'
import { Panel } from '../components/Panel'
import { BookMetaPanel } from '../components/BookMetaPanel'
import { Bars, Band, CountUp, Donut, type BarItem, type Slice } from '../components/charts'
import { StateGate } from '../components/Toast'
import { FingerprintBanner } from '../components/FingerprintBanner'
import { WordPlanet, type PlanetWord } from '../components/WordPlanet'
import { typeColorVar } from '../graph/types'
import { shortTime } from '../lib/format'
import type { TypeOption } from '../api/types'

interface Props {
  onNewEntity: () => void
  onNewBook: () => void
  onRebuild: () => void
  rebuilding: boolean
}

/** 汇总页上的视角入口 —— 与导航条一致，只是多了「这里是干嘛的」一句 */
const VIEWS: { key: View; label: string; desc: string; hint: string }[] = [
  { key: 'world', label: '世界观', desc: '概念、境界、器物 —— 世界的规矩', hint: '思维导图：中心 → 标签 → 设定' },
  { key: 'geo', label: '地理观', desc: '地点与从属，谁归谁管', hint: '思维导图：按标签聚成地点树' },
  { key: 'roster', label: '名册录', desc: '整册名册，谁还只有个名字', hint: '带完备度四格' },
  { key: 'methodology', label: '方法论', desc: '哲学观、意识形态、戒律 —— 谁信奉什么', hint: '按信念把实体聚起来看' },
  { key: 'history', label: '历史观', desc: '故事内纪年 —— 哪一年发生了什么', hint: '真源 world/chronology.md' },
  { key: 'timeline', label: '时间线', desc: '第几章发生了什么（叙事序）', hint: '数据来自首现与出场记录' },
  { key: 'plot', label: '剧情线', desc: '卷、章节、事件与状态', hint: '章节导入后由 AI 补全' },
  { key: 'relation', label: '关系网', desc: '谁和谁有关系，缺谁没录', hint: '四种布局，虚线是未录入' },
]

/** 完备度四档的名字。0 分 = 真的只有一个名字。 */
const COMPLETENESS_NAMES = ['只有名字', '有摘要或标签', '差一项就齐', '基本齐了', '很完整']

export function DashboardView({ onNewEntity, onRebuild, rebuilding }: Props) {
  const {
    entities, stats, tags, types, books, bookId, setView, openEntity, setTypeFilter, setTagFilter,
    prefs,
  } = useApp()

  const [ov, setOv] = useState<Overview | null>(null)
  // 按 bookId 单独记一次「这次结果属于哪本书」——切书时旧数据不能顶上来冒充新书
  const [ovBook, setOvBook] = useState<string | null>(null)
  //: 拉取失败的原因。**必须留下** —— 以前这里静默吞掉，页面只剩空白，
  //: 看着就像「这本书里没数据」，把「接口挂了」和「真没录」两件事混成一件。
  const [ovErr, setOvErr] = useState<string | null>(null)
  const [retryTick, setRetryTick] = useState(0)

  useEffect(() => {
    if (!bookId) {
      setOv(null)
      setOvBook(null)
      setOvErr(null)
      return
    }
    let alive = true
    setOvErr(null)
    api
      .getOverview(bookId)
      .then((d) => {
        if (!alive) return
        setOv(d)
        setOvBook(bookId)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setOv(null)
        setOvErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [bookId, stats, entities.length, retryTick])

  const fresh = ov && ovBook === bookId ? ov : null
  //: 还没回来、也没报错 = 正在读。**加载中不能画成「还没有实体」**，
  //: 那也是「看着像空的」的一大来源。
  const ovLoading = !fresh && !ovErr && Boolean(bookId)

  const recent = useMemo(
    () => [...entities].sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '')).slice(0, 8),
    [entities],
  )
  const book = books.find((b) => b.book_id === bookId)
  const labelOf = (key: string) => types.find((t: TypeOption) => t.key === key)?.label ?? key

  // ---- 类型切片（环形图 + 图例共用一份，顺序即占比降序）----
  const typeSlices: Slice[] = useMemo(() => {
    const src = fresh?.entities.by_type ?? {}
    return types
      .map((t) => ({ key: t.key, label: t.label, value: src[t.key] ?? 0, entityType: t.key }))
      .filter((s) => s.value > 0)
      .sort((a, b) => b.value - a.value)
  }, [types, fresh])

  const total = fresh?.entities.total ?? stats?.total ?? 0

  // ---- 完备度：五档都留着（含 0 条那档），否则「没有人是 0 分」这件事看不出来 ----
  const compSlices: Slice[] = useMemo(() => {
    const b = fresh?.completeness.buckets ?? [0, 0, 0, 0, 0]
    return b.map((n, i) => ({
      key: `c${i}`,
      label: `${i} 分 · ${COMPLETENESS_NAMES[i]}`,
      value: n,
      color: `var(--comp-${i})`,
    }))
  }, [fresh])

  const degItems: BarItem[] = useMemo(
    () =>
      (fresh?.degree.buckets ?? []).map((b) => ({
        key: b.label,
        label: b.label,
        value: b.count,
        hint: `${b.label} 条关系的实体：${b.count} 个`,
      })),
    [fresh],
  )

  const topTagItems: BarItem[] = useMemo(
    () => (fresh?.tags.top ?? []).map((t) => ({ key: t.name, label: t.name, value: t.count, hint: `#${t.name} 用在 ${t.count} 条实体上` })),
    [fresh],
  )

  const topDegreeItems: BarItem[] = useMemo(
    () => (fresh?.degree.top ?? []).map((e) => ({
      key: e.id, label: e.name, value: e.count, entityType: e.type,
      hint: `${e.name} 连出 ${e.count} 条关系`,
    })),
    [fresh],
  )

  // ---- 章节体量：≥2 章才值得按章铺开，1 章就直接给数字 ----
  const chapterItems: BarItem[] = useMemo(
    () =>
      (fresh?.chapters.series ?? [])
        .filter((c) => c.words > 0)
        .slice(-16)
        .map((c, i) => ({
          // 用下标兜底：章号理论上不会空，但真缺了也不能让两条柱子共用一个 key
          key: `${c.no ?? 'x'}-${i}`,
          label: c.no == null ? '未编号' : `第${c.no}章`,
          value: c.words,
          hint:
            c.no == null
              ? `《${c.title}》${c.words.toLocaleString('zh-CN')} 字`
              : `第 ${c.no} 章《${c.title}》${c.words.toLocaleString('zh-CN')} 字`,
        })),
    [fresh],
  )

  const goType = (key: string) => {
    setTypeFilter(key)
    setTagFilter(null)
    setView('entities')
  }

  /**
   * 词汇星球的词表（P9 ⑧）。
   *
   * 三类词混在一颗球上，**权重各自归一后再放一起** —— 标签用了 3 次和实体
   * 连出 30 条关系不在一个量纲，直接拿原始数字比大小，球上就只剩实体了。
   * 颜色一律走类型色 / 强调色，和全站一致。
   */
  const planetWords: PlanetWord[] = useMemo(() => {
    if (!fresh) return []
    const out: PlanetWord[] = []
    const maxType = Math.max(1, ...typeSlices.map((s) => s.value))
    for (const s of typeSlices) {
      out.push({
        key: `t:${s.key}`,
        text: s.label,
        weight: 3 + Math.round((s.value / maxType) * 11), // 4~14：类型是骨架，始终偏大
        color: typeColorVar(s.key),
        kind: 'type',
      })
    }
    const topTags = fresh.tags.top.slice(0, 18)
    const maxTag = Math.max(1, ...topTags.map((t) => t.count))
    for (const t of topTags) {
      out.push({
        key: `g:${t.name}`,
        text: `#${t.name}`,
        weight: 1 + Math.round((t.count / maxTag) * 6),
        color: 'var(--accent)',
        kind: 'tag',
      })
    }
    const topEnt = fresh.degree.top.slice(0, 26)
    const maxDeg = Math.max(1, ...topEnt.map((e) => e.count))
    const used = new Set(topEnt.map((e) => e.id))
    for (const e of topEnt) {
      out.push({
        key: `e:${e.id}`,
        text: e.name,
        weight: 1 + Math.round((e.count / maxDeg) * 7),
        color: typeColorVar(e.type),
        kind: 'entity',
        entityId: e.id,
      })
    }

    // 填充层：后端只给 top10，光靠它球太稀。从**已加载的全部实体**里按类型
    // 均匀取样（每类最多 6 条），既有「整本书的词都在上面」的体量感，
    // 又不会让某一类刷屏。字号固定最小档 —— 它们是背景星尘，不是主角。
    const perType = new Map<string, number>()
    for (const e of [...entities].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))) {
      if (used.has(e.id) || out.length >= 88) continue
      const n = perType.get(e.type) ?? 0
      if (n >= 6) continue
      perType.set(e.type, n + 1)
      out.push({
        key: `f:${e.id}`,
        text: e.name,
        weight: 1,
        color: typeColorVar(e.type),
        kind: 'entity',
        entityId: e.id,
      })
    }
    return out
  }, [fresh, typeSlices, entities])

  const pickWord = (w: PlanetWord) => {
    if (w.kind === 'type') goType(w.key.slice(2))
    else if (w.kind === 'tag') {
      setTagFilter(w.text.replace(/^#/, ''))
      setTypeFilter(null)
      setView('entities')
    } else if (w.entityId) openEntity(w.entityId)
  }

  const pending = (fresh?.completeness.buckets[0] ?? 0) + (fresh?.completeness.buckets[1] ?? 0)
  const avgComp = fresh?.completeness.average ?? 0
  const topTag = fresh?.tags.top[0]

  return (
    <div className="dash board">
      {/* ---- 抬头：一进来先给「这是什么」和「什么时候的数据」 ---- */}
      <header className="board__head">
        <div>
          <h2 className="board__title">{book?.title ?? '未选择书目'}</h2>
          <p className="board__sub">
            世界观档案的实时体检 —— {labelOf('character')}、{labelOf('location')}、{labelOf('organization')} …
            共 {types.length} 类
          </p>
        </div>
        <div className="board__live">
          <span className="board__pulse" aria-hidden />
          {ovErr ? '索引读取失败' : ovLoading ? '正在读取…' : '索引已就绪'}
        </div>
      </header>

      {/* ---- 书目信息：**首要位置**（用户 2026-10-03：放汇总里，且居首）----
          抬头下面第一块就是「这是哪本书」—— 书名/作者/题材/封面都能直接改。
          原先它在【设置 → 后台】里，已经撤掉，同一件事只留一个入口。 */}
      <BookMetaPanel />

      {/* ---- 取数状态：失败/加载中/真·空，三种必须各说各话 ---- */}
      {ovErr && (
        <div className="board__alert board__alert--err" role="alert">
          <div className="board__alert-main">
            <b>汇总数据没取到 —— 下面所有图都靠它，所以请先别看那些空面板</b>
            <span className="fs-sm">{ovErr}</span>
            <span className="faint fs-xs">
              最常见两种原因：① 后端还是改动之前的进程，重启一次就好；
              ② 这本书的索引里没有数据，用右边「重建索引」修。
            </span>
          </div>
          <div className="board__alert-act">
            <button className="board__alert-btn" onClick={() => setRetryTick((n) => n + 1)}>
              重试
            </button>
            <button className="board__alert-btn board__alert-btn--quiet" onClick={onRebuild} disabled={rebuilding}>
              {rebuilding ? '重建中…' : '重建索引'}
            </button>
          </div>
        </div>
      )}

      {ovLoading && (
        <div className="board__alert board__alert--wait" role="status">
          <span className="spinner" />
          <span className="fs-sm">正在读取汇总数据…</span>
        </div>
      )}

      {/* 外部改动提示（P11-A5）：档案/正文被别处改过就说出来。
          放在取数状态之后 —— 「数据没取到」比「你改过文件」更该先被看见。 */}
      <FingerprintBanner onRebuild={onRebuild} rebuilding={rebuilding} />

      {/* 请求回来了、可索引里一条实体都没有 —— 这才是真的空，而且带上「为什么空」 */}
      {fresh && fresh.entities.total === 0 && (
        <div className="board__alert board__alert--warn" role="status">
          <div className="board__alert-main">
            {fresh.health?.index_stale ? (
              <>
                <b>索引过期了 —— 磁盘上有实体文件，索引里却是 0 条</b>
                <span className="faint fs-xs">
                  实体目录里躺着 {fresh.health.disk_total} 个 .md，索引一条都查不到。
                  点「重建索引」就全回来了，正文与档案文件分毫不动。
                </span>
              </>
            ) : (
              <>
                <b>这本书的实体目录里确实还没有文件</b>
                <span className="faint fs-xs">
                  索引 0 条、磁盘也 0 个 .md{fresh.health?.entities_dir_exists ? '' : '（连实体目录都还没建出来）'}。
                  当前数据目录：<span className="mono">{fresh.health?.data_dir ?? '未知'}</span>
                  {' '}—— 若这不是你预期的位置，说明程序切到另一个数据目录去了。
                </span>
              </>
            )}
          </div>
          <div className="board__alert-act">
            {fresh.health?.index_stale && (
              <button className="board__alert-btn" onClick={onRebuild} disabled={rebuilding}>
                {rebuilding ? '重建中…' : '重建索引'}
              </button>
            )}
            <button className="board__alert-btn board__alert-btn--quiet" onClick={onNewEntity}>
              新建实体
            </button>
          </div>
        </div>
      )}

      {/* ---- 大数字 ---- */}
      <section className="kpis">
        <Kpi
          value={total}
          label="实体总数"
          hint={`${typeSlices.length} 种类型在用`}
          onClick={() => { setTypeFilter(null); setTagFilter(null); setView('entities') }}
        />
        <Kpi
          value={fresh?.relations.total ?? stats?.relations ?? 0}
          label="关系（双链）"
          hint={
            fresh?.relations.dangling
              ? `${fresh.relations.dangling} 条指向还没建的实体`
              : '全部指向已建实体'
          }
        />
        <Kpi
          value={fresh?.chapters.count ?? 0}
          label="已导入章节"
          hint={fresh ? `合计 ${fresh.chapters.words.toLocaleString('zh-CN')} 字` : '—'}
          onClick={() => setView('text')}
        />
        <Kpi
          value={fresh?.tags.total ?? tags.length}
          label="标签"
          hint={topTag ? `最多：#${topTag.name}（${topTag.count}）` : '还没有标签'}
        />
        <Kpi
          value={avgComp}
          fixed={2}
          suffix=" / 4"
          label="平均完备度"
          hint={pending ? `${pending} 条还只有个名字` : '没有空壳实体'}
          tone={pending ? 'warn' : 'ok'}
          onClick={() => setView('roster')}
        />
        <Kpi
          value={typeSlices[0]?.value ?? 0}
          label={`最大一类`}
          hint={typeSlices[0] ? `${typeSlices[0].label}，占 ${((typeSlices[0].value / Math.max(1, total)) * 100).toFixed(0)}%` : '—'}
        />
      </section>

      {/* ---- 主角图：环形 + 色带，同一份数据两种读法 ---- */}
      <Panel
        title="类型分布"
        className="board__hero"
        actions={<span className="faint fs-xs">点任一色块 → 进实体界面按这个类型筛</span>}
      >
        <StateGate loading={ovLoading} empty={typeSlices.length === 0} emptyTitle="还没有实体" emptyHint="先录几条，这里就会长出分布。">
          <div className="hero">
            <Donut slices={typeSlices} size={188} thickness={22} onPick={(s) => goType(s.key)} />
            <div className="hero__side">
              <Band items={typeSlices} thickness={12} showLegend onPick={(s) => goType(s.key)} />
            </div>
          </div>
        </StateGate>
      </Panel>

      {/* ---- 词汇星球：把整本书的高频词与枢纽实体转成一颗球 ---- */}
      <Panel
        title="词汇星球"
        actions={<span className="faint fs-xs">高频标签 + 枢纽实体 · 点任一词进去</span>}
      >
        <StateGate
          loading={ovLoading}
          empty={planetWords.length < 6}
          emptyTitle="词还不够组成星球"
          emptyHint="录几条实体、打上标签，这里就会转起来。"
        >
          <div className="planet">
            <WordPlanet
              words={planetWords}
              size={340}
              colorKey={`${prefs?.ui?.theme ?? ''}|${prefs?.ui?.mode ?? ''}`}
              onPick={pickWord}
            />
            <div className="planet__side">
              <p className="board__note" style={{ marginTop: 0 }}>
                球面上每个词都是这本书里<b>真实出现过的</b>东西：字号看分量，颜色看类型。
                外层是枢纽实体（连出的关系最多），中间层是高频标签，最大的一圈是类型骨架。
              </p>
              <div className="planet__legend">
                <span className="planet__dot" style={{ background: 'var(--accent)' }} />
                标签
                <span className="planet__dot" style={{ background: 'var(--type-character)' }} />
                实体（按类型上色）
                <span className="planet__dot" style={{ background: 'var(--text-muted)' }} />
                类型骨架
              </div>
              <p className="faint fs-xs">
                一直转是为了看出「前后层次」—— 静止的球只是一堆字。滚出视野或切走面板它会自己停下。
              </p>
            </div>
          </div>
        </StateGate>
      </Panel>

      {/* ---- 三个小图：结构性问题 ---- */}
      <div className="board__trio">
        <Panel title="完备度分布" actions={<span className="faint fs-xs">平均 {avgComp.toFixed(2)} / 4</span>}>
          <StateGate loading={ovLoading} empty={total === 0} emptyTitle="还没有实体">
            {/* 点色块去名册录 —— 那里有「只看待补全」的开关，是真正动手补的地方 */}
            <Band items={compSlices} thickness={14} showLegend onPick={() => setView('roster')} />
            <p className="board__note">
              完备度 = 有摘要 + 有标签 +（有别名或出场记录）+ 有关系，各记 1 分。
              <b>0 分的那几条真的只有一个名字</b> —— 点色块进名册录，那里能筛出待补全的。
            </p>
          </StateGate>
        </Panel>

        <Panel title="关系度数分布" actions={<span className="faint fs-xs">连出多少条 [[双链]]</span>}>
          <StateGate loading={ovLoading} empty={total === 0} emptyTitle="还没有实体">
            <Bars items={degItems} layout="col" height={104} />
            <p className="board__note">
              左边矮、右边长说明关系还集中在少数实体身上；每档都鼓起来才是「这张网织开了」。
            </p>
          </StateGate>
        </Panel>

        <Panel
          title="章节体量"
          actions={
            fresh && fresh.chapters.count >= 2 ? (
              <span className="faint fs-xs">最近 {chapterItems.length} 章</span>
            ) : undefined
          }
        >
          <StateGate loading={ovLoading} empty={chapterItems.length === 0} emptyTitle="还没有导入章节" emptyHint="导入正文后，这里会按章给出字数曲线。">
            {chapterItems.length === 1 ? (
              <div className="bigstat">
                <div className="bigstat__num mono">
                  <CountUp value={chapterItems[0].value} />
                </div>
                <div className="bigstat__label">{chapterItems[0].hint} —— 只有一章，攒够两章才画得出走势</div>
              </div>
            ) : (
              <Bars items={chapterItems} layout="col" height={104} />
            )}
            <p className="board__note">
              这一条衡量的是<b>节奏</b>：忽然一柱特别高说明这一章塞了太多设定。
            </p>
          </StateGate>
        </Panel>
      </div>

      {/* ---- 两个排行 ---- */}
      <div className="board__grid2">
        <Panel title="标签用得最多" actions={<span className="faint fs-xs">共 {fresh?.tags.total ?? tags.length} 个标签</span>}>
          <StateGate loading={ovLoading} empty={topTagItems.length === 0} emptyTitle="还没有标签" emptyHint="录入时在「标签」栏填几个词，这里就有排名了。">
            <Bars
              items={topTagItems}
              layout="row"
              onPick={(b) => { setTagFilter(b.key); setTypeFilter(null); setView('entities') }}
            />
          </StateGate>
        </Panel>

        <Panel title="连线最多的实体" actions={<span className="faint fs-xs">谁是这个世界的枢纽</span>}>
          <StateGate loading={ovLoading} empty={topDegreeItems.length === 0} emptyTitle="还没有关系" emptyHint="实体正文里写 [[另一个名字]]，关系就长出来了。">
            <Bars items={topDegreeItems} layout="row" onPick={(b) => openEntity(b.key)} />
          </StateGate>
        </Panel>
      </div>

      {/* ---- 八个视角 ---- */}
      <Panel title="这个世界的八个视角">
        <div className="views">
          {VIEWS.map((v) => (
            <button key={v.key} className="view-card" onClick={() => setView(v.key)} title={v.hint}>
              <span className="view-card__name">{v.label}</span>
              <span className="view-card__desc">{v.desc}</span>
              <span className="view-card__go">进入 →</span>
            </button>
          ))}
        </div>
      </Panel>

      <div className="dash__grid">
        <Panel title="最近改动">
          <StateGate empty={recent.length === 0} emptyTitle="还没有实体">
            <ul className="recent">
              {recent.map((e) => (
                <li key={e.id}>
                  <button className="recent__item" data-entity-type={e.type} onClick={() => openEntity(e.id)}>
                    <span className="dot" />
                    <span className="recent__name ellipsis">{e.name}</span>
                    <span className="chip">{labelOf(e.type)}</span>
                    <span className="recent__time faint fs-xs">{shortTime(e.updated_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </StateGate>
        </Panel>

        <Panel title="当前书目">
          {book ? (
            <div className="kv">
              {book.cover && (
                <div className="kv__cover">
                  <img src={api.assetUrlOf(book.cover)} alt={`${book.title} 封面`} />
                </div>
              )}
              <div className="kv__k">书名</div>
              <div className="kv__v">
                {book.title}
                {book.genre && <span className="chip chip--accent" style={{ marginLeft: 8 }}>{book.genre}</span>}
              </div>
              <div className="kv__k">目录名</div>
              <div className="kv__v mono fs-xs">{book.book_id}</div>
              {book.author && (
                <>
                  <div className="kv__k">作者</div>
                  <div className="kv__v">{book.author}</div>
                </>
              )}
              <div className="kv__k">实体</div>
              <div className="kv__v">{total} 条</div>
              {fresh && (
                <>
                  <div className="kv__k">关系</div>
                  <div className="kv__v">{fresh.relations.total} 条</div>
                  <div className="kv__k">正文</div>
                  <div className="kv__v">
                    {fresh.chapters.count} 章 · {fresh.chapters.words.toLocaleString('zh-CN')} 字
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="empty__title fs-sm">未选择书目</div>
          )}
        </Panel>
      </div>
    </div>
  )
}

/** 大数字格子。`fixed` 用来保留小数位（完备度 3.01 不能显示成 3）。 */
function Kpi({
  value,
  label,
  hint,
  suffix,
  fixed = 0,
  tone,
  onClick,
}: {
  value: number
  label: string
  hint?: string
  suffix?: string
  fixed?: number
  tone?: 'ok' | 'warn'
  onClick?: () => void
}) {
  const fmt = (n: number) =>
    fixed > 0 ? n.toFixed(fixed) : Math.round(n).toLocaleString('zh-CN')
  const inner = (
    <>
      <div className="kpi__num mono">
        <CountUp value={value} format={fmt} />
        {suffix && <span className="kpi__suffix">{suffix}</span>}
      </div>
      <div className="kpi__label">{label}</div>
      {hint && <div className={`kpi__hint ${tone === 'warn' ? 'kpi__hint--warn' : ''}`}>{hint}</div>}
      <span className="kpi__rule" aria-hidden />
    </>
  )
  return onClick ? (
    <button className="kpi kpi--click" onClick={onClick}>{inner}</button>
  ) : (
    <div className="kpi">{inner}</div>
  )
}

export default DashboardView
