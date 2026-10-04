/**
 * 图谱布局算法。
 *
 * 六种布局的定位：
 * - force    力导向：交给 d3-force 跑物理模拟，适合看整体聚类
 * - radial   放射：经典「思维导图」形态，根在圆心，按层级一圈圈向外发散
 * - tree     树形：左右展开的组织架构图，同层对齐
 * - circle   环形：等距排在圆周上，看谁和谁有连线
 * - timeline 时间轴：按**首现顺序**从左到右排成一条横轴（P5 新增）
 * - fishbone 鱼骨：一条主脊，支线上下交替分出去（P5 新增）
 *
 * 除 force 外都是纯计算、结果确定 —— 同一份数据每次打开位置一致，
 * 不会像力导向那样刷新一次就跳一次（这对「思维导图」的可用性很关键）。
 */

import type { GEdge, GNode, LayoutKind, Pt } from './types'

export interface Tree {
  root: string
  children: Map<string, string[]>
  parent: Map<string, string>
  depth: Map<string, number>
  /** BFS 访问顺序 */
  order: string[]
  /** 没连到根的孤立节点 */
  orphans: string[]
}

/** 从边构建一棵 BFS 树。rootId 为空时取度数最高的节点当根。 */
export function buildTree(nodes: GNode[], edges: GEdge[], rootId?: string | null): Tree {
  const adj = new Map<string, string[]>()
  const ids = new Set(nodes.map((n) => n.id))
  for (const n of nodes) adj.set(n.id, [])
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue
    adj.get(e.source)!.push(e.target)
    adj.get(e.target)!.push(e.source)
  }

  let root = rootId && ids.has(rootId) ? rootId : ''
  if (!root) {
    let best = nodes[0]?.id ?? ''
    let bestDeg = -1
    for (const n of nodes) {
      const deg = adj.get(n.id)?.length ?? 0
      if (deg > bestDeg) {
        bestDeg = deg
        best = n.id
      }
    }
    root = best
  }

  const children = new Map<string, string[]>()
  const parent = new Map<string, string>()
  const depth = new Map<string, number>()
  const order: string[] = []
  const seen = new Set<string>()

  if (root) {
    // BFS：保证层级是最短的，树形/放射才不会出现长链绕路
    const queue: string[] = [root]
    seen.add(root)
    depth.set(root, 0)
    while (queue.length) {
      const cur = queue.shift()!
      order.push(cur)
      const kids: string[] = []
      for (const nb of adj.get(cur) ?? []) {
        if (seen.has(nb)) continue
        seen.add(nb)
        parent.set(nb, cur)
        depth.set(nb, (depth.get(cur) ?? 0) + 1)
        kids.push(nb)
        queue.push(nb)
      }
      children.set(cur, kids)
    }
  }

  const orphans = nodes.filter((n) => !seen.has(n.id)).map((n) => n.id)
  return { root, children, parent, depth, order, orphans }
}

/** 放射布局：根在圆心，子树占据连续扇区。 */
export function layoutRadial(
  _nodes: GNode[],
  tree: Tree,
  radiusStep = 130,
): Map<string, Pt> {
  const out = new Map<string, Pt>()
  if (!tree.root) return out

  const maxDepth = Math.max(0, ...[...tree.depth.values()])

  const walk = (id: string, depth: number, a0: number, a1: number) => {
    const mid = (a0 + a1) / 2
    const r = depth * radiusStep
    out.set(id, { x: Math.cos(mid) * r, y: Math.sin(mid) * r })
    const kids = tree.children.get(id) ?? []
    if (!kids.length) return
    const step = (a1 - a0) / kids.length
    kids.forEach((kid, i) => walk(kid, depth + 1, a0 + i * step, a0 + (i + 1) * step))
  }
  walk(tree.root, 0, 0, Math.PI * 2)

  // 孤立节点另起一圈，免得挤在中心
  const orphanRing = (maxDepth + 1) * radiusStep
  tree.orphans.forEach((id, i) => {
    const a = (i / Math.max(1, tree.orphans.length)) * Math.PI * 2
    out.set(id, { x: Math.cos(a) * orphanRing, y: Math.sin(a) * orphanRing })
  })
  return out
}

