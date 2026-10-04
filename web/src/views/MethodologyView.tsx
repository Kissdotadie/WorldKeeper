/**
 * 方法论（独立界面）。
 *
 * 「方法论」在这个工具里指某种意义上的哲学观：意识形态、戒律、主义、公约、
 * 思维方式……它们有两重身份，所以这个界面有两件事必须同时成立：
 *
 * 1. **方法论自己是实体**（type = methodology）—— 能单独浏览、有正文、能进关系图。
 * 2. **角色身上挂着方法论**（frontmatter 的 methodologies 字段）—— 于是能反查
 *    「谁信奉晨曦主义」。
 *
 * 为什么不是普通标签？因为标签只能筛，不能承载「这套思想讲了什么」。
 * 为什么不是纯双链？因为「按方法论筛角色」是高频动作，走双链要多绕一层。
 *
 * 图的骨架是**派生的**：节点来自 methodology 实体与它们的信奉者，边来自
 * 实体字段。删掉索引重建，这张图长得一模一样。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '../api/client'
import type { MethodologyData, MethodologyItem } from '../api/types'
import { useApp } from '../state/store'
import { useGraphEdit } from '../state/useGraphEdit'
import { Panel, PanelClose } from '../components/Panel'
import { GraphStylePanel, spacingLabel } from '../components/GraphStylePanel'
import { StylePackPanel } from '../components/StylePackPanel'
import { StickerLayer, StickerPanel } from '../components/StickerLayer'
import { StateGate } from '../components/Toast'
import { Graph2D } from '../graph/Graph2D'
import { Graph3D } from '../graph/Graph3D'
import { useSceneStyles } from '../graph/useSceneStyles'
import { useStyleResolver } from '../graph/useStyleResolver'
import { useOutlineEdit } from '../graph/useOutlineEdit'
import { isVirtualOutlineId } from '../graph/outline'
import { LAYOUT_LABELS, typeColorVar, type GEdge, type GNode, type LayoutKind } from '../graph/types'

const ROOT = '__meth_root__'
const methNodeId = (name: string) => `__meth__:${name}`

/** 三维图的 scene.json 分区键 —— 坐标锁定与「重新排版」都按它走 */
const SCENE_KEY_3D = 'meth-3d'

type Mode = 'cards' | 'map' | 'map3d' | 'holders'

