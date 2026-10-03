/** 工具箱（P7）：免费对话 / 图片生成的网页端入口合集。
 *
 * 收藏夹，不是套壳 —— 这里不嵌任何第三方页面，点卡片就是新开标签页。
 * 好处：加载零成本、不受第三方反爬/改版影响、隐私上干净（不经过本程序）。
 *
 * 数据存在数据目录的 tools.json（不进程序目录），首次打开给一份内置
 * 默认清单，之后整份就是用户自己的了 —— 删改排序都行。
 */

import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type { ToolLinkItem, ToolsData } from '../api/client'
import { useApp } from '../state/store'
import { Panel } from '../components/Panel'

const GROUP_KEYS: ToolsData['groups'][number]['key'][] = ['free-chat', 'image-gen']

/** 摘出域名展示 —— 用户认「deepseek.com」比认整串 URL 快得多 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function ToolboxView() {
  const { notify } = useApp()
  const [data, setData] = useState<ToolsData | null>(null)
  const [tab, setTab] = useState<ToolsData['groups'][number]['key']>('free-chat')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<ToolsData | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.getTools().then(setData).catch(() => setData(null))
  }, [])

  const group = () => {
    const d = editing ? draft : data
    return d?.groups.find((g) => g.key === tab)
  }

  const startEdit = () => {
    if (!data) return
    // 深拷贝一份当草稿 —— 取消时直接丢掉，不碰已保存的数据
    setDraft(JSON.parse(JSON.stringify(data)) as ToolsData)
    setEditing(true)
  }

  const cancelEdit = () => {
    setEditing(false)
    setDraft(null)
  }

  const save = async () => {
    if (!draft) return
    setBusy(true)
    try {
      const saved = await api.saveTools(draft)
      setData(saved)
      setEditing(false)
      setDraft(null)
      notify('ok', '工具箱已保存')
    } catch (e) {
      notify('err', `保存失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const mutateGroup = (fn: (links: ToolLinkItem[]) => ToolLinkItem[]) => {
    if (!draft) return
    setDraft({
      ...draft,
      groups: draft.groups.map((g) => (g.key === tab ? { ...g, links: fn(g.links) } : g)),
    })
  }

  const patchLink = (i: number, patch: Partial<ToolLinkItem>) => {
    mutateGroup((links) => links.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  }
  const moveLink = (i: number, dir: -1 | 1) => {
    mutateGroup((links) => {
      const j = i + dir
      if (j < 0 || j >= links.length) return links
      const next = [...links]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }
  const removeLink = (i: number) => mutateGroup((links) => links.filter((_, j) => j !== i))
  const addLink = () => mutateGroup((links) => [...links, { name: '', url: 'https://', note: '' }])

  const g = group()

  return (
    <div className="toolbox">
      <Panel
        title="工具箱"
        actions={
          editing ? (
            <>
              <button className="btn btn--sm" onClick={cancelEdit} disabled={busy}>
                取消
              </button>
              <button className="btn btn--primary btn--sm" onClick={() => void save()} disabled={busy}>
                {busy && <span className="spinner" />}
                保存
              </button>
            </>
          ) : (
            <button className="btn btn--sm" onClick={startEdit} disabled={!data}>
              编辑
            </button>
          )
        }
      >
        <div className="toolbox__tabs">
          {GROUP_KEYS.map((k) => {
            const gg = data?.groups.find((x) => x.key === k)
            return (
              <button
                key={k}
                className={`toolbox__tab ${tab === k ? 'toolbox__tab--on' : ''}`}
                onClick={() => setTab(k)}
              >
                {gg?.label ?? k}
                <span className="faint fs-xs">{gg?.links.length ?? 0}</span>
              </button>
            )
          })}
        </div>

        {!g ? (
          <div className="notice">
            <div>清单还没读出来 —— 刷新一下试试。</div>
          </div>
        ) : (
          <>
            <div className="toolbox__grid">
              {g.links.map((l, i) =>
                editing ? (
                  <div className="toolbox__edit" key={i}>
                    <input
                      className="input input--sm"
                      placeholder="名称"
                      value={l.name}
                      maxLength={60}
                      onChange={(e) => patchLink(i, { name: e.target.value })}
                    />
                    <input
                      className="input input--sm mono"
                      placeholder="https://…"
                      value={l.url}
                      maxLength={500}
                      onChange={(e) => patchLink(i, { url: e.target.value })}
                    />
                    <input
                      className="input input--sm"
                      placeholder="备注（可选）"
                      value={l.note}
                      maxLength={200}
                      onChange={(e) => patchLink(i, { note: e.target.value })}
                    />
                    <div className="toolbox__edit-ops">
                      <button className="btn btn--sm" onClick={() => moveLink(i, -1)} disabled={i === 0} title="上移">↑</button>
                      <button className="btn btn--sm" onClick={() => moveLink(i, 1)} disabled={i === g.links.length - 1} title="下移">↓</button>
                      <button className="btn btn--sm" onClick={() => removeLink(i)} title="删除">✕</button>
                    </div>
                  </div>
                ) : (
                  <a
                    key={`${l.name}-${l.url}`}
                    className="toolbox__card"
                    href={l.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={l.note || l.url}
                  >
                    <span className="toolbox__name">{l.name || '（未命名）'}</span>
                    <span className="toolbox__host mono">{hostOf(l.url)}</span>
                    {l.note && <span className="toolbox__note">{l.note}</span>}
                  </a>
                ),
              )}
            </div>
            {editing && (
              <button className="btn btn--sm" style={{ marginTop: 'var(--p-space-3)' }} onClick={addLink}>
                ＋ 添加链接
              </button>
            )}
            <div className="faint fs-xs" style={{ marginTop: 'var(--p-space-3)' }}>
              {editing
                ? '网址要以 http(s):// 开头，非法网址保存时会被拒绝。'
                : '点击卡片在新标签页打开。这些只是收藏夹式入口，不嵌页面、不存账号 —— 数据在本机数据目录的 tools.json。'}
            </div>
          </>
        )}
      </Panel>
    </div>
  )
}

export default ToolboxView
