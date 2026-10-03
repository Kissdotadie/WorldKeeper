/** API 小白引导（N1，2026-10-03 用户提出）。
 *
 * 要解决的问题：目标用户可能对「API / API Key」一窍不通，界面只丢一个空的
 * `base_url / model / key` 三件套给他，等于把「你不会」当成「你懒得」。
 *
 * 三条边界（改这块时请继续守）：
 * 1. **只引导，不代办** —— 不做「一键申请」：注册、实名、充值都是用户自己的账号，
 *    本程序不碰、不代充、不分成。
 * 2. **内容归后端**（`app/ai/catalog.py`）—— 改文案不用重新构建界面。
 * 3. **隐私写在明处** —— 正文会离开这台机器，这是未发表作品。
 *
 * 形态：一条常驻的醒目小条（高度只有一行），点开才是完整引导 ——
 * 既让人一眼看见，又不至于把配置页撑成一长溜（用户明确嫌过这个）。
 */

import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type { AiCatalog } from '../api/types'
import { useApp } from '../state/store'

/** 极简富文本：只认 `**加粗**` 与 `` `代码` ``。
 * 引 markdown 渲染器不值得（体积 + 主题），后端文案里也只用了这两种标记。 */
function rich(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((seg, i) => {
    if (seg.startsWith('**') && seg.endsWith('**')) return <b key={i}>{seg.slice(2, -2)}</b>
    if (seg.startsWith('`') && seg.endsWith('`')) {
      return <code key={i} className="aiguide__code">{seg.slice(1, -1)}</code>
    }
    return <span key={i}>{seg}</span>
  })
}

export function AiGuide() {
  const { notify } = useApp()
  const [cat, setCat] = useState<AiCatalog | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    // 读不到就整块不显示：引导缺了不该让配置页出错
    api.getAiCatalog().then(setCat).catch(() => setCat(null))
  }, [])

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      notify('ok', `已复制${what}：${text}`)
    } catch {
      notify('err', '复制失败 —— 请手动选中复制')
    }
  }

  if (!cat) return null

  return (
    <div className={`aiguide ${open ? 'aiguide--open' : ''}`}>
      <button
        type="button"
        className="aiguide__bar"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="aiguide__bulb">💡</span>
        <span className="aiguide__lead">
          <b>没有 API Key？</b> 完全不懂也没关系 —— 3 步弄到一个
        </span>
        <span className="aiguide__caret">{open ? '收起引导' : '展开引导'}</span>
      </button>

      {open && (
        <div className="aiguide__body">
          {/* ---- 是什么 ---- */}
          <h4 className="aiguide__h">{cat.intro.title}</h4>
          <p className="aiguide__p">{rich(cat.intro.api)}</p>
          <p className="aiguide__p">{rich(cat.intro.key)}</p>
          <p className="aiguide__p aiguide__p--faint">{rich(cat.intro.where)}</p>

          {/* ---- 三步 ---- */}
          <h4 className="aiguide__h">怎么做</h4>
          <ol className="aiguide__steps">
            {cat.steps.map((s) => (
              <li key={s.n}>
                <b>{s.title}</b>
                <div className="aiguide__step-detail">{rich(s.detail)}</div>
              </li>
            ))}
          </ol>

          {/* ---- 官方申请直链 ---- */}
          <h4 className="aiguide__h">
            去哪申请 <span className="faint fs-xs">（全是官网直链，不放推广链）</span>
          </h4>
          <div className="aiguide__provs">
            {cat.providers.map((p) => (
              <div key={p.id} className={`aiguide__prov ${p.recommended ? 'aiguide__prov--rec' : ''}`}>
                <div className="aiguide__prov-head">
                  <b>{p.label}</b>
                  {p.recommended && <span className="chip chip--accent fs-xs">新手推荐</span>}
                  <span className="chip fs-xs">{p.access}</span>
                  <div className="grow" />
                  <a className="aiguide__link" href={p.url} target="_blank" rel="noreferrer">
                    {p.url_label} ↗
                  </a>
                </div>
                <div className="aiguide__prov-signup">{rich(p.signup)}</div>
                {/* base_url / 模型名是可以整串抄错的，所以做成「点一下复制」 */}
                <div className="aiguide__prov-fields">
                  <button type="button" className="aiguide__copy" onClick={() => copy(p.base_url, 'base_url')}>
                    base_url · {p.base_url}
                  </button>
                  <button type="button" className="aiguide__copy" onClick={() => copy(p.model, '模型名')}>
                    模型 · {p.model}
                  </button>
                  <span className="faint fs-xs">{p.pricing}</span>
                </div>
                <div className="aiguide__prov-note">{rich(p.note)}</div>
              </div>
            ))}
          </div>

          {/* ---- 不想把正文发出去 ---- */}
          <h4 className="aiguide__h">不想让正文离开这台电脑？</h4>
          {cat.local.map((l) => (
            <div key={l.id} className="aiguide__prov">
              <div className="aiguide__prov-head">
                <b>{l.label}</b>
                <span className="chip fs-xs">完全离线</span>
                <div className="grow" />
                <a className="aiguide__link" href={l.url} target="_blank" rel="noreferrer">
                  {l.url_label} ↗
                </a>
              </div>
              <div className="aiguide__prov-fields">
                <button type="button" className="aiguide__copy" onClick={() => copy(l.base_url, 'base_url')}>
                  base_url · {l.base_url}
                </button>
                <button type="button" className="aiguide__copy" onClick={() => copy(l.model, '模型名')}>
                  模型 · {l.model}
                </button>
              </div>
              <div className="aiguide__prov-note">{rich(l.note)}</div>
            </div>
          ))}

          {/* ---- 花多少钱 ---- */}
          <h4 className="aiguide__h">{cat.cost.title}</h4>
          <p className="aiguide__p">{rich(cat.cost.body)}</p>

          {/* ---- 隐私与免责：两句都不删 ---- */}
          <p className="notice notice--warn aiguide__privacy">{rich(cat.privacy)}</p>
          <p className="aiguide__disclaimer">{rich(cat.disclaimer)}</p>
          <p className="faint fs-xs">{cat.note}</p>
        </div>
      )}
    </div>
  )
}
