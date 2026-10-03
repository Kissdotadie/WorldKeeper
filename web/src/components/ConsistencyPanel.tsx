/** 不一致体检（P11-7️⃣②）—— 五类「记录之间对不对得上」的检查。
 *
 * 与旁边那块「实体体检」是一对：
 *   实体体检看**单个名字像不像专名**（一条实体一条结论）；
 *   不一致体检看**几处记录对不对得上**（一条结论必然牵出至少两处）。
 *
 * 三条自我约束：
 * 1. **只报不改**。这里不提供任何「一键修复」—— 修哪一处、按哪一处为准，
 *    是作者的创作决定，工具替他拿主意一定错。
 * 2. **每条都带双方证据 + 出处**。没有证据的结论没法核，等于让人凭信任改稿。
 * 3. **说清楚没查什么**。纯规则读不懂剧情，界面上逐类写明「这类检查只查了形态，
 *    语义留给技能中心的 AI 检查」—— 免得人以为「体检干净 = 全书没问题」。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import * as api from '../api/client'
import type { ConsistencyCheckGroup, ConsistencyItem, ConsistencyResult } from '../api/types'
import { useApp } from '../state/store'
import { Panel } from '../components/Panel'

/** 证据落在哪份档案上 → 界面上点它跳去哪个视图 */
const DOC_VIEW: Record<string, string> = {
  foreshadow: '伏笔看板',
  geography: '地理观',
  chronology: '历史观',
}

const SEV_LABEL: Record<string, string> = { high: '高', mid: '中', low: '低' }

