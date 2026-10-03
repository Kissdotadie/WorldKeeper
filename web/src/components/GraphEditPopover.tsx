/**
 * 图上就地编辑浮层。
 *
 * 三种形态，都是一件事：**别为了改一个名字，关掉图去表格里找半天**。
 *   - `node`：双击已有节点 → 改名称 / 类型 / 标签 / 摘要（保存即落盘 Markdown）
 *   - `blank`：双击空白 → 就地新建一个实体（类型按所在分簇预选）
 *   - `link`：从一个节点拖到另一个 → 往源实体的「关联」段写一条
 *     `关系名：[[目标]]`（关系的真源永远只有这一处，图只是它的呈现）
 *
 * 为什么不复用 EntityForm？那是「完整档案」的思路（别名、方法论、图标、出处…）。
 * 在图上想动的通常只有一两个字段，弹一整个大表单反而更慢。
 *
 * ⚠️ 后端的更新是**全量覆盖**：不带的字段等于清空。所以这里改任何东西之前
 * 先把详情读回来，其余字段原样带回（图标就是这么差点被抹掉的）。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api/client'
import type { EntityPayload } from '../api/client'
import { useToast } from '../state/store'
import { useUndo } from '../state/undo'
import { useShortcuts } from '../lib/shortcuts'
import type { EntityDetail, TypeOption } from '../api/types'

/** 「读回来的这条」折成一份完整 payload —— 撤销要用它当旧快照。
 *  后端是全量覆盖，所以必须给全；少一个字段就等于「撤销也把它清空了」。 */
function payloadOf(d: EntityDetail): EntityPayload {
  return {
    type: d.type,
    name: d.name,
    aliases: d.aliases ?? [],
    tags: d.tags ?? [],
    methodologies: d.methodologies ?? [],
    first_appear: d.first_appear ?? null,
    status: d.status ?? null,
    icon: d.icon ?? null,
    body: d.body ?? null,
  }
}

export type EditKind = 'node' | 'blank' | 'link'

export interface GraphEditTarget {
  kind: EditKind
  /** 视口坐标 —— 浮层贴着鼠标出现 */
  screen: { x: number; y: number }
  entityId?: string
  entityName?: string
  toId?: string
  toName?: string
  /** 新建时的预选类型（按所在分簇推断） */
  defaultType?: string
  /** 新建落点（3D 世界坐标），由调用方写进 scene.json 的装饰层 */
  world?: { x: number; y: number; z: number }
}

interface Props {
  bookId: string
  target: GraphEditTarget
  types: TypeOption[]
  onClose: () => void
  /** 保存成功 —— 调用方负责重新拉图；新建时附带落点。默认关浮层。 */
  onSaved: (id: string, world?: { x: number; y: number; z: number }) => void
  /**
   * 档案变了、但**浮层要留着**（删关联走这条）。
   * 删一条就关掉浮层的话，想连着删两条得重新双击节点 —— 剪枝本来是连续动作。
   * 不给就退回 onSaved（老行为：刷新并关闭）。
   */
  onChanged?: (id: string) => void
  onOpenDetail?: (id: string) => void
}

const W = 330

