/**
 * 打赏码篡改告警条（P11-3️⃣②）。
 *
 * 常驻、**没有关闭按钮** —— 用户明确要的是「报警不消」：一旦有人动过收款码，
 * 这条就必须一直挂在那儿，直到人真的看一眼再点「已知悉」。
 *
 * 三档严重程度：
 * - `mirror_restored`  数据目录里的副本被改过，程序已自动覆盖回原图 → 黄条，可点掉
 * - `mirror_unfixed`   副本被改且写不回去（目录不可写）→ 红条，点不掉
 * - `bundle_tampered`  程序文件本身被改过 → 红条，点不掉（只能重装或重新登记）
 *
 * 轮询很轻（后端自检有 2 秒缓存、3 张图 < 1MB），另外切回标签页时立刻刷一次。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../api/client'
import type { DonateAlert } from '../api/types'
import { useApp } from '../state/store'

/** 后台自检本身很便宜，但没必要太勤 —— 20 秒足够「不消」的语义 */
const POLL_MS = 20000

export function DonateAlertBar() {
  const { requestView } = useApp()
  const [alerts, setAlerts] = useState<DonateAlert[]>([])
  const [busy, setBusy] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  const load = useCallback(async () => {
    try {
      const info = await api.getDonateInfo()
      setAlerts(info.alerts)
    } catch {
      // 后端没连上时静默 —— 顶栏本来就会报「连不上后端」，这里再报一次只是噪音
    }
  }, [])

  useEffect(() => {
    void load()
    timer.current = window.setInterval(() => void load(), POLL_MS)
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer.current)
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  if (alerts.length === 0) return null

  const critical = alerts.some((a) => a.level === 'critical')
  const ackable = alerts.some((a) => a.code === 'mirror_restored')

  const recheck = async () => {
    setBusy(true)
    try {
      const info = await api.verifyDonate()
      setAlerts(info.alerts)
    } catch {
      /* 重检失败就保持现状，不弹框打扰 */
    } finally {
      setBusy(false)
    }
  }

  const ack = async () => {
    setBusy(true)
    try {
      await api.ackDonateAlerts()
      await load()
    } catch {
      /* 同上 */
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={`donate-alert ${critical ? 'donate-alert--critical' : 'donate-alert--warn'}`}
      role="alert"
      aria-live="polite"
    >
      <span className="donate-alert__icon" aria-hidden>
        {critical ? '⛔' : '⚠'}
      </span>

      <div className="donate-alert__body">
        {alerts.map((a, i) => (
          <div key={`${a.code}-${i}`} className="donate-alert__item">
            <b className="donate-alert__title">{a.title}</b>
            <span className="donate-alert__detail">{a.detail}</span>
          </div>
        ))}
      </div>

      <div className="donate-alert__actions">
        <button className="btn btn--sm" onClick={() => void recheck()} disabled={busy}>
          重新检查
        </button>
        <button
          className="btn btn--sm btn--ghost"
          onClick={() => requestView('settings')}
          title="到「设置 · 支持作者」看明细"
        >
          看明细
        </button>
        {ackable && !critical && (
          <button className="btn btn--sm" onClick={() => void ack()} disabled={busy}>
            已知悉
          </button>
        )}
      </div>
    </div>
  )
}
