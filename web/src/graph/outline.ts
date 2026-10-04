/**
 * 思维导图的「自由结构」数据层。
 *
 * 背景：导图的骨架以前是**纯派生**的（界面名 → 标签 → 实体），用户没法表达
 * 「A 包含 B」「B 的上级是 C」这种自己的层级。现在把结构变成一份**可编辑的
 * 覆盖层**，存在 `view/scene.json` 的 `outlines[sceneKey]` 里 —— 装饰层落文件，
 * 不碰实体档案（铁律 2/5），后端 scene 接口本来就整份存 JSON，零后端改动。
 *
 * 节点分两种：
 * - 实体节点：id 就是实体 id，结构只记「谁挂在谁下面」，实体档案一字不动；
 * - 自由节点：`__outline__:` 前缀的界面造节点（快速 brainstorm 用），
 *   名字存在 `names` 里，随时可以删，不影响任何实体。
 *
 * 所有函数都是纯的：传进来，返回新的，不改旧的 —— 调用方拿着返回值去 setState。
 */

export interface OutlineState {
  schema: 1
  /** 根节点 id（实体 id 或虚拟节点 id）。根只有一个 —— 不做多父（面包屑会乱） */
  root: string
  /** 父 id → 有序子 id 列表。顺序就是 WPS 思维导图里兄弟节点的上下顺序 */
  children: Record<string, string[]>
  /** 自由节点的名字。实体节点不在这里 —— 名字永远以实体档案为准 */
  names: Record<string, string>
  /**
   * 节点 → 描述文本（导入大纲时用）。
   *
   * 从思维导图导出的文档里，「子级」和「描述」长得一模一样（都是子节点），
   * 导入面板把它们分开之后：「子级」建成节点，**「描述」不建节点**，
   * 落到这里挂在它说明的那个节点名下，图上作为小字显示。
   *
   * 为什么不落进实体档案：铁律 1 —— 工具绝不改写正文，只产待确认清单。
   * 所以它留在装饰层，跟着结构走；结构丢了最多重新导一次。
   */
  notes?: Record<string, string>
}

export const VIRTUAL_PREFIX = '__outline__:'

export const isVirtualOutlineId = (id: string) => id.startsWith(VIRTUAL_PREFIX)

let virtualSeq = 0
export function newVirtualId(): string {
  virtualSeq += 1
  return `${VIRTUAL_PREFIX}n${Date.now().toString(36)}${virtualSeq.toString(36)}`
}

export function newOutline(rootId: string, rootName: string): OutlineState {
  const o: OutlineState = { schema: 1, root: rootId, children: {}, names: {} }
  if (isVirtualOutlineId(rootId)) o.names[rootId] = rootName
  return o
}

/** 克隆一份再改 —— 纯函数的底盘 */
function clone(o: OutlineState): OutlineState {
  return {
    schema: 1,
    root: o.root,
    children: { ...o.children },
    names: { ...o.names },
    ...(o.notes ? { notes: { ...o.notes } } : {}),
  }
}

export function outlineName(o: OutlineState, id: string): string | null {
  return o.names[id] ?? null
}

/** 某个节点的描述文本（导入时识别出的那些） */
export function outlineNote(o: OutlineState, id: string): string {
  return o.notes?.[id] ?? ''
}

/** 追加一段描述到节点名下（多条用空行分隔，保持先后顺序） */
export function outlineAppendNote(o: OutlineState, id: string, text: string): OutlineState {
  const clean = text.trim()
  if (!clean) return o
  const next = clone(o)
  const prev = next.notes?.[id]
  next.notes = { ...(next.notes ?? {}), [id]: prev ? `${prev}\n\n${clean}` : clean }
  return next
}

export function outlineChildren(o: OutlineState, id: string): string[] {
  return o.children[id] ?? []
}

export function outlineParentOf(o: OutlineState, id: string): string | null {
  if (id === o.root) return null
  for (const [p, kids] of Object.entries(o.children)) {
    if (kids.includes(id)) return p
  }
  return null
}

/** id 的全部后代（不含自己）。换挂父级前拿来防环 */
export function outlineDescendants(o: OutlineState, id: string): Set<string> {
  const out = new Set<string>()
  const walk = (cur: string) => {
    for (const k of outlineChildren(o, cur)) {
      if (out.has(k)) continue
      out.add(k)
      walk(k)
    }
  }
  walk(id)
  return out
}

