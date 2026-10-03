/**
 * 素材库（P11-B4 = C4）：贴纸 / 背景 / 底图 / 图标 / 封面 / 字体，一处管理。
 *
 * 上传、删除、预览都在这；每张卡上带**引用徽标** —— 删除前先告诉你
 * 这个素材正被谁用着（全局外观 / 某本书的 book.yaml / view 下的摆设与样式）。
 * 引用是**文本级扫描**（后端 /api/assets/usage），宁多报不漏报。
 *
 * 之前字体的管理散在外观页、底图散在地理观、封面散在书目元数据 ——
 * 这页是它们的总账，其它页面照旧能用（这里不接管，只做总览与清理）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../api/client'
import type { AssetItem } from '../api/types'
import { useAppUi } from '../state/store'
import { Panel } from '../components/Panel'
import { StateGate } from '../components/Toast'

const KIND_LABELS: Record<string, string> = {
  backgrounds: '背景图',
  stickers: '贴纸',
  icons: '节点图标',
  covers: '书目封面',
  maps: '地图底图',
  fonts: '字体',
}

/** 按类别限制可选扩展名 —— 手滑选错类别时至少文件类型对得上 */
const ACCEPT: Record<string, string> = {
  backgrounds: '.png,.jpg,.jpeg,.webp,.gif,.avif',
  stickers: '.png,.webp,.svg,.gif',
  icons: '.png,.svg,.webp',
  covers: '.png,.jpg,.jpeg,.webp',
  maps: '.png,.jpg,.jpeg,.webp',
  fonts: '.ttf,.otf,.woff,.woff2',
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

export function AssetsView() {
  const { assets, reloadAppearance } = useAppUi()
  const [kind, setKind] = useState<string>('backgrounds')
  const [usage, setUsage] = useState<Record<string, api.AssetRef[]>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const kinds = assets?.kinds ?? Object.keys(KIND_LABELS)
  const items: AssetItem[] = assets?.assets?.[kind] ?? []

  const loadUsage = useCallback(() => {
    api
      .getAssetUsage()
      .then((r) => setUsage(r.usages))
      .catch((e) => setErr((e as Error).message))
  }, [])

  useEffect(() => {
    loadUsage()
  }, [loadUsage])

  const upload = async (files: FileList | null) => {
    if (!files || !files.length) return
    setBusy(true)
    setErr(null)
    let ok = 0
    const fail: string[] = []
    for (const f of files) {
      try {
        await api.uploadAsset(kind, f)
        ok++
      } catch (e) {
        fail.push(`${f.name}：${(e as Error).message}`)
      }
    }
    await reloadAppearance()
    loadUsage()
    setBusy(false)
    if (fail.length) setErr(`有 ${fail.length} 个没传上 —— ${fail.join('；')}`)
  }

  const remove = async (it: AssetItem) => {
    const refs = usage[`${it.kind}/${it.name}`] ?? []
    const msg = refs.length
      ? `「${it.name}」正被 ${refs.length} 处引用：\n${refs.map((r) => `· ${r.label}`).join('\n')}\n\n删掉后这些地方会丢图/丢字体，确定删除？`
      : `删除素材「${it.name}」？此操作不可撤销。`
    if (!window.confirm(msg)) return
    setBusy(true)
    try {
      await api.deleteAsset(it.kind, it.name)
      await reloadAppearance()
      loadUsage()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="assets-admin">
      <Panel
        title="素材库"
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              accept={ACCEPT[kind]}
              onChange={(e) => {
                void upload(e.target.files)
                e.target.value = ''
              }}
            />
            <button className="btn btn--primary btn--sm" disabled={busy} onClick={() => fileInput.current?.click()}>
              ＋ 上传到「{KIND_LABELS[kind] ?? kind}」
            </button>
            <button className="btn btn--sm" disabled={busy} onClick={loadUsage}>
              重扫引用
            </button>
          </>
        }
      >
        <StateGate loading={false} error={err} empty={false}>
          <div className="row row--wrap" style={{ marginBottom: 'var(--p-space-3)', gap: 'var(--p-space-2)' }}>
            {kinds.map((k) => (
              <button
                key={k}
                className={`chip ${k === kind ? 'chip--accent' : ''}`}
                style={{ border: 0, cursor: 'pointer' }}
                onClick={() => setKind(k)}
              >
                {KIND_LABELS[k] ?? k} {(assets?.assets?.[k] ?? []).length}
              </button>
            ))}
          </div>

          <p className="faint fs-xs" style={{ marginBottom: 'var(--p-space-3)' }}>
            同名上传会覆盖原文件。删除前看一眼引用徽标 —— 有引用的删了，那些地方会丢图/丢字体
            （外观可以再设置回来，不影响任何实体数据）。
          </p>

          {items.length === 0 ? (
            <p className="empty fs-sm">「{KIND_LABELS[kind] ?? kind}」还是空的 —— 点右上角上传。</p>
          ) : (
            <div className="assets-admin__grid">
              {items.map((it) => {
                const refs = usage[`${it.kind}/${it.name}`] ?? []
                return (
                  <div key={it.name} className="assets-admin__card">
                    <div className="assets-admin__preview">
                      {it.kind === 'fonts' ? (
                        <span style={{ fontFamily: `url("${it.url}")` }}>字 Aa</span>
                      ) : (
                        <img src={it.url} alt={it.name} loading="lazy" />
                      )}
                    </div>
                    <div className="assets-admin__meta">
                      <span className="assets-admin__name" title={it.name}>{it.name}</span>
                      <span className="faint fs-xs">{fmtSize(it.size)}</span>
                    </div>
                    <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                      {refs.length > 0 ? (
                        <span
                          className="chip chip--accent"
                          title={`被引用：\n${refs.map((r) => `· ${r.label}`).join('\n')}`}
                        >
                          引用 {refs.length} 处
                        </span>
                      ) : (
                        <span className="chip faint">未引用</span>
                      )}
                      <div className="grow" />
                      <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void remove(it)}>
                        删
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </StateGate>
      </Panel>
    </div>
  )
}

export default AssetsView
