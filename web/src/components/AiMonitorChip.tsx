/** 词元监测开关 + 实时读数。
 *
 * 可自主选择开启或关闭：开着的时候，之后所有 AI 调用的 token
 * 都累计进读数（后端以开启时刻为界聚合）。读数每 4 秒刷新一次。
 */

import { useCallback, useEffect, useState } from 'react'
import * as api from '../api/client'
import type { AiMonitor } from '../api/types'

export function AiMonitorChip() {
  const [mon, setMon] = useState<AiMonitor | null>(null)

  const load = useCallback(() => {
    api
      .getAiMonitor()
      .then(setMon)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 开着的时候才轮询 —— 关了就不要每 4 秒敲一次后端
  useEffect(() => {
    if (!mon?.active) return
    const t = window.setInterval(load, 4000)
    return () => window.clearInterval(t)
  }, [mon?.active, load])

  const toggle = async () => {
    const next = !(mon?.active ?? false)
    try {
      await api.setAiMonitor(next)
      load()
    } catch {
      /* 开关失败下轮轮询会自愈 */
    }
  }

  const active = mon?.active ?? false
  return (
    <span
      className={`aimon ${active ? 'aimon--on' : ''}`}
      title={active ? `监测中：自 ${mon?.started_at?.slice(11, 19) ?? ''} 起的全部 AI 消耗` : '词元监测：开启后统计之后的 AI 消耗'}
    >
      <label className="row" style={{ gap: 4, cursor: 'pointer' }}>
        <input type="checkbox" checked={active} onChange={toggle} />
        <span className="fs-xs">词元监测</span>
      </label>
      {active && mon && (
        <span className="aimon__nums mono fs-xs">
          {mon.tokens.toLocaleString()} tok
          {mon.cost_cny > 0 && <span className="faint"> ≈ ¥{mon.cost_cny.toFixed(4)}</span>}
        </span>
      )}
    </span>
  )
}
