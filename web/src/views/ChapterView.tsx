/**
 * 章节原文（独立界面）。
 *
 * 这个界面只有两件事，但两件事都必须做对：
 *
 * 1. **导入正文，且导入是唯一一次写入。** 正文一旦落地就成了知识库的「史官」——
 *    后面所有实体、出场记录、出处都指着它。所以这里提供的是「章节列表 + 只读阅读器」，
 *    没有任何「编辑正文」的入口。段落用 `\n\n` 分隔，那是出处定位的锚点。
 *
 * 2. **规则抽取必须先过清单再落盘。** 中文没有空格，规则抽取一定会混进
 *    「卡特疑惑」这类碎片。这里不做静默落盘：候选一条条列出来，带证据、
 *    带出处、带置信度，勾哪条才落哪条。
 *
 * 为什么是规则而不是 AI？因为规则抽取是**可复现**的 —— 同一批章节跑两次，
 * 结果一模一样。AI 那一层等 P3，接口已经留好了。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api/client'
import type {
  AiCandidate,
  AiExtractResult,
  ChapterBrief,
  ChapterData,
  ChapterImportResult,
  ChapterListData,
  ChapterPreviewResult,
  ExtractCandidate,
  ExtractResult,
  LintVerdict,
  TypeOption,
} from '../api/types'
import { useApp } from '../state/store'
import { useJobs } from '../state/jobs'
import { Panel } from '../components/Panel'
import { StateGate } from '../components/Toast'
import { AiMonitorChip } from '../components/AiMonitorChip'
import { typeColorVar } from '../graph/types'
import { splitList } from '../lib/format'

type Mode = 'list' | 'review'

/** 候选项在清单里的可变状态（名字/类型/方法论/是否保留都能改） */
interface CandidateRow {
  name: string
  type: string
  keep: boolean
  confidence: number
  count: number
  reasons: string[]
  chapters: number[]
  samples: string[]
  first_at: { chapter_no: number; para: number } | null
  exists: boolean
  entity_id: string | null
  /** 文本形式，方便直接改；落盘时再切成数组 */
  meth: string
  /** 抽取给出的证据，用于在界面上说明「为什么挂这条」 */
  methEvidence: ExtractCandidate['methodology_evidence']
  /** 这条候选是哪台引擎捞的：rule / ai / both（双引擎都报到） */
  source?: 'rule' | 'ai' | 'both'
  /** AI 给的一句话摘要（落盘时可带走） */
  summary?: string
  /** 体检判定 —— 疑似非名词性片段（低头 / 赶紧 / 啊啊啊），默认不勾且标红 */
  lint?: LintVerdict
}

