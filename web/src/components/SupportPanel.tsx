/**
 * 「支持作者」面板（P11-3️⃣②）。
 *
 * 打赏 + 加群都在这一页。二维码的**真源在程序包里**（app/assets/donate/），
 * 哈希写在代码里（app/donate_manifest.py）—— 接口永远从包内吐图，所以数据
 * 目录里那份副本怎么改都不会换掉界面上显示的码；被改过则**自动覆盖回原图**，
 * 并留一条**不会自己消失**的告警（顶栏那条黄/红条就是它）。
 *
 * 这一页是告警的「细节页」：看得到哪张被动过、什么时候、恢复成没成，
 * 以及那个唯一能清掉提示的「已知悉」按钮。
 *
 * 文案是作者自己写的（2026-10-02 定稿），改文案不用问后端。
 */

import { useCallback, useEffect, useState } from 'react'
import * as api from '../api/client'
import type { DonateInfo } from '../api/types'
import { Panel } from './Panel'
import { useToast } from '../state/store'

const SNOOZE_KEY = 'wkv_donate_snooze'

const INTEGRITY_TEXT: Record<DonateInfo['integrity'], string> = {
  ok: '正常 · 三张码与程序内置的一致',
  repaired: '副本曾被改动，已自动恢复原图',
  tampered: '程序内的码与内置哈希不符，已拒绝显示',
  absent: '程序包里还没有登记码图',
}

export function SupportPanel() {
  const { notify } = useToast()
  const [info, setInfo] = useState<DonateInfo | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [showDonate, setShowDonate] = useState(false)
  const [showGroup, setShowGroup] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setInfo(await api.getDonateInfo())
      setErr(null)
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const snooze = () => {
    try {
      localStorage.setItem(SNOOZE_KEY, new Date().toISOString().slice(0, 10))
    } catch {
      /* 隐私模式下存不进去就算了，只是少记一个「下次一定」 */
    }
    setShowDonate(false)
    notify('info', '行，下次一定。')
  }

  const recheck = async () => {
    setBusy(true)
    try {
      setInfo(await api.verifyDonate())
      notify('ok', '已重新检查')
    } catch (e) {
      notify('err', `检查失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const ack = async () => {
    setBusy(true)
    try {
      await api.ackDonateAlerts()
      await load()
      notify('ok', '已清除提示')
    } catch (e) {
      notify('err', `清除失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const alerts = info?.alerts ?? []
  const hasCritical = alerts.some((a) => a.level === 'critical')
  const ackable = alerts.some((a) => a.code === 'mirror_restored')

  // 状态行要与告警一致：码虽然已经恢复成原图，但「发生过改动」这件事还没被确认，
  // 这时再写「正常」会让人以为上面那条提示是误报。
  const statusText = !info
    ? '检查中…'
    : alerts.length
      ? INTEGRITY_TEXT[hasCritical ? 'tampered' : 'repaired']
      : INTEGRITY_TEXT[info.integrity]

  return (
    <div className="support">
      <Panel title="请作者喝杯咖啡" className="support__card">
        <div className="support__headline">作者快没咖啡了</div>
        <p className="support__text">
          本工具免费，作者靠咖啡续命。如果你觉得它好用，可以投喂一杯；
          如果觉得一般，也欢迎进群骂醒我（轻点骂）。
        </p>
        <p className="support__note">打赏不影响功能，只影响作者今晚几点睡。</p>

        <div className="support__actions">
          <button
            className="btn btn--primary"
            onClick={() => setShowDonate((v) => !v)}
            disabled={!info?.items.wechat.exists && !info?.items.alipay.exists}
          >
            {showDonate ? '收起' : '投喂咖啡'}
          </button>
          <button className="btn btn--ghost" onClick={snooze}>
            下次一定
          </button>
        </div>

        {showDonate && (
          <div className="support__codes">
            {(['wechat', 'alipay'] as const).map((key) => {
              const item = info?.items[key]
              return (
                <figure key={key} className="support__code">
                  <figcaption className="support__code-label">{item?.label ?? key}</figcaption>
                  {item?.exists && item.url ? (
                    <img src={item.url} alt={`${item.label}收款码`} loading="lazy" />
                  ) : (
                    <div className="support__code-missing">码图没找到</div>
                  )}
                </figure>
              )
            })}
          </div>
        )}
        {showDonate && (
          <p className="support__hint">扫码时备注一句「世界观查询器」，作者好知道是哪位书友投的喂。</p>
        )}
      </Panel>

      <Panel title="来交流群坐坐" className="support__card">
        <div className="support__headline">遇到 bug？想加功能？想聊设定？</div>
        <p className="support__text">
          进群说一声就行，更新与坑都第一时间在群里说。
          <b className="support__danger">群内禁止发 API Key！！！</b>
        </p>

        <div className="support__actions support__actions--group">
          <button
            className="btn btn--primary btn--lg support__join"
            onClick={() => setShowGroup((v) => !v)}
            disabled={!info?.items.qqgroup.exists}
          >
            {showGroup ? '收起二维码' : '加入交流群'}
          </button>
          <button className="btn btn--ghost" onClick={() => setShowGroup(false)}>
            暂不加入
          </button>
        </div>

        {showGroup && (
          <div className="support__codes support__codes--one">
            <figure className="support__code">
              <figcaption className="support__code-label">
                {info?.items.qqgroup.label ?? 'QQ 群'} · 群号 1125806847
              </figcaption>
              {info?.items.qqgroup.exists && info.items.qqgroup.url ? (
                <img src={info.items.qqgroup.url} alt="交流群二维码" loading="lazy" />
              ) : (
                <div className="support__code-missing">群二维码没找到</div>
              )}
            </figure>
          </div>
        )}
        {showGroup && <p className="support__hint">扫不了的话，手动搜群号 1125806847 也一样。</p>}
      </Panel>

      <Panel title="收款码防替换" className="support__card">
        <p className="support__text">
          三张码的真源<b>编在程序里</b>，接口永远从程序包读图；数据目录里那份只是副本，
          被改或被删都会<b>自动用原图覆盖回去</b>，并在这里与顶栏留下一条提示。
          提示不会自己消失 —— 确认没问题后点下面的按钮才会清掉。
        </p>

        <div className={`support__status support__status--${hasCritical ? 'bad' : alerts.length ? 'warn' : 'ok'}`}>
          <b>{statusText}</b>
          {info?.checked_at && <span className="support__status-time">上次检查 {info.checked_at}</span>}
        </div>

        {alerts.length > 0 && (
          <ul className="support__alerts">
            {alerts.map((a, i) => (
              <li key={`${a.code}-${i}`} className={`support__alert support__alert--${a.level}`}>
                <b>{a.title}</b>
                <span>{a.detail}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="support__actions">
          <button className="btn btn--sm" onClick={() => void recheck()} disabled={busy}>
            重新检查
          </button>
          {ackable && (
            <button className="btn btn--sm btn--ghost" onClick={() => void ack()} disabled={busy}>
              已知悉，清除提示
            </button>
          )}
        </div>
        {/* 刻意**不显示**任何文件路径与脚本名 —— 这是作者要求的安全口径：
            防替换的说明只讲机制（「编在程序里」「自动覆盖」），
            讲到文件在哪、用哪个脚本换码，只进 PLAN.md 与日志，不进界面 */}
      </Panel>

      {err && <div className="support__warn">读取打赏信息失败：{err}</div>}
    </div>
  )
}
