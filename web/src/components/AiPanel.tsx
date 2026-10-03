/** AI 配置面板（后台）：服务商 / 预算 / 成本看板 / 提示词管理。
 *
 * 安全边界（与后端对齐）：
 * - 密钥永远只显示打码形态；输入框留空 = 不改 key
 * - 界面必须告知「正文会外发给服务商」—— 这是未发表作品
 */

import { useCallback, useEffect, useState } from 'react'
import * as api from '../api/client'
import type {
  AiConfig,
  AiPrompt,
  AiPromptVersion,
  AiProviderInfo,
  AiUsage,
} from '../api/types'
import { useApp } from '../state/store'
import { Panel } from './Panel'
import { AiMonitorChip } from './AiMonitorChip'
import { AiGuide } from './AiGuide'

const fmtCny = (v: number) => (v > 0 ? `¥${v.toFixed(v >= 1 ? 2 : 4)}` : '—')
const fmtTok = (v: number) => (v >= 10000 ? `${(v / 10000).toFixed(1)}万` : String(v))

export function AiPanel() {
  const { bookId, notify } = useApp()
  const [cfg, setCfg] = useState<AiConfig | null>(null)
  const [usage, setUsage] = useState<AiUsage | null>(null)
  const [limit, setLimit] = useState('')
  const [warnAt, setWarnAt] = useState('80')
  const [testing, setTesting] = useState<string | null>(null)
  const [newName, setNewName] = useState('')

  const load = useCallback(() => {
    api.getAiConfig().then((c) => {
      setCfg(c)
      setLimit(String(c.budget.monthly_limit_cny || ''))
      setWarnAt(String(c.budget.warn_at_percent ?? 80))
    }).catch((e) => notify('err', `AI 配置读不出来：${(e as Error).message}`))
    api.getAiUsage().then(setUsage).catch(() => undefined)
  }, [notify])

  useEffect(load, [load])

  const saveProvider = async (name: string, patch: Record<string, unknown>) => {
    try {
      await api.saveAiProvider(name, patch)
      notify('ok', `已保存服务商「${name}」`)
      load()
    } catch (e) {
      notify('err', `保存失败：${(e as Error).message}`)
    }
  }

  const testProvider = async (name: string) => {
    setTesting(name)
    try {
      const r = await api.testAiProvider(name)
      notify(r.ok ? 'ok' : 'err',
        r.ok ? `${name} 连通正常（${r.latency_ms}ms）：${r.reply || '正常'}` : `${name} 连不通：${r.error}`)
    } catch (e) {
      notify('err', `测试失败：${(e as Error).message}`)
    } finally {
      setTesting(null)
    }
  }

  const saveBudget = async () => {
    try {
      await api.saveAiBudget({
        monthly_limit_cny: Number(limit) || 0,
        warn_at_percent: Number(warnAt) || 80,
      })
      notify('ok', '预算已保存')
      load()
    } catch (e) {
      notify('err', `预算保存失败：${(e as Error).message}`)
    }
  }

  const addProvider = async () => {
    const name = newName.trim()
    if (!name) return
    await saveProvider(name, { label: name, enabled: false })
    setNewName('')
  }

  return (
    <>
      <Panel
        title="AI 服务商"
        collapsible
        sectionId="admin:ai:provider"
        actions={
          <span className="row">
            <input
              className="input input--sm"
              style={{ width: 130 }}
              placeholder="新服务商名"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button className="btn btn--sm" disabled={!newName.trim()} onClick={addProvider}>
              加一家
            </button>
          </span>
        }
      >
        {/* 小白引导放在最前面：不懂 base_url / key 的人，第一眼要看到的是「去哪弄」，
            而不是一个空的三件套。收起态只有一行，不占版面。 */}
        <AiGuide />
        <div className="notice" style={{ marginBottom: 'var(--p-space-2)' }}>
          <div>
            <b>隐私：</b>跑 AI 抽取时，<b>章节正文会发送给所选服务商</b> —— 这是未发表作品。
            介意的话，日后可以在服务商里加本地 Ollama（正文不出本机）。
            密钥只存本地数据目录，界面永远只显示打码形态。
          </div>
        </div>
        {!cfg || cfg.providers.length === 0 ? (
          <p className="empty">还没有配置服务商。上面输入名字「加一家」，填上 base_url / model / key 就能用。</p>
        ) : (
          <div className="aiprov">
            {cfg.providers.map((p) => (
              <ProviderRow
                key={p.key}
                p={p}
                testing={testing === p.key}
                onSave={saveProvider}
                onTest={testProvider}
                onDefault={async () => {
                  await api.setAiDefault(p.key)
                  notify('ok', `默认服务商已切到「${p.label}」`)
                  load()
                }}
              />
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title="成本与词元"
        collapsible
        sectionId="admin:ai:cost"
        actions={
          <>
            <AiMonitorChip />
            <button className="btn btn--sm" onClick={load}>刷新</button>
          </>
        }
      >
        <div className="row row--wrap" style={{ marginBottom: 'var(--p-space-2)' }}>
          <span className="chip chip--accent">
            本月 {usage ? fmtTok(usage.month.prompt_tokens + usage.month.completion_tokens) : '—'} tok
            {usage && usage.month.cost_cny > 0 && ` ≈ ${fmtCny(usage.month.cost_cny)}`}
          </span>
          <span className="chip">
            累计 {usage ? fmtTok(usage.total.prompt_tokens + usage.total.completion_tokens) : '—'} tok
            {usage && usage.total.cost_cny > 0 && ` ≈ ${fmtCny(usage.total.cost_cny)}`}
          </span>
          <span className="chip">{usage?.total.calls ?? 0} 次调用 · {usage?.total.cache_hits ?? 0} 次缓存命中</span>
          {usage?.month_percent != null && (
            <span className="chip" style={{ color: usage.month_percent >= (usage.budget.warn_at_percent || 80) ? 'var(--danger)' : undefined }}>
              已达月预算 {usage.month_percent}%
            </span>
          )}
        </div>
        <div className="row row--wrap fs-sm">
          <label className="row" style={{ gap: 4 }}>
            月度花费上限 ¥
            <input
              className="input input--sm"
              style={{ width: 80 }}
              value={limit}
              placeholder="0 = 不限"
              onChange={(e) => setLimit(e.target.value)}
            />
          </label>
          <label className="row" style={{ gap: 4 }}>
            到 %
            <input
              className="input input--sm"
              style={{ width: 56 }}
              value={warnAt}
              onChange={(e) => setWarnAt(e.target.value)}
            />
            提醒
          </label>
          <button className="btn btn--sm" onClick={saveBudget}>保存预算</button>
          <span className="faint fs-xs">超限后 AI 抽取会直接刹车；单价为 0 的服务商只计 token 不计钱</span>
        </div>
        {usage && usage.recent_chapters.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 'var(--p-space-2)', maxHeight: 180 }}>
            <table className="etable">
              <thead>
                <tr><th>时间</th><th>章</th><th>服务商</th><th>token</th><th>估算花费</th></tr>
              </thead>
              <tbody>
                {usage.recent_chapters.slice(0, 12).map((r, i) => (
                  <tr key={i}>
                    <td className="mono fs-xs muted">{r.ts.slice(5, 16)}</td>
                    <td className="mono fs-xs">{r.book_id === '(测试)' ? '测试' : `第${r.chapter_no}章`}</td>
                    <td className="fs-xs">{r.provider}</td>
                    <td className="mono fs-xs">
                      {r.cache_hit ? <span className="faint">缓存</span> : (r.prompt_tokens + r.completion_tokens).toLocaleString()}
                    </td>
                    <td className="mono fs-xs">{r.cost_cny > 0 ? fmtCny(r.cost_cny) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <PromptEditor />
      {bookId && <span style={{ display: 'none' }} />}
    </>
  )
}

/** 单家服务商：行内编辑，保存才落盘 */
function ProviderRow({
  p, testing, onSave, onTest, onDefault,
}: {
  p: AiProviderInfo
  testing: boolean
  onSave: (name: string, patch: Record<string, unknown>) => Promise<void>
  onTest: (name: string) => Promise<void>
  onDefault: () => Promise<void>
}) {
  const [baseUrl, setBaseUrl] = useState(p.base_url)
  const [model, setModel] = useState(p.model)
  const [key, setKey] = useState('')
  const [pin, setPin] = useState(String(p.price_input || ''))
  const [pout, setPout] = useState(String(p.price_output || ''))

  useEffect(() => {
    setBaseUrl(p.base_url)
    setModel(p.model)
    setPin(String(p.price_input || ''))
    setPout(String(p.price_output || ''))
  }, [p])

  return (
    <div className={`aiprov__row ${p.is_default ? 'aiprov__row--default' : ''}`}>
      <div className="row row--wrap">
        <label className="row" style={{ gap: 4, cursor: 'pointer' }} title="默认服务商：抽取时没指定就用它">
          <input type="radio" checked={p.is_default} onChange={onDefault} />
          <b>{p.label}</b>
          <span className="faint fs-xs mono">{p.key}</span>
        </label>
        <span className="chip fs-xs" title="密钥打码显示；下方输入框留空 = 不改">
          {p.has_key ? p.key_masked : '未填 key'}
        </span>
        <label className="row fs-xs muted" style={{ gap: 4, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={p.enabled}
            onChange={(e) => onSave(p.key, { enabled: e.target.checked })}
          />
          启用
        </label>
        <div className="grow" />
        <button className="btn btn--sm" disabled={testing} onClick={() => onTest(p.key)}>
          {testing && <span className="spinner" />}
          测连通
        </button>
      </div>
      <div className="row row--wrap aiprov__fields">
        <input
          className="input input--sm grow"
          style={{ minWidth: 240 }}
          placeholder="base_url（OpenAI 兼容，如 https://api.deepseek.com/v1）"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <input
          className="input input--sm"
          style={{ width: 180 }}
          placeholder="模型名"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
        <input
          className="input input--sm"
          style={{ width: 200 }}
          type="password"
          placeholder={p.has_key ? `${p.key_masked}（留空不改）` : 'API key'}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="new-password"
        />
        <input
          className="input input--sm"
          style={{ width: 84 }}
          placeholder="入价/M"
          title="输入单价（元/百万 token），0 = 只计 token"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
        />
        <input
          className="input input--sm"
          style={{ width: 84 }}
          placeholder="出价/M"
          title="输出单价（元/百万 token）"
          value={pout}
          onChange={(e) => setPout(e.target.value)}
        />
        <button
          className="btn btn--primary btn--sm"
          onClick={() =>
            onSave(p.key, {
              base_url: baseUrl,
              model,
              ...(key.trim() ? { api_key: key.trim() } : {}),
              price_input: Number(pin) || 0,
              price_output: Number(pout) || 0,
            }).then(() => setKey(''))
          }
        >
          保存
        </button>
      </div>
    </div>
  )
}

/** 提示词编辑：版本化，可回滚 */
function PromptEditor() {
  const { notify } = useApp()
  const [prompt, setPrompt] = useState<AiPrompt | null>(null)
  const [draft, setDraft] = useState('')
  const [versions, setVersions] = useState<AiPromptVersion[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api.getAiPrompt('extraction').then((p) => {
      setPrompt(p)
      setDraft(p.content)
    }).catch((e) => notify('err', `提示词读不出来：${(e as Error).message}`))
    api.getAiPromptVersions('extraction').then((r) => setVersions(r.versions)).catch(() => undefined)
  }, [notify])

  useEffect(load, [load])

  const save = async () => {
    setBusy(true)
    try {
      const p = await api.saveAiPrompt('extraction', draft)
      setPrompt(p)
      notify('ok', `已存为 v${p.version}（换版本后旧缓存自动失效）`)
      load()
    } catch (e) {
      notify('err', `保存失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const rollback = async (version: number) => {
    setBusy(true)
    try {
      await api.rollbackAiPrompt('extraction', version)
      notify('ok', `已回滚到 v${version}（历史不丢，回滚本身也是一个新版本）`)
      load()
    } catch (e) {
      notify('err', `回滚失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      title={`提示词 · 章节信息抽取${prompt ? ` · v${prompt.version}${prompt.is_default ? '（内置）' : ''}` : ''}`}
      collapsible
      sectionId="admin:ai:prompt"
      actions={
        <>
          <select
            className="select"
            value=""
            onChange={(e) => {
              const v = Number(e.target.value)
              if (v) rollback(v)
            }}
          >
            <option value="">回滚到…</option>
            {versions.map((v) => (
              <option key={v.version} value={v.version} disabled={v.is_current}>
                v{v.version}{v.is_current ? '（当前）' : ''} · {v.size} 字
              </option>
            ))}
          </select>
          <button className="btn btn--primary btn--sm" disabled={busy || !prompt || draft === prompt.content} onClick={save}>
            {busy && <span className="spinner" />}
            存为新版本
          </button>
        </>
      }
    >
      <p className="faint fs-xs">
        改提示词不用改代码。必须保留占位符：
        {prompt?.placeholders.map((ph) => <code key={ph} className="chip fs-xs" style={{ margin: '0 2px' }}>{`{${ph}}`}</code>)}
        。某章抽得不满意，改完提示词去章节界面单章重跑即可。
      </p>
      <textarea
        className="input prompt-editor"
        rows={16}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
      />
    </Panel>
  )
}