/** 树形布局：深度决定横坐标，叶子按顺序占行，父节点纵向居中。 */
export function layoutTree(
  _nodes: GNode[],
  tree: Tree,
  layerGap = 210,
  rowGap = 40,
): Map<string, Pt> {
  const out = new Map<string, Pt>()
  if (!tree.root) return out
  const cursor = { row: 0 }
  const maxDepth = Math.max(0, ...[...tree.depth.values()])

  const walk = (id: string): number => {
    const depth = tree.depth.get(id) ?? 0
    const kids = tree.children.get(id) ?? []
    let y: number
    if (!kids.length) {
      y = cursor.row++
    } else {
      const ys = kids.map(walk)
      y = (Math.min(...ys) + Math.max(...ys)) / 2
    }
    out.set(id, { x: depth * layerGap, y: y * rowGap })
    return y
  }
  walk(tree.root)

  // 孤儿排成**多列网格**，不是一条长队。
  // 为什么：结构模式刚打开（或大纲刚导入）时，没挂进结构的实体动辄几百个，
  // 排成一条 780×40px 的长队，适配窗口后每个节点缩到不足 1 像素 ——
  // 用户看到的就是「图是空的」，其实东西全在。改成固定行数的网格后，
  // 高度被压住，适配之后至少是「看得见的一整块」。
  const ORPHAN_ROWS = 14
  tree.orphans.forEach((id, i) => {
    const col = Math.floor(i / ORPHAN_ROWS)
    const row = i % ORPHAN_ROWS
    out.set(id, {
      x: (maxDepth + 1 + col) * layerGap,
      y: (cursor.row + row) * rowGap,
    })
  })
  return out
}

/** 环形布局：按类型聚在一起，等距排在圆周上。 */
export function layoutCircle(nodes: GNode[], minRadius = 180): Map<string, Pt> {
  const out = new Map<string, Pt>()
  const sorted = [...nodes].sort(
    (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, 'zh-Hans-CN'),
  )
  const r = Math.max(minRadius, (sorted.length * 46) / (Math.PI * 2))
  sorted.forEach((n, i) => {
    const a = (i / Math.max(1, sorted.length)) * Math.PI * 2 - Math.PI / 2
    out.set(n.id, { x: Math.cos(a) * r, y: Math.sin(a) * r })
  })
  return out
}

/**
 * 时间轴布局：按**首现顺序**从左到右排一条横轴。
 *
 * 排序口径：先按 `first_appear` 里的章节号，没有章节号的（或同一个章节里的）
 * 按名称排 —— 目标只有一个：**同一份数据每次排出来一模一样**，
 * 换个顺序就失去了「时间轴」的意义。
 *
 * 为什么不做成真的刻度轴：实体只记到「第几章」，没有更细的时间。
 * 按章号分段、段内等距，是这批数据能支撑的诚实画法。
 */
export function layoutTimeline(nodes: GNode[], gapX = 150, gapY = 74): Map<string, Pt> {
  const out = new Map<string, Pt>()
  if (!nodes.length) return out

  /** 从 `第3章` / `3` / `ch3` 里抠出章号；抠不到就给一个大数排到最后 */
  const chapterNo = (s?: string | null): number => {
    if (!s) return Number.MAX_SAFE_INTEGER
    const m = /(\d+)/.exec(s)
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
  }

  const sorted = [...nodes].sort((a, b) => {
    const ca = chapterNo(a.first_appear)
    const cb = chapterNo(b.first_appear)
    if (ca !== cb) return ca - cb
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })

  // 同一章的分成一列上下错开，不同章之间左右推进 —— 一眼看出「哪几条是同时登场的」
  //
  // 一列**最多 9 个**就另起一列：几百个实体挤进一章（或者干脆没有首现章节，
  // 全都落到「最后」那一列）时，上下错开会排出一根 6000px 的长条，
  // 缩放到能看全的时候节点就只剩一个像素了。
  const PER_COL = 9
  let col = 0
  let slot = 0
  let prev: number | null = null
  for (const n of sorted) {
    const c = chapterNo(n.first_appear)
    if (prev === null || c !== prev) {
      col += slot > 0 ? 1 : 0
      slot = 0
      prev = c
    } else if (slot >= PER_COL) {
      // 这一列满了：紧挨着再开一列接着放，视觉上是「同一章的两行」
      col += 1
      slot = 0
    }
    const offset = slot === 0 ? 0 : Math.ceil(slot / 2) * (slot % 2 ? 1 : -1)
    out.set(n.id, { x: col * gapX, y: offset * gapY })
    slot += 1
  }
  return out
}

/**
 * 鱼骨布局：一条水平主脊，支线上下交替分出去。
 *
 * 用在「拆一个事件的多方动因」上：主脊是那件事，每条支线是一方。
 * 支线内部仍按度数从高到低排 —— 影响大的靠近主脊。
 */
