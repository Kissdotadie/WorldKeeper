/**
 * 技能中心（P10 反馈第③条）—— 提示词模板库。
 *
 * 每张卡 = 一个「读正文」的用法：名字 + 适用场景 + 提示词模板。
 * 选章节 → 跑一次 → 拿到分析结果。
 *
 * 两条不能破的线（写在界面上，也写在每张内置模板里）：
 * 1. **只读不写**：产出分析、清单、梳理，绝不生成 / 续写 / 润色正文
 * 2. **结果不落盘**：看完要不要用，由你自己决定（录入走人工确认那条路）
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '../api/client'
import type { ChapterBrief, SkillCard, SkillList, SkillRunResult } from '../api/types'
import { useApp } from '../state/store'
import { Panel } from '../components/Panel'
import { StateGate } from '../components/Toast'

export function SkillsView() {
  const { bookId, notify, dataVersion } = useApp()

  const [data, setData] = useState<SkillList | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [picked, setPicked] = useState<SkillCard | null>(null)
  const [card, setCard] = useState<SkillCard | null>(null) // 详情（带模板）
  const [draft, setDraft] = useState({ name: '', scene: '', template: '' })

  const [chapters, setChapters] = useState<ChapterBrief[]>([])
  const [chNos, setChNos] = useState<Set<number>>(new Set())
  const [focus, setFocus] = useState('')
  const [busy, setBusy] = useState<'save' | 'run' | null>(null)
  const [result, setResult] = useState<SkillRunResult | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    api
      .listSkills()
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(load, [load])

  useEffect(() => {
    if (bookId) api.listChapters(bookId).then((d) => setChapters(d.items)).catch(() => setChapters([]))
  }, [bookId, dataVersion])

  // 选中卡片 → 拉详情（列表不带模板正文）
  useEffect(() => {
    if (!picked) {
      setCard(null)
      return
    }
    api
      .getSkill(picked.id)
      .then((c) => {
        setCard(c)
        setDraft({ name: c.name, scene: c.scene, template: c.template ?? '' })
      })
      .catch((e) => notify('err', `读技能卡失败：${(e as Error).message}`))
  }, [picked, notify])

  const builtin = useMemo(() => (data?.items ?? []).filter((s) => s.builtin), [data])
  const custom = useMemo(() => (data?.items ?? []).filter((s) => !s.builtin), [data])

  const doSave = async () => {
    if (!card || card.builtin) return
    setBusy('save')
    try {
      await api.updateSkill(card.id, draft)
      notify('ok', '技能卡已保存')
      load()
      const fresh = await api.getSkill(card.id)
      setCard(fresh)
    } catch (e) {
      notify('err', `保存失败：${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const doClone = async () => {
    if (!card) return
    const name = window.prompt('新技能卡的名字', `${card.name}（副本）`)
    if (name === null) return
    try {
      const c = await api.cloneSkill(card.id, name.trim() || undefined)
      notify('ok', `已复制成「${c.name}」，现在可以改了`)
      load()
      setPicked(c)
    } catch (e) {
      notify('err', `复制失败：${(e as Error).message}`)
    }
  }

  const doNew = async () => {
    const name = window.prompt('新技能卡的名字', '')
    if (name === null || !name.trim()) return
    try {
      const c = await api.createSkill({
        name: name.trim(),
        scene: '',
        template:
          '你是小说设定整理助手。你只阅读并分析正文，绝不续写、改写、润色正文里的任何一个字。\n\n' +
          '## 正文\n{chapter_text}\n\n## 输出要求\n（在这里写你要 AI 产出什么）\n{focus}',
      })
      notify('ok', `已新建「${c.name}」`)
      load()
      setPicked(c)
    } catch (e) {
      notify('err', `新建失败：${(e as Error).message}`)
    }
  }

  const doDelete = async () => {
    if (!card || card.builtin) return
    if (!window.confirm(`删掉技能卡「${card.name}」？\n这只删这张卡，知识库与正文都不受影响。`)) return
    try {
      await api.deleteSkill(card.id)
      notify('ok', '已删除')
      setPicked(null)
      load()
    } catch (e) {
      notify('err', `删除失败：${(e as Error).message}`)
    }
  }

  const doRun = async () => {
    if (!card || !bookId) return
    setBusy('run')
    setResult(null)
    try {
      const r = await api.runSkill(card.id, {
        bookId,
        chapterNos: Array.from(chNos).sort((a, b) => a - b),
        focus,
      })
      setResult(r)
      notify('ok', `「${r.skill_name}」跑完 · ${r.tokens.total} tok ≈ ¥${r.cost_cny.toFixed(4)}`)
    } catch (e) {
      notify('err', `运行失败：${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const toggleCh = (no: number) =>
    setChNos((p) => {
      const n = new Set(p)
      if (n.has(no)) n.delete(no)
      else n.add(no)
      return n
    })

  const chLabel = chNos.size ? `第 ${Array.from(chNos).sort((a, b) => a - b).join('、')} 章` : '全部章节'

  return (
    <StateGate loading={loading && !data} error={error}>
      <div className="chap">
        <div className="chap__bar">
          <div className="chap__nums">
            <b>技能中心</b>
            <span className="faint fs-xs">
              每张卡是一个「读正文」的用法 —— 只生产分析，不动正文一个字；结果也不落盘。
            </span>
          </div>
          <div className="grow" />
          <button className="btn btn--sm" onClick={doNew}>
            + 新建技能卡
          </button>
        </div>

        <div className="chap__split">
          {/* ---- 左：卡片列表 ---- */}
          <Panel title={`技能卡 · ${data?.items.length ?? 0}`} flush>
            <div className="skill__list">
              <div className="skill__group">内置（可复制成自己的再改）</div>
              {builtin.map((s) => (
                <CardRow key={s.id} card={s} active={picked?.id === s.id} onClick={() => setPicked(s)} />
              ))}
              {custom.length > 0 && <div className="skill__group">我的技能卡</div>}
              {custom.map((s) => (
                <CardRow key={s.id} card={s} active={picked?.id === s.id} onClick={() => setPicked(s)} />
              ))}
              {custom.length === 0 && (
                <p className="faint fs-xs" style={{ padding: '0 var(--p-space-3) var(--p-space-3)' }}>
                  还没有自定义卡。想按自己的习惯问问题，点上面「+ 新建技能卡」，
                  或挑一张内置卡「复制为自定义」再改。
                </p>
              )}
            </div>
          </Panel>

          {/* ---- 右：详情 + 运行 ---- */}
          <Panel
            title={card ? card.name : '技能卡详情'}
            flush
            actions={
              card && (
                <>
                  {card.builtin ? (
                    <button className="btn btn--sm" onClick={doClone} title="内置卡不能直接改，复制一份再改">
                      复制为自定义
                    </button>
                  ) : (
                    <>
                      <button className="btn btn--sm btn--primary" onClick={doSave} disabled={busy !== null}>
                        {busy === 'save' && <span className="spinner" />}
                        保存
                      </button>
                      <button className="btn btn--sm" onClick={doDelete}>
                        删除
                      </button>
                    </>
                  )}
                </>
              )
            }
          >
            {!card ? (
              <div className="empty">
                <div className="empty__title">左边挑一张技能卡</div>
                <div className="fs-sm" style={{ maxWidth: 460 }}>
                  技能卡回答的是「这几章到底讲了什么、谁跟谁有关系、埋了什么」这类**读书问题**。
                  它不会替你写正文 —— 这是这套工具的底线。
                </div>
              </div>
            ) : (
              <div className="skill__detail">
                {card.scene && (
                  <div className="skill__scene">
                    <span className="chip chip--accent">适用</span> {card.scene}
                    {card.builtin && <span className="chip" style={{ marginLeft: 8 }}>内置</span>}
                  </div>
                )}

                <label className="fs-xs faint">名字</label>
                <input
                  className="input"
                  value={draft.name}
                  disabled={card.builtin}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                />

                <label className="fs-xs faint">适用场景（一句话说清什么时候用它）</label>
                <input
                  className="input"
                  value={draft.scene}
                  disabled={card.builtin}
                  onChange={(e) => setDraft((d) => ({ ...d, scene: e.target.value }))}
                />

                <label className="fs-xs faint">
                  提示词模板 —— 用 <code>{'{chapter_text}'}</code> 表示正文、
                  <code>{'{entity_roster}'}</code> 表示已有实体名录、
                  <code>{'{focus}'}</code> 表示下面填的补充要求
                </label>
                <textarea
                  className="input skill__tpl"
                  value={draft.template}
                  disabled={card.builtin}
                  onChange={(e) => setDraft((d) => ({ ...d, template: e.target.value }))}
                  spellCheck={false}
                />
                {card.builtin && (
                  <p className="faint fs-xs">
                    内置卡是只读的 —— 点右上「复制为自定义」就能改成你自己的版本。
                  </p>
                )}

                {/* ---- 运行区 ---- */}
                <div className="skill__run">
                  <div className="row row--wrap" style={{ gap: 8 }}>
                    <span className="fs-xs faint">读哪些章：</span>
                    <span className="chip chip--accent">{chLabel}</span>
                    <button
                      className="btn btn--sm"
                      onClick={() => setChNos(new Set(chapters.map((c) => c.chapter_no)))}
                    >
                      全选
                    </button>
                    <button className="btn btn--sm" onClick={() => setChNos(new Set())}>
                      清空
                    </button>
                    <span className="faint fs-xs">不选=全部章 · 共 {chapters.length} 章</span>
                  </div>
                  <div className="row row--wrap skill__chips">
                    {chapters.slice(0, 60).map((c) => (
                      <button
                        key={c.chapter_no}
                        className={`chip skill__ch ${chNos.has(c.chapter_no) ? 'skill__ch--on' : ''}`}
                        onClick={() => toggleCh(c.chapter_no)}
                        title={c.title}
                      >
                        {c.chapter_no}
                      </button>
                    ))}
                    {chapters.length > 60 && <span className="faint fs-xs">…共 {chapters.length} 章</span>}
                  </div>

                  <label className="fs-xs faint">补充要求（可选，会拼进提示词的最后）</label>
                  <input
                    className="input"
                    placeholder="例如：只看打斗场面里出现的角色 / 重点核对时间顺序"
                    value={focus}
                    onChange={(e) => setFocus(e.target.value)}
                  />

                  <div className="row" style={{ gap: 8 }}>
                    <button className="btn btn--primary" onClick={doRun} disabled={busy !== null || !bookId}>
                      {busy === 'run' && <span className="spinner" />}
                      {busy === 'run' ? '正在读…' : '运行这张卡'}
                    </button>
                    <span className="faint fs-xs">
                      正文会发给 AI 服务商；结果只展示，不写进知识库。
                    </span>
                  </div>
                </div>

                {/* ---- 结果 ---- */}
                {result && (
                  <div className="skill__result">
                    <div className="row row--wrap" style={{ gap: 6, marginBottom: 6 }}>
                      <span className="chip chip--accent">
                        {result.model} · {result.tokens.total} tok ≈ ¥{result.cost_cny.toFixed(4)}
                      </span>
                      <span className="chip">读了第 {result.chapters.join('、')} 章</span>
                      {result.truncated && (
                        <span className="chip" style={{ color: 'var(--warn)' }}>
                          篇幅超限已截断 —— 缩小章节范围能读全
                        </span>
                      )}
                    </div>
                    <div className="skill__out">{result.content}</div>
                    <p className="faint fs-xs" style={{ marginTop: 6 }}>
                      {result.readonly_notice}
                    </p>
                  </div>
                )}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </StateGate>
  )
}

function CardRow({ card, active, onClick }: { card: SkillCard; active: boolean; onClick: () => void }) {
  return (
    <button className={`skill__card ${active ? 'skill__card--on' : ''}`} onClick={onClick}>
      <div className="skill__card-name">
        {card.name}
        {card.builtin && <span className="chip fs-xs">内置</span>}
      </div>
      {card.scene && <div className="skill__card-scene">{card.scene}</div>}
    </button>
  )
}