export function ConsistencyPanel() {
  const { bookId, openEntity, requestView, dataVersion } = useApp()
  const [data, setData] = useState<ConsistencyResult | null>(null)
  const [deep, setDeep] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const run = useCallback(
    async (useDeep: boolean) => {
      if (!bookId) {
        setData(null)
        return
      }
      setBusy(true)
      setErr(null)
      try {
        const r = await api.adminConsistency(bookId, useDeep)
        setData(r)
        // 有问题的类自动展开，干净的类折起来 —— 页面第一眼该落在要处理的东西上
        const next: Record<string, boolean> = {}
        for (const c of r.checks) next[c.id] = c.total > 0
        setOpen(next)
      } catch (e) {
        setData(null)
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [bookId],
  )

  useEffect(() => {
    // 换书或数据变过（= 刚改过东西）就重扫 —— 「常驻」的含义是结论始终是新的
    void run(deep)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, dataVersion])

  const groups = data?.checks ?? []
  const severity = data?.severity ?? {}

  const goDoc = (doc: string) => {
    const view = doc === 'foreshadow' ? 'foreshadow' : doc === 'geography' ? 'geo' : 'history'
    requestView(view as never)
  }

  const renderItem = (it: ConsistencyItem) => (
    <li key={it.id} className={`consist__row consist__row--${it.severity}`}>
      <div className="consist__head">
        <span className={`consist__sev consist__sev--${it.severity}`}>{SEV_LABEL[it.severity]}</span>
        <span className="consist__title">{it.title}</span>
      </div>
      <div className="consist__detail faint fs-xs">{it.detail}</div>
      {it.evidence.length > 0 && (
        <ul className="consist__ev">
          {it.evidence.map((ev, i) => (
            <li key={i} className="consist__ev-row">
              <span className="chip">{ev.label}</span>
              {ev.text && <span className="consist__ev-text fs-xs">{ev.text}</span>}
              {ev.entity_id && (
                <button className="consist__link fs-xs" onClick={() => openEntity(ev.entity_id!)}>
                  看实体
                </button>
              )}
              {ev.doc && DOC_VIEW[ev.doc] && (
                <button className="consist__link fs-xs" onClick={() => goDoc(ev.doc!)}>
                  看{DOC_VIEW[ev.doc]}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  )

  return (
    <Panel
      title="不一致体检"
      className="admin__audit admin__consist"
      collapsible
      sectionId="admin:consistent"
      actions={
        <div className="consist__acts">
          <label className="consist__deep fs-xs" title="连「出处指向的章节还在不在」一起查，要读一遍全部档案（大书约 2 秒）">
            <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} />
            连出处一起查
          </label>
          <button className="btn btn--sm" onClick={() => void run(deep)} disabled={busy || !bookId}>
            {busy && <span className="spinner" />}
            {data ? '重新体检' : '开始体检'}
          </button>
        </div>
      }
    >
      <div className="notice" style={{ marginBottom: 'var(--p-space-3)' }}>
        <div>
          查的是<b>几处记录之间对不对得上</b>：首现章与出场记录、伏笔的埋设与回收、
          称呼有没有撞车、地理从属有没有成环、引用的章节还在不在。
          <b>只报不改</b> —— 以哪一处为准是创作决定，工具不替你拿主意。
          每条都带双方证据，点证据能直接跳过去核。
        </div>
      </div>

      {!bookId && <div className="empty__title fs-sm">先选一本书</div>}
      {err && (
        <div className="notice notice--warn" style={{ marginBottom: 'var(--p-space-3)' }}>
          读取失败：{err}
        </div>
      )}

      {data && bookId && (
        <>
          <div className="audit__bar">
            <span className="chip">比了 {data.checked_entities} 条实体</span>
            <span className="chip">{data.checked_chapters} 章</span>
            <span className={`chip${severity.high ? ' consist__chip--high' : ''}`}>{severity.high ?? 0} 高</span>
            <span className="chip">{severity.mid ?? 0} 中</span>
            <span className="chip">{severity.low ?? 0} 低</span>
            <span className="faint fs-xs">
              {data.generated_at} 扫的{data.deep ? '' : '（没查出处）'}
            </span>
          </div>

          {data.clean ? (
            <div className="empty">
              <div className="empty__title">五类检查都没发现对不上的地方</div>
              <div className="fs-sm" style={{ maxWidth: 460 }}>
                注意这只说明<b>记录之间互相自洽</b>，不等于全书的设定没有问题 ——
                语义层面的矛盾（同一时间挂了两件互斥的事）要读正文才看得出来，
                那是技能中心「设定矛盾检查」的活。
              </div>
            </div>
          ) : (
            <div className="consist">
              {groups.map((g) => (
                <CheckGroup
                  key={g.id}
                  g={g}
                  open={open[g.id] ?? true}
                  onToggle={() => setOpen((s) => ({ ...s, [g.id]: !(s[g.id] ?? true) }))}
                  renderItem={renderItem}
                />
              ))}
            </div>
          )}

          <div className="consist__foot faint fs-xs">
            纯规则体检的边界：{groups.filter((g) => g.leaves).map((g) => g.name).join('、')}
            {' '}这几类里，语义判断的部分留给技能中心的 AI 检查。两边用的是同一套性质与严重度口径（
            {(data.natures ?? []).join(' / ')}；{(data.severities ?? []).join(' / ')}），结论能摆在一起看。
          </div>
        </>
      )}
    </Panel>
  )
}

function CheckGroup({
  g, open, onToggle, renderItem,
}: {
  g: ConsistencyCheckGroup
  open: boolean
  onToggle: () => void
  renderItem: (it: ConsistencyItem) => ReactElement
}) {
  const counts = useMemo(
    () =>
      (['high', 'mid', 'low'] as const)
        .filter((s) => (g.severity[s] ?? 0) > 0)
        .map((s) => `${SEV_LABEL[s]} ${g.severity[s]}`)
        .join(' · '),
    [g],
  )
  return (
    <section className={`consist__group ${g.total === 0 ? 'consist__group--clean' : ''}`}>
      <button className="consist__group-head" onClick={onToggle} aria-expanded={open}>
        <span className="consist__caret">{open ? '▾' : '▸'}</span>
        <span className="consist__group-name">{g.name}</span>
        <span className="chip">{g.nature}</span>
        {g.total > 0 ? (
          <span className="consist__count">{counts}</span>
        ) : (
          <span className="consist__count consist__count--ok">没问题</span>
        )}
      </button>
      {open && (
        <>
          <div className="consist__scope fs-xs faint">
            <div><b>查了</b>：{g.covers}</div>
            {g.leaves && <div><b>没查</b>：{g.leaves}</div>}
          </div>
          {g.total === 0 ? (
            <div className="consist__none fs-xs faint">这一类没发现对不上的地方。</div>
          ) : (
            <ul className="consist__list">{g.items.map(renderItem)}</ul>
          )}
          {g.omitted > 0 && (
            <div className="faint fs-xs consist__more">
              还有 {g.omitted} 条同类问题没列出来（这一类太多了，列全了没法看）。
            </div>
          )}
        </>
      )}
    </section>
  )
}

export default ConsistencyPanel
