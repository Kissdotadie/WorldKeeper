/**
 * 顶栏的「有新版本」小条（P11-C1）。
 *
 * 承诺过的边界：**只提示，绝不自动下载、绝不自动替换程序**。
 * - 启动后**延迟 4 秒**再异步查一次（不拖慢首屏）；
 * - 没有新版本、检查被关掉、远端没配地址、网络失败 —— 四种情况全都**静默**，
 *   顶栏什么都不出现（检查失败不值得打扰写小说的人）；
 * - 有新版本才浮出一枚 chip，悬停看更新说明，点一下去下载页（远端给了 url）
 *   或后台界面看详情。
 */

import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type { UpdateCheckInfo } from '../api/client'
import { useApp } from '../state/store'

/** 启动后等多久再查。首屏和数据加载都要用网络，更新检查排在它们后面 */
const DELAY_MS = 4000

export function UpdateChip() {
  const { setView } = useApp()
  const [info, setInfo] = useState<UpdateCheckInfo | null>(null)

  useEffect(() => {
    let alive = true
    const timer = window.setTimeout(() => {
      api
        .getUpdateCheck()
        .then((r) => alive && setInfo(r))
        .catch(() => undefined) // 静默：接口挂了也不弹错误
    }, DELAY_MS)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [])

  if (!info?.has_update) return null

  const tip = [
    info.latest && `最新版本 ${info.latest}（当前 ${info.current}）`,
    info.notes,
    !info.url && '更新说明与下载见后台界面',
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <button
      className="chip chip--accent"
      title={tip}
      onClick={() => {
        if (info.url) window.open(info.url, '_blank')
        else setView('settings')
      }}
    >
      ⬆ 新版本 {info.latest}
    </button>
  )
}