const splitTags = (s: string) =>
  s
    .split(/[、,，;；\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)

export function GraphEditPopover({ bookId, target, types, onClose, onSaved, onChanged, onOpenDetail }: Props) {
  const { notify } = useToast()
  const { recordEntity } = useUndo()
  const boxRef = useRef<HTMLDivElement>(null)
  const [detail, setDetail] = useState<EntityDetail | null>(null)
  const [name, setName] = useState(target.entityName ?? '')
  const [type, setType] = useState(target.defaultType ?? types[0]?.key ?? '')
  const [tags, setTags] = useState('')
  const [summary, setSummary] = useState('')
  const [rel, setRel] = useState('关联')
  const [loading, setLoading] = useState(target.kind !== 'blank')
  const [busy, setBusy] = useState(false)

  // 已有节点：把现状读回来填进表单（也是「其余字段原样带回」的来源）
  useEffect(() => {
    if (target.kind === 'blank' || !target.entityId) return
    let alive = true
    setLoading(true)
    api
      .getEntity(bookId, target.entityId)
      .then((d) => {
        if (!alive) return
        setDetail(d)
        setName(d.name)
        setType(d.type)
        setTags((d.tags ?? []).join('、'))
        setSummary(d.summary ?? '')
      })
      .catch((e) => {
        notify('err', `读不到这条实体：${(e as Error).message}`)
        onClose()
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [bookId, target.kind, target.entityId, notify, onClose])

  // 定位：贴着鼠标，但不许出屏幕。
  // 两个坑都踩过：
  //   1. 高度不能写死 —— 关联清单一出来浮层高了一截，按 300 估会在下缘被裁掉。
  //   2. `position: fixed` 不一定相对视口 —— dockview 的容器带 transform，
  //      会把 fixed 变成**相对那个容器**定位。这时按 window.innerHeight 钳制
  //      就差出一个容器头的距离（实测 46px）。`offsetParent` 正是浏览器算好的
  //      定位基准，按它的矩形来钳才准。
  // 所以挂 ResizeObserver 持续盯真实高度 + 基准矩形，变了就重新钳一次。
  const [measuredH, setMeasuredH] = useState(300)
  const [base, setBase] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const read = () => {
      const h = el.offsetHeight
      if (h) setMeasuredH((prev) => (Math.abs(prev - h) > 1 ? h : prev))
      const op = el.offsetParent as HTMLElement | null
      const r = op?.getBoundingClientRect()
      setBase((prev) => {
        const next = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null
        const same =
          prev === next ||
          (prev && next && Math.abs(prev.x - next.x) < 1 && Math.abs(prev.y - next.y) < 1 &&
            Math.abs(prev.w - next.w) < 1 && Math.abs(prev.h - next.h) < 1)
        return same ? prev : next
      })
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    window.addEventListener('resize', read)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', read)
    }
  }, [])
  const pos = useMemo(() => {
    // screen 是视口坐标；基准不是视口时先换算进基准坐标系
    const bx = base?.x ?? 0
    const by = base?.y ?? 0
    const bw = base?.w ?? window.innerWidth
    const bh = base?.h ?? window.innerHeight
    const sx = target.screen.x - bx
    const sy = target.screen.y - by
    return {
      x: Math.max(8, Math.min(sx + 16, bw - W - 8)),
      y: Math.max(8, Math.min(sy + 12, bh - measuredH - 8)),
    }
  }, [target.screen, measuredH, base])

  // 点外面关掉（pointerdown 那条保持本地的：它就是「点这儿以外」这个空间判断，
  // 跟键盘无关）。Esc 则走全局注册表（P11-A2）——
  // 优先级 100：比常规动作（取消选中，0）高，比弹窗（200）低。
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose()
    }
    // 延后一拍再挂，免得把「触发这次打开」的那一下点击也算成点外面
    const t = window.setTimeout(() => window.addEventListener('pointerdown', onDown), 0)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [onClose])

  useShortcuts(
    [
      {
        id: 'gedit.esc',
        keys: 'Esc',
        scope: 'global',
        desc: '关闭图上编辑浮层',
        priority: 100,
        run: () => onClose(),
      },
    ],
    [onClose],
  )

  const save = async () => {
    const nm = name.trim()
    if (!nm || busy) return
    setBusy(true)
    try {
      if (target.kind === 'blank') {
        const r = await api.createEntity(bookId, {
          type,
          name: nm,
          tags: splitTags(tags),
          summary: summary.trim(),
        })
        notify('ok', `已新建「${nm}」`)
        onSaved(r.id, target.world)
        return
      }

      if (!target.entityId || !detail) return
      // 把不打算动的字段原样带回去 —— 后端是全量覆盖
      const base = {
        type,
        name: nm,
        aliases: detail.aliases ?? [],
        tags: splitTags(tags),
        methodologies: detail.methodologies ?? [],
        first_appear: detail.first_appear ?? null,
        status: detail.status ?? null,
        icon: detail.icon ?? null,
      }

      const before = payloadOf(detail)
      if (target.kind === 'link' && target.toName) {
        const marker = `[[${target.toName}]]`
        const list = (detail.body?.关联 ?? []).filter((x) => !x.includes(marker))
        list.push(`${rel.trim() || '关联'}：${marker}`)
        const after = { ...base, body: { 关联: list } }
        await api.updateEntity(bookId, target.entityId, after)
        await recordEntity({
          bookId, entityId: target.entityId, before, after,
          label: `连一条关联：${nm} → ${target.toName}`,
        })
        notify('ok', `已建立「${nm} → ${target.toName}」`)
      } else {
        const after = { ...base, summary: summary.trim() }
        await api.updateEntity(bookId, target.entityId, after)
        await recordEntity({ bookId, entityId: target.entityId, before, after, label: `改属性：${nm}` })
        notify('ok', `已更新「${nm}」`)
      }
      onSaved(target.entityId)
    } catch (e) {
      notify('err', `保存失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const removeRel = async (line: string) => {
    if (!target.entityId || !detail || busy) return
    setBusy(true)
    try {
      // 与 save() 同一套规矩：不动的字段原样带回（后端顶层字段是全量覆盖）
      const base = {
        type,
        name: name.trim(),
        aliases: detail.aliases ?? [],
        tags: splitTags(tags),
        methodologies: detail.methodologies ?? [],
        first_appear: detail.first_appear ?? null,
        status: detail.status ?? null,
        icon: detail.icon ?? null,
      }
      const list = (detail.body?.关联 ?? []).filter((x: string) => x !== line)
      const after = {
        ...base,
        body: { 关联: list },
        summary: summary.trim(),
      }
      await api.updateEntity(bookId, target.entityId, after)
      await recordEntity({
        bookId, entityId: target.entityId, before: payloadOf(detail), after,
        label: `删掉一条关联：${line.replace(/\[\[|\]\]/g, '')}`,
      })
      // 把现状读回来 —— 连删几条时不会拿旧列表当底
      const fresh = await api.getEntity(bookId, target.entityId)
      setDetail(fresh)
      setTags((fresh.tags ?? []).join('、'))
      notify('ok', '已删掉这条关联 —— 图上的连线随之消失（按 Ctrl+Z 可撤销）')
      // 删关联是连续动作：图刷新，但浮层留着，好在清单里接着删下一条
      if (onChanged) onChanged(target.entityId)
      else onSaved(target.entityId)
    } catch (e) {
      notify('err', `删除失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const title =
    target.kind === 'blank' ? '就地新建' : target.kind === 'link' ? '建立关联' : '改这一条'

  return (
    <div className="gedit" ref={boxRef} style={{ left: pos.x, top: pos.y, width: W }}>
      <div className="gedit__head">
        <span className="fs-sm">{title}</span>
        <div className="grow" />
        <button className="btn btn--ghost btn--icon btn--sm" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </div>

      {target.kind === 'link' && (
        <div className="gedit__flow">
          <span className="gedit__pill">{target.entityName}</span>
          <span className="faint">→</span>
          <span className="gedit__pill">{target.toName}</span>
        </div>
      )}

      {loading ? (
        <div className="gedit__loading">
          <span className="spinner" />
          <span className="fs-sm faint">读取中…</span>
        </div>
      ) : (
        <div className="gedit__body">
          {target.kind === 'link' ? (
            <label className="field">
              <span className="field__label">关系名</span>
              <input
                className="input"
                value={rel}
                autoFocus
                placeholder="师徒 / 上级 / 效忠…"
                onChange={(e) => setRel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void save()
                }}
              />
              <span className="faint fs-xs">
                会写进「{target.entityName}」的关联段：{rel.trim() || '关联'}：[[{target.toName}]]
              </span>
            </label>
          ) : (
            <>
              <label className="field">
                <span className="field__label">名称</span>
                <input
                  className="input"
                  value={name}
                  autoFocus={target.kind === 'blank'}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void save()
                  }}
                />
              </label>

              <label className="field">
                <span className="field__label">类型</span>
                <select className="select" value={type} onChange={(e) => setType(e.target.value)}>
                  {types.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span className="field__label">标签</span>
                <input
                  className="input"
                  value={tags}
                  placeholder="顿号或逗号分隔"
                  onChange={(e) => setTags(e.target.value)}
                />
              </label>

              <label className="field">
                <span className="field__label">摘要</span>
                <textarea
                  className="textarea"
                  rows={3}
                  value={summary}
                  placeholder="一句话说清它是谁 / 是什么"
                  onChange={(e) => setSummary(e.target.value)}
                />
              </label>

              {/* 关联清单（P10 编辑器补全）：图上点开一个节点就能删掉某条关系，
                  不用回表格翻正文。删的是源档案里的 [[双链]] 行 —— 关系真源唯一。 */}
              {target.kind === 'node' && (detail?.body?.关联?.length ?? 0) > 0 && (
                <div className="gedit__rels">
                  <span className="field__label">关联（✕ 删掉这条，图上的连线随之消失）</span>
                  {(detail!.body!.关联 as string[]).map((line) => (
                    <div key={line} className="gedit__rel">
                      <span className="gedit__rel-text" title={line}>
                        {line}
                      </span>
                      <button
                        className="btn btn--ghost btn--sm gedit__rel-del"
                        disabled={busy}
                        title="删掉这条关联（写入档案；后悔了按 Ctrl+Z 撤销）"
                        onClick={() => void removeRel(line)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="gedit__actions">
        {target.kind === 'node' && target.entityId && onOpenDetail && (
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => {
              onOpenDetail(target.entityId!)
              onClose()
            }}
            title="别名、方法论、图标、出处 —— 完整档案在那边"
          >
            完整档案
          </button>
        )}
        <div className="grow" />
        <button className="btn btn--sm" onClick={onClose}>
          取消
        </button>
        <button className="btn btn--primary btn--sm" disabled={busy || !name.trim()} onClick={() => void save()}>
          {busy ? '保存中…' : target.kind === 'link' ? '连线' : target.kind === 'blank' ? '新建' : '保存'}
        </button>
      </div>
    </div>
  )
}

export default GraphEditPopover
