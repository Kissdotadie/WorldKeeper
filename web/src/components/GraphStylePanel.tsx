/**
 * 三维外观控制 —— 所有「图」类视图共用的那一份。
 *
 * 三节：**辉光**（后处理）、**节点疏密 + 重新排版**（力布局参数）、**按类型换图标**。
 * 由 `useSceneStyles` 提供状态与落盘，这里只管画。
 *
 * 为什么不做成「每个视图自己写一份」：这三节东西在关系网里调好了，
 * 世界观没道理又长出另一套。拷贝第二遍就容易长歪。
 *
 * 口径（用户 2026-10-01 拍板）：**只给「图」加**。汇总、名册录、历史观、
 * 剧情线、伏笔、全部实体本质是列表和文档 —— 那些地方硬塞三维是找麻烦，
 * 看大纲还要转视角是折磨。
 */

import * as api from '../api/client'
import type { SceneStylesApi } from '../graph/useSceneStyles'
import type { Spacing } from '../graph/Graph3D'

const SPACING_LABELS: { key: Spacing; label: string; hint: string }[] = [
  { key: 'compact', label: '紧凑', hint: '节点密、适合看整体轮廓' },
  { key: 'normal', label: '标准', hint: '默认' },
  { key: 'loose', label: '宽松', hint: '间距拉到最大，标签不打架' },
]

/** 档位 → 中文名。重排提示要用，三个视图各写一遍迟早文本会不一致 */
export const spacingLabel = (sp: Spacing) =>
  SPACING_LABELS.find((s) => s.key === sp)?.label ?? sp

interface Props {
  styles: SceneStylesApi
  types: { key: string; label: string }[]
  /** 这张图在 scene.json 里的键 —— 「重新排版」按它清锁定坐标 */
  sceneKey: string
  /** 不是力导向的图（比如时间线长河）没有「疏密」这一节 */
  hideSpacing?: boolean
  hideIcons?: boolean
  /** 重排之后的收尾（清选中、弹提示…） */
  onRelayout?: (nextSpacing?: Spacing) => void
}

export function GraphStylePanel({
  styles: s,
  types,
  sceneKey,
  hideSpacing = false,
  hideIcons = false,
  onRelayout,
}: Props) {
  const doRelayout = (nextSpacing?: Spacing) => {
    void s.relayout(sceneKey, nextSpacing)
    onRelayout?.(nextSpacing)
  }

  return (
    <>
      <label className="row fs-sm" style={{ gap: 6, cursor: 'pointer', marginBottom: 8 }}>
        <input type="checkbox" checked={s.glow} onChange={(e) => s.setGlow(e.target.checked)} />
        辉光效果
      </label>
      <p className="faint fs-xs" style={{ marginBottom: 10, lineHeight: 1.6 }}>
        节点周围那圈柔光。机器吃力就关掉 —— 它是后处理，几百个节点时最费。
      </p>

      {!hideSpacing && (
        <>
          <div className="field__label" style={{ marginBottom: 4 }}>节点疏密</div>
          <div className="row row--wrap" style={{ gap: 6, alignItems: 'center' }}>
            <div className="seg" role="tablist" aria-label="节点疏密">
              {SPACING_LABELS.map((sp) => (
                <button
                  key={sp.key}
                  className={`seg__item ${s.spacing === sp.key ? 'seg__item--on' : ''}`}
                  onClick={() => doRelayout(sp.key)}
                  title={`${sp.hint}（会重新排版一次）`}
                >
                  {sp.label}
                </button>
              ))}
            </div>
            <button
              className="btn btn--sm"
              onClick={() => doRelayout()}
              title="按当前疏密重新模拟一次，清掉历史锁定坐标"
            >
              重新排版
            </button>
          </div>
          <p className="faint fs-xs" style={{ marginTop: 6, marginBottom: 10, lineHeight: 1.6 }}>
            节点挤成一坨就切「宽松」，它会自动重排；排布算一次要几秒，之后会被锁定，
            下次打开一模一样。只影响<strong>这张图</strong>，别的图不动。
          </p>
        </>
      )}

      {!hideIcons && (
        <>
          <div className="field__label" style={{ marginBottom: 6 }}>按类型换图标</div>
          <div className="icon-pick">
            {types.map((t) => (
              <div className="icon-pick__row" key={t.key}>
                <span className="dot" data-entity-type={t.key} />
                <span className="icon-pick__label">{t.label}</span>
                {s.typeIcons[t.key] ? (
                  <img className="icon-pick__preview" src={api.assetUrlOf(s.typeIcons[t.key])} alt="" />
                ) : (
                  <span className="icon-pick__shape">默认形状</span>
                )}
                <select
                  className="select select--sm"
                  value={s.typeIcons[t.key] ?? ''}
                  onChange={(e) => s.setTypeIcon(t.key, e.target.value)}
                  title="换成素材库里的图标"
                >
                  <option value="">默认形状</option>
                  {s.icons.map((i) => (
                    <option key={i.name} value={`icons/${i.name}`}>
                      {i.stem}
                    </option>
                  ))}
                </select>
                <label className="btn btn--ghost btn--sm icon-pick__up" title="上传一张图片当图标">
                  传
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) void s.uploadIcon(t.key, f)
                      e.target.value = ''
                    }}
                  />
                </label>
              </div>
            ))}
          </div>
          <p className="faint fs-xs" style={{ marginTop: 6, lineHeight: 1.6 }}>
            按类型统一换图标属<strong>视图装饰</strong>，只写进 <span className="mono">scene.json</span>，
            不动实体文件；单个实体自己的图标在实体编辑里设，那才算内容。
            图片放 <span className="mono">data/assets/icons/</span>，支持 png/jpg/webp/svg。
          </p>
        </>
      )}
    </>
  )
}

export default GraphStylePanel
