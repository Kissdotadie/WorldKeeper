/** 识别引擎配置（后台）：本地 OpenCV+OCR / 云端视觉模型。
 *
 * 这个面板要回答三个问题，而且答案必须一眼看见：
 * 1. 现在会走哪个引擎？
 * 2. 这个引擎**会不会把底图发到外网**？（auto 的答案取决于本地能不能用，不是固定的）
 * 3. 用不了的话缺什么、怎么装？
 *
 * 与 AI 服务商面板的分工：那边管密钥，这边只**引用**服务商名字。
 * 密钥只有一个地方存，也只有一个地方能看见。
 */

import { useCallback, useEffect, useState } from 'react'
import * as api from '../api/client'
import type { VisionConfig } from '../api/types'
import { useApp } from '../state/store'
import { Panel } from './Panel'

export function VisionPanel() {
  const { notify } = useApp()
  const [cfg, setCfg] = useState<VisionConfig | null>(null)
  const [providers, setProviders] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api
      .getVisionConfig()
      .then(setCfg)
      .catch((e) => notify('err', `识别配置读不出来：${(e as Error).message}`))
    api
      .getAiConfig()
      .then((c) => setProviders(c.providers.map((p) => p.key)))
      .catch(() => setProviders([]))
  }, [notify])

  useEffect(load, [load])

  const save = async (patch: Record<string, unknown>, msg: string) => {
    setBusy(true)
    try {
      await api.saveVisionConfig(patch)
      notify('ok', msg)
      load()
    } catch (e) {
      notify('err', `保存失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const local = (cfg?.local ?? {}) as Record<string, unknown>
  const cloud = (cfg?.cloud ?? {}) as Record<string, unknown>
  const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d)
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d)

  const clearCache = async () => {
    try {
      const r = await api.clearVisionCache()
      notify('ok', `已清掉 ${r.removed} 份缓存（下次会重算，不丢任何数据）`)
    } catch (e) {
      notify('err', `清缓存失败：${(e as Error).message}`)
    }
  }

  /** 引擎目录（去哪下载 / 怎么装 / 什么许可）—— 用户 2026-10-03 拍板：引擎不进包，只给地址 */
  const cat = cfg?.catalog

  const copy = (text: string, what: string) => {
    try {
      void navigator.clipboard
        .writeText(text)
        .then(() => notify('ok', `已复制${what}`))
        .catch(() => notify('err', '复制失败 —— 手动选中那行字复制吧'))
    } catch {
      notify('err', '这个浏览器不给复制 —— 手动选中那行字复制吧')
    }
  }

  return (
    <Panel
      title="识别引擎"
      collapsible
      sectionId="admin:vision"
      actions={
        cfg ? (
          <span className="faint fs-xs">
            当前走：{cfg.current?.will_use_label || '（没有可用的引擎）'}
          </span>
        ) : null
      }
    >
      <div className="notice" style={{ marginBottom: 'var(--p-space-3)' }}>
        <div>
          <b>识别只出候选。</b>认出多少块区域、多少个地名，都要你在地图上点过、勾过才算数 ——
          和 AI 抽取一样，机器猜的东西不进知识库。
        </div>
      </div>

      {cfg?.privacy && (
        <div className="notice notice--warn" style={{ marginBottom: 'var(--p-space-3)' }}>
          <div>
            <b>隐私：</b>
            {cfg.privacy}
          </div>
        </div>
      )}

      <div className="vpanel__engines">
        {(cfg?.engines ?? []).map((e) => (
          <label
            key={e.id}
            className={
              'vpanel__engine' +
              (cfg?.engine === e.id ? ' vpanel__engine--on' : '') +
              (e.available ? '' : ' vpanel__engine--off')
            }
          >
            <input
              type="radio"
              name="wkv-vision-engine"
              checked={cfg?.engine === e.id}
              disabled={!e.available || busy}
              onChange={() => void save({ engine: e.id }, `已切到「${e.label}」`)}
            />
            <span className="vpanel__engine-body">
              <span className="vpanel__engine-title">
                {e.label}
                {e.sends_image_offsite ? (
                  <span className="vpanel__flag vpanel__flag--out">会把图发出去</span>
                ) : (
                  <span className="vpanel__flag vpanel__flag--in">图不出这台机器</span>
                )}
              </span>
              <span className="faint fs-xs">{e.hint}</span>
              {!e.available && e.reason && (
                <span className="vpanel__why">用不了：{e.reason}</span>
              )}
            </span>
          </label>
        ))}
      </div>

      <div className="vpanel__grid">
        <section className="vpanel__sec">
          <h4 className="vpanel__h">本地识别参数</h4>
          <p className="faint fs-xs" style={{ margin: '0 0 var(--p-space-2)' }}>
            手绘地图的线条没有规范，所以这些数字得能调。调完直接重跑即可，不用改代码。
          </p>
          <div className="kv" style={{ maxWidth: 460 }}>
            <div className="kv__k">找闭合区域</div>
            <div className="kv__v">
              <input
                type="checkbox"
                checked={bool(local.detect_regions, true)}
                onChange={(e) => void save({ local: { detect_regions: e.target.checked } }, '已保存')}
              />
            </div>
            <div className="kv__k">认图上的字（OCR）</div>
            <div className="kv__v">
              <input
                type="checkbox"
                checked={bool(local.detect_text, true)}
                onChange={(e) => void save({ local: { detect_text: e.target.checked } }, '已保存')}
              />
            </div>
            <div className="kv__k">区域最小面积（占整图比例）</div>
            <div className="kv__v">
              <input
                className="input input--sm"
                style={{ width: 110 }}
                type="number"
                step="0.0005"
                min="0.0001"
                max="0.2"
                value={num(local.min_region_area, 0.0015)}
                onChange={(e) =>
                  void save({ local: { min_region_area: Number(e.target.value) } }, '已保存')
                }
              />
              <span className="faint fs-xs" style={{ marginLeft: 8 }}>
                小于这个面积的不算区域（噪点、标点）
              </span>
            </div>
            <div className="kv__k">边界简化强度</div>
            <div className="kv__v">
              <input
                className="input input--sm"
                style={{ width: 110 }}
                type="number"
                step="0.002"
                min="0.001"
                max="0.08"
                value={num(local.simplify, 0.012)}
                onChange={(e) => void save({ local: { simplify: Number(e.target.value) } }, '已保存')}
              />
              <span className="faint fs-xs" style={{ marginLeft: 8 }}>
                越大越方正，越小越贴着手画的边
              </span>
            </div>
            <div className="kv__k">OCR 后端</div>
            <div className="kv__v">
              <select
                className="input input--sm"
                style={{ width: 220 }}
                value={str(local.ocr, 'auto')}
                onChange={(e) => void save({ local: { ocr: e.target.value } }, '已保存')}
              >
                <optgroup label="轻量（推荐先试这些）">
                  <option value="auto">自动挑一个</option>
                  <option value="rapidocr">rapidocr · 约 75MB</option>
                </optgroup>
                <optgroup label="大体积（装了才可选）">
                  <option value="paddleocr">paddleocr · 约 1GB</option>
                  <option value="easyocr">easyocr · 约 2GB</option>
                </optgroup>
                <optgroup label="其他">
                  <option value="tesseract">tesseract · 需另装程序</option>
                  <option value="none">不用 OCR</option>
                </optgroup>
              </select>
              <span className="faint fs-xs" style={{ marginLeft: 8 }}>
                装了哪个才选得出效果；没装的会被自动跳过
              </span>
            </div>
          </div>
        </section>

        <section className="vpanel__sec">
          <h4 className="vpanel__h">云端识别（会把底图发给服务商）</h4>
          <p className="faint fs-xs" style={{ margin: '0 0 var(--p-space-2)' }}>
            只有它能把图上的字读进去，所以「这块是北境」这种判断只有它能给。
            代价是底图会离开这台机器，而且按 token 计费。
          </p>
          <div className="kv" style={{ maxWidth: 460 }}>
            <div className="kv__k">用哪家服务商</div>
            <div className="kv__v">
              <select
                className="input input--sm"
                style={{ width: 200 }}
                value={str(cloud.provider, '')}
                onChange={(e) => void save({ cloud: { provider: e.target.value } }, '已保存')}
              >
                <option value="">（用默认服务商）</option>
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <span className="faint fs-xs" style={{ marginLeft: 8 }}>
                密钥在「AI 服务商」那一节配，这里只选名字
              </span>
            </div>
            <div className="kv__k">区域数上限</div>
            <div className="kv__v">
              <input
                className="input input--sm"
                style={{ width: 110 }}
                type="number"
                min="1"
                max="400"
                value={num(cloud.max_regions, 60)}
                onChange={(e) => void save({ cloud: { max_regions: Number(e.target.value) } }, '已保存')}
              />
            </div>
            <div className="kv__k">文字数上限</div>
            <div className="kv__v">
              <input
                className="input input--sm"
                style={{ width: 110 }}
                type="number"
                min="1"
                max="2000"
                value={num(cloud.max_texts, 300)}
                onChange={(e) => void save({ cloud: { max_texts: Number(e.target.value) } }, '已保存')}
              />
            </div>
            <div className="kv__k">自定义提示词</div>
            <div className="kv__v">
              <textarea
                className="input"
                rows={3}
                style={{ width: '100%' }}
                placeholder="留空用内置提示词（内置的已经写好了归一化坐标与「宁可不报不要凑数」这些规矩）"
                value={str(cloud.prompt, '')}
                onChange={(e) => void save({ cloud: { prompt: e.target.value } }, '已保存')}
              />
            </div>
          </div>
        </section>
      </div>

      {/* ---- 去哪下载（用户 2026-10-03 拍板：引擎不进安装包，只给地址与装法）----
          所以这一节是这个面板的重点，不是附录：本地引擎一个都不在包里，
          用户想知道「怎么才能用上」，答案必须在这里一眼找齐。 */}
      {cat && (
        <section className="vpanel__cat">
          <h4 className="vpanel__h">识别引擎下载与安装</h4>
          <p className="faint fs-xs" style={{ margin: '0 0 var(--p-space-3)', lineHeight: 1.75 }}>
            {cat.note}
          </p>

          <div className="vpanel__cat-group">
            <div className="vpanel__cat-label">本地引擎 —— 图不出这台机器</div>
            {cat.local.map((e) => (
              <div key={e.id} className="vpanel__cat-item">
                <div className="vpanel__cat-head">
                  <span className="vpanel__cat-name">{e.label}</span>
                  <span className="chip chip--sm">{e.role}</span>
                  {e.adapted === 'verified' && (
                    <span className="vpanel__flag vpanel__flag--in" title="作者本机真跑通过">
                      已实测
                    </span>
                  )}
                  {e.adapted === 'code' && (
                    <span
                      className="vpanel__flag vpanel__flag--code"
                      title="代码已就位，但作者本机没装过这个包，没实测过 —— 装完报错就先回 RapidOCR"
                    >
                      未实测
                    </span>
                  )}
                </div>
                <div className="vpanel__cat-note">{e.note}</div>
                <div className="vpanel__cat-meta">
                  <span className="vpanel__lic">{e.license}</span>
                  <span className="faint">·</span>
                  <span>{e.size}</span>
                  <div className="grow" />
                  {e.pip && (
                    <button
                      type="button"
                      className="vpanel__pip"
                      onClick={() => copy(`pip install ${e.pip}`, '安装命令')}
                      title="点一下复制安装命令"
                    >
                      pip install {e.pip}
                    </button>
                  )}
                  <a className="vpanel__cat-link" href={e.url} target="_blank" rel="noreferrer">
                    {e.url_label} ↗
                  </a>
                </div>
              </div>
            ))}
          </div>

          <div className="vpanel__cat-group">
            <div className="vpanel__cat-label">云端识别 —— 图会发出去、按量计费，下面是申请密钥的地方</div>
            {cat.cloud.map((e) => (
              <div key={e.id} className="vpanel__cat-item">
                <div className="vpanel__cat-head">
                  <span className="vpanel__cat-name">{e.label}</span>
                  <span className="chip chip--sm">{e.role}</span>
                  <span className="vpanel__flag vpanel__flag--out">图会发出去</span>
                </div>
                <div className="vpanel__cat-note">{e.note}</div>
                <div className="vpanel__cat-meta">
                  <span className="vpanel__lic">{e.license}</span>
                  <div className="grow" />
                  <a className="vpanel__cat-link" href={e.url} target="_blank" rel="noreferrer">
                    {e.url_label} ↗
                  </a>
                </div>
              </div>
            ))}
          </div>

          <div className="vpanel__cat-group">
            <div className="vpanel__cat-label">怎么装 —— 照着抄，装完重启程序</div>
            {(['source_run', 'installed', 'manual'] as const).map((k) => {
              const ins = cat.install?.[k]
              if (!ins) return null
              return (
                <div key={k} className="vpanel__install">
                  <div className="vpanel__install-label">{ins.label}</div>
                  {ins.commands.map((cmd) => (
                    <code key={cmd} className="vpanel__cmd" onClick={() => copy(cmd, '命令')} title="点一下复制">
                      {cmd}
                    </code>
                  ))}
                  <div className="faint fs-xs" style={{ lineHeight: 1.7 }}>
                    {ins.note}
                  </div>
                </div>
              )
            })}
          </div>

          <p className="faint fs-xs" style={{ margin: 'var(--p-space-3) 0 0', lineHeight: 1.75 }}>
            {cat.license_note}
          </p>
        </section>
      )}

      <div className="vpanel__foot">
        <span className="faint fs-xs">
          配置：<span className="mono">{cfg?.where.config ?? '—'}</span>
          <br />
          缓存：<span className="mono">{cfg?.where.cache ?? '—'}</span>（同一张图同一套参数不重复跑）
        </span>
        <div className="grow" />
        <button className="btn btn--sm" onClick={clearCache}>
          清空识别缓存
        </button>
      </div>

      <p className="faint fs-xs" style={{ margin: 'var(--p-space-2) 0 0' }}>
        没装本地识别的机器上，上面的「本地」一项会变灰并直接给出安装命令 ——
        不装也不影响其他任何功能。
      </p>
    </Panel>
  )
}
