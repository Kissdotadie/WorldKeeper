/**
 * 思维导图大纲导入面板。
 *
 * 干的事：收一个 `.mm` / `.docx`，把解析出来的结构树摆给用户看，
 * 让 TA 逐个确认「这条是子级，还是对上面那条的说明」——然后才落盘。
 *
 * ## 为什么非要人过一眼
 *
 * 源文件里「子级」和「描述」**结构完全同构**（都是 child node），长度也不
 * 足以区分：「旧世界最大的海洋国」9 个字，是描述；「猎枪」2 个字，是真子级。
 * 后端已经尽力做了启发式初判（见 `app/parsers/outline_import.py`），
 * 但这类判断本质上需要作者的意图 —— 所以这里一不隐藏二不自动落盘，
 * 把每条的判定理由摊开给人看，推翻它只要点一下。
 *
 * 这是铁律 1 在结构层的同一条规矩：工具只产「待确认变更清单」。
 */

import { useCallback, useMemo, useRef, useState } from 'react'

import * as api from '../api/client'
import type { OutlineImport, OutlineImportNode } from '../api/client'
import { Modal } from '../components/Modal'
import { newVirtualId, type OutlineState } from '../graph/outline'

type Role = 'node' | 'desc'

interface Props {
  bookId: string
  /** 根节点默认名（界面名） */
  title: string
  /** 同名实体的解析 —— 命中就把节点挂到已有实体上，而不是新建自由节点 */
  resolveEntityId?: (name: string) => string | null
  onClose: () => void
  onApply: (next: OutlineState) => void
}

/** 走一遍树，收所有节点（含自己） */
function walkAll(ns: OutlineImportNode[]): OutlineImportNode[] {
  const out: OutlineImportNode[] = []
  const walk = (list: OutlineImportNode[]) => {
    for (const n of list) {
      out.push(n)
      walk(n.children)
    }
  }
  walk(ns)
  return out
}

/**
 * 一棵树 → 一份结构。
 *
 * - `role === 'node'`：建节点（优先挂同名实体，否则建自由节点）；
 * - `role === 'desc'`：**不建节点**，文本挂到当前父节点的描述里；
 *   万一它自己还挂着子级（人手动把结构节点标成了描述），子级上提给父级 ——
 *   与「摘下节点」同一条语义：不许把下面的东西弄丢。
 */
function buildOutline(
  items: OutlineImportNode[],
  roleOf: (n: OutlineImportNode) => Role,
  title: string,
  resolveEntityId?: (name: string) => string | null,
): { outline: OutlineState; nodes: number; descs: number; reused: number } {
  const rootId = newVirtualId()
  const outline: OutlineState = {
    schema: 1,
    root: rootId,
    children: {},
    names: { [rootId]: title },
    notes: {},
  }
  const used = new Set<string>([rootId])
  const stat = { nodes: 0, descs: 0, reused: 0 }

  const addNote = (id: string, text: string) => {
    const clean = text.trim()
    if (!clean) return
    const prev = outline.notes![id]
    outline.notes![id] = prev ? `${prev}\n\n${clean}` : clean
  }

  const walk = (list: OutlineImportNode[], parentId: string) => {
    for (const n of list) {
      const role = roleOf(n)
      if (role === 'desc') {
        stat.descs += 1
        addNote(parentId, n.desc ? `${n.head}\n${n.desc}` : n.head)
        walk(n.children, parentId) // 子级上提，不许丢
        continue
      }
      let id = resolveEntityId?.(n.head) ?? null
      if (id) {
        if (used.has(id)) id = null // 一个实体在一个结构里只能有一个位置
        else stat.reused += 1
      }
      if (!id) {
        id = newVirtualId()
        outline.names[id] = n.head
      }
      used.add(id)
      stat.nodes += 1
      const kids = outline.children[parentId] ?? []
      outline.children[parentId] = [...kids, id]
      if (n.desc) addNote(id, n.desc)
      walk(n.children, id)
    }
  }

  // 文档只有一个顶层节点（导出的中心主题）时，直接拿它当根名 ——
  // 「旧世界」比「世界观」更贴近这份稿子。
  let roots = items
  if (items.length === 1 && roleOf(items[0]) === 'node') {
    outline.names[rootId] = items[0].head
    roots = items[0].children
  }
  walk(roots, rootId)
  if (!outline.notes || Object.keys(outline.notes).length === 0) delete outline.notes
  return { outline, ...stat }
}

