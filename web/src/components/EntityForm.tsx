import { useEffect, useMemo, useState } from 'react'
import * as api from '../api/client'
import type { AssetItem, EntityBody, EntityDetail, TypeOption } from '../api/types'
import { useApp } from '../state/store'
import { useUndo } from '../state/undo'
import { genreSample } from '../lib/genre'
import { Modal } from './Modal'
import { splitList, stripLinks } from '../lib/format'

interface Props {
  /** 传入则为编辑，不传为新建 */
  editing: EntityDetail | null
  defaultType?: string
  onClose: () => void
  onSaved: (id: string) => void
}

type Pair = [string, string]

export function EntityForm({ editing, defaultType, onClose, onSaved }: Props) {
  const { bookId, types, notify, refresh, currentBook } = useApp()
  const { recordEntity } = useUndo()
  // 示例占位跟着书目题材走 —— 玄幻书别给你看「明显帝」
  const sample = genreSample(currentBook?.genre)

  const [type, setType] = useState(editing?.type ?? defaultType ?? 'character')
  const [name, setName] = useState(editing?.name ?? '')
  const [aliases, setAliases] = useState((editing?.aliases ?? []).join('、'))
  const [tags, setTags] = useState((editing?.tags ?? []).join('、'))
  const [firstAppear, setFirstAppear] = useState(editing?.first_appear ?? '')
  const [status, setStatus] = useState(editing?.status ?? '')
  const [icon, setIcon] = useState(editing?.icon ?? '')
  const [icons, setIcons] = useState<AssetItem[]>([])
  const [summary, setSummary] = useState(editing?.body.摘要 ?? '')
  const [attrs, setAttrs] = useState<Pair[]>(editing?.body.属性 ?? [])
  const [apps, setApps] = useState<Pair[]>(editing?.body.出场记录 ?? [])
  const [relations, setRelations] = useState((editing?.body.关联 ?? []).join('\n'))
  const [todos, setTodos] = useState((editing?.body.待补充 ?? []).join('\n'))

  const [saving, setSaving] = useState(false)
  const dirty = useMemo(() => name.trim().length > 0, [name])

  useEffect(() => {
    api
      .listAssets()
      .then((r) => setIcons(r.assets.icons ?? []))
      .catch(() => undefined)
  }, [])

  const submit = async () => {
    if (!bookId || !dirty) return
    setSaving(true)
    try {
      const body: EntityBody = {
        摘要: summary.trim(),
        属性: attrs.filter((r) => r[0].trim()),
        出场记录: apps.filter((r) => r[0].trim()),
        关联: relations.split('\n').map((s) => s.trim()).filter(Boolean),
        待补充: todos.split('\n').map((s) => s.trim()).filter(Boolean),
      }
      const payload = {
        type,
        name: name.trim(),
        aliases: splitList(aliases),
        tags: splitList(tags),
        first_appear: firstAppear.trim() || null,
        status: status.trim() || null,
        icon: icon || null,
        body,
      }

      if (editing) {
        await api.updateEntity(bookId, editing.id, payload)
        // 记进撤销栈（P11-A1）。`before` 直接取**读回来的那条**（不是表单初始值）——
        // 后端是全量覆盖，拿表单初始值当旧快照会把表单打开期间别处改的东西一起退回去。
        await recordEntity({
          bookId,
          entityId: editing.id,
          before: {
            type: editing.type,
            name: editing.name,
            aliases: editing.aliases ?? [],
            tags: editing.tags ?? [],
            methodologies: editing.methodologies ?? [],
            first_appear: editing.first_appear ?? null,
            status: editing.status ?? null,
            icon: editing.icon ?? null,
            body: editing.body ?? null,
          },
          after: payload,
          label: `改属性：${editing.name}`,
        })
        notify('ok', `已保存「${name.trim()}」`)
        onSaved(editing.id)
      } else {
        const res = await api.createEntity(bookId, payload)
        notify('ok', `已新建「${res.name}」（${res.id}）`)
        onSaved(res.id)
      }
      await refresh()
      onClose()
    } catch (e) {
      notify('err', `保存失败：${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      wide
      title={editing ? `编辑「${editing.name}」` : '新建实体'}
      onClose={onClose}
      footer={
        <>
          {editing && (
            <span className="faint fs-xs mono grow" style={{ marginRight: 'auto' }}>
              {editing.id} · 改名不会改 ID，引用不会断
            </span>
          )}
          <button className="btn" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={saving || !dirty}>
            {saving && <span className="spinner" />}
            {editing ? '保存' : '创建'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="field">
          <label className="field__label" htmlFor="f-type">类型</label>
          <select
            id="f-type"
            className="select"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            {types.map((t: TypeOption) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="f-name">主名 *</label>
          <input
            id="f-name"
            className="input"
            value={name}
            autoFocus
            placeholder={`例如：${sample.person}`}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="f-aliases">别名（顿号或逗号分隔）</label>
          <input
            id="f-aliases"
            className="input"
            value={aliases}
            placeholder={sample.aliases}
            onChange={(e) => setAliases(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="f-tags">标签</label>
          <input
            id="f-tags"
            className="input"
            value={tags}
            placeholder={sample.tags}
            onChange={(e) => setTags(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="f-first">首次出场</label>
          <input
            id="f-first"
            className="input"
            value={firstAppear}
            placeholder={sample.firstAppear}
            onChange={(e) => setFirstAppear(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="f-status">状态</label>
          <input
            id="f-status"
            className="input"
            value={status}
            placeholder={sample.status}
            onChange={(e) => setStatus(e.target.value)}
          />
        </div>

        <div className="field form-grid--full">
          <label className="field__label" htmlFor="f-icon">图标（可选）</label>
          <div className="row" style={{ gap: 8 }}>
            {icon && <img className="icon-pick__preview" src={api.assetUrlOf(icon)} alt="" />}
            <select
              id="f-icon"
              className="select"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
            >
              <option value="">不用图标（按类型显示形状）</option>
              {icons.map((i) => (
                <option key={i.name} value={`icons/${i.name}`}>
                  {i.stem}
                </option>
              ))}
            </select>
            <label className="btn btn--ghost btn--sm" title="上传一张图片当这个实体的图标">
              上传
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (!f) return
                  try {
                    const item = await api.uploadAsset('icons', f)
                    const r = await api.listAssets()
                    setIcons(r.assets.icons ?? [])
                    setIcon(`icons/${item.name}`)
                    notify('ok', `已上传 ${item.name}`)
                  } catch (err) {
                    notify('err', `上传失败：${(err as Error).message}`)
                  }
                }}
              />
            </label>
          </div>
          <p className="faint fs-xs" style={{ marginTop: 4 }}>
            这是这个实体自己的图标（属内容，写进实体文件）；「按类型统一换图标」在关系网右侧，属视图装饰。
          </p>
        </div>

        <div className="field form-grid--full">
          <label className="field__label" htmlFor="f-summary">摘要</label>
          <textarea
            id="f-summary"
            className="textarea"
            value={summary}
            placeholder="一两句话讲清这是谁 / 这是什么。以后搜索主要靠它。"
            onChange={(e) => setSummary(e.target.value)}
          />
        </div>
      </div>

      <hr className="hr" />

      <div className="detail__section" style={{ marginTop: 0 }}>
        <div className="detail__section-title">属性</div>
        <PairEditor
          rows={attrs}
          onChange={setAttrs}
          kPlaceholder={`例如：${sample.attrKey}`}
          vPlaceholder={`例如：${sample.attrValue}`}
          addLabel="＋ 加一条属性"
        />
      </div>

      <div className="detail__section">
        <div className="detail__section-title">出场记录</div>
        <PairEditor
          rows={apps}
          onChange={setApps}
          kPlaceholder="章节，例如：第12章"
          vPlaceholder="这一章里做了什么"
          addLabel="＋ 加一条出场"
        />
      </div>

      <div className="detail__section">
        <div className="detail__section-title">
          关联 —— 用 <span className="mono">[[名字]]</span> 建立关系，关系图由此生成
        </div>
        <textarea
          className="textarea"
          value={relations}
          placeholder={sample.relation}
          onChange={(e) => setRelations(e.target.value)}
        />
        {relations.trim() && (
          <div className="row row--wrap" style={{ marginTop: 6 }}>
            <span className="faint fs-xs">识别到的双链</span>
            {[...relations.matchAll(/\[\[([^[\]]+)\]\]/g)].map((m, i) => (
              <span key={i} className="chip">
                {stripLinks(m[1])}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="detail__section">
        <div className="detail__section-title">待补充（一行一条）</div>
        <textarea
          className="textarea"
          style={{ minHeight: 60 }}
          value={todos}
          placeholder={sample.todo}
          onChange={(e) => setTodos(e.target.value)}
        />
      </div>
    </Modal>
  )
}

function PairEditor({
  rows,
  onChange,
  kPlaceholder,
  vPlaceholder,
  addLabel,
}: {
  rows: Pair[]
  onChange: (rows: Pair[]) => void
  kPlaceholder: string
  vPlaceholder: string
  addLabel: string
}) {
  const set = (i: number, idx: 0 | 1, value: string) => {
    const next = rows.map((r, j) => (i === j ? ([idx === 0 ? value : r[0], idx === 1 ? value : r[1]] as Pair) : r))
    onChange(next)
  }
  return (
    <div className="rows">
      {rows.map((r, i) => (
        <div className="rows__row" key={i}>
          <input className="input" value={r[0]} placeholder={kPlaceholder} onChange={(e) => set(i, 0, e.target.value)} />
          <input className="input" value={r[1]} placeholder={vPlaceholder} onChange={(e) => set(i, 1, e.target.value)} />
          <button className="btn btn--ghost btn--sm" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="删除这一行">
            ✕
          </button>
        </div>
      ))}
      <button className="btn btn--sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...rows, ['', '']])}>
        {addLabel}
      </button>
    </div>
  )
}
