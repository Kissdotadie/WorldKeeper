/** 后台界面（独立页）：环境信息、索引重建、AI 配置、日志。 */

import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type { AdminInfo } from '../api/types'
import { useApp } from '../state/store'
import { Panel, SectionControls } from '../components/Panel'
import { AiPanel } from '../components/AiPanel'
import { TypeLabelsPanel } from '../components/TypeLabelsPanel'
import { VisionPanel } from '../components/VisionPanel'
import { AliasPanel } from '../components/AliasPanel'
// 书目信息已挪到汇总页首位（用户 2026-10-03），后台不再重复放一份
import { EntityAuditPanel } from '../components/EntityAuditPanel'
import { ConsistencyPanel } from '../components/ConsistencyPanel'
import { SampleBookPanel } from '../components/SampleBookPanel'
import { SnapshotPanel } from '../components/SnapshotPanel'
import { ShortcutPanel } from '../components/ShortcutPanel'

export function AdminView() {
  const { bookId, notify, refresh, stats } = useApp()
  const [info, setInfo] = useState<AdminInfo | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const loadLogs = () =>
    api.adminLogs(200).then((r) => setLogs(r.lines)).catch(() => setLogs(['（读日志失败）']))

  useEffect(() => {
    api.adminInfo().then(setInfo).catch(() => setInfo(null))
    loadLogs()
  }, [])

  const rebuild = async () => {
    setBusy(true)
    setResult(null)
    try {
      const res = await api.rebuildIndex(bookId ?? undefined)
      const msg = res.books
        ? `重建完成：${res.books.length} 本书，共 ${res.total_entities} 条实体`
        : `重建完成：${res.entities} 条，耗时 ${res.elapsed_seconds}s`
      setResult(msg)
      notify('ok', msg)
      await refresh()
    } catch (e) {
      notify('err', `重建失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="admin">
      <div className="admin__tools">
        <SectionControls what="后台区块" />
      </div>

      <Panel
        title="索引"
        collapsible
        defaultOpen
        sectionId="admin:index"
        summary={
          info ? (info.index_ready ? '就绪' : '需要重建') : stats ? `${stats.total} 条实体` : undefined
        }
        actions={
          <button className="btn btn--primary btn--sm" onClick={rebuild} disabled={busy}>
            {busy && <span className="spinner" />}
            重建索引{bookId ? '（当前书目）' : '（全部）'}
          </button>
        }
      >
        <div className="notice" style={{ marginBottom: 'var(--p-space-3)' }}>
          <div>
            索引是<b>可以随时丢掉的派生数据</b>。它坏了、删了、换了数据目录，第一手段都是重建 ——
            只读 Markdown 档案，不碰正文。正文和档案才是真源。
          </div>
        </div>
        {result && <div className="notice notice--ok" style={{ marginBottom: 'var(--p-space-3)' }}>{result}</div>}

        <div className="kv" style={{ maxWidth: 560 }}>
          <div className="kv__k">索引状态</div>
          <div className="kv__v">
            {info?.index_ready ? (
              <span style={{ color: 'var(--ok)' }}>就绪</span>
            ) : (
              <span style={{ color: 'var(--warn)' }}>不可用，需要重建</span>
            )}
          </div>
          <div className="kv__k">索引文件</div>
          <div className="kv__v mono fs-xs" style={{ wordBreak: 'break-all' }}>{info?.index_file ?? '—'}</div>
          {stats && (
            <>
              <div className="kv__k">本册实体</div>
              <div className="kv__v">{stats.total} 条 · 关系 {stats.relations} 条</div>
            </>
          )}
        </div>
      </Panel>

      <Panel
        title="环境"
        collapsible
        sectionId="admin:env"
        summary={info ? (info.frozen ? '正式程序' : '源码运行') : undefined}
      >
        <div className="kv" style={{ maxWidth: 720 }}>
          <div className="kv__k">数据目录</div>
          <div className="kv__v mono fs-xs" style={{ wordBreak: 'break-all' }}>{info?.data_dir ?? '—'}</div>
          <div className="kv__k">程序目录</div>
          <div className="kv__v mono fs-xs" style={{ wordBreak: 'break-all' }}>{info?.program_dir ?? '—'}</div>
          <div className="kv__k">日志目录</div>
          <div className="kv__v mono fs-xs" style={{ wordBreak: 'break-all' }}>{info?.logs_dir ?? '—'}</div>
          <div className="kv__k">运行形态</div>
          <div className="kv__v">{info ? (info.frozen ? '打包后的正式程序' : '源码运行（开发形态）') : '—'}</div>
        </div>
      </Panel>

      <SnapshotPanel />

      <SampleBookPanel />

      <TypeLabelsPanel />

      <AliasPanel />

      <EntityAuditPanel />

      <ConsistencyPanel />

      <ShortcutPanel />

      <Panel title="数据导出" collapsible sectionId="admin:export">
        <div className="notice" style={{ marginBottom: 'var(--p-space-3)' }}>
          <div>
            把当前书目的<b>全部内容</b>打包成一个 zip：实体档案、章节正文、世界观文档、
            时间线 / 伏笔、配置和视图摆位。Markdown 原样打包、不做任何转换 ——
            解压到数据目录的 <code>books/</code> 下（目录名 = 书目 ID）就能恢复。
          </div>
        </div>
        <button
          className="btn btn--primary btn--sm"
          onClick={() => {
            if (bookId) window.open(api.bookExportUrl(bookId), '_blank')
          }}
          disabled={!bookId}
        >
          导出当前书目（zip）
        </button>
      </Panel>

      <AiPanel />

      <UpdatePanel />

      <VisionPanel />

      <Panel
        title="最近日志"
        className="admin__logs"
        collapsible
        sectionId="admin:logs"
        summary={logs.length ? `${logs.length} 行` : '暂无'}
        actions={
          <button className="btn btn--sm" onClick={loadLogs}>刷新日志</button>
        }
        flush
      >
        <pre className="logbox" style={{ border: 0, borderRadius: 0, maxHeight: 'none', flex: 1 }}>
          {logs.length ? logs.join('\n') : '（暂无日志）'}
        </pre>
      </Panel>
    </div>
  )
}

export default AdminView

/** 更新提示（P11-C1）：只查、只提示，绝不自动下载替换。 */
function UpdatePanel() {
  const [info, setInfo] = useState<api.UpdateCheckInfo | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = async (force = false) => {
    setBusy(true)
    try {
      setInfo(await api.getUpdateCheck(force))
    } catch {
      setInfo(null)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  return (
    <Panel
      title="更新"
      collapsible
      sectionId="admin:update"
      summary={
        !info ? undefined : info.has_update ? `有新版本 ${info.latest}` : '已是最新'
      }
    >
      <div className="notice" style={{ marginBottom: 'var(--p-space-3)' }}>
        <div>
          只做<b>提示</b>，绝不自动下载、绝不自动替换程序 —— 程序永远由你亲手安装。
          检查开关、远端地址与频率在 <code>config.yaml → updates</code> 里配。
        </div>
      </div>
      <div className="kv" style={{ maxWidth: 640 }}>
        <div className="kv__k">检查开关</div>
        <div className="kv__v">{info ? (info.enabled ? '开' : '关') : '—'}</div>
        <div className="kv__k">远端地址</div>
        <div className="kv__v">
          {info ? (info.configured ? '已配置' : '未配置（config.yaml → updates.url）') : '—'}
        </div>
        <div className="kv__k">检查频率</div>
        <div className="kv__v">{info ? `每 ${info.interval_hours ?? 24} 小时最多查一次` : '—'}</div>
        <div className="kv__k">当前版本</div>
        <div className="kv__v mono">{info?.current ?? '—'}</div>
        <div className="kv__k">上次检查</div>
        <div className="kv__v">
          {!info && '—'}
          {info?.checked === false && (info.reason || info.error || '没查')}
          {info?.checked && !info.has_update && `已是最新（远端 ${info.latest}）`}
          {info?.checked && info.has_update && (
            <span style={{ color: 'var(--ok)' }}>
              有新版本 {info.latest}
              {info.notes ? ` —— ${info.notes}` : ''}
              {info.url && (
                <>
                  {' '}
                  <a href={info.url} target="_blank" rel="noreferrer">下载页 →</a>
                </>
              )}
            </span>
          )}
        </div>
      </div>
      <button className="btn btn--sm" style={{ marginTop: 'var(--p-space-3)' }} disabled={busy} onClick={() => void reload(true)}>
        {busy && <span className="spinner" />}
        重新检查
      </button>
    </Panel>
  )
}