export function layoutFishbone(nodes: GNode[], gapX = 170, ribLen = 130): Map<string, Pt> {
  const out = new Map<string, Pt>()
  if (!nodes.length) return out

  const spine = [...nodes].sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0))
  // 主脊取度数最高的那几个（连着别人才配当脊），其余按度数分列两侧
  const spineCount = Math.max(1, Math.min(6, Math.ceil(spine.length / 6)))
  spine.slice(0, spineCount).forEach((n, i) => {
    out.set(n.id, { x: (i - (spineCount - 1) / 2) * gapX, y: 0 })
  })

  // 支线：**一列最多 4 根**（上下各 2），列数多了就折成「多条鱼骨」
  // （每 ~√列 根并成一条带，带宽往下挪）。不折的话几百个节点的图
  // 会摊成一根一万多像素的横条，缩放到能看全的时候什么都看不清。
  const ribs = spine.slice(spineCount)
  const PER_COL = 4
  const cols = Math.ceil(ribs.length / PER_COL)
  const perBand = Math.max(1, Math.ceil(Math.sqrt(cols)))
  const bandH = PER_COL * ribLen * 0.62
  const bandCount = Math.ceil(cols / perBand)

  ribs.forEach((n, i) => {
    const c = Math.floor(i / PER_COL)
    const k = i % PER_COL
    const band = Math.floor(c / perBand)
    const cin = c % perBand
    const dir = k % 2 === 0 ? -1 : 1 // 列内上下交替
    const row = Math.floor(k / 2) // 上下各最多 2 根
    const x = (cin - (perBand - 1) / 2) * gapX * 0.9
    const y =
      dir * (ribLen * (row + 1)) +
      (band - (bandCount - 1) / 2) * bandH
    out.set(n.id, { x, y })
  })
  return out
}

/**
 * 「自由结构」给的层级覆盖：结构模式下树的形状由用户亲手搭（outline），
 * 不许 buildTree 再按 BFS 最短路自作主张 —— 否则用户刚挂好的上下级一刷新就散架。
 */
export interface HierarchyOverride {
  root: string
  children: Map<string, string[]>
}

/** 从层级覆盖直接造 Tree。覆盖里没提到（或 id 已不存在）的节点归入 orphans */
function treeFromHierarchy(nodes: GNode[], h: HierarchyOverride): Tree | null {
  const ids = new Set(nodes.map((n) => n.id))
  if (!ids.has(h.root)) return null
  const children = new Map<string, string[]>()
  const parent = new Map<string, string>()
  const depth = new Map<string, number>()
  const order: string[] = []
  const seen = new Set<string>([h.root])
  const queue: string[] = [h.root]
  depth.set(h.root, 0)
  while (queue.length) {
    const cur = queue.shift()!
    order.push(cur)
    const kids = (h.children.get(cur) ?? []).filter((k) => ids.has(k) && !seen.has(k))
    for (const k of kids) {
      seen.add(k)
      parent.set(k, cur)
      depth.set(k, (depth.get(cur) ?? 0) + 1)
    }
    children.set(cur, kids)
    queue.push(...kids)
  }
  const orphans = nodes.filter((n) => !seen.has(n.id)).map((n) => n.id)
  return { root: h.root, children, parent, depth, order, orphans }
}

/**
 * 五种「纯计算、结果确定」布局的统一入口 —— 一次调用拿到整张图的位置表。
 *
 * 为什么要有这个函数（P11-1️⃣⑤）：样式包的**缩略预览**也得画出一张图，
 * 而预览必须和真实渲染长得一样。把分派逻辑收在一处，`Graph2D` 与预览
 * 组件都调它，就不可能出现「缩略图是树形、点下去变环形」。
 *
 * `force` 不在其中 —— 它靠 d3-force 迭代出结果，天生带随机性，
 * 由 `Graph2D` 自己跑（预览里用一份固定的小样本近似）。
 */
export function layoutStatic(
  kind: LayoutKind,
  nodes: GNode[],
  edges: GEdge[],
  rootId?: string | null,
  hierarchy?: HierarchyOverride | null,
): Map<string, Pt> {
  const tree = (hierarchy && treeFromHierarchy(nodes, hierarchy)) || buildTree(nodes, edges, rootId)
  switch (kind) {
    case 'radial':
      return layoutRadial(nodes, tree)
    case 'tree':
      return layoutTree(nodes, tree)
    case 'timeline':
      return layoutTimeline(nodes)
    case 'fishbone':
      return layoutFishbone(nodes)
    case 'circle':
      return layoutCircle(nodes)
    default:
      // force 走不到这里；真到了就给圆环当兜底，总比空白强
      return layoutCircle(nodes)
  }
}

/**
 * 按当前位置把整图平移到原点附近 —— 切换布局后不用手动找图。
 * 返回包围盒，调用方据此自动缩放。
 */
export function boundsOf(pos: Map<string, Pt>, pad = 40) {
  const pts = [...pos.values()]
  if (!pts.length) return { minX: -1, minY: -1, maxX: 1, maxY: 1 }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }
}
