/**
 * 「图长什么样」的控制面板（P5）—— 所有「图」类视图共用的那一份。
 *
 * 三节：
 *   1. **样式包**：一排卡片，点一下整张图变形（WPS 思维导图那种感觉）
 *   2. **图外观**：布局、节点形状、配色、连线、标签、背景
 *   3. **批量应用**：按类型 / 按标签定规则，免得一个个节点去调
 *
 * 为什么和「三维外观」（`GraphStylePanel`）分成两个面板：那一个是**三维专属**
 * （辉光、疏密、类型图标），改的是 `scene.json`；这一个管的是**图的内容长相**，
 * 改的是样式包。两者会同时出现在三维档的侧栏里，但归属完全不同的东西。
 *
 * ⚠️ 这里改的全是**装饰**：落 `view/styles/`，实体文件一个字不动。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api/client'
import { useApp } from '../state/store'
import type { NodeShape, NodeStylePatch, PaletteId, StylePack, StyleRule } from '../api/types'
import { LAYOUT_LABELS, type LayoutKind } from '../graph/types'
import { PALETTES, SHAPE_LABELS, withAlpha } from '../graph/styles'
import { PackThumb } from './PackThumb'

/** 规则里那个颜色，没设就显示成空 —— 空 = 不改，用底色 */
function RuleRow({
  rule,
  types,
  onRemove,
}: {
  rule: StyleRule
  types: { key: string; label: string }[]
  onRemove: () => void
}) {
  const byType = rule.match.by === 'type'
  const label = byType
    ? (types.find((t) => t.key === rule.match.value)?.label ?? rule.match.value)
    : `#${rule.match.value}`
  return (
    <div className="rule-row">
      <span className="chip chip--sm">{byType ? '按类型' : '按标签'}</span>
      <span className="rule-row__name ellipsis" title={label}>{label}</span>
      <span className="rule-row__what">
        {rule.style.shape && <span className="rule-row__tag">{rule.style.shape}</span>}
        {rule.style.fill && (
          <span className="swatch swatch--sm" style={{ background: rule.style.fill }} title={rule.style.fill} />
        )}
        {rule.style.stroke && (
          <span className="swatch swatch--sm" style={{ background: rule.style.stroke }} title={rule.style.stroke} />
        )}
        {rule.style.highlight && <span className="rule-row__tag">高亮</span>}
        {!rule.style.shape && !rule.style.fill && !rule.style.stroke && !rule.style.highlight && (
          <span className="faint fs-xs">没设任何东西</span>
        )}
      </span>
      <button className="btn btn--ghost btn--sm" onClick={onRemove} title="删掉这条规则">
        ✕
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 单节点自定义（P5 9.1）
// ---------------------------------------------------------------------------

interface NodeDraft {
  shape: '' | NodeShape
  fill: string
  stroke: string
  size: number | null
  label: '' | 'on' | 'off'
  highlight: boolean
  image: string
}

const draftOf = (p: NodeStylePatch | undefined): NodeDraft => ({
  shape: p?.shape ?? '',
  fill: p?.fill ?? '',
  stroke: p?.stroke ?? '',
  size: p?.size ?? null,
  label: p?.label == null ? '' : p.label ? 'on' : 'off',
  highlight: p?.highlight ?? false,
  image: p?.image ?? '',
})

/**
 * 选中节点的样子。
 *
 * 为什么放侧栏而不是做成跟随节点的浮层：调颜色、试大小是**反复对着图看**的事，
 * 浮层会一直挡住那个节点本身；而且这个面板本来就挂在所有图视图的侧栏里，
 * 选中状态一传进来它就工作了，不用再接一套弹出逻辑。
 */
function NodeStyleSection({ nodeId, name }: { nodeId: string; name: string }) {
  const { nodeStyles, setNodeStyle, assets, notify } = useApp()
  const [draft, setDraft] = useState<NodeDraft>(() => draftOf(nodeStyles[nodeId]))
  const timer = useRef<number | undefined>(undefined)
  const fileRef = useRef<HTMLInputElement>(null)

  // 换了选中的节点 → 重新读一遍它的现状
  useEffect(() => {
    setDraft(draftOf(nodeStyles[nodeId]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId])

  /** 草稿 → 落盘的补丁。全空 = 恢复默认（后端会把那条删掉，不留空壳） */
  const commit = (d: NodeDraft) => {
    const patch: NodeStylePatch = {}
    if (d.shape && d.shape !== 'auto') patch.shape = d.shape as Exclude<NodeShape, 'auto'>
    if (d.fill) patch.fill = d.fill
    if (d.stroke) patch.stroke = d.stroke
    if (d.size != null) patch.size = d.size
    if (d.label) patch.label = d.label === 'on'
    if (d.highlight) patch.highlight = true
    if (d.image) patch.image = d.image
    void setNodeStyle(nodeId, patch)
  }

  /** 改草稿 + 400ms 防抖落盘（拖大小滑杆是一连续动作，一下一请求会把接口打爆） */
  const edit = (patch: Partial<NodeDraft>) => {
    setDraft((cur) => {
      const next = { ...cur, ...patch }
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => commit(next), 400)
      return next
    })
  }

  const upload = async (file: File) => {
    try {
      const item = await api.uploadAsset('icons', file)
      // 传了图就顺手把形状切成「图片」—— 不然图存进去了图上却不显示，
      // 用户只会觉得「上传失败了」
      edit({ image: `icons/${item.name}`, shape: 'image' })
      notify('ok', `已上传「${item.stem}」并用作这个节点的图`)
    } catch (e) {
      notify('err', `上传失败：${(e as Error).message}`)
    }
  }

  const icons = assets?.assets?.icons ?? []
  const dirty = Boolean(nodeStyles[nodeId])

  return (
    <>
      <p className="faint fs-xs" style={{ margin: '0 0 8px', lineHeight: 1.7 }}>
        正在调：<strong>{name || nodeId}</strong>
        {dirty ? '（手动调过 —— 它优先于下面所有的样式包规则）' : ''}
      </p>

      <div className="field">
        <label className="field__label">形状</label>
        <div className="row row--wrap" style={{ gap: 5 }}>
          {SHAPE_LABELS.map((s) => (
            <button
              key={s.key}
              className={`chip chip--btn ${draft.shape === s.key ? 'chip--accent' : ''}`}
              onClick={() => edit({ shape: draft.shape === s.key ? '' : s.key })}
              title={s.hint}
            >
              {s.key === 'auto' ? '跟随包' : s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="row row--wrap" style={{ gap: 8, margin: '4px 0 8px' }}>
        <label className="colorin" title="填色（空 = 跟随包）">
          <input type="color" value={draft.fill || '#6a97f5'} onChange={(e) => edit({ fill: e.target.value })} />
          <span>填色</span>
        </label>
        {draft.fill && (
          <button className="chip chip--btn chip--sm" onClick={() => edit({ fill: '' })} title="清掉填色，改回跟随包">
            ✕ 填色
          </button>
        )}
        <label className="colorin" title="描边">
          <input type="color" value={draft.stroke || '#ffffff'} onChange={(e) => edit({ stroke: e.target.value })} />
          <span>描边</span>
        </label>
        {draft.stroke && (
          <button className="chip chip--btn chip--sm" onClick={() => edit({ stroke: '' })} title="清掉描边">
            ✕ 描边
          </button>
        )}
        <button
          className={`chip chip--btn ${draft.highlight ? 'chip--accent' : ''}`}
          onClick={() => edit({ highlight: !draft.highlight })}
          title="加一圈高亮环，用来强调关键角色"
        >
          高亮
        </button>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`ns-size-${nodeId}`}>
          大小　{draft.size != null ? `${Math.round(draft.size)}px` : '跟随包'}
        </label>
        <input
          id={`ns-size-${nodeId}`}
          type="range"
          min={4}
          max={60}
          step={1}
          value={draft.size ?? 14}
          onChange={(e) => edit({ size: Number(e.target.value) })}
          style={{ width: '100%' }}
        />
        {draft.size != null && (
          <button className="btn btn--ghost btn--sm" style={{ marginTop: 4 }} onClick={() => edit({ size: null })}>
            改回跟随包
          </button>
        )}
      </div>

      <div className="field">
        <label className="field__label">图片</label>
        <div className="row row--wrap" style={{ gap: 6 }}>
          {draft.image && <img className="nsicon" src={api.assetUrlOf(draft.image)} alt="" />}
          <select
            className="select select--sm grow"
            value={draft.image}
            onChange={(e) => edit({ image: e.target.value, shape: e.target.value ? 'image' : draft.shape })}
          >
            <option value="">不指定</option>
            {icons.map((i) => (
              <option key={i.name} value={`icons/${i.name}`}>{i.stem}</option>
            ))}
          </select>
          <label className="btn btn--ghost btn--sm" title="从电脑上传一张图当这个节点">
            上传
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void upload(f)
                e.target.value = ''
              }}
            />
          </label>
          {draft.image && (
            <button
              className="chip chip--btn chip--sm"
              onClick={() => edit({ image: '', shape: '' })}
              title="不用图了，改回跟随包"
            >
              ✕ 图片
            </button>
          )}
        </div>
      </div>

      <div className="row row--wrap" style={{ gap: 6, margin: '4px 0 10px' }}>
        <span className="faint fs-xs">名字：</span>
        {([['', '跟随包'], ['on', '显示'], ['off', '隐藏']] as const).map(([v, text]) => (
          <button
            key={v || 'auto'}
            className={`chip chip--btn ${draft.label === v ? 'chip--accent' : ''}`}
            onClick={() => edit({ label: v })}
          >
            {text}
          </button>
        ))}
      </div>

      {dirty && (
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => {
            window.clearTimeout(timer.current)
            setDraft(draftOf(undefined))
            void setNodeStyle(nodeId, {})
          }}
          title="把这条节点上的手动设定全部去掉"
        >
          恢复默认（清掉手动设定）
        </button>
      )}
    </>
  )
}

export function StylePackPanel({
  nodeId = null,
  nodeName = null,
}: {
  /** 图上选中的节点 id。给了才显示「这个节点」一节 */
  nodeId?: string | null
  nodeName?: string | null
} = {}) {
  const {
    styles, tags: allTags, types, patchPackGraph, patchPackRules, patchPackMeta,
    setPack, newPack, removePack, importPack, notify,
  } = useApp()

  const pack: StylePack | null = styles?.active_pack ?? null
  const fileRef = useRef<HTMLInputElement>(null)

  // ---- 新规则的草稿（加进列表才落盘，避免每改一个字段就写一次文件）----
  const [draftBy, setDraftBy] = useState<'type' | 'tag'>('type')
  const [draftValue, setDraftValue] = useState('')
  // 收 `NodeShape` 全量而不是 `Exclude<…,'auto'>`：下面那排按钮是 `SHAPE_LABELS`
  // 过滤出来的，`filter` 在类型层面收不窄，写成 Exclude 就得在 onClick 里塞断言。
  // 把「auto 不算一种具体形状」这件事放到加规则那一步判，类型和意图都更直白。
  const [draftShape, setDraftShape] = useState<'' | NodeShape>('')
  const [draftFill, setDraftFill] = useState('')
  const [draftStroke, setDraftStroke] = useState('')
  const [draftHi, setDraftHi] = useState(false)

  const tagOptions = useMemo(() => allTags.slice(0, 200), [allTags])

  if (!pack) {
    return (
      <p className="faint fs-xs" style={{ lineHeight: 1.7 }}>
        样式还没读出来。它在 <span className="mono">view/styles/</span> 里，
        删掉也不影响实体数据，重新打开这一页会重新生成。
      </p>
    )
  }

  const g = pack.graph
  const setG = (patch: Partial<typeof g>) => void patchPackGraph(patch)

  const addRule = () => {
    const value = draftValue.trim()
    if (!value) {
      notify('info', '先选一个类型或标签')
      return
    }
    const style: StyleRule['style'] = {}
    // 「自动」不是一种形状，是「不规定」—— 规则里写它等于什么都不做
    if (draftShape && draftShape !== 'auto') style.shape = draftShape
    if (draftFill) style.fill = draftFill
    if (draftStroke) style.stroke = draftStroke
    if (draftHi) style.highlight = true
    if (!Object.keys(style).length) {
      notify('info', '至少设一样：形状、颜色或高亮')
      return
    }
    // 同一个「类型/标签」只留一条 —— 两条会互相打架，谁也说不清哪条赢
    const rest = pack.rules.filter(
      (r) => !(r.match.by === draftBy && r.match.value === value),
    )
    void patchPackRules([...rest, { match: { by: draftBy, value }, style }])
    setDraftValue('')
    setDraftFill('')
    setDraftStroke('')
    setDraftShape('')
    setDraftHi(false)
  }

  /** 导出：把当前包存成一个 JSON 文件。文件名用包名，方便认 */
  const doExport = () => {
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${pack.name || 'style'}.json`
    a.click()
    URL.revokeObjectURL(a.href)
    notify('ok', `已导出「${pack.name}」`)
  }

  /** 导入：读一个 JSON，交给 store 存成**新包**（不覆盖现有的任何一个） */
  const doImport = async (file: File) => {
    try {
      const raw = JSON.parse(await file.text())
      const body = raw?.pack && typeof raw.pack === 'object' ? raw.pack : raw
      if (!body || typeof body !== 'object') throw new Error('文件里没有样式包')
      await importPack({ ...body, name: String(body.name || file.name.replace(/\.json$/i, '')) })
      notify('ok', '样式已导入，并切了过去')
    } catch (e) {
      notify('err', `导入失败：${(e as Error).message}`)
    }
  }

  return (
    <>
      {/* ---------- 1. 样式包 ---------- */}
      <div className="packwall">
        {(styles?.packs ?? []).map((p) => (
          <button
            key={p.id}
            className={`packcard ${p.id === styles?.active ? 'packcard--on' : ''}`}
            onClick={() => void setPack(p.id)}
            title={p.desc || p.name}
          >
            {/* 缩略预览（P11-1️⃣⑤）：不点也知道这套包长什么样。
                画法与真实渲染共用 layoutStatic / resolveNode / edgePath，
                不是照着样子描一遍。 */}
            <span className="packcard__thumb">
              <PackThumb spec={p.spec} layout={p.layout} />
            </span>
            <span className="packcard__name">{p.name}</span>
            <span className="packcard__meta">
              {p.builtin ? (p.modified ? '内置 · 已改' : '内置') : '自建'}
              {p.layout ? ` · ${LAYOUT_LABELS.find((l) => l.key === p.layout)?.label ?? p.layout}` : ''}
            </span>
          </button>
        ))}
      </div>
      <p className="faint fs-xs" style={{ marginTop: 6, lineHeight: 1.7 }}>
        点一下<strong>整张图立刻变形</strong>。自己调过的单个节点不会被切包冲掉。
      </p>

      <div className="row row--wrap" style={{ gap: 6, margin: '8px 0 4px' }}>
        <button
          className="btn btn--sm"
          onClick={() => {
            const name = prompt('新样式叫什么？', `${pack.name} 改`)
            if (name?.trim()) void newPack(name.trim(), pack.id)
          }}
          title="以当前这套为底，另存一份可以随便改的"
        >
          另存为我的样式
        </button>
        <button
          className="btn btn--ghost btn--sm"
          onClick={doExport}
          title="导出成一个 JSON 文件，可以发给别人或留着备份"
        >
          导出
        </button>
        <label className="btn btn--ghost btn--sm" title="从 JSON 文件导入，会存成一个新样式">
          导入
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void doImport(f)
              e.target.value = ''
            }}
          />
        </label>
        {pack.builtin ? (
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => void removePack(pack.id)}
            disabled={!pack.modified}
            title={pack.modified ? '把这一套恢复成出厂的样子' : '还没改过，不用恢复'}
          >
            恢复出厂
          </button>
        ) : (
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => void removePack(pack.id)}
            title="删掉这个自建样式"
          >
            删除
          </button>
        )}
      </div>
      <div className="field" style={{ marginTop: 8 }}>
        <label className="field__label" htmlFor="pk-name">这一套的名字</label>
        <input
          id="pk-name"
          className="input input--sm"
          value={pack.name}
          onChange={(e) => void patchPackMeta({ name: e.target.value })}
        />
      </div>

      <hr className="panel__hr" />

      {/* ---------- 2. 图外观 ---------- */}
      <div className="field">
        <label className="field__label" htmlFor="pk-layout">布局</label>
        <select
          id="pk-layout"
          className="select select--sm"
          value={g.layout}
          onChange={(e) => setG({ layout: e.target.value as LayoutKind })}
        >
          {LAYOUT_LABELS.map((l) => (
            <option key={l.key} value={l.key}>{l.label} —— {l.hint}</option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label">节点形状</label>
        <div className="row row--wrap" style={{ gap: 5 }}>
          {SHAPE_LABELS.map((s) => (
            <button
              key={s.key}
              className={`chip chip--btn ${g.shape === s.key ? 'chip--accent' : ''}`}
              onClick={() => setG({ shape: s.key })}
              title={s.hint}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="faint fs-xs" style={{ marginTop: 5, lineHeight: 1.6 }}>
          「图片」用的是每个实体自己的图标；没设图标的会退回按类型配的图标。
        </p>
      </div>

      <div className="field">
        <label className="field__label">配色</label>
        <div className="row row--wrap" style={{ gap: 5 }}>
          {PALETTES.map((p) => (
            <button
              key={p.id}
              className={`chip chip--btn ${g.palette === p.id ? 'chip--accent' : ''}`}
              onClick={() => setG({ palette: p.id as PaletteId })}
              title={p.desc}
            >
              {p.name}
            </button>
          ))}
        </div>
        <div className="row" style={{ gap: 4, marginTop: 6 }}>
          {(PALETTES.find((p) => p.id === g.palette)?.colors ?? ['var(--accent)']).map((c, i) => (
            <span key={i} className="swatch" style={{ background: c }} />
          ))}
        </div>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="pk-size">节点大小　{g.sizeScale.toFixed(2)}×</label>
        <input
          id="pk-size"
          type="range"
          min={0.5}
          max={2.5}
          step={0.05}
          value={g.sizeScale}
          onChange={(e) => setG({ sizeScale: Number(e.target.value) })}
          style={{ width: '100%' }}
        />
      </div>

      <div className="field">
        <label className="field__label">连线</label>
        <div className="row row--wrap" style={{ gap: 5 }}>
          {(
            [
              ['straight', '直线', '直来直去'],
              ['curve', '曲线', '拱出去的贝塞尔弧'],
              ['elbow', '折线', '每条边各自一根竖段，成扇状'],
              ['bracket', '括号', '同父的子边合流成一根竖脊 —— 子节点多时最清爽'],
              ['step', '阶梯', '正交阶梯递进，层级感最强'],
            ] as const
          ).map(([c, label, hint]) => (
            <button
              key={c}
              className={`chip chip--btn ${g.edge.curve === c ? 'chip--accent' : ''}`}
              title={hint}
              onClick={() => setG({ edge: { ...g.edge, curve: c } })}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="row row--wrap" style={{ gap: 10, marginTop: 7 }}>
          <label className="row fs-sm" style={{ gap: 5, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={g.edge.dashed}
              onChange={(e) => setG({ edge: { ...g.edge, dashed: e.target.checked } })}
            />
            虚线
          </label>
          <label className="row fs-sm" style={{ gap: 5, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={g.edge.arrow}
              onChange={(e) => setG({ edge: { ...g.edge, arrow: e.target.checked } })}
            />
            箭头
          </label>
        </div>
      </div>

      <div className="field">
        <label className="field__label">标签</label>
        <div className="row row--wrap" style={{ gap: 10 }}>
          <label className="row fs-sm" style={{ gap: 5, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={g.label.show}
              onChange={(e) => setG({ label: { ...g.label, show: e.target.checked } })}
            />
            显示名称
          </label>
          <label className="row fs-sm" style={{ gap: 6, flex: 1, minWidth: 140 }}>
            字号
            <input
              type="range"
              min={0.6}
              max={2}
              step={0.05}
              value={g.label.scale}
              onChange={(e) => setG({ label: { ...g.label, scale: Number(e.target.value) } })}
              style={{ flex: 1 }}
            />
          </label>
        </div>
      </div>

      <div className="field">
        <label className="field__label">背景</label>
        <div className="row row--wrap" style={{ gap: 5 }}>
          {(['none', 'grid', 'stars', 'solid'] as const).map((b) => (
            <button
              key={b}
              className={`chip chip--btn ${g.background === b ? 'chip--accent' : ''}`}
              onClick={() => setG({ background: b })}
              title={b === 'grid' ? '细网格：给节点对齐一点参照' : b === 'stars' ? '星空：纯氛围' : ''}
            >
              {b === 'none' ? '无' : b === 'grid' ? '网格' : b === 'stars' ? '星空' : '纯色'}
            </button>
          ))}
        </div>
      </div>

      <hr className="panel__hr" />

      {/* ---------- 3. 这个节点（选中图上某个节点才出现） ---------- */}
      {nodeId ? (
        <>
          <div className="field__label" style={{ marginBottom: 6 }}>这个节点</div>
          <NodeStyleSection nodeId={nodeId} name={nodeName ?? ''} />
          <hr className="panel__hr" />
        </>
      ) : (
        <p className="faint fs-xs" style={{ margin: '0 0 4px', lineHeight: 1.7 }}>
          点图上一个节点，这里就能单独调它的样子 —— 手动调过的<strong>永远赢过</strong>下面任何规则。
        </p>
      )}

      {/* ---------- 4. 批量应用 ---------- */}
      <div className="field__label" style={{ marginBottom: 4 }}>批量应用</div>
      <p className="faint fs-xs" style={{ marginBottom: 8, lineHeight: 1.7 }}>
        给「某类实体」或「带某个标签的实体」统一规定长相，免得一个个点。
        <strong>标签规则优先于类型规则</strong>，你手动调过的那个节点又优先于两者。
      </p>

      {pack.rules.length === 0 ? (
        <p className="faint fs-xs" style={{ marginBottom: 8 }}>还没有规则。</p>
      ) : (
        <div className="rules">
          {pack.rules.map((r, i) => (
            <RuleRow
              key={`${r.match.by}:${r.match.value}`}
              rule={r}
              types={types}
              onRemove={() => void patchPackRules(pack.rules.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}

      <div className="rule-new">
        <div className="row" style={{ gap: 5 }}>
          <div className="seg" role="tablist" aria-label="规则对象">
            <button
              className={`seg__item ${draftBy === 'type' ? 'seg__item--on' : ''}`}
              onClick={() => { setDraftBy('type'); setDraftValue('') }}
            >
              按类型
            </button>
            <button
              className={`seg__item ${draftBy === 'tag' ? 'seg__item--on' : ''}`}
              onClick={() => { setDraftBy('tag'); setDraftValue('') }}
            >
              按标签
            </button>
          </div>
          <select
            className="select select--sm grow"
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
          >
            <option value="">选一个{draftBy === 'type' ? '类型' : '标签'}…</option>
            {(draftBy === 'type' ? types : tagOptions.map((t) => ({ key: t, label: `#${t}` }))).map(
              (o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ),
            )}
          </select>
        </div>
        <div className="row row--wrap" style={{ gap: 5, marginTop: 6 }}>
          {SHAPE_LABELS.filter((s) => s.key !== 'auto').map((s) => (
            <button
              key={s.key}
              className={`chip chip--btn ${draftShape === s.key ? 'chip--accent' : ''}`}
              onClick={() => setDraftShape(draftShape === s.key ? '' : s.key)}
              title={s.hint}
            >
              {s.label}
            </button>
          ))}
          <label className="colorin" title="填色">
            <input type="color" value={draftFill || '#6a97f5'} onChange={(e) => setDraftFill(e.target.value)} />
            <span>填色</span>
          </label>
          <label className="colorin" title="描边">
            <input type="color" value={draftStroke || '#ffffff'} onChange={(e) => setDraftStroke(e.target.value)} />
            <span>描边</span>
          </label>
          <button
            className={`chip chip--btn ${draftHi ? 'chip--accent' : ''}`}
            onClick={() => setDraftHi((v) => !v)}
            title="加一圈同色高亮环，用来强调关键角色"
          >
            高亮
          </button>
        </div>
        <div className="row" style={{ marginTop: 7 }}>
          <button className="btn btn--sm" onClick={addRule}>加进规则</button>
          {(draftFill || draftStroke) && (
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => { setDraftFill(''); setDraftStroke('') }}
            >
              清掉颜色
            </button>
          )}
          <div className="grow" />
          <span className="faint fs-xs">
            {draftFill && <span className="swatch swatch--sm" style={{ background: withAlpha(draftFill, 1) }} />}
          </span>
        </div>
      </div>

      <p className="faint fs-xs" style={{ marginTop: 10, lineHeight: 1.7 }}>
        样式存在 <span className="mono">books/&lt;书名&gt;/view/styles/</span>，
        与实体档案物理隔离 —— 这里怎么改都不会动到一个字的正文或设定。
      </p>
    </>
  )
}

export default StylePackPanel