const fmtWords = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n} 字`)

export function ChapterView() {
  const { bookId, notify, refresh, openEntity, types, entities, dataVersion } = useApp()
  // 长活儿一律走异步任务（P11-A3）：进度、停止、续跑都由任务中心统一管
  const { submitImport, submitAiExtract, waitFor: waitJob } = useJobs()

  const [data, setData] = useState<ChapterListData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('list')

  // 阅读器
  const [current, setCurrent] = useState<ChapterData | null>(null)
  const [reading, setReading] = useState(false)

  // 导入
  const fileRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<File[]>([])
  const [overwrite, setOverwrite] = useState(false)
  const [preview, setPreview] = useState<ChapterPreviewResult | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [importResult, setImportResult] = useState<ChapterImportResult | null>(null)
  const [busy, setBusy] = useState<'import' | 'preview' | 'extract' | 'ai' | 'commit' | 'delete' | null>(null)

  // 抽取
  const [result, setResult] = useState<ExtractResult | null>(null)
  const [rows, setRows] = useState<CandidateRow[]>([])
  const [updateExisting, setUpdateExisting] = useState(false)
  const [batchMeth, setBatchMeth] = useState('')
  const [pickedChapters, setPickedChapters] = useState<Set<number>>(new Set())
  const [commitMsg, setCommitMsg] = useState<string | null>(null)

  // AI 抽取（P2 AI 层）：结果与规则候选合并进同一份清单
  const [aiResult, setAiResult] = useState<AiExtractResult | null>(null)
  const [fsPicked, setFsPicked] = useState<Set<number>>(new Set())
  const [fsMsg, setFsMsg] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!bookId) return
    setLoading(true)
    setError(null)
    api
      .listChapters(bookId)
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }, [bookId, dataVersion])

  useEffect(load, [load])

  // ---- 导入 ----------------------------------------------------------

  const pickFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return
    const arr = Array.from(files)
    setPending(arr)
    setImportResult(null)
    setProgress(null)
    setPreview(null)
    // 选完立刻预检（只解析不落盘）：冲突在导入**之前**就标红，
    // 而不是导入完才发现「呀，这章已经有了」
    if (bookId) {
      setBusy('preview')
      api
        .previewImportChapters(bookId, arr)
        .then(setPreview)
        .catch((e) => notify('err', `预检失败：${(e as Error).message}`))
        .finally(() => setBusy(null))
    }
  }

  const clearPending = () => {
    setPending([])
    setPreview(null)
    setProgress(null)
    if (fileRef.current) fileRef.current.value = ''
    if (dirRef.current) dirRef.current.value = ''
  }

  const doImport = async () => {
    if (!bookId || pending.length === 0) return
    setBusy('import')
    setImportResult(null)
    setProgress(0)
    try {
      // 排成后台任务（P11-A3）：上传完就能走开，进度与「停止 / 续跑」在任务中心。
      // 文件先落到任务暂存目录，所以哪怕中途关掉程序，重启后也能接着导。
      const job = await submitImport(bookId, pending, overwrite, setProgress)
      setProgress(null)
      notify('info', `已排入任务中心：${job.title}`)
      const done = await waitJob(job.id)
      if (done.status !== 'done') {
        notify(
          done.status === 'cancelled' ? 'info' : 'err',
          done.status === 'cancelled'
            ? '导入已停止 —— 已入库的章保留着，再点一次「导入」会跳过它们只补没进去的'
            : `导入失败：${done.error ?? done.message}`,
        )
        return
      }
      const r = done.result as unknown as ChapterImportResult
      setImportResult(r)
      // 断点续跑：解析失败的留在待导入列表里 —— 修好文件后再点一次「导入」
      // 就只补这些；已成功的章重传也会自动跳过，不会重复入库
      const failedNames = new Set(r.errors.map((e) => e.file))
      setPending(pending.filter((f) => failedNames.has(f.name)))
      setPreview(null)
      if (failedNames.size === 0) clearPending()
      notify(
        r.failed ? 'err' : 'ok',
        `导入 ${r.imported} 章，跳过 ${r.skipped} 章${r.failed ? `，失败 ${r.failed} 章（已留在列表里可重试）` : ''}`,
      )
      load()
    } catch (e) {
      notify('err', `导入没能排上队：${(e as Error).message}`)
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  const openChapter = async (no: number) => {
    if (!bookId) return
    setReading(true)
    try {
      setCurrent(await api.getChapter(bookId, no))
    } catch (e) {
      notify('err', `读不出这一章：${(e as Error).message}`)
    } finally {
      setReading(false)
    }
  }

  const removeChapter = async (no: number) => {
    if (!bookId) return
    if (!window.confirm(`删掉第 ${no} 章的正文？档案里的实体不会动，但它们的出处会指向一个不存在的章节。`)) {
      return
    }
    setBusy('delete')
    try {
      await api.deleteChapter(bookId, no)
      notify('ok', `已删除第 ${no} 章`)
      if (current?.chapter_no === no) setCurrent(null)
      load()
    } catch (e) {
      notify('err', `删除失败：${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  // ---- 抽取 ----------------------------------------------------------

  const pickChapter = (no: number) =>
    setPickedChapters((prev) => {
      const next = new Set(prev)
      if (next.has(no)) next.delete(no)
      else next.add(no)
      return next
    })

  const doExtract = async () => {
    if (!bookId) return
    setBusy('extract')
    setCommitMsg(null)
    try {
      const r = await api.extractCandidates(bookId, Array.from(pickedChapters))
      setResult(r)
      setRows(
        r.candidates.map((c: ExtractCandidate) => ({
          name: c.name,
          type: c.type,
          // 默认只勾「新候选」，且**跳过体检判为疑似垃圾的**（低头 / 赶紧 / 啊啊啊）：
          // 这样即便有人不逐条看、直接点确认，垃圾也不会跟着落盘。
          keep: !c.exists && !(c.lint && !c.lint.ok),
          confidence: c.confidence,
          count: c.count,
          reasons: c.reasons,
          chapters: c.chapters,
          samples: c.samples,
          first_at: c.first_at,
          exists: c.exists,
          entity_id: c.entity_id,
          meth: (c.methodologies ?? []).join(', '),
          methEvidence: c.methodology_evidence ?? {},
          source: 'rule',
          lint: c.lint,
        })),
      )
      setMode('review')
      notify(
        'ok',
        `扫了 ${r.stats.chapters} 章 / ${fmtWords(r.stats.chars)}，捞出 ${r.stats.candidates} 条候选`,
      )
    } catch (e) {
      notify('err', `抽取失败：${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const patchRow = (i: number, patch: Partial<CandidateRow>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  // ---- AI 抽取 --------------------------------------------------------
  // 双引擎合并：AI 候选与规则候选进同一份清单。同名的合并证据，
  // 标「双引擎」；AI 独有的标「AI」。落盘仍走同一个人工确认。

  const mergeAiCandidates = (cands: AiCandidate[]) => {
    setRows((prev) => {
      const next = [...prev]
      for (const c of cands) {
        const idx = next.findIndex((r) => r.name === c.name)
        if (idx >= 0) {
          const r = next[idx]
          next[idx] = {
            ...r,
            confidence: Math.max(r.confidence, c.confidence),
            reasons: [...r.reasons, ...c.reasons.filter((x) => !r.reasons.includes(x))],
            samples: Array.from(new Set([...r.samples, ...c.samples])).slice(0, 4),
            meth: r.meth.trim() || (c.methodologies ?? []).join(', '),
            summary: r.summary || c.summary,
            source: 'both',
          }
        } else {
          next.push({
            name: c.name,
            type: c.type,
            keep: !c.exists && !(c.lint && !c.lint.ok),
            confidence: c.confidence,
            count: c.count,
            reasons: c.reasons,
            chapters: c.chapters,
            samples: c.samples,
            first_at: c.first_at,
            exists: c.exists,
            entity_id: c.entity_id,
            meth: (c.methodologies ?? []).join(', '),
            methEvidence: c.methodology_evidence ?? {},
            summary: c.summary,
            source: 'ai',
            lint: c.lint,
          })
        }
      }
      return next
    })
  }

  const doAiExtract = async () => {
    if (!bookId) return
    setBusy('ai')
    setCommitMsg(null)
    setFsMsg(null)
    try {
      // 排成后台任务（P11-A3）：一本 30 章的书要十几分钟，同步等会被浏览器超时掐掉，
      // 也看不出跑到第几章。异步之后能看进度、能停、断了能只补没跑完的章。
      const job = await submitAiExtract(bookId, Array.from(pickedChapters))
      setBusy(null)
      notify('info', `已排入任务中心：${job.title}（可离开这一页，跑完会来通知）`)
      const done = await waitJob(job.id)
      if (done.status !== 'done') {
        notify(
          done.status === 'cancelled' ? 'info' : 'err',
          done.status === 'cancelled'
            ? 'AI 抽取已停止 —— 已跑完的章保留着，点「续跑」只补没跑完的（不会重复花钱）'
            : `AI 抽取失败：${done.error ?? done.message}`,
        )
        return
      }
      const r = done.result as unknown as AiExtractResult
      setAiResult(r)
      mergeAiCandidates(r.candidates)
      setFsPicked(new Set(r.foreshadow.map((_, i) => i)))
      setMode('review')
      const t = r.totals
      notify(
        t.chapters_failed ? 'err' : 'ok',
        `AI 跑完 ${t.chapters_run} 章：${r.candidates.length} 候选 / ${r.changes.length} 变更 / ${r.foreshadow.length} 伏笔` +
          ` · ${t.tokens.toLocaleString()} tok${t.cost_cny > 0 ? ` ≈ ¥${t.cost_cny.toFixed(4)}` : ''}` +
          (t.chapters_failed ? ` · ${t.chapters_failed} 章失败` : ''),
      )
    } catch (e) {
      notify('err', `AI 抽取没能排上队：${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const doCommitForeshadow = async () => {
    if (!bookId || !aiResult) return
    const items = aiResult.foreshadow
      .filter((_, i) => fsPicked.has(i))
      .map((f) => ({ content: f.content, chapter_no: f.chapter_no, para: f.para ?? undefined }))
    if (!items.length) {
      notify('info', '一条伏笔都没勾')
      return
    }
    setBusy('commit')
    try {
      const r = await api.commitForeshadow(bookId, items)
      setFsMsg(`已写入伏笔看板 ${r.added} 条${r.skipped ? `，${r.skipped} 条重复跳过` : ''}`)
      notify('ok', `伏笔落盘 ${r.added} 条`)
      // 落过盘的从清单里移掉
      setAiResult({
        ...aiResult,
        foreshadow: aiResult.foreshadow.filter((_, i) => !fsPicked.has(i)),
      })
      setFsPicked(new Set())
    } catch (e) {
      notify('err', `伏笔落盘失败：${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const doCommit = async () => {
    if (!bookId) return
    const picked = rows.filter((r) => r.keep && r.name.trim())
    if (!picked.length) {
      notify('info', '一条都没勾选，没什么可落盘的')
      return
    }
    const batch = splitList(batchMeth)
    setBusy('commit')
    try {
      const r = await api.commitExtraction(
        bookId,
        picked.map((p) => {
          // 每条自己的（抽取给的 + 手工改的）与「这批统一挂」的合并去重
          const own = splitList(p.meth)
          const merged = Array.from(new Set([...own, ...batch]))
          return {
            name: p.name.trim(),
            type: p.type,
            methodologies: merged.length ? merged : undefined,
            chapters: p.chapters,
            first_at: p.first_at,
          }
        }),
        updateExisting,
      )
      const extra = r.skipped ? `，跳过 ${r.skipped} 条` : ''
      const reason = r.skipped_items.slice(0, 4).map((s) => `${s.name}（${s.reason}）`).join('、')
      setCommitMsg(`落盘 ${r.created} 条${extra}${reason ? ` —— ${reason}${r.skipped > 4 ? ' …' : ''}` : ''}`)
      notify('ok', `已落盘 ${r.created} 条实体${extra}`)
      await refresh()
      load()
    } catch (e) {
      notify('err', `落盘失败：${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  // ---- 派生 ----------------------------------------------------------

  const chapters = data?.items ?? []
  const existingCount = rows.filter((r) => r.exists).length
  const keptCount = rows.filter((r) => r.keep).length
  const lowConf = useMemo(() => rows.filter((r) => r.confidence < 0.35).length, [rows])
  /** 体检判为「疑似非名词性片段」的候选数 —— 默认就不勾，全选也会跳过 */
  const suspectCount = useMemo(() => rows.filter((r) => r.lint && !r.lint.ok).length, [rows])
  const scopeLabel = pickedChapters.size ? `第 ${Array.from(pickedChapters).sort((a, b) => a - b).join('、')} 章` : '全部章节'

  // ---- 渲染 ----------------------------------------------------------

  return (
    <StateGate loading={loading && !data} error={error}>
      <div className="chap">
        <div className="chap__bar">
          <div className="chap__nums">
            <span className="chap__num">
              <b>{data?.stats.chapters ?? 0}</b> 章
            </span>
            <span className="chap__sep" />
            <span className="chap__num">
              <b>{fmtWords(data?.stats.words ?? 0)}</b> 正文
            </span>
            {data && data.stats.chapters > 0 && (
              <>
                <span className="chap__sep" />
                <span className="chap__num" title={data.dir}>
                  <b>{Math.round((data.stats.words ?? 0) / Math.max(1, data.stats.chapters))}</b> 字/章
                </span>
              </>
            )}
          </div>
          <div className="chap__actions">
            <div className="seg">
              <button
                className={`seg__item ${mode === 'list' ? 'seg__item--on' : ''}`}
                onClick={() => setMode('list')}
              >
                章节
              </button>
              <button
                className={`seg__item ${mode === 'review' ? 'seg__item--on' : ''}`}
                onClick={() => setMode('review')}
              >
                待确认清单{rows.length ? ` · ${rows.length}` : ''}
              </button>
            </div>
            <button className="btn btn--sm" onClick={() => fileRef.current?.click()}>
              选文件
            </button>
            <button className="btn btn--sm" onClick={() => dirRef.current?.click()} title="整目录导入（P3 批量）">
              选目录
            </button>
            <AiMonitorChip />
            <button
              className="btn btn--primary btn--sm"
              disabled={busy !== null || !chapters.length}
              onClick={doExtract}
            >
              {busy === 'extract' && <span className="spinner" />}
              跑规则抽取
            </button>
            <button
              className="btn btn--primary btn--sm"
              disabled={busy !== null || !chapters.length}
              onClick={doAiExtract}
              title="把选中章的正文发给 AI 服务商抽取（未发表作品会出本机，介意见后台 AI 配置）。结果与规则候选合并进同一份待确认清单。"
            >
              {busy === 'ai' && <span className="spinner" />}
              跑 AI 抽取
            </button>
          </div>
        </div>

        {/* ---- 导入区 ---- */}
        <Panel
          title="导入正文"
          actions={
            <>
              <label className="row fs-xs muted" style={{ gap: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={overwrite}
                  onChange={(e) => setOverwrite(e.target.checked)}
                />
                覆盖同章号
              </label>
              <button
                className="btn btn--primary btn--sm"
                disabled={busy !== null || pending.length === 0}
                onClick={doImport}
              >
                {busy === 'import' && <span className="spinner" />}
                导入 {pending.length || ''} 个文件
                {preview && preview.new > 0 && pending.length > 0 ? `（${preview.new} 新增）` : ''}
              </button>
            </>
          }
        >
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".docx,.txt,.md,.markdown"
            style={{ display: 'none' }}
            onChange={(e) => pickFiles(e.target.files)}
          />
          <input
            ref={dirRef}
            type="file"
            multiple
            {...{ webkitdirectory: '' }}
            style={{ display: 'none' }}
            onChange={(e) => pickFiles(e.target.files)}
          />

          <div
            className="chap__drop"
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              e.currentTarget.classList.add('chap__drop--hot')
            }}
            onDragLeave={(e) => e.currentTarget.classList.remove('chap__drop--hot')}
            onDrop={(e) => {
              e.preventDefault()
              e.currentTarget.classList.remove('chap__drop--hot')
              pickFiles(e.dataTransfer.files)
            }}
          >
            <b>把正文拖进来</b>
            <span className="faint fs-xs">
              支持 .docx / .txt / .md —— 一个文件算一章，可整批拖入或点「选目录」导入整个文件夹。
              章号与标题优先从正文里的「第X章」认，认不出才退回文件名。
            </span>
          </div>

          {progress !== null && (
            <div className="chap__prog" role="progressbar" aria-valuenow={progress}>
              <span className="chap__prog-fill" style={{ width: `${progress}%` }} />
              <span className="chap__prog-label mono fs-xs">{progress}%</span>
            </div>
          )}

          {busy === 'preview' && (
            <div className="row fs-xs muted" style={{ marginTop: 'var(--p-space-2)' }}>
              <span className="spinner" /> 预检中：解析章号、检查冲突…
            </div>
          )}

          {preview && pending.length > 0 && (
            <div className="chap__prev">
              <div className="row row--wrap">
                <span className="chip" style={{ color: 'var(--ok)' }}>
                  {preview.new} 章新增
                </span>
                {preview.conflicts > 0 && (
                  <span className="chip" style={{ color: 'var(--danger)' }}>
                    {preview.conflicts} 章冲突{overwrite ? '（已勾覆盖，将替换）' : '（未勾覆盖，将跳过）'}
                  </span>
                )}
                {preview.failed > 0 && (
                  <span className="chip" style={{ color: 'var(--danger)' }}>
                    {preview.failed} 个文件无法解析
                  </span>
                )}
                <div className="grow" />
                <button className="btn btn--ghost btn--sm" onClick={clearPending}>
                  清空
                </button>
              </div>
              <div className="chap__prev-list">
                {preview.items.map((it, i) => (
                  <div
                    key={`${it.file}-${i}`}
                    className={`chap__prev-row ${
                      !it.ok || it.exists || it.dup_in_batch ? 'chap__prev-row--conflict' : ''
                    }`}
                  >
                    <span className="chap__prev-file" title={it.file}>
                      {it.file}
                    </span>
                    {it.ok ? (
                      <>
                        <span className="chip mono">第 {it.chapter_no} 章</span>
                        <span className="fs-xs muted grow">{it.title || '（无标题）'}</span>
                        <span className="fs-xs faint mono">{it.word_count} 字</span>
                        {it.dup_in_batch ? (
                          <span className="chip" style={{ color: 'var(--warn)' }} title={`与「${it.dup_in_batch}」都解析成第 ${it.chapter_no} 章，先到的先用`}>
                            批内撞章号
                          </span>
                        ) : it.exists ? (
                          <span className="chip" style={{ color: 'var(--danger)', background: 'var(--danger-soft)' }}>
                            冲突 · 已存在
                          </span>
                        ) : (
                          <span className="chip" style={{ color: 'var(--ok)' }}>
                            新增
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="fs-xs grow" style={{ color: 'var(--danger)' }}>
                        {it.error}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {!preview && busy !== 'preview' && pending.length > 0 && (
            <div className="row row--wrap" style={{ marginTop: 'var(--p-space-2)' }}>
              {pending.map((f, i) => (
                <span key={`${f.name}-${i}`} className="chip">
                  {f.name}
                  <span className="faint"> {(f.size / 1024).toFixed(0)}KB</span>
                </span>
              ))}
              <button className="btn btn--ghost btn--sm" onClick={clearPending}>
                清空
              </button>
            </div>
          )}

          {importResult && (
            <div
              className={`notice ${importResult.failed ? 'notice--danger' : 'notice--ok'}`}
              style={{ marginTop: 'var(--p-space-2)' }}
            >
              <div>
                <div>
                  导入 {importResult.imported} 章 · 跳过 {importResult.skipped} 章 · 失败{' '}
                  {importResult.failed} 章
                </div>
                {importResult.skipped_items.slice(0, 5).map((s, i) => (
                  <div key={i} className="fs-xs">
                    跳过 {s.file}：{s.reason}
                  </div>
                ))}
                {importResult.errors.slice(0, 5).map((s, i) => (
                  <div key={i} className="fs-xs">
                    失败 {s.file}：{s.error}
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="faint fs-xs" style={{ marginTop: 'var(--p-space-2)' }}>
            导入是**唯一一次写正文**。之后正文只读 —— 抽取、出场记录都只写档案文件，不动章节一个字。
            批量导入中断或部分失败不用怕：重传同一批文件即可续跑，已入库的章会自动跳过。
          </p>
        </Panel>

        {/* ---- 章节列表 + 阅读器 ---- */}
        {mode === 'list' && (
          <div className="chap__split">
            <Panel
              title={`章节${chapters.length ? ` · ${chapters.length}` : ''}`}
              flush
              actions={
                <>
                  <button
                    className="btn btn--sm"
                    onClick={() => setPickedChapters(new Set(chapters.map((c) => c.chapter_no)))}
                  >
                    全选
                  </button>
                  <button className="btn btn--sm" onClick={() => setPickedChapters(new Set())}>
                    清空
                  </button>
                  <span className="faint fs-xs">选中范围：{scopeLabel}</span>
                </>
              }
            >
              {chapters.length === 0 ? (
                <p className="empty">
                  还没有正文。上面「把正文拖进来」导入第一章 —— 导入之后，实体、出场记录、
                  出处才有地方可指。
                </p>
              ) : (
                <div className="table-wrap chap__table">
                  <table className="etable">
                    <thead>
                      <tr>
                        <th style={{ width: 34 }} />
                        <th style={{ width: 62 }}>章</th>
                        <th>标题</th>
                        <th style={{ width: 96 }}>卷</th>
                        <th style={{ width: 84 }}>字数</th>
                        <th style={{ width: 62 }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {chapters.map((c: ChapterBrief) => {
                        const on = pickedChapters.has(c.chapter_no)
                        return (
                          <tr
                            key={c.chapter_no}
                            className={current?.chapter_no === c.chapter_no ? 'is-on' : ''}
                          >
                            <td onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={() => pickChapter(c.chapter_no)}
                                title="勾选 = 只对这些章跑抽取"
                              />
                            </td>
                            <td className="mono fs-xs" onClick={() => openChapter(c.chapter_no)}>
                              {c.chapter_no}
                            </td>
                            <td className="etable__name" onClick={() => openChapter(c.chapter_no)}>
                              {c.title || <span className="faint">（无标题）</span>}
                            </td>
                            <td className="muted fs-xs" onClick={() => openChapter(c.chapter_no)}>
                              {c.volume || <span className="faint">—</span>}
                            </td>
                            <td className="mono fs-xs" onClick={() => openChapter(c.chapter_no)}>
                              {c.word_count}
                            </td>
                            <td onClick={(e) => e.stopPropagation()}>
                              <button
                                className="btn btn--ghost btn--sm"
                                disabled={busy !== null}
                                onClick={() => removeChapter(c.chapter_no)}
                                title="只删章节文件，不删实体"
                              >
                                删
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <Panel
              title={
                current ? (
                  <span>
                    第 {current.chapter_no} 章 · {current.title}
                  </span>
                ) : (
                  '正文'
                )
              }
              actions={
                current && (
                  <span className="row">
                    <span className="chip">{current.word_count} 字</span>
                    {current.volume && <span className="chip">{current.volume}</span>}
                    <span className="chip faint" title={current.source_file}>
                      源 {current.source_file || '—'}
                    </span>
                  </span>
                )
              }
            >
              {reading ? (
                <div className="empty">
                  <span className="spinner" />
                  读取中…
                </div>
              ) : current ? (
                <div className="chap__reader">
                  {current.text.split('\n\n').map((p, i) => (
                    <p key={i} className="chap__para">
                      <span className="chap__para-no mono" title="段落号 —— 档案里的出处就指这个">
                        {i + 1}
                      </span>
                      {p}
                    </p>
                  ))}
                </div>
              ) : (
                <div className="empty">
                  <div className="empty__title">左边点一章看正文</div>
                  <div className="fs-sm" style={{ maxWidth: 380 }}>
                    这里只读。段号标在每段前面 —— 实体档案里的「出处」指的就是
                    「第几章第几段」，所以段落的切分不能变。
                  </div>
                </div>
              )}
            </Panel>
          </div>
        )}

        {/* ---- 待确认清单 ---- */}
        {mode === 'review' && (
          <Panel
            title="待确认变更清单"
            flush
            actions={
              rows.length > 0 && (
                <>
                  <button
                    className="btn btn--sm"
                    onClick={() => setRows((p) => p.map((r) => ({ ...r, keep: !(r.lint && !r.lint.ok) })))}
                    title={
                      suspectCount > 0
                        ? `勾上全部候选，但会自动跳过 ${suspectCount} 条体检判为疑似垃圾的`
                        : '勾上全部候选'
                    }
                  >
                    全选{suspectCount > 0 ? `（跳过 ${suspectCount} 条疑似）` : ''}
                  </button>
                  <button className="btn btn--sm" onClick={() => setRows((p) => p.map((r) => ({ ...r, keep: false })))}>
                    全不选
                  </button>
                  <button
                    className="btn btn--sm"
                    onClick={() => setRows((p) => p.map((r) => ({ ...r, keep: !r.exists && !(r.lint && !r.lint.ok) })))}
                  >
                    只选新候选
                  </button>
                  <button
                    className="btn btn--sm"
                    onClick={() => setRows((p) => p.filter((r) => !r.keep))}
                    title="把没勾的从清单里移掉，剩下的看得清"
                  >
                    隐藏未勾选
                  </button>
                </>
              )
            }
          >
            {!result && !aiResult ? (
              <div className="empty">
                <div className="empty__title">还没跑过抽取</div>
                <div className="fs-sm" style={{ maxWidth: 420 }}>
                  先在上面「章节」里勾选要抽的章（不勾就是全部），再点「跑规则抽取」或「跑 AI 抽取」。
                  两台引擎的候选会合并进同一份清单 —— 抽出来的是**候选**，一条都不会自己落盘。
                </div>
              </div>
            ) : (
              <>
                <div className="row row--wrap" style={{ padding: '0 var(--p-space-3) var(--p-space-2)' }}>
                  {result && (
                    <span className="chip chip--accent">
                      规则扫过 {result.stats.chapters} 章 · {fmtWords(result.stats.chars)}
                    </span>
                  )}
                  {aiResult && (
                    <span className="chip chip--accent">
                      AI 跑过 {aiResult.totals.chapters_run} 章 · {aiResult.totals.tokens.toLocaleString()} tok
                      {aiResult.totals.cost_cny > 0 && ` ≈ ¥${aiResult.totals.cost_cny.toFixed(4)}`}
                    </span>
                  )}
                  <span className="chip">{rows.length} 条候选</span>
                  {existingCount > 0 && (
                    <span className="chip">其中 {existingCount} 条已存在</span>
                  )}
                  {suspectCount > 0 && (
                    <span className="chip" style={{ color: 'var(--warn)' }}>
                      {suspectCount} 条疑似垃圾（已默认不勾）
                    </span>
                  )}
                  {lowConf > 0 && (
                    <span className="chip" style={{ color: 'var(--warn)' }}>
                      {lowConf} 条低置信
                    </span>
                  )}
                  <div className="grow" />
                  <span className="faint fs-xs">
                    已勾选 {keptCount} / {rows.length}
                  </span>
                  {/* 决定「已存在」怎么处理的关键开关 —— 放在最上面，
                      而不是藏在底部按钮堆里让人以为没有下一步 */}
                  {existingCount > 0 && (
                    <label className="fs-xs row chap__upd" style={{ gap: 4, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={updateExisting}
                        onChange={(e) => setUpdateExisting(e.target.checked)}
                      />
                      已存在的也更新（补出处与出场记录）
                    </label>
                  )}
                </div>

                <div className="review-list chap__review">
                  {(() => {
                    // 分区展示：新建 / 已存在。重跑抽取时几乎全是「已存在」，
                    // 不分区的话满屏「已有档案 →」，真正的新候选反而被淹没，
                    // 底部按钮又灰着 —— 看起来就是「没有下一步」。
                    const pairs = rows.map((r, i) => ({ r, i }))
                    const fresh = pairs.filter((p) => !p.r.exists)
                    const exist = pairs.filter((p) => p.r.exists)
                    const row = (r: CandidateRow, i: number) => (
                    <div
                      key={`${r.name}-${i}`}
                      className={`review-item ${r.exists ? 'review-item--conflict' : ''} ${
                        r.lint && !r.lint.ok ? 'review-item--junk' : ''
                      } ${r.keep ? '' : 'review-item--skip'}`}
                    >
                      <input
                        type="checkbox"
                        checked={r.keep}
                        onChange={(e) => patchRow(i, { keep: e.target.checked })}
                        style={{ marginTop: 4 }}
                      />

                      <div className="grow">
                        <div className="row row--wrap">
                          <input
                            className="input chap__name"
                            value={r.name}
                            onChange={(e) => patchRow(i, { name: e.target.value })}
                            aria-label="候选名字"
                          />
                          <select
                            className="select chap__type"
                            value={r.type}
                            onChange={(e) => patchRow(i, { type: e.target.value })}
                            aria-label="候选类型"
                          >
                            {types.map((t: TypeOption) => (
                              <option key={t.key} value={t.key}>
                                {t.label}
                              </option>
                            ))}
                          </select>
                          <ConfBar v={r.confidence} />
                          {r.lint && !r.lint.ok && (
                            <span
                              className="chip fs-xs"
                              style={{ color: 'var(--warn)' }}
                              title={`体检判定：${r.lint.reason ?? '疑似非名词性片段'}`}
                            >
                              ⚠ 疑似垃圾{ r.lint.reason ? ` · ${r.lint.reason}` : '' }
                            </span>
                          )}
                          <span
                            className="chip fs-xs"
                            style={
                              r.source === 'ai'
                                ? { color: 'var(--accent)' }
                                : r.source === 'both'
                                  ? { color: 'var(--ok)' }
                                  : undefined
                            }
                            title={
                              r.source === 'ai'
                                ? '这条是 AI 引擎捞的'
                                : r.source === 'both'
                                  ? '规则与 AI 都报到了这条（证据已合并）'
                                  : '这条是规则引擎捞的（可复现）'
                            }
                          >
                            {r.source === 'ai' ? 'AI' : r.source === 'both' ? '双引擎' : '规则'}
                          </span>
                          <span className="chip">出现 {r.count} 次</span>
                          {r.first_at && (
                            <span className="chip chip--accent">
                              首现 第{r.first_at.chapter_no}章 · 第{r.first_at.para}段
                            </span>
                          )}
                          {r.exists && (
                            <button
                              className="chip"
                              style={{ border: 0, cursor: 'pointer', color: 'var(--accent)' }}
                              onClick={() => r.entity_id && openEntity(r.entity_id)}
                              title="这条已经有档案了，点开看看"
                            >
                              已有档案 →
                            </button>
                          )}
                        </div>

                        {r.samples.length > 0 && (
                          <div className="chap__samples">
                            {r.samples.slice(0, 3).map((s, j) => (
                              <div key={j} className="fs-xs faint chap__sample">
                                …{s}…
                              </div>
                            ))}
                          </div>
                        )}

                        <div className="chap__meth-row">
                          <span className="chap__meth-label" title="这个角色信奉/遵循的哲学观、戒律、主义">
                            方法论
                          </span>
                          <input
                            className="input chap__meth"
                            placeholder="逗号分隔；抽取到的会自动填在这里"
                            value={r.meth}
                            onChange={(e) => patchRow(i, { meth: e.target.value })}
                            aria-label="方法论标签"
                          />
                          {r.meth.trim() &&
                            splitList(r.meth).map((m) => {
                              const ev = r.methEvidence[m]
                              return (
                                <span
                                  key={m}
                                  className={`chip ${ev?.strong ? 'chip--accent' : ''}`}
                                  title={
                                    ev
                                      ? `${ev.strong ? '明确表态' : '同句提及'} ×${ev.count}｜第${ev.chapter_no}章第${ev.para}段：${ev.sentence}`
                                      : '手工填的，没有抽取证据'
                                  }
                                >
                                  {ev?.strong ? '★ ' : ''}
                                  {m}
                                  {ev && <span className="faint"> ×{ev.count}</span>}
                                </span>
                              )
                            })}
                          {batchMeth.trim() && (
                            <span className="faint fs-xs">落盘时会叠加上「{batchMeth.trim()}」</span>
                          )}
                        </div>

                        <div className="review-item__meta">
                          {r.reasons.map((why) => (
                            <span key={why} className="chip">
                              {why}
                            </span>
                          ))}
                          {r.chapters.slice(0, 8).map((c) => (
                            <span key={c} className="chip faint">
                              第{c}章
                            </span>
                          ))}
                          {r.chapters.length > 8 && (
                            <span className="chip faint">…共 {r.chapters.length} 章</span>
                          )}
                        </div>
                      </div>

                      <div className="chap__row-right">
                        <i
                          className="chap__dot"
                          style={{ background: typeColorVar(r.type) }}
                          title={r.type}
                        />
                      </div>
                    </div>
                    )
                    return (
                      <>
                        {fresh.length > 0 && (
                          <div className="review-sec">
                            <div className="review-sec__head">
                              新建 {fresh.length} 条 —— 落盘会创建实体档案
                            </div>
                            {fresh.map(({ r, i }) => row(r, i))}
                          </div>
                        )}
                        {exist.length > 0 && (
                          <div className="review-sec">
                            <div className="review-sec__head review-sec__head--dim">
                              已存在 {exist.length} 条 —— 默认不勾；勾选＝落盘时给已有实体补出处与出场记录
                            </div>
                            {exist.map(({ r, i }) => row(r, i))}
                          </div>
                        )}
                      </>
                    )
                  })()}
                </div>

                {/* ---- AI 专區：逐章状态 / 实体变更 / 伏笔 ---- */}
                {aiResult && (
                  <div className="chap__ai">
                    <div className="row row--wrap">
                      {aiResult.per_chapter.map((p) => (
                        <span
                          key={p.chapter_no}
                          className="chip fs-xs"
                          style={p.status === 'error' || p.status === 'budget_stop' ? { color: 'var(--danger)' } : undefined}
                          title={
                            p.error
                              ? p.error
                              : `${p.provider}/${p.model} · 提示词 v${p.prompt_version} · ${p.candidates} 候选 ${p.changes} 变更 ${p.foreshadow} 伏笔`
                          }
                        >
                          第{p.chapter_no}章
                          {p.status === 'cache' && ' · 缓存'}
                          {p.status === 'error' && ' · 失败'}
                          {p.status === 'budget_stop' && ' · 预算刹车'}
                          {p.tokens ? ` · ${p.tokens.toLocaleString()}tok` : ''}
                          {p.cost_cny ? ` ¥${p.cost_cny.toFixed(4)}` : ''}
                        </span>
                      ))}
                      <span className="faint fs-xs">{aiResult.privacy_hint}</span>
                    </div>

                    {aiResult.changes.length > 0 && (
                      <div className="chap__changes">
                        <div className="fs-sm" style={{ marginBottom: 4 }}>
                          <b>已有实体的新变化（{aiResult.changes.length}）</b>
                          <span className="faint fs-xs">
                            {' '}
                            —— AI 只报告不落盘；点「打开实体」核对着改
                          </span>
                        </div>
                        {aiResult.changes.map((c, i) => {
                          // 变更只有名字，按名字找到实体给个入口 ——
                          // 不给入口的话这里就是一句死文案，看完还是「没有然后」
                          const hit = entities.find((e) => e.name === c.name)
                          return (
                            <div key={i} className="chap__change fs-xs">
                              <span className="chip">{c.name}</span>
                              <span className="muted">{c.field}：{c.detail}</span>
                              {c.para && (
                                <span className="chip chip--accent">第{c.chapter_no}章 · 第{c.para}段</span>
                              )}
                              {hit && (
                                <button
                                  className="chip"
                                  style={{ border: 0, cursor: 'pointer', color: 'var(--accent)' }}
                                  onClick={() => openEntity(hit.id)}
                                  title="打开实体档案，核对这个变化"
                                >
                                  打开实体 →
                                </button>
                              )}
                              {c.evidence && <div className="faint chap__sample">…{c.evidence}…</div>}
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {aiResult.foreshadow.length > 0 && (
                      <div className="chap__foreshadow">
                        <div className="row fs-sm" style={{ marginBottom: 4 }}>
                          <b>伏笔候选（{aiResult.foreshadow.length}）</b>
                          <div className="grow" />
                          <button
                            className="btn btn--sm"
                            disabled={busy !== null || fsPicked.size === 0}
                            onClick={doCommitForeshadow}
                          >
                            写入伏笔看板 {fsPicked.size || ''} 条
                          </button>
                        </div>
                        {aiResult.foreshadow.map((f, i) => (
                          <label key={i} className="chap__fs fs-xs" style={{ cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={fsPicked.has(i)}
                              onChange={() =>
                                setFsPicked((prev) => {
                                  const next = new Set(prev)
                                  if (next.has(i)) next.delete(i)
                                  else next.add(i)
                                  return next
                                })
                              }
                            />
                            <span>{f.content}</span>
                            <span className="chip chip--accent">
                              第{f.chapter_no}章{f.para ? ` · 第${f.para}段` : ''}
                            </span>
                            {f.evidence && <span className="faint chap__sample">…{f.evidence}…</span>}
                          </label>
                        ))}
                        {fsMsg && <div className="notice notice--ok fs-sm">{fsMsg}</div>}
                      </div>
                    )}
                  </div>
                )}

                <div className="chap__foot">
                  <div className="row row--wrap">
                    <span className="chap__sep" />
                    <label className="fs-xs muted row" style={{ gap: 4 }}>
                      这批统一挂方法论
                      <input
                        className="input chap__meth"
                        placeholder="如：晨曦主义, 圣光戒律"
                        value={batchMeth}
                        onChange={(e) => setBatchMeth(e.target.value)}
                      />
                    </label>
                  </div>

                  {commitMsg && <div className="notice notice--ok fs-sm">{commitMsg}</div>}

                  {keptCount === 0 && rows.length > 0 && (
                    <div className="notice notice--warn fs-sm row row--wrap">
                      <span className="grow">
                        {existingCount === rows.length
                          ? `一条都没勾 —— 本轮 ${existingCount} 条候选全部对应已存在的实体（默认不勾，防止重复建档），所以「确认落盘」是灰的。`
                          : '一条都没勾 —— 清单里勾选想落盘的候选（新建的默认已勾，被你取消掉了）。'}
                      </span>
                      {existingCount > 0 && (
                        <button
                          className="btn btn--sm"
                          onClick={() => {
                            setUpdateExisting(true)
                            setRows((p) => p.map((r) => ({ ...r, keep: true })))
                          }}
                        >
                          {existingCount === rows.length ? '全部勾选并更新已有实体' : '全部勾选'}
                        </button>
                      )}
                    </div>
                  )}

                  <div className="row">
                    <span className="faint fs-xs grow">
                      落盘会写：实体文件 + frontmatter + 出处（章节 / 段号 / 录入方式 / 置信度）
                      + 首次出场记录。正文一个字都不动。
                    </span>
                    <button
                      className="btn btn--sm"
                      disabled={busy !== null}
                      onClick={() => {
                        setResult(null)
                        setRows([])
                        setCommitMsg(null)
                        setAiResult(null)
                        setFsPicked(new Set())
                        setFsMsg(null)
                      }}
                    >
                      丢掉清单
                    </button>
                    <button
                      className="btn btn--primary"
                      disabled={busy !== null || keptCount === 0}
                      onClick={doCommit}
                    >
                      {busy === 'commit' && <span className="spinner" />}
                      确认落盘 {keptCount} 条
                    </button>
                  </div>
                </div>
              </>
            )}
          </Panel>
        )}
      </div>
    </StateGate>
  )
}

/** 置信度条 —— 只是把数字画出来，别让用户对着 0.42 发呆 */
function ConfBar({ v }: { v: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, v)) * 100)
  const tone = v >= 0.6 ? 'ok' : v >= 0.35 ? 'mid' : 'low'
  return (
    <span className={`conf conf--${tone}`} title={`置信度 ${pct}%`}>
      <span className="conf__track">
        <span className="conf__fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="mono fs-xs">{pct}</span>
    </span>
  )
}

export default ChapterView
