import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type { EntityDetail as Detail } from '../api/types'
import { useApp } from '../state/store'
import { Panel } from './Panel'
import { StateGate } from './Toast'
import { shortTime, stripLinks } from '../lib/format'

interface Props {
  entityId: string
  onEdit: (detail: Detail) => void
  onBack: () => void
}

export function EntityDetail({ entityId, onEdit, onBack }: Props) {
  const { bookId, entities, select, notify, refresh, dataVersion } = useApp()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    api
      .getEntity(bookId!, entityId)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [bookId, entityId, dataVersion])

  const onDelete = async () => {
    if (!detail) return
    const ok = window.confirm(
      `确定删除「${detail.name}」？\n\n` +
        `会连同 ${detail.id} 的实体文件一起删掉。\n` +
        `如果只是写错了，建议先改，别删。`,
    )
    if (!ok) return
    try {
      await api.deleteEntity(bookId!, detail.id)
      notify('ok', `已删除「${detail.name}」`)
      select(null)
      onBack()
      await refresh()
    } catch (e) {
      notify('err', `删除失败：${(e as Error).message}`)
    }
  }

  return (
    <Panel
      title={
        <div className="row">
          <button className="btn btn--ghost btn--sm" onClick={onBack} title="返回实体列表">
            ← 返回
          </button>
          <span className="faint fs-xs mono">{entityId}</span>
        </div>
      }
      actions={
        detail && (
          <>
            <button className="btn btn--sm" onClick={() => onEdit(detail)}>
              编辑
            </button>
            <button className="btn btn--sm btn--danger" onClick={onDelete}>
              删除
            </button>
          </>
        )
      }
    >
      <StateGate loading={loading} error={error} empty={!detail}>
        {detail && (
          <article data-entity-type={detail.type}>
            <div className="row row--wrap" style={{ gap: 'var(--p-space-2)' }}>
              <span className="chip chip--type">
                <span className="chip__dot" />
                {detail.type_label}
              </span>
              {detail.status && <span className="chip">{detail.status}</span>}
              {detail.first_appear && <span className="chip">首现 · {detail.first_appear}</span>}
            </div>

            <h1 className="detail__name" style={{ marginTop: 'var(--p-space-2)' }}>
              {detail.name}
            </h1>

            {detail.aliases.length > 0 && (
              <div className="row row--wrap" style={{ marginTop: 4 }}>
                <span className="faint fs-xs">又称</span>
                {detail.aliases.map((a) => (
                  <span key={a} className="chip">
                    {a}
                  </span>
                ))}
              </div>
            )}

            {detail.tags.length > 0 && (
              <div className="row row--wrap" style={{ marginTop: 6 }}>
                {detail.tags.map((t) => (
                  <span key={t} className="chip chip--accent">
                    #{t}
                  </span>
                ))}
              </div>
            )}

            <hr className="hr" />

            <div className="detail__section" style={{ marginTop: 0 }}>
              <div className="detail__section-title">摘要</div>
              <p style={{ whiteSpace: 'pre-wrap', color: 'var(--text-primary)' }}>
                {detail.body.摘要 || <span className="faint">还没写摘要</span>}
              </p>
            </div>

            {detail.body.属性.length > 0 && (
              <div className="detail__section">
                <div className="detail__section-title">属性</div>
                <div className="kv">
                  {detail.body.属性.map(([k, v], i) => (
                    <Row key={`${k}-${i}`} k={k} v={v} />
                  ))}
                </div>
              </div>
            )}

            {detail.body.出场记录.length > 0 && (
              <div className="detail__section">
                <div className="detail__section-title">出场记录</div>
                <div className="kv">
                  {detail.body.出场记录.map(([k, v], i) => (
                    <Row key={`${k}-${i}`} k={k} v={v} />
                  ))}
                </div>
              </div>
            )}

            {detail.relations.length > 0 && (
              <div className="detail__section">
                <div className="detail__section-title">关联（点名字跳过去）</div>
                <div className="row row--wrap">
                  {detail.relations.map((r, i) => {
                    const target = r.to_id ? entities.find((e) => e.id === r.to_id) : null
                    const linked = Boolean(r.to_id)
                    return (
                      <button
                        key={`${r.to_name}-${i}`}
                        className="node-link"
                        disabled={!linked}
                        title={linked ? '跳转到该实体' : '目标不在本册，可能还没录入'}
                        onClick={() => r.to_id && select(r.to_id)}
                      >
                        {r.kind && <span className="faint">{r.kind}：</span>}
                        <span>{stripLinks(r.to_name)}</span>
                        {!linked && <span className="faint">？</span>}
                        {target && <span className="faint mono fs-xs">{target.id}</span>}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {detail.body.待补充.length > 0 && (
              <div className="detail__section">
                <div className="detail__section-title">待补充</div>
                <ul className="bullets">
                  {detail.body.待补充.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </div>
            )}

            <hr className="hr" />

            <div className="detail__section" style={{ marginTop: 0 }}>
              <div className="detail__section-title">出处</div>
              <div className="kv">
                <Row k="录入方式" v={detail.provenance?.method ?? '—'} />
                <Row k="创建" v={shortTime(detail.created_at)} />
                <Row k="改动" v={shortTime(detail.updated_at)} />
                <Row k="文件" v={detail.file_path} mono />
              </div>
              {detail.provenance?.sources?.length > 0 && (
                <ul className="bullets" style={{ marginTop: 6 }}>
                  {detail.provenance.sources.map((s, i) => (
                    <li key={i}>
                      {s.chapter ?? '—'}
                      {s.paragraph ? ` 第 ${s.paragraph} 段` : ''}
                      {s.note ? ` · ${s.note}` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </article>
        )}
      </StateGate>
    </Panel>
  )
}

function Row({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <div className="kv__k">{k}</div>
      <div className={`kv__v ${mono ? 'mono fs-xs' : ''}`} style={mono ? { wordBreak: 'break-all' } : undefined}>
        {v}
      </div>
    </>
  )
}