export function OutlineImportPanel({ bookId, title, resolveEntityId, onClose, onApply }: Props) {
  const [data, setData] = useState<OutlineImport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 用户改过的角色（只存与初判不同的那些） */
  const [overrides, setOverrides] = useState<Record<string, Role>>({})
  const [onlyDesc, setOnlyDesc] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const inputRef = useRef<HTMLInputElement | null>(null)

  const roleOf = useCallback(
    (n: OutlineImportNode): Role => overrides[n.id] ?? n.role,
    [overrides],
  )

  const upload = async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.parseOutline(bookId, file)
      setData(r)
      setOverrides({})
      setCollapsed({})
    } catch (e) {
      setData(null)
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const stats = useMemo(() => {
    if (!data) return { nodes: 0, descs: 0 }
    let nodes = 0
    let descs = 0
    for (const n of walkAll(data.items)) (roleOf(n) === 'desc' ? descs++ : nodes++)
    return { nodes, descs }
  }, [data, roleOf])

  const preview = useMemo(
    () => (data ? buildOutline(data.items, roleOf, title, resolveEntityId) : null),
    [data, roleOf, title, resolveEntityId],
  )

  const setRole = (id: string, role: Role) =>
    setOverrides((prev) => ({ ...prev, [id]: role }))

  /** 把一组兄弟整体设成同一个角色 —— 一段并列的说明，一条条点太慢 */
  const setGroupRole = (ns: OutlineImportNode[], role: Role) =>
    setOverrides((prev) => {
      const next = { ...prev }
      for (const n of ns) {
        // 有子级的节点被标成描述，子级要上提 —— 界面上提示过，允许这么做
        next[n.id] = role
      }
      return next
    })

  const row = (n: OutlineImportNode, depth: number, siblings: OutlineImportNode[]) => {
    const role = roleOf(n)
    const hasKids = n.children.length > 0
    const matchesFilter = !onlyDesc || role === 'desc' || hasDescendant(n, roleOf)
    if (!matchesFilter) return null
    const isCollapsed = collapsed[n.id] ?? (depth >= 2)
    return (
      <div key={n.id} className="oimp__node">
        <div
          className={`oimp__row ${role === 'desc' ? 'oimp__row--desc' : ''}`}
          style={{ paddingLeft: 6 + depth * 16 }}
        >
          <button
            className="oimp__caret"
            onClick={() => setCollapsed((p) => ({ ...p, [n.id]: !isCollapsed }))}
            disabled={!hasKids}
            title={hasKids ? '展开 / 收起子级' : ''}
            aria-label="展开或收起"
          >
            {hasKids ? (isCollapsed ? '▸' : '▾') : '·'}
          </button>
          <span className="oimp__head" title={`${n.reason}${n.desc ? `\n\n注记：${n.desc}` : ''}`}>
            {n.head}
          </span>
          {n.desc && <span className="oimp__desc-inline">{n.desc.replace(/\n/g, ' / ')}</span>}
          {hasKids && <span className="oimp__kids">{n.children.length}</span>}
          <div className="grow" />
          {hasKids && siblings.length > 1 && (
            <button
              className="oimp__group"
              onClick={() => setGroupRole(siblings, role)}
              title={`把这一组（${siblings.length} 条同级）都设成「${role === 'desc' ? '描述' : '子级'}」`}
            >
              整组
            </button>
          )}
          <div className="seg seg--xs">
            <button
              className={`seg__item ${role === 'node' ? 'seg__item--on' : ''}`}
              onClick={() => setRole(n.id, 'node')}
              title="建成一个节点"
            >
              子级
            </button>
            <button
              className={`seg__item ${role === 'desc' ? 'seg__item--on' : ''}`}
              onClick={() => setRole(n.id, 'desc')}
              title="不建节点，作为上面那条的描述"
            >
              描述
            </button>
          </div>
        </div>
        {hasKids && !isCollapsed && n.children.map((c) => row(c, depth + 1, n.children))}
      </div>
    )
  }

  const src = data?.source
  const footer = (
    <>
      {data && (
        <span className="fs-xs muted">
          将写入 <strong>{preview?.nodes ?? 0}</strong> 个节点
          {preview && preview.descs > 0 && <> · {preview.descs} 条并入描述</>}
          {preview && preview.reused > 0 && <> · <span className="oimp__reuse">{preview.reused} 条命中已有实体</span></>}
        </span>
      )}
      <div className="grow" />
      <button className="btn btn--ghost" onClick={onClose}>
        取消
      </button>
      <button
        className="btn btn--primary"
        disabled={!preview || busy}
        onClick={() => preview && onApply(preview.outline)}
        title="结构与描述写入这本的 view/scene.json；实体档案一个字不动"
      >
        导入
      </button>
    </>
  )

  return (
    <Modal title={`导入思维导图大纲 → ${title}`} onClose={onClose} footer={footer} xwide>
      <div className="oimp">
        <div className="row row--wrap" style={{ gap: 6, marginBottom: 'var(--p-space-2)' }}>
          <input
            ref={inputRef}
            type="file"
            accept=".mm,.docx,.txt,.md"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void upload(f)
              e.target.value = ''
            }}
          />
          <button className="btn btn--sm btn--primary" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? '解析中…' : '选择文件'}
          </button>
          <span className="faint fs-xs">支持 .mm（思维导图源文件，最准）/ .docx / .txt / .md</span>
        </div>

        {error && (
          <div className="oimp__error" role="alert">
            {error}
          </div>
        )}

        {!data && !error && !busy && (
          <div className="oimp__hint">
            <p>
              <strong>用思维导图的源文件（.mm）比导出的 .docx 准。</strong>
              实测同一份导图：<code>.mm</code> 是 22 层，导成 <code>.docx</code> 后被 Word
              的多级列表上限压成 9 层、39 个假的一级分支 —— 层级一旦压平就回不来了。
            </p>
            <p>
              导入后，「子级」会建成图上的节点，「描述」不占节点、作为上面那条的小字备注。
              这一步的判断结果**先给你过目**，改完才落盘；实体档案一个字都不会动。
            </p>
          </div>
        )}

        {data && src && (
          <>
            <div className="row row--wrap oimp__meta">
              <span className="chip">{src.name}</span>
              <span className="chip">共 {data.stats.total} 条</span>
              <span className="chip">最深 {data.stats.max_depth} 层</span>
              <span className={`chip ${src.exact ? 'oimp__exact' : 'oimp__lossy'}`}>
                {src.exact ? '层级无损' : '层级可能被导出器压平'}
              </span>
              <span className="chip oimp__c-node">子级 {stats.nodes}</span>
              <span className="chip oimp__c-desc">描述 {stats.descs}</span>
              <div className="grow" />
              <label className="row fs-xs muted" style={{ gap: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={onlyDesc}
                  onChange={(e) => setOnlyDesc(e.target.checked)}
                />
                只看被判为描述的
              </label>
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => setCollapsed({})}
                title="全部展开"
              >
                全部展开
              </button>
            </div>
            <div className="oimp__tree">{data.items.map((n) => row(n, 0, data.items))}</div>
          </>
        )}
      </div>
    </Modal>
  )
}

/** 子树里有没有描述 —— 「只看描述」筛选要顺着祖先链保留路径 */
function hasDescendant(n: OutlineImportNode, roleOf: (x: OutlineImportNode) => Role): boolean {
  for (const c of n.children) {
    if (roleOf(c) === 'desc' || hasDescendant(c, roleOf)) return true
  }
  return false
}