export function MethodologyView() {
  const { bookId, notify, openEntity, types, refresh, prefs, dataVersion } = useApp()

  const [data, setData] = useState<MethodologyData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('cards')
  /** 布局：本界面手动选过的赢，没选过就跟样式包走（同 RelationView） */
  const [layoutPick, setLayoutPick] = useState<LayoutKind | null>(() => {
    try {
      return (localStorage.getItem('wkv.layout.methodology') as LayoutKind) || null
    } catch {
      return null
    }
  })
  const [showLabels, setShowLabels] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  /** 贴纸编辑态（只有「思维导图」这一档有图可贴） */
  const [stickerEdit, setStickerEdit] = useState(false)

  /** 三维取景令牌：每次切进三维都重新取一次全景 */
  const [token3d, setToken3d] = useState(0)
  /** 三维里选中的是**实体 id** —— 和二维的「方法论名字」不是一套（见下） */
  const [selectedId3d, setSelectedId3d] = useState<string | null>(null)
  /** 三维外观（辉光 / 疏密 / 类型图标）—— 与关系网、世界观共用同一份状态 */
  const styles = useSceneStyles(bookId)
  /** 样式包（图长相）：2D 全接，3D 只接颜色与大小 */
  const sr = useStyleResolver()
  const layout: LayoutKind = layoutPick ?? sr.layout

  // ---- 自由结构（WPS 式思维导图编辑）----
  // 「方法论 → 某某主义 / 某某戒律」本来只能靠标签想，现在能亲手搭。
  // 结构落 view/scene.json 的 outlines['methodology']，与方法论实体档案无关。
  //
  // 结构模式下**不再画信奉者节点**：那是派生信息（谁信这套），搭结构时碍事，
  // 切回普通图或卡片就能看到。所以这里多一个 outlineSel —— 与 selected
  // （方法论名字）不是一套：结构里还能选中自由节点，它没有「名字」。
  const [outlineSel, setOutlineSel] = useState<string | null>(null)
  const oe = useOutlineEdit({ sceneKey: 'methodology', title: '方法论', onSelect: setOutlineSel })

  const pickLayout = (k: LayoutKind) => {
    const next = k === sr.layout ? null : k
    setLayoutPick(next)
    try {
      if (next) localStorage.setItem('wkv.layout.methodology', next)
      else localStorage.removeItem('wkv.layout.methodology')
    } catch {
      /* 忽略 */
    }
  }

  // 新建 / 批量导入
  const [creating, setCreating] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftSummary, setDraftSummary] = useState('')
  const [draftTags, setDraftTags] = useState('')
  const [pasting, setPasting] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    if (!bookId) return
    setLoading(true)
    setError(null)
    api
      .getMethodologies(bookId)
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }, [bookId, dataVersion])

  useEffect(load, [load])

  /** 方法论 → 信奉者 的派生图 */
  const graph = useMemo(() => {
    const items = data?.items ?? []

    // ---- 自由结构模式：骨架换成用户亲手搭的那份 ----
    // 方法论节点照常平铺进来（一个都不能少 —— 结构里没提到的也要看得见），
    // 但不再自动生成「中心 → 方法论」的派生边：层级由结构说了算。
    if (oe.on && oe.outline) {
      const sk = oe.skeleton()
      const have = new Set(sk.nodes.map((n) => n.id))
      for (const it of items) {
        if (typeFilter && !it.holders.some((h) => h.type === typeFilter)) continue
        const mid = methNodeId(it.name)
        if (have.has(mid)) continue
        have.add(mid)
        sk.nodes.push({
          id: mid,
          name: it.name,
          type: 'methodology',
          size: it.count ? 16 + Math.min(10, it.count * 2) : 12,
          color: typeColorVar('methodology'),
        })
      }
      return sk
    }

    const nodes: GNode[] = [
      { id: ROOT, name: '方法论', type: '__root__', size: 22, color: 'var(--accent)' },
    ]
    const edges: GEdge[] = []
    const seen = new Set<string>()

    for (const it of items) {
      if (typeFilter && !it.holders.some((h) => h.type === typeFilter)) continue
      const mid = methNodeId(it.name)
      nodes.push({
        id: mid,
        name: it.name,
        type: 'methodology',
        size: it.count ? 16 + Math.min(10, it.count * 2) : 12,
        color: typeColorVar('methodology'),
      })
      edges.push({ source: ROOT, target: mid, kind: '方法论' })

      for (const h of it.holders) {
        const hid = `ent:${h.id}`
        if (!seen.has(hid)) {
          seen.add(hid)
          nodes.push({
            id: hid,
            name: h.name,
            type: h.type,
            size: 13,
            color: typeColorVar(h.type),
          })
        }
        edges.push({ source: hid, target: mid, kind: '信奉' })
      }
    }
    return { nodes, edges }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, typeFilter, oe.on, oe.outline])

  /**
   * 结构模式的层级表。
   *
   * 结构里没提到的节点**挂到根下**，而不是丢进孤儿行 —— 方法论这一页的节点
   * 本来就是派生出来的（用户没义务把它们全拖进结构），让它们散在孤儿行里
   * 看起来就像「结构模式把图弄坏了」。挂在根下既保住了层级，也一眼看得出
   * 「这些还没归位」。
   */
  const hierarchy = useMemo(() => {
    const o = oe.outline
    if (!oe.on || !o) return null
    const children = new Map<string, string[]>()
    for (const [p, ks] of Object.entries(o.children)) children.set(p, [...ks])
    const placed = new Set<string>([o.root])
    for (const ks of children.values()) for (const k of ks) placed.add(k)
    const rootKids = [...(children.get(o.root) ?? [])]
    for (const it of data?.items ?? []) {
      const mid = methNodeId(it.name)
      if (!placed.has(mid)) {
        placed.add(mid)
        rootKids.push(mid)
      }
    }
    if (rootKids.length) children.set(o.root, rootKids)
    return { root: o.root, children }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oe.on, oe.outline, data])

  /**
   * 三维图 —— **只画真身**。
   *
   * 二维那张图上的节点 id 是界面自造的（`__meth__:<名字>` 可能还没建档、
   * `__meth_root__` 纯粹是骨架），所以在二维里编辑要先翻译回真身。
   * 三维不要这套：不建档的方法论在空间里本来就没有落点，硬塞进去只会多出一批
   * 「点了没反应」的幽灵。于是这里直接拿实体 id 当节点 id —— 图上的每个点
   * 都点得开、都能就地编辑，`graphEditProps` 一个字都不用改。
   *
   * 颜色**故意不写** `node.color`：三维走 WebGL，`var(--type-x)` 它不认，
   * 交给 Graph3D 用 getComputedStyle 解析成真实色值（二维是 SVG，才无所谓）。
   */
  const graph3d = useMemo(() => {
    const nodes: GNode[] = []
    const edges: GEdge[] = []
    const seen = new Set<string>()

    for (const it of data?.items ?? []) {
      if (!it.id) continue
      if (typeFilter && !it.holders.some((h) => h.type === typeFilter)) continue

      nodes.push({
        id: it.id,
        name: it.name,
        type: 'methodology',
        size: it.count ? 16 + Math.min(10, it.count * 2) : 12,
      })

      for (const h of it.holders) {
        if (!seen.has(h.id)) {
          seen.add(h.id)
          nodes.push({ id: h.id, name: h.name, type: h.type, size: 13 })
        }
        edges.push({ source: h.id, target: it.id, kind: '信奉' })
      }
    }
    return { nodes, edges }
  }, [data, typeFilter])

  const selectedItem = useMemo(
    () => data?.items.find((i) => i.name === selected) ?? null,
    [data, selected],
  )

  // ---- 就地编辑（P4.3）----
  // 这张图的节点 id 是「界面自造」的：`ent:<id>` 是真实体，`__meth__:<名字>`
  // 可能已经有实体、也可能还没建档，根节点纯粹是骨架。所以要先把 id 翻译回
  // 真身再交给浮层 —— 否则浮层会去读一个根本不存在的档案。
  const realIdOf = (nodeId: string): string | null => {
    if (nodeId.startsWith('ent:')) return nodeId.slice(4)
    if (nodeId.startsWith('__meth__:')) {
      const nm = nodeId.slice('__meth__:'.length)
      return data?.items.find((i) => i.name === nm)?.id ?? null
    }
    return null
  }

  const gEdit = useGraphEdit({
    bookId,
    sceneKey: SCENE_KEY_3D, // 撤销「挪动节点」时要指到这张图
    types,
    onChanged: () => {
      load()
      void refresh()
    },
    onOpenDetail: (id) => openEntity(id),
  })

  const graphEditProps = {
    ...gEdit.graphProps,
    onNodeEdit: (id: string, name: string, screen: { x: number; y: number }, nearType?: string) => {
      // 自由结构模式下双击自由节点 = 想给它改名，不该弹「还没建成实体」的提示。
      // 改名走 F2 / 浮条上的「改名」，这里安静放过。
      if (isVirtualOutlineId(id)) return
      const real = realIdOf(id)
      if (!real) {
        notify('info', `「${name}」还没建成实体 —— 在卡片视图点「待补建」，或双击空白新建一条`)
        return
      }
      gEdit.graphProps.onNodeEdit(real, name, screen, nearType)
    },
    onCanvasEdit: (screen: { x: number; y: number }, world?: undefined) =>
      gEdit.graphProps.onCanvasEdit(screen, world, 'methodology'),
    onLink: (
      fromId: string,
      fromName: string,
      toId: string,
      toName: string,
      screen: { x: number; y: number },
    ) => {
      const a = realIdOf(fromId)
      const b = realIdOf(toId)
      if (!a || !b) {
        notify('info', '这条连线里有还没建档的节点，先把它补建成实体再连')
        return
      }
      gEdit.graphProps.onLink(a, fromName, b, toName, screen)
    },
  }

  // ---- 动作 ----------------------------------------------------------

  const createOne = async () => {
    const name = draftName.trim()
    if (!bookId || !name) return
    setBusy(true)
    try {
      await api.createEntity(bookId, {
        type: 'methodology',
        name,
        summary: draftSummary.trim(),
        tags: draftTags
          .split(/[,，、\s]+/)
          .map((t) => t.trim())
          .filter(Boolean),
      })
      notify('ok', `已新建方法论「${name}」`)
      setDraftName('')
      setDraftSummary('')
      setDraftTags('')
      setCreating(false)
      await refresh()
      load()
    } catch (e) {
      notify('err', `新建失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const bulkPaste = async () => {
    if (!bookId || !pasteText.trim()) return
    setBusy(true)
    try {
      const r = await api.commitPaste(bookId, {
        text: pasteText,
        mode: 'auto',
        type: 'methodology',
      })
      notify('ok', `批量导入：新增 ${r.created} 条，跳过 ${r.skipped.length} 条`)
      setPasteText('')
      setPasting(false)
      await refresh()
      load()
    } catch (e) {
      notify('err', `导入失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  /** 把「被引用但没建实体」的方法论补建成实体 */
  const backfill = async (name: string) => {
    if (!bookId) return
    setBusy(true)
    try {
      await api.createEntity(bookId, { type: 'methodology', name })
      notify('ok', `已补建「${name}」`)
      await refresh()
      load()
    } catch (e) {
      notify('err', `补建失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const detach = async (item: MethodologyItem, entityId: string, holderName: string) => {
    if (!bookId) return
    setBusy(true)
    try {
      await api.attachMethodology(bookId, item.name, [entityId], 'remove')
      notify('ok', `已从「${holderName}」摘掉`)
      load()
    } catch (e) {
      notify('err', `摘除失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  // ---- 渲染 ----------------------------------------------------------

  const stats = data
    ? {
        total: data.count,
        built: data.items.filter((i) => i.has_entity).length,
        missing: data.missing.length,
        holders: data.holders_total,
      }
    : { total: 0, built: 0, missing: 0, holders: 0 }

  return (
    <StateGate loading={loading && !data} error={error}>
      <div className="meth">
        <div className="meth__bar">
          <div className="meth__nums">
            <span className="meth__num">
              <b>{stats.total}</b> 条方法论
            </span>
            <span className="meth__sep" />
            <span className="meth__num">
              <b>{stats.built}</b> 已建实体
            </span>
            <span className="meth__sep" />
            <span className="meth__num">
              <b>{stats.holders}</b> 处信奉
            </span>
            {stats.missing > 0 && (
              <>
                <span className="meth__sep" />
                <span className="meth__num meth__num--warn">
                  <b>{stats.missing}</b> 待补建实体
                </span>
              </>
            )}
          </div>
          <div className="meth__actions">
            <div className="seg">
              {(
                [
                  ['cards', '卡片'],
                  ['map', '思维导图'],
                  ['map3d', '三维图'],
                  ['holders', '信奉总表'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  className={`seg__item ${mode === k ? 'seg__item--on' : ''}`}
                  onClick={() => {
                    setMode(k)
                    // 已经在三维里再点一次 = 「重新取景」，跟世界观那档一致
                    if (k === 'map3d') setToken3d((t) => t + 1)
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <button className="btn btn--sm" onClick={() => setPasting((v) => !v)}>
              批量粘贴
            </button>
            <button className="btn btn--primary btn--sm" onClick={() => setCreating((v) => !v)}>
              + 新建方法论
            </button>
          </div>
        </div>

        {creating && (
          <Panel title="新建方法论">
            <div className="meth__form">
              <input
                className="input"
                placeholder="名字，如：晨曦主义 / 圣光戒律 / 君主崇拜"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createOne()}
              />
              <input
                className="input"
                placeholder="一句话说清它主张什么"
                value={draftSummary}
                onChange={(e) => setDraftSummary(e.target.value)}
              />
              <input
                className="input"
                placeholder="标签，逗号分隔：意识形态, 帝国"
                value={draftTags}
                onChange={(e) => setDraftTags(e.target.value)}
              />
              <div className="row">
                <button className="btn btn--primary btn--sm" disabled={busy || !draftName.trim()} onClick={createOne}>
                  建
                </button>
                <button className="btn btn--sm" onClick={() => setCreating(false)}>
                  取消
                </button>
              </div>
            </div>
            <p className="faint fs-xs">
              建完它就是一个正常实体了 —— 写在正文里的「思想」不是标签，是一条能被检索、能被
              角色引用的记录。
            </p>
          </Panel>
        )}

        {pasting && (
          <Panel title="批量粘贴方法论">
            <textarea
              className="input meth__paste"
              rows={6}
              placeholder={'一行一条，支持三种写法：\n晨曦主义：神授君主立宪，皇帝即国家的意志。\n极权独裁主义 | 军工、民生、宣传为王 | 意识形态\n圣光戒律 | 七美德为纲'}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
            />
            <div className="row">
              <button className="btn btn--primary btn--sm" disabled={busy || !pasteText.trim()} onClick={bulkPaste}>
                导入
              </button>
              <button className="btn btn--sm" onClick={() => setPasting(false)}>
                取消
              </button>
            </div>
          </Panel>
        )}

        {mode === 'map' && (
          <div className="meth__split">
            <Panel
              title="方法论图谱"
              flush
              actions={
                <div className="row">
                  <button
                    className={`btn btn--sm ${oe.on ? 'btn--on' : ''}`}
                    onClick={oe.toggle}
                    title="自由结构：自己搭「谁包含谁」—— 选中节点后 Tab 加子级、Enter 加同级、拖到节点上换父级"
                  >
                    {oe.on ? '✓ 自由结构' : '自由结构'}
                  </button>
                  <div className="seg">
                    {LAYOUT_LABELS.map((l) => (
                      <button
                        key={l.key}
                        className={`seg__item ${layout === l.key ? 'seg__item--on' : ''}`}
                        onClick={() => pickLayout(l.key)}
                        title={l.hint}
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>
                  {layoutPick !== null && (
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => pickLayout(sr.layout)}
                      title="改回跟样式包走"
                    >
                      ↻ 跟随样式
                    </button>
                  )}
                  <button
                    className={`btn btn--sm ${showLabels ? 'btn--primary' : ''}`}
                    onClick={() => setShowLabels((v) => !v)}
                  >
                    标签
                  </button>
                </div>
              }
            >
              {graph.nodes.length <= 1 ? (
                <p className="empty">
                  还没有方法论。先在上面「新建方法论」或「批量粘贴」，或者在角色身上挂一条，这里就会长出来。
                </p>
              ) : (
                <div className="meth__graph">
                  <Graph2D
                    {...graphEditProps}
                    {...sr.g2d}
                    outlineAvailable
                    onEnableOutline={oe.toggle}
                    nodes={graph.nodes}
                    edges={graph.edges}
                    layout={layout}
                    rootId={oe.on && oe.outline ? oe.outline.root : ROOT}
                    selectedId={oe.on ? outlineSel : selected ? methNodeId(selected) : null}
                    showLabels={showLabels}
                    hierarchy={hierarchy}
                    outline={oe.editApi}
                    noteOf={oe.noteOf}
                    onToggleLinkMode={() => gEdit.setLinkMode((v) => !v)}
                    onSelect={(id) => {
                      if (id === null) {
                        // 点了空白 → 取消选中（P11-2️⃣②）
                        setSelected(null)
                        setSelectedId3d(null)
                        setOutlineSel(null)
                        return
                      }
                      setOutlineSel(id)
                      if (id.startsWith('__meth__:')) {
                        setSelected(id.slice('__meth__:'.length))
                      } else if (id.startsWith('ent:')) {
                        openEntity(id.slice(4))
                      } else if (!isVirtualOutlineId(id)) {
                        // 中心骨架这类点不着档案的：清掉侧栏选中，别留着上一次的
                        setSelected(null)
                      }
                    }}
                  >
                    <StickerLayer sceneKey="methodology" editing={stickerEdit} />
                  </Graph2D>
                </div>
              )}
            </Panel>

            <div className="meth__side">
              <Panel title="图长相 · 样式包">
                <StylePackPanel />
              </Panel>
              <Panel title="贴纸">
                <StickerPanel
                  sceneKey="methodology"
                  editing={stickerEdit}
                  onEditingChange={setStickerEdit}
                  hint="给某条教义贴个标记，或者钉一张想法的草图"
                />
              </Panel>
            </div>
          </div>
        )}

        {mode === 'map3d' && bookId && (
          <div className="meth__split">
            <Panel
              title="方法论三维图"
              flush
              actions={
                <div className="row">
                  <button
                    className={`btn btn--sm ${showLabels ? 'btn--primary' : ''}`}
                    onClick={() => setShowLabels((v) => !v)}
                  >
                    标签
                  </button>
                </div>
              }
            >
              {graph3d.nodes.length === 0 ? (
                <p className="empty">
                  还没有已建档的方法论 —— 三维图只画<strong>真身</strong>。先在上面「新建方法论」，
                  或者回卡片视图把那条「待补建」补上，这里才有点可站。
                </p>
              ) : (
                <div className="meth__graph">
                  <Graph3D
                    {...gEdit.graphProps}
                    bookId={bookId}
                    sceneKey={SCENE_KEY_3D}
                    nodes={graph3d.nodes}
                    edges={graph3d.edges}
                    selectedId={selectedId3d}
                    onSelect={(id) => setSelectedId3d(id)}
                    onToggleLinkMode={() => gEdit.setLinkMode((v) => !v)}
                    showLabels={showLabels}
                    themeKey={`${prefs?.ui.mode ?? ''}-${prefs?.ui.theme ?? ''}`}
                    typeIcons={styles.typeIcons}
                    glow={styles.glow}
                    spacing={styles.spacing}
                    // 方法论本身一类，信奉者按各自类型分团 —— 于是「谁和谁同源」看得出来
                    clusterByType
                    nodeStyle={sr.hasPack ? sr.s3d : undefined}
                    // 两个令牌相加当变化量：切进三维要重新取景，改疏密要重新排布
                    layoutToken={token3d + styles.layoutToken}
                  />
                </div>
              )}
            </Panel>

            {/* 三维外观只在这一档出现 —— 卡片/导图/总表里它是无关的噪音 */}
            <div className="meth__side">
              <Panel title="图长相 · 样式包">
                <StylePackPanel />
              </Panel>
              <Panel title="三维外观">
                <GraphStylePanel
                  styles={styles}
                  types={types}
                  sceneKey={SCENE_KEY_3D}
                  onRelayout={(nextSpacing) => {
                    setSelectedId3d(null)
                    notify(
                      'info',
                      nextSpacing ? `已切到「${spacingLabel(nextSpacing)}」并重新排版` : '正在重新排版…',
                    )
                  }}
                />
              </Panel>
              <Panel title="这张图怎么来的">
                <p className="faint fs-xs" style={{ lineHeight: 1.7 }}>
                  节点来自 <span className="mono">methodology</span> 实体本身，连线来自角色
                  frontmatter 里的「方法论」字段 —— <strong>没有一样是手摆的</strong>，
                  删掉索引重跑，这张图长得一模一样。
                </p>
                <p className="faint fs-xs" style={{ marginTop: 8, lineHeight: 1.7 }}>
                  还没建档的方法论在这里不出现：它在空间里没有可站的落点，硬画出来只会多几个
                  「点了没反应」的点。二维导图里那些点仍在，点它会提示去补建。
                </p>
              </Panel>
            </div>
          </div>
        )}

        {mode === 'cards' && (
          <div className="meth__grid">
            {(data?.items ?? []).map((it) => (
              <div
                key={it.name}
                className={`meth__card ${selected === it.name ? 'meth__card--on' : ''}`}
              >
                <div className="meth__card-head">
                  <button
                    className="meth__name"
                    onClick={() => (it.id ? openEntity(it.id) : setSelected(it.name))}
                    title={it.id ? '打开实体' : '还没建成实体'}
                  >
                    {it.name}
                  </button>
                  {it.has_entity ? (
                    <span className="chip chip--type">{it.count} 人信奉</span>
                  ) : (
                    <button
                      className="btn btn--sm meth__backfill"
                      disabled={busy}
                      onClick={() => backfill(it.name)}
                      title="被角色引用，但还没有自己的档案 —— 点一下补建"
                    >
                      待补建
                    </button>
                  )}
                </div>

                {it.summary ? (
                  <p className="meth__summary">{it.summary}</p>
                ) : (
                  <p className="meth__summary faint">
                    {it.id ? '还没有写它主张什么 —— 点名字补上' : '尚未建档'}
                  </p>
                )}

                {it.tags.length > 0 && (
                  <div className="meth__tags">
                    {it.tags.map((t) => (
                      <span key={t} className="chip">
                        {t}
                      </span>
                    ))}
                  </div>
                )}

                <div className="meth__holders">
                  {it.holders.length === 0 ? (
                    <span className="faint fs-xs">还没有角色挂上这一条</span>
                  ) : (
                    it.holders.map((h) => (
                      <button
                        key={h.id}
                        className="meth__holder"
                        onClick={() => openEntity(h.id)}
                        title={`${h.name}（${h.type}）`}
                      >
                        <i style={{ background: typeColorVar(h.type) }} />
                        {h.name}
                      </button>
                    ))
                  )}
                </div>
              </div>
            ))}
            {(data?.items.length ?? 0) === 0 && (
              <p className="empty">
                还没有方法论。可以「新建」，也可以「批量粘贴」把设定稿里那一串
                意识形态一次倒进来。
              </p>
            )}
          </div>
        )}

        {mode === 'holders' && (
          <Panel title="信奉总表" flush>
            <table className="table">
              <thead>
                <tr>
                  <th>方法论</th>
                  <th>信奉者</th>
                  <th>人数</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {(data?.items ?? [])
                  .filter((i) => i.holders.length > 0)
                  .map((it) => (
                    <tr key={it.name}>
                      <td>
                        <b>{it.name}</b>
                        {!it.has_entity && <span className="chip chip--warn">未建档</span>}
                      </td>
                      <td>
                        <div className="meth__holders">
                          {it.holders.map((h) => (
                            <span key={h.id} className="meth__holder-wrap">
                              <button
                                className="meth__holder"
                                onClick={() => openEntity(h.id)}
                              >
                                <i style={{ background: typeColorVar(h.type) }} />
                                {h.name}
                              </button>
                              <button
                                className="meth__unhook"
                                title={`把「${it.name}」从「${h.name}」身上摘掉`}
                                disabled={busy}
                                onClick={() => detach(it, h.id, h.name)}
                              >
                                ✕
                              </button>
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>{it.count}</td>
                      <td>
                        {!it.has_entity && (
                          <button className="btn btn--sm" disabled={busy} onClick={() => backfill(it.name)}>
                            补建实体
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {(data?.items ?? []).every((i) => i.holders.length === 0) && (
              <p className="empty">
                还没有任何角色挂上方法论。可以在实体详情里给角色加「方法论」字段，
                也可以在导入正文后跑一次抽取，让候选里直接带上。
              </p>
            )}
          </Panel>
        )}

        {selectedItem && mode === 'cards' && (
          <Panel
            title={`「${selectedItem.name}」信奉者`}
            actions={
              <div className="row">
                {types.map((t) => (
                  <button
                    key={t.key}
                    className={`chip ${typeFilter === t.key ? 'chip--on' : ''}`}
                    onClick={() => setTypeFilter(typeFilter === t.key ? null : t.key)}
                  >
                    {t.label}
                  </button>
                ))}
                <PanelClose onClick={() => setSelected(null)} />
              </div>
            }
          >
            <p className="faint fs-xs">
              想让某个角色挂上这条？去它的详情页加「方法论」字段；这里的 ✕ 只能摘、不能加 ——
              加需要先知道挂给谁。
            </p>
            <div className="meth__holders">
              {selectedItem.holders
                .filter((h) => !typeFilter || h.type === typeFilter)
                .map((h) => (
                  <span key={h.id} className="meth__holder-wrap">
                    <button className="meth__holder" onClick={() => openEntity(h.id)}>
                      <i style={{ background: typeColorVar(h.type) }} />
                      {h.name}
                    </button>
                    <button
                      className="meth__unhook"
                      disabled={busy}
                      onClick={() => detach(selectedItem, h.id, h.name)}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              {selectedItem.holders.length === 0 && (
                <p className="empty">还没有角色挂上这一条。</p>
              )}
            </div>
          </Panel>
        )}
      </div>
      {gEdit.layer}
    </StateGate>
  )
}

export default MethodologyView