/** 结构里出现过的全部节点 id（根 + 挂着的 + 有名字的） */
export function outlineNodeIds(o: OutlineState): string[] {
  const out = new Set<string>([o.root, ...Object.keys(o.names)])
  for (const [p, kids] of Object.entries(o.children)) {
    out.add(p)
    for (const k of kids) out.add(k)
  }
  return [...out]
}

/**
 * 把一个已有节点（实体或自由节点）挂到 parent 下面。
 * childId 不存在且带 name → 当作新建自由节点；返回新的结构与节点 id。
 * 挂不上（父不存在 / 成环 / 已挂在其下）原样返回，id 为 null。
 */
export function outlineAttach(
  o: OutlineState,
  parentId: string,
  childId?: string,
  childName?: string,
): { outline: OutlineState; id: string | null } {
  if (!parentId) return { outline: o, id: null }
  const known = outlineNodeIds(o).includes(parentId)
  if (!known && parentId !== o.root) return { outline: o, id: null }
  const next = clone(o)
  let id = childId
  if (!id) {
    id = newVirtualId()
    next.names[id] = childName || '新节点'
  } else if (isVirtualOutlineId(id) && childName) {
    next.names[id] = childName
  }
  const kids = next.children[parentId] ?? []
  if (kids.includes(id)) return { outline: o, id: null } // 已经挂着的别重复挂
  next.children[parentId] = [...kids, id]
  return { outline: next, id }
}

/** 在 refId 的后面插一个兄弟节点（WPS 的 Enter）。refId 是根时没有兄弟，挂成它的子级 */
export function outlineInsertSibling(
  o: OutlineState,
  refId: string,
  name?: string,
): { outline: OutlineState; id: string | null } {
  const parent = outlineParentOf(o, refId)
  if (!parent) return outlineAttach(o, refId, undefined, name)
  const next = clone(o)
  const id = newVirtualId()
  next.names[id] = name || '新节点'
  const kids = [...(next.children[parent] ?? [])]
  const at = kids.indexOf(refId)
  kids.splice(at + 1, 0, id)
  next.children[parent] = kids
  return { outline: next, id }
}

/** 改自由节点的名字。实体节点不归这里管 —— 返回原样 */
export function outlineRename(o: OutlineState, id: string, name: string): OutlineState {
  const clean = name.trim()
  if (!isVirtualOutlineId(id) || !clean) return o
  const next = clone(o)
  next.names[id] = clean
  return next
}

/** 删自由节点：子级整体上提给它的父级（WPS 的 Tab 化），实体节点只摘链不删档案 */
export function outlineDetach(o: OutlineState, id: string): OutlineState {
  if (id === o.root) return o
  const next = clone(o)
  const parent = outlineParentOf(o, id)
  const kids = outlineChildren(o, id)
  if (parent) {
    const siblings = (next.children[parent] ?? []).filter((k) => k !== id)
    if (kids.length) {
      const at = siblings.indexOf(id) // 上面已 filter，必是 -1；插到原位置
      siblings.splice(at < 0 ? siblings.length : at, 0, ...kids)
    }
    next.children[parent] = siblings
  }
  delete next.children[id]
  if (isVirtualOutlineId(id)) {
    delete next.names[id]
    if (next.notes) delete next.notes[id]
  }
  return next
}

/** 换挂父级。防环：新父不能是自己或自己的后代；newParent 为 null = 挂回根 */
export function outlineReparent(
  o: OutlineState,
  childId: string,
  newParentId: string | null,
): OutlineState {
  if (childId === o.root) return o
  const target = newParentId ?? o.root
  if (target === childId) return o
  if (outlineDescendants(o, childId).has(target)) return o
  const parent = outlineParentOf(o, childId)
  if (parent === target) return o
  const next = clone(o)
  if (parent) next.children[parent] = (next.children[parent] ?? []).filter((k) => k !== childId)
  next.children[target] = [...(next.children[target] ?? []), childId]
  return next
}

/**
 * 结构树里**够得着**的节点集合（从根 BFS）。布局只对这批算层级，
 * 没挂进结构的实体照常画（连双链），但落在孤儿行里 —— 不许悄悄消失。
 */
export function outlineReachable(o: OutlineState): Set<string> {
  const out = new Set<string>()
  const queue = [o.root]
  while (queue.length) {
    const cur = queue.shift()!
    if (out.has(cur)) continue
    out.add(cur)
    for (const k of outlineChildren(o, cur)) queue.push(k)
  }
  return out
}
