/**
 * 地图工作台（P4.5）。
 *
 * 三栏：左边地图树（世界图 → 区域图 → 城市图）、中间画布、右边点位。
 *
 * 分工的规矩：
 * - **点位是「这个地点画在哪」，不是「这个地点是什么」**。后者永远在实体里。
 *   所以这里改任何东西都只动 `view/maps/`，实体文件一个字不碰 ——
 *   除了「就地新建」那一下，那是显式地让你建一个新实体。
 * - 一个地点可以摆在多张图上（政区图 + 地形图），所以「未落点」是按**当前这张图**
 *   算的，不是全局。
 * - 地图本身没有真源，它就是一种摆法。删掉一张图，实体一个不少。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api/client'
import type {
  AssetItem,
  EntityMeta,
  MapDoc,
  MapEntityInfo,
  MapsData,
  MapPin,
  MapRegion,
  TypeOption,
  VisionAnalyzeResult,
} from '../api/types'
import { useToast } from '../state/store'
import { useShortcutScope, useShortcuts } from '../lib/shortcuts'
import { GraphEditPopover, type GraphEditTarget } from './GraphEditPopover'
import { MapCanvas } from './MapCanvas'
import { Modal } from './Modal'
import {
  PORTAL_META,
  levelTint,
  portalKindOf,
  treePadLeft,
  type PortalKind,
} from './mapShared'

interface Props {
  bookId: string
  /** 就地新建时「类型」下拉的候选项（地理观只给地点那一类） */
  types: TypeOption[]
  /** 全部实体元信息（用来列「还没落点的地点」） */
  entities: EntityMeta[]
  query: string
  /** 打开实体详情 —— 由视图注入，组件不反向依赖全局状态 */
  onOpenEntity: (id: string) => void
  /** 数据变了：外层重新拉实体与图 */
  onChanged: () => void
  /**
   * 全局数据版本号（P11-1️⃣①）。实体被删掉后地图上的点位不该还留着，
   * 所以外层把它传进来当重取信号 —— 仍然走 props，不反向依赖全局状态。
   */
  dataVersion: number
}

/** 装饰层自己的 id。不占服务端号段，前端生成即可。 */
const nid = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2, 7)}${Date.now().toString(36).slice(-4)}`

/** 新区域的取色顺序。不追求好看，只求相邻两块一眼能分开。 */
const REGION_PALETTE = [
  '#c0392b',
  '#c9701f',
  '#a89327',
  '#3f8f4f',
  '#2f7f8f',
  '#3f5f9f',
  '#6b4f9f',
  '#9f3f77',
  '#7a6a58',
  '#4f6b7a',
]

const loadImageSize = (url: string) =>
  new Promise<{ w: number; h: number }>((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => resolve({ w: 0, h: 0 })
    img.src = url
  })

export function GeoMapBoard({ bookId, types, entities, query, onOpenEntity, onChanged, dataVersion }: Props) {
  const { notify } = useToast()

  const [data, setData] = useState<MapsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [selectedPin, setSelectedPin] = useState<string | null>(null)
  const [selectedRegion, setSelectedRegion] = useState<string | null>(null)
  const [drawingRegion, setDrawingRegion] = useState(false)
  const [tab, setTab] = useState<'pins' | 'regions'>('pins')
  const [placing, setPlacing] = useState<{ entityId: string; name: string } | null>(null)
  const [assets, setAssets] = useState<AssetItem[]>([])

  // 新建地图表单
  const [creating, setCreating] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftImage, setDraftImage] = useState('')
  const [draftParent, setDraftParent] = useState<string>('')
  const [draftLevel, setDraftLevel] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  /** 树的展开/收起。收起的是**子图那一层**，节点本身还在。 */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('wkv.mapTreeCollapsed')
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : [])
    } catch {
      return new Set<string>()
    }
  })
  /** 按层级标签筛树；null = 全部 */
  const [levelFilter, setLevelFilter] = useState<string | null>(null)

  /** 「这张图」元信息编辑（标题 / 层级标签 / 上一级 / 备注） */
  const [editingMeta, setEditingMeta] = useState(false)
  const [metaTitle, setMetaTitle] = useState('')
  const [metaLevel, setMetaLevel] = useState('')
  const [metaParent, setMetaParent] = useState('')
  const [metaNote, setMetaNote] = useState('')

  // ---- 识别（P4.5.3）----
  // 引擎只出候选。这份 state 就是「待确认清单」：勾选是人做的，
  // 落盘走 addRegion / addPin 那条老路 —— 识别**一个字都不直接写库**。
  const [vision, setVision] = useState<VisionAnalyzeResult | null>(null)
  const [visionBusy, setVisionBusy] = useState(false)
  const [visionPicked, setVisionPicked] = useState<Set<number>>(new Set())
  // 地名候选默认**不勾**：位置常有偏差，而且不绑实体就只是个标签，
  // 得人一个个挑。区域不一样 —— 区域找出来基本就是要收的那些。
  const [visionPickedText, setVisionPickedText] = useState<Set<number>>(new Set())

  // 就地编辑浮层（复用图谱那一套：改实体 / 新建实体）
  const [edit, setEdit] = useState<GraphEditTarget | null>(null)
  /** 新建落点：浮层保存成功后要把点摆上去 */
  const pendingAtRef = useRef<{ x: number; y: number } | null>(null)

  // ---------------------------------------------------------------- 落盘
  //
  // **为什么不是「改一次 PUT 一次」**：
  // 1. 名称是个输入框，敲十个字就是十次 PUT；颜色、透明度拖着调也是十几次。
  // 2. 更要命的是**丢改动**。每次 patch 都从「渲染那一刻的 maps」派生下一版，
  //    同一个事件循环里连着改两个字段时，后一个会拿旧快照把前一个盖回去 ——
  //    实测就撞上了：改完名字紧接着点色块，名字没了。
  // 所以：内存里留一份最新快照（stateRef），写盘只发这一份；再串行排队，
  // 保证服务器收到的顺序就是改动的顺序；连续改动合并成一次写盘。
  const stateRef = useRef<{ maps: Record<string, MapDoc>; order: string[] }>({ maps: {}, order: [] })
  const timerRef = useRef<number | null>(null)
  const chainRef = useRef<Promise<unknown>>(Promise.resolve())
  const inflightRef = useRef<Promise<unknown>>(Promise.resolve())

  const bookIdRef = useRef(bookId)
  const notifyRef = useRef(notify)
  const loadRef = useRef<() => Promise<void>>(async () => {})
  bookIdRef.current = bookId
  notifyRef.current = notify

  const pushSave = useCallback(() => {
    // 注意是**轮到自己时**才读快照，不是排队时 —— 排到队尾时可能又改过几轮了
    chainRef.current = chainRef.current
      .then(() => {
        const snap = stateRef.current
        return api.saveMaps(bookIdRef.current, { schema: 1, maps: snap.maps, order: snap.order })
      })
      .catch((e) => {
        notifyRef.current('err', `地图没存上：${(e as Error).message}`)
        // 再拉一次真实状态，别让界面继续显示没落盘的假象。
        // 延后一拍：直接在这里调 load 会 await 自己这条链，死锁。
        window.setTimeout(() => void loadRef.current(), 0)
      })
    inflightRef.current = chainRef.current
    return chainRef.current
  }, [])

  /** 攒着的改动 + 正在飞的写盘，一并等干净 —— 删地图之类的前后必须排干队列，
   *  否则一次迟到的写盘会把刚删掉的图又写回来。 */
  const flushNow = useCallback(async () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
      await pushSave()
    }
    await inflightRef.current
  }, [pushSave])

  const load = useCallback(async () => {
    await flushNow()
    setLoading(true)
    try {
      const r = await api.getMaps(bookId)
      stateRef.current = { maps: r.maps ?? {}, order: r.order ?? [] }
      setData(r)
      setActiveId((prev) => (prev && r.maps[prev] ? prev : (r.order[0] ?? null)))
    } catch (e) {
      notify('err', `地图读不出来：${(e as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [bookId, notify, flushNow, dataVersion])

  useEffect(() => {
    loadRef.current = load
  }, [load])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    api
      .listAssets()
      .then((r) => setAssets(r.assets.maps ?? []))
      .catch(() => undefined)
  }, [bookId, creating])

  // Esc 退出「放点 / 圈区域」这类一次性模式（P11-A2：走全局注册表）。
  //
  // 为什么必须迁移：以前这里是自己往 window 上挂 keydown，而注册表里的
  // 图上「Esc 取消选中」也在同一按上生效 —— 一次 Esc 会同时退出画区域
  // **并且**把图上的选中也清掉。进了注册表之后按优先级裁决：
  // 一次性模式（10）压过常规动作（0），一按只做一件事。
  useShortcutScope('map')
  useShortcuts(
    [
      {
        id: 'map.cancel-mode',
        keys: 'Esc',
        scope: 'map',
        desc: '退出放点 / 圈区域模式',
        priority: 10,
        when: () => Boolean(placing || drawingRegion),
        run: () => {
          if (placing) setPlacing(null)
          else setDrawingRegion(false)
        },
      },
    ],
    [placing, drawingRegion],
  )

  // 换地图就清干净：上张图的选中项在这张图上没有意义
  const switchMap = useCallback((id: string | null) => {
    setActiveId(id)
    setSelectedPin(null)
    setSelectedRegion(null)
    setPlacing(null)
    setDrawingRegion(false)
    setEditingMeta(false)
    // 识别结果是**针对某一张图**的候选，换了图就不该还挂在那儿
    setVision(null)
  }, [])

  const maps = data?.maps ?? {}
  const order = data?.order ?? []
  const active: MapDoc | null = activeId ? (maps[activeId] ?? null) : null

  /** 全量实体表：服务端那份 `entities` 索引是**按当前已知的 pin** 算的，
   *  刚放上去还没重新拉数据的点不在里面 —— 拿它当兜底，否则标签会变成「未命名」。 */
  const entityById = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities])

  /** 实体信息查询：pin 指向的实体名/类型/是否还在 */
  const entityOf = useCallback(
    (id: string | null): MapEntityInfo | null => {
      if (!id) return null
      const fromServer = data?.entities[id]
      if (fromServer?.exists) return fromServer
      const local = entityById.get(id)
      if (local) {
        return { name: local.name, type: local.type, status: local.status ?? null, exists: true }
      }
      return fromServer ?? null
    },
    [data, entityById],
  )

  // ---------------------------------------------------------------- 改一处
  // 每次改动都从**内存最新快照**派生下一版，而不是从渲染时的 maps —— 见上面落盘那段。

  /** 本地先改（界面立刻跟手），写盘按需延后 */
  const commit = useCallback(
    (nextMaps: Record<string, MapDoc>, nextOrder: string[], opts?: { now?: boolean }) => {
      stateRef.current = { maps: nextMaps, order: nextOrder }
      setData((prev) => (prev ? { ...prev, maps: nextMaps, order: nextOrder } : prev))
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      if (opts?.now) return pushSave()
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        void pushSave()
      }, 260)
    },
    [pushSave],
  )

  /** 改一张图。读的是**内存最新快照**，所以同一个事件循环里连着改两处也不会互相盖。 */
  const mutateMap = useCallback(
    (mapId: string, fn: (cur: MapDoc) => MapDoc | null) => {
      const snap = stateRef.current
      const cur = snap.maps[mapId]
      if (!cur) return
      const next = fn(cur)
      if (!next) return
      void commit({ ...snap.maps, [mapId]: next }, snap.order)
    },
    [commit],
  )

  // ---------------------------------------------------------------- 地图

  const resetCreating = () => {
    setCreating(false)
    setDraftTitle('')
    setDraftImage('')
    setDraftParent('')
    setDraftLevel('')
    if (fileRef.current) fileRef.current.value = ''
  }

  const onPickFile = async (file: File) => {
    setBusy(true)
    try {
      const item = await api.uploadMapImage(file)
      setDraftImage(`maps/${item.name}`)
      if (!draftTitle.trim()) setDraftTitle(item.stem)
      notify('ok', `已上传底图 ${item.name}`)
    } catch (e) {
      notify('err', `上传失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const createMap = async () => {
    if (!bookId) return
    // 「空白画布」（用户 2026-10-03 拍板）：不传底图也能直接建一张可编辑的画布 ——
    // 先摆点位、圈区域，底图以后随时补传。MapCanvas 对 image 为空的地图本就有
    // 兜底（doc.width 优先于实测像素），所以这里把画布尺寸直接写死即可。
    if (data && order.length >= data.limits.max_maps) {
      notify('err', `最多 ${data.limits.max_maps} 张地图`)
      return
    }
    setBusy(true)
    try {
      const size = draftImage
        ? await loadImageSize(api.assetUrlOf(draftImage))
        : { w: 1600, h: 1200 } // 空白画布默认 4:3（1600×1200），归一化坐标不受影响
      const id = nid('map')
      const doc: MapDoc = {
        id,
        title: draftTitle.trim() || '未命名地图',
        image: draftImage,
        width: size.w,
        height: size.h,
        parent: draftParent || null,
        level: draftLevel.trim(),
        note: '',
        pins: [],
        regions: [],
      }
      const snap = stateRef.current
      await commit({ ...snap.maps, [id]: doc }, [...snap.order, id], { now: true })
      switchMap(id)
      resetCreating()
      notify('ok', `已新建「${doc.title}」`)
    } finally {
      setBusy(false)
    }
  }

  const removeMap = async (mapId: string) => {
    const m = maps[mapId]
    if (!m) return
    const kids = order.filter((x) => maps[x]?.parent === mapId).length
    const msg =
      `删掉地图「${m.title}」？\n\n` +
      `图上的 ${m.pins.length} 个点位会一起消失，但**地点实体一个都不会动** —— ` +
      `地图只是摆法，不是内容。` +
      (kids ? `\n它的 ${kids} 张子图会挂到上一级。` : '')
    if (!window.confirm(msg)) return
    try {
      // 先把攒着的写盘排干：删完之后如果还有一次迟到的整体覆盖写落下来，
      // 会把刚删掉的图连同点位一起写回来。
      await flushNow()
      await api.deleteMap(bookId, mapId)
      if (activeId === mapId) switchMap(null)
      await load()
      notify('ok', `已删除「${m.title}」`)
    } catch (e) {
      notify('err', `删除失败：${(e as Error).message}`)
    }
  }

  // ---------------------------------------------------------------- 点位

  const addPin = (mapId: string, pin: MapPin) => {
    mutateMap(mapId, (cur) => ({ ...cur, pins: [...cur.pins, pin] }))
  }

  const movePin = (pinId: string, x: number, y: number) => {
    if (!activeId) return
    mutateMap(activeId, (cur) => ({
      ...cur,
      pins: cur.pins.map((p) => (p.id === pinId ? { ...p, x, y } : p)),
    }))
  }

  const updatePin = (pinId: string, patch: Partial<MapPin>) => {
    if (!activeId) return
    mutateMap(activeId, (cur) => ({
      ...cur,
      pins: cur.pins.map((p) => (p.id === pinId ? { ...p, ...patch } : p)),
    }))
  }

  const deletePin = (pinId: string) => {
    if (!activeId) return
    const pin = active?.pins.find((p) => p.id === pinId)
    if (!pin) return
    const name = pin.label || entityOf(pin.entity_id)?.name || '这个点'
    if (!window.confirm(`把「${name}」从图上拿掉？\n\n只是这个点不见了，地点本身还在。`)) return
    mutateMap(activeId, (cur) => ({ ...cur, pins: cur.pins.filter((p) => p.id !== pinId) }))
    setSelectedPin(null)
  }

  // ---------------------------------------------------------------- 区域

  /** 圈完一块面 —— 顶点是归一化的，所以换一张不同分辨率的底图也不用重摆。
   *
   * `label` 给识别结果用（引擎认出来的名字直接带进来），手圈时留空。
   * `silent` 给批量加入用：一次加十块不该弹十条提示。
   */
  const addRegion = (points: [number, number][], label = '', silent = false) => {
    if (!activeId) return false
    const cap = data?.limits.max_regions_per_map ?? 400
    const maxPts = data?.limits.max_points_per_region ?? 400
    if ((stateRef.current.maps[activeId]?.regions.length ?? 0) >= cap) {
      notify('err', `一张图最多 ${cap} 块区域`)
      return false
    }
    if (points.length > maxPts) {
      notify('err', '顶点太多了，圈得粗一点')
      return false
    }
    const id = nid('reg')
    mutateMap(activeId, (cur) => ({
      ...cur,
      regions: [
        ...cur.regions,
        {
          id,
          name: label,
          entity_id: null,
          points,
          // 按已有数量轮色，相邻两块一眼能分开
          fill: REGION_PALETTE[cur.regions.length % REGION_PALETTE.length],
          opacity: 0.22,
        } satisfies MapRegion,
      ],
    }))
    if (!silent) {
      setSelectedRegion(id)
      setSelectedPin(null)
      setTab('regions')
      setDrawingRegion(false)
      notify('ok', `圈好了（${points.length} 个顶点）—— 右边给它起个名字`)
    }
    return true
  }

  const updateRegion = (regionId: string, patch: Partial<MapRegion>) => {
    if (!activeId) return
    mutateMap(activeId, (cur) => ({
      ...cur,
      regions: cur.regions.map((r) => (r.id === regionId ? { ...r, ...patch } : r)),
    }))
  }

  /** 拖区域顶点：松手才回写，拖的过程在画布里跟手 */
  const moveRegionVertex = (regionId: string, index: number, x: number, y: number) => {
    if (!activeId) return
    mutateMap(activeId, (cur) => ({
      ...cur,
      regions: cur.regions.map((r) =>
        r.id === regionId ? { ...r, points: r.points.map((p, i) => (i === index ? [x, y] : p)) } : r,
      ),
    }))
  }

  /** 拖区域**整体**平移：松手才回写。所有顶点加同一个位移，夹到 0~1 不出画布 */
  const moveRegionWhole = (regionId: string, dx: number, dy: number) => {
    if (!activeId) return
    const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
    mutateMap(activeId, (cur) => ({
      ...cur,
      regions: cur.regions.map((r) =>
        r.id === regionId
          ? {
              ...r,
              points: r.points.map(([x, y]) => [clamp01(x + dx), clamp01(y + dy)] as [number, number]),
            }
          : r,
      ),
    }))
  }

  /** 去掉最后加的那个顶点 —— 闭合之后才发现多点了一下，用这个修 */
  const dropLastVertex = (regionId: string) => {
    const r = stateRef.current.maps[activeId ?? '']?.regions.find((x) => x.id === regionId)
    if (!r) return
    if (r.points.length <= 3) {
      notify('info', '只剩三个顶点了，再删就围不成面。要取消的话直接删掉这块区域。')
      return
    }
    updateRegion(regionId, { points: r.points.slice(0, -1) })
  }

  const deleteRegion = (regionId: string) => {
    const r = stateRef.current.maps[activeId ?? '']?.regions.find((x) => x.id === regionId)
    if (!r || !activeId) return
    const name = r.name || entityOf(r.entity_id)?.name || '这块区域'
    if (!window.confirm(`删掉「${name}」？\n\n只是这块面不见了，底图和实体都不动。`)) return
    mutateMap(activeId, (cur) => ({
      ...cur,
      regions: cur.regions.filter((x) => x.id !== regionId),
    }))
    setSelectedRegion(null)
  }

  // ---------------------------------------------------------------- 识别

  /** 跑一次识别。**只拿候选**，界面上什么都不落盘。 */
  const runVision = async (refresh = false) => {
    if (!active) return
    setVisionBusy(true)
    try {
      const r = await api.analyzeVision(bookId, { map_id: active.id, refresh })
      setVision(r)
      // 默认全勾：识别出来的通常就是要收的那几块，取消不要的比一块块勾省事得多。
      // 但**加入这个动作仍然要人点** —— 默认勾选不等于自动落盘。
      setVisionPicked(new Set(r.result.regions.map((_, i) => i)))
      setVisionPickedText(new Set())
    } catch (e) {
      notify('err', (e as Error).message)
    } finally {
      setVisionBusy(false)
    }
  }

  const toggleVisionPick = (i: number) =>
    setVisionPicked((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  const toggleVisionText = (i: number) =>
    setVisionPickedText((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  /** 把勾中的候选区域并进这张图。走的是和手圈完全同一条路（addRegion）。 */
  const applyVisionRegions = () => {
    if (!vision || !active) return
    const picked = vision.result.regions.filter((_, i) => visionPicked.has(i))
    if (!picked.length) {
      notify('info', '一块都没勾 —— 没有东西要加')
      return
    }
    let ok = 0
    for (const r of picked) {
      if (addRegion(r.points, r.label, true)) ok += 1
    }
    setVision(null)
    setTab('regions')
    notify('ok', `加了 ${ok} 块区域 —— 右边起名、绑实体；不满意的拖着顶点改`)
  }

  /** 把一条识别出的地名放成点位。点位可以先不绑实体，之后再绑。 */
  const placeVisionText = (text: string, x: number, y: number, silent = false) => {
    if (!active) return
    addPin(active.id, {
      id: nid('pin'),
      entity_id: null,
      label: text,
      x,
      y,
      portal: null,
      kind: null,
      color: null,
      note: '识别出来的地名，还没绑实体',
    })
    if (!silent) notify('ok', `「${text}」已标在图上 —— 右边可以绑到实体`)
  }

  const applyVisionTexts = () => {
    if (!vision || !active) return
    const picked = vision.result.texts.filter((_, i) => visionPickedText.has(i))
    if (!picked.length) {
      notify('info', '一个字都没勾')
      return
    }
    for (const t of picked) placeVisionText(t.text, t.x, t.y, true)
    notify('ok', `标了 ${picked.length} 个地名 —— 记得绑到实体，它们现在还只是标签`)
  }

  // 「未落点」= 还没摆在**当前这张图**上的地点。
  // 按当前图算而不是全局：同一个地方可以既在政区图上又在 terrain 图上。
  const placedHere = useMemo(
    () => new Set((active?.pins ?? []).map((p) => p.entity_id).filter(Boolean) as string[]),
    [active],
  )
  const unplaced = useMemo(() => {
    if (!active) return []
    const hl = query.trim().toLowerCase()
    return entities
      .filter((e) => e.type === 'location')
      .filter((e) => !placedHere.has(e.id))
      .filter((e) => !hl || e.name.toLowerCase().includes(hl))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  }, [entities, placedHere, query, active])

  // ---------------------------------------------------------------- 就地编辑

  const openPinEdit = (pin: MapPin, screen: { x: number; y: number }) => {
    if (!pin.entity_id) {
      notify('info', '这个点还没挂实体 —— 用左边的「未落点」把它接上，或双击空白新建一个')
      return
    }
    setEdit({
      kind: 'node',
      entityId: pin.entity_id,
      entityName: pin.label || entityOf(pin.entity_id)?.name || '',
      screen,
    })
  }

  const openBlankEdit = (screen: { x: number; y: number }, at: { x: number; y: number }) => {
    if (!active) return
    pendingAtRef.current = at
    setEdit({
      kind: 'blank',
      screen,
      defaultType: types.find((t) => t.key === 'location')?.key ?? types[0]?.key ?? 'location',
    })
  }

  const selPin = active?.pins.find((p) => p.id === selectedPin) ?? null
  const selInfo = entityOf(selPin?.entity_id ?? null)
  const selRegion = active?.regions.find((r) => r.id === selectedRegion) ?? null
  const selRInfo = entityOf(selRegion?.entity_id ?? null)

  /** 区域显示名：自己起的名字优先，没起就用绑定的实体名 */
  const regionLabel = (r: MapRegion) => r.name || entityOf(r.entity_id)?.name || '未命名区域'

  /** 区域可以绑到任意实体上（地点、势力、国家都行），按名字排一遍好找 */
  const bindable = useMemo(
    () => [...entities].sort((a, b) => a.name.localeCompare(b.name, 'zh')),
    [entities],
  )

  /** 已经用过的层级标签（给新建/编辑表单的 datalist 当建议 —— 仍是自由文本） */
  const levels = useMemo(() => {
    const seen: string[] = []
    for (const id of order) {
      const lv = maps[id]?.level?.trim()
      if (lv && !seen.includes(lv)) seen.push(lv)
    }
    // 用得多的大概率是常用层，排前面
    return seen.sort((a, b) => {
      const ca = order.filter((id) => maps[id]?.level?.trim() === a).length
      const cb = order.filter((id) => maps[id]?.level?.trim() === b).length
      return cb - ca || a.localeCompare(b, 'zh')
    })
  }, [maps, order])

  const persistCollapsed = (next: Set<string>) => {
    setCollapsed(next)
    try {
      localStorage.setItem('wkv.mapTreeCollapsed', JSON.stringify([...next]))
    } catch {
      /* 存不上就只影响这次会话，不值得打扰 */
    }
  }

  const toggleCollapse = (id: string) =>
    persistCollapsed(
      (() => {
        const next = new Set(collapsed)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })(),
    )

  // 树：顶层在前，子图缩进。父图找不到的当顶层，别让图凭空消失。
  //
  // `depth` 只用来算缩进；**缩进封顶在 mapShared 里**（只影响它的第 5 层起），
  // 树的真实层级关系一点没变，只是左边不再无限往右挤。
  // `collapsed` 里某张图被收起时，它的整棵子树都不出行 —— 但节点自己还在。
  const tree = useMemo(() => {
    const rows: { doc: MapDoc; depth: number; kids: number; hidden: number }[] = []
    const kidsOf = (pid: string | null) =>
      order.map((id) => maps[id]).filter((m) => m && m.parent === pid)

    const countAll = (id: string, guard: Set<string>): number => {
      let n = 0
      for (const k of kidsOf(id)) {
        if (guard.has(k.id)) continue
        guard.add(k.id)
        n += 1 + countAll(k.id, guard)
      }
      return n
    }

    const walk = (pid: string | null, depth: number, guard: Set<string>) => {
      for (const m of kidsOf(pid)) {
        if (guard.has(m.id)) continue
        guard.add(m.id)
        const kids = kidsOf(m.id).length
        const shut = collapsed.has(m.id)
        rows.push({
          doc: m,
          depth,
          kids,
          hidden: shut ? countAll(m.id, new Set([m.id])) : 0,
        })
        if (!shut) walk(m.id, depth + 1, guard)
      }
    }

    // 先按 parent 算一遍「谁能从顶层走到」。**折叠之前**要算这个 ——
    // 下面那个兜底循环的本意是捞回成环/悬空的图，要是拿「走没走到过」
    // 来判断，被收起的子树会被它当成孤儿重新摊开，收展就失效了。
    const reach = new Set<string>()
    const mark = (pid: string | null, guard: Set<string>) => {
      for (const m of kidsOf(pid)) {
        if (guard.has(m.id)) continue
        guard.add(m.id)
        reach.add(m.id)
        mark(m.id, guard)
      }
    }
    mark(null, new Set())

    walk(null, 0, new Set())

    // 兜底：父指针成环或指向自己的（从顶层走不到的），直接铺在最后
    for (const id of order) {
      if (maps[id] && !reach.has(id)) {
        rows.push({ doc: maps[id], depth: 0, kids: kidsOf(id).length, hidden: 0 })
      }
    }
    // 层级筛选：命中的图连同它的祖先一起留着，否则被筛掉的父图会把它藏起来
    if (levelFilter) {
      const keep = new Set<string>()
      for (const r of rows) {
        if ((r.doc.level ?? '').trim() !== levelFilter) continue
        keep.add(r.doc.id)
        let p = r.doc.parent
        let guard = 0
        while (p && maps[p] && guard++ < 64) {
          keep.add(p)
          p = maps[p].parent
        }
      }
      return rows.filter((r) => keep.has(r.doc.id))
    }
    return rows
  }, [maps, order, collapsed, levelFilter])

  /** 有子图的图 —— 「全部折叠」只折这些，叶子折了没意义 */
  const parentIds = useMemo(
    () => order.filter((id) => maps[id] && order.some((x) => maps[x]?.parent === id)),
    [maps, order],
  )

  /** 门户角标用：这张图通向哪儿 */
  const portalKindFor = useCallback(
    (toId: string): PortalKind => portalKindOf(maps, activeId, toId) ?? 'side',
    [maps, activeId],
  )

  /** 当前图上的门户按种类计数 —— 有一枚以上才值得显示图例 */
  const portalKinds = useMemo(() => {
    const out: PortalKind[] = []
    for (const p of active?.pins ?? []) {
      if (!p.portal) continue
      const k = portalKindFor(p.portal)
      if (!out.includes(k)) out.push(k)
    }
    return out
  }, [active, portalKindFor])

  const openMetaEditor = () => {
    if (!active) return
    setMetaTitle(active.title)
    setMetaLevel(active.level ?? '')
    setMetaParent(active.parent ?? '')
    setMetaNote(active.note ?? '')
    setEditingMeta(true)
  }

  /** 上一级候选：自己与被自己收纳的图都不能当自己的上一级（否则树会断/成环）。 */
  const parentOptions = useMemo(() => {
    if (!active) return []
    const banned = new Set<string>([active.id])
    const guard = new Set<string>([active.id])
    const collect = (id: string) => {
      for (const m of order.map((x) => maps[x]).filter((m) => m && m.parent === id)) {
        if (guard.has(m.id)) continue
        guard.add(m.id)
        banned.add(m.id)
        collect(m.id)
      }
    }
    collect(active.id)
    return tree.filter((r) => !banned.has(r.doc.id))
  }, [active, maps, order, tree])

  const saveMeta = () => {
    if (!active) return
    mutateMap(active.id, (cur) => ({
      ...cur,
      title: metaTitle.trim() || '未命名地图',
      level: metaLevel.trim(),
      parent: metaParent || null,
      note: metaNote.trim(),
    }))
    setEditingMeta(false)
    notify('ok', '这张图的说法已更新')
  }


  const childMaps = useMemo(
    () => order.map((id) => maps[id]).filter((m) => m && m.parent === active?.id),
    [maps, order, active],
  )

  if (loading && !data) {
    return (
      <div className="gboard gboard--empty">
        <span className="spinner" />
        <span className="fs-sm faint">读取地图…</span>
      </div>
    )
  }

  return (
    <>
    <div className="gboard">
      {/* ---------------- 左：地图树 ---------------- */}
      <div className="gboard__side">
        <div className="gboard__side-head">
          <span className="fs-sm">地图</span>
          <span className="faint fs-xs">{order.length}</span>
          <div className="grow" />
          {parentIds.length > 0 && (
            <button
              className="btn btn--ghost btn--sm"
              onClick={() =>
                persistCollapsed(collapsed.size >= parentIds.length ? new Set() : new Set(parentIds))
              }
              title={
                collapsed.size >= parentIds.length
                  ? '把所有子图铺出来'
                  : '只留顶层，深层的收起来'
              }
            >
              {collapsed.size >= parentIds.length ? '全展开' : '全收起'}
            </button>
          )}
          <button
            className="btn btn--sm"
            onClick={() => (creating ? resetCreating() : setCreating(true))}
            title="一张图一层：世界图 → 区域图 → 城市图"
          >
            {creating ? '取消' : '＋ 新建'}
          </button>
        </div>

        {/* 层级标签是自由文本，所以这里的筛选也是「你有什么就筛什么」。
            只影响显示，不改变树的结构（命中的图连同祖先一起留下）。 */}
        {levels.length > 1 && (
          <div className="gboard__quick">
            <button
              className={`chip ${levelFilter === null ? 'chip--on' : ''}`}
              onClick={() => setLevelFilter(null)}
            >
              全部
            </button>
            {levels.map((lv) => (
              <button
                key={lv}
                className={`chip ${levelFilter === lv ? 'chip--on' : ''}`}
                style={{
                  background: levelTint(lv, levelFilter === lv ? 0.3 : 0.14),
                  borderColor: levelTint(lv, 0.55),
                }}
                onClick={() => setLevelFilter(levelFilter === lv ? null : lv)}
                title={`只看打了「${lv}」的图`}
              >
                {lv}
              </button>
            ))}
          </div>
        )}

        {creating && (
          <div className="gboard__form">
            <label className="field">
              <span className="field__label">底图</span>
              <select
                className="select select--sm"
                value={draftImage}
                onChange={(e) => setDraftImage(e.target.value)}
              >
                <option value="">（选一张已上传的图）</option>
                {assets.map((a) => (
                  <option key={a.name} value={`maps/${a.name}`}>
                    {a.stem}
                  </option>
                ))}
              </select>
            </label>
            <label className="btn btn--ghost btn--sm gboard__up">
              {busy ? '上传中…' : '上传新图'}
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/avif"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void onPickFile(f)
                }}
              />
            </label>
            <label className="field">
              <span className="field__label">标题</span>
              <input
                className="input input--sm"
                value={draftTitle}
                placeholder="世界全图 / 北境 / 灰堡城"
                onChange={(e) => setDraftTitle(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field__label">层级标签（随便写）</span>
              <input
                className="input input--sm"
                list="gboard-levels"
                value={draftLevel}
                placeholder="世界 / 位面 / 城市 / 房间…"
                onChange={(e) => setDraftLevel(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field__label">上一级</span>
              <select
                className="select select--sm"
                value={draftParent}
                onChange={(e) => setDraftParent(e.target.value)}
              >
                <option value="">（顶层）</option>
                {tree.map((r) => (
                  <option key={r.doc.id} value={r.doc.id}>
                    {'　'.repeat(r.depth)}
                    {r.doc.title}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn--primary btn--sm" disabled={busy} onClick={() => void createMap()}>
              {draftImage ? '建这张图' : '建空白画布'}
            </button>
          </div>
        )}

        <div className="gboard__tree">
          {tree.length === 0 ? (
            <p className="faint fs-xs" style={{ padding: '8px 2px', lineHeight: 1.7 }}>
              {levelFilter ? `没有打了「${levelFilter}」的图。` : '还没有地图。手绘的、扫描的、网图都行 —— 传一张进来当天图画。'}
            </p>
          ) : (
            tree.map(({ doc, depth, kids, hidden }) => {
              const shut = collapsed.has(doc.id)
              return (
                <div
                  key={doc.id}
                  className={`gboard__node ${doc.id === activeId ? 'gboard__node--on' : ''}`}
                  style={{ paddingLeft: treePadLeft(depth) }}
                >
                  {/* 收展只动子图那一层；节点自身点了还是切图 */}
                  {kids > 0 ? (
                    <button
                      className="gboard__twist"
                      onClick={() => toggleCollapse(doc.id)}
                      title={shut ? `展开它的 ${hidden} 张子图` : '收起子图'}
                      aria-expanded={!shut}
                    >
                      {shut ? '▸' : '▾'}
                    </button>
                  ) : (
                    <span className="gboard__twist gboard__twist--leaf" aria-hidden>
                      ·
                    </span>
                  )}
                  <button className="gboard__node-main" onClick={() => switchMap(doc.id)}>
                    <span className="gboard__node-title">{doc.title}</span>
                    {/* 层级在这里只给一枚**色点**：左栏拢共 220px，缩进封顶后
                        深层留给标题的空间不多，文字标签会把标题挤成两个字。
                        文字在筛选条、面包屑、「这张图」编辑器和悬浮提示里都有，
                        颜色（哈希稳定）足以让人一眼把同类归堆。 */}
                    {doc.level?.trim() && (
                      <span
                        className="gboard__level-dot"
                        style={{ background: levelTint(doc.level.trim(), 0.92) }}
                        title={`层级标签：${doc.level.trim()}`}
                      />
                    )}
                    <span className="faint fs-xs">
                      {doc.pins.length}
                      {doc.regions.length ? ` · ${doc.regions.length}区` : ''}
                      {shut && hidden ? ` · +${hidden}张子图` : ''}
                    </span>
                  </button>
                </div>
              )
            })
          )}
        </div>

        {active && (
          <div className="gboard__side-foot">
            {editingMeta ? (
              <div className="gboard__form gboard__form--meta">
                <label className="field">
                  <span className="field__label">标题</span>
                  <input
                    className="input input--sm"
                    value={metaTitle}
                    onChange={(e) => setMetaTitle(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field__label">层级标签（随便写，不参与逻辑）</span>
                  <input
                    className="input input--sm"
                    list="gboard-levels"
                    value={metaLevel}
                    placeholder="世界 / 位面 / 城市 / 房间…"
                    onChange={(e) => setMetaLevel(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field__label">上一级</span>
                  <select
                    className="select select--sm"
                    value={metaParent}
                    onChange={(e) => setMetaParent(e.target.value)}
                  >
                    <option value="">（顶层）</option>
                    {parentOptions.map((r) => (
                      <option key={r.doc.id} value={r.doc.id}>
                        {'　'.repeat(r.depth)}
                        {r.doc.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">备注</span>
                  <input
                    className="input input--sm"
                    value={metaNote}
                    placeholder="这张图是干嘛的（只有你自己看）"
                    onChange={(e) => setMetaNote(e.target.value)}
                  />
                </label>
                <div className="row">
                  <button className="btn btn--primary btn--sm" onClick={saveMeta}>
                    保存
                  </button>
                  <button className="btn btn--sm" onClick={() => setEditingMeta(false)}>
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <div className="row">
                <button className="btn btn--sm" onClick={openMetaEditor} title="改标题 / 层级标签 / 上一级">
                  ✎ 这张图
                </button>
                <div className="grow" />
                <button className="btn btn--ghost btn--sm" onClick={() => void removeMap(active.id)}>
                  删除
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---------------- 中：画布 ---------------- */}
      <div className="gboard__main">
        {!active ? (
          <div className="gboard__placeholder">
            <b>还没有地图</b>
            <p className="faint fs-sm">
              左边「＋ 新建」传一张底图（手绘、扫描、网图都行），
              然后把已经建好的「地点」拖到图上的位置。
            </p>
          </div>
        ) : (
          <>
            <div className="gboard__crumbs">
              <Breadcrumb
                maps={maps}
                mapId={active.id}
                onPick={(id) => switchMap(id)}
              />
              <div className="grow" />
              {/* 有门户才解释记号 —— 没有门户时这行字纯属噪音 */}
              {portalKinds.length > 0 && (
                <span className="gboard__legend">
                  {portalKinds.map((k) => (
                    <span key={k} className="gboard__legend-item" title={PORTAL_META[k].hint}>
                      <b>{PORTAL_META[k].glyph}</b>
                      {PORTAL_META[k].short}
                    </span>
                  ))}
                </span>
              )}
              <span className="faint fs-xs">
                点位 {active.pins.length} · 区域 {active.regions.length}
                {active.level?.trim() ? ` · ${active.level.trim()}` : ''}
                {active.width ? ` · 底图 ${active.width}×${active.height}` : ''}
              </span>
              {/* 识别：只出候选，勾过才进图 —— 所以这里不叫「自动圈区域」 */}
              <button
                className="btn btn--sm"
                disabled={visionBusy || !active.image}
                onClick={() => void runVision(false)}
                title={
                  active.image
                    ? '让识别引擎圈出图上的区域、认出图上的字。结果要你勾过才进地图。'
                    : '这张图还没设底图'
                }
              >
                {visionBusy ? <span className="spinner" /> : '⌖'} 识别
              </button>
            </div>
            <MapCanvas
              map={active}
              entityOf={entityOf}
              portalKindOf={portalKindFor}
              selectedPinId={selectedPin}
              onSelectPin={(id) => setSelectedPin(id)}
              onMovePin={movePin}
              onPinEdit={openPinEdit}
              onBlankEdit={openBlankEdit}
              onPortal={(id) => {
                if (!maps[id]) {
                  notify('info', '这个入口指向的地图已经不在了')
                  return
                }
                switchMap(id)
              }}
              placing={placing}
              onPlaced={(x, y) => {
                if (!placing) return
                addPin(active.id, {
                  id: nid('pin'),
                  entity_id: placing.entityId,
                  label: '',
                  x,
                  y,
                  portal: null,
                  kind: null,
                  color: null,
                  note: '',
                })
                notify('ok', `已把「${placing.name}」放到图上`)
                setPlacing(null)
              }}
              highlight={query}
              drawingRegion={drawingRegion && !placing}
              onToggleRegionDraw={() => {
                setDrawingRegion((v) => !v)
                setPlacing(null)
                if (!drawingRegion) setTab('regions')
              }}
              onRegionDrawn={addRegion}
              selectedRegionId={selectedRegion}
              onSelectRegion={(id) => {
                setSelectedRegion(id)
                if (id) setSelectedPin(null)
              }}
              onMoveRegionVertex={moveRegionVertex}
              onMoveRegionWhole={moveRegionWhole}
              onRegionEdit={() => setTab('regions')}
            />
          </>
        )}
      </div>

      {/* ---------------- 右：点位 / 区域 ---------------- */}
      <div className="gboard__side gboard__side--right">
        {!active ? (
          <p className="faint fs-xs">先建一张地图。</p>
        ) : (
          <>
            <div className="gboard__tabs">
              <button
                className={`gboard__tab ${tab === 'pins' ? 'gboard__tab--on' : ''}`}
                onClick={() => setTab('pins')}
              >
                点位 {active.pins.length}
              </button>
              <button
                className={`gboard__tab ${tab === 'regions' ? 'gboard__tab--on' : ''}`}
                onClick={() => setTab('regions')}
              >
                区域 {active.regions.length}
              </button>
            </div>

            {tab === 'pins' ? (
              <>
                <div className="gboard__side-head">
                  <span className="fs-sm">这张图上的点</span>
                  <div className="grow" />
                  <span className="faint fs-xs">{active.pins.length}</span>
                </div>

                <div className="gboard__list">
                  {active.pins.length === 0 ? (
                    <p className="faint fs-xs" style={{ lineHeight: 1.7 }}>
                      还没有点位。在下面的「未落点」里点一个地点，再点图上位置即可。
                    </p>
                  ) : (
                    active.pins.map((p) => {
                      const info = entityOf(p.entity_id)
                      const ghost = Boolean(p.entity_id) && info != null && !info.exists
                      return (
                        <button
                          key={p.id}
                          className={`gboard__pin ${selectedPin === p.id ? 'gboard__pin--on' : ''}`}
                          onClick={() => setSelectedPin(p.id)}
                        >
                          <span
                            className={`dot ${ghost ? 'dot--ghost' : ''}`}
                            data-entity-type={info?.type || undefined}
                          />
                          <span className="gboard__pin-name">
                            {p.label || info?.name || '未命名'}
                            {ghost && <span className="faint fs-xs">（实体已删）</span>}
                          </span>
                          {p.portal &&
                            (() => {
                              const k = portalKindFor(p.portal)
                              return (
                                <span
                                  className={`gboard__pin-tag gboard__pin-tag--${k}`}
                                  title={PORTAL_META[k].hint}
                                >
                                  {PORTAL_META[k].glyph}
                                </span>
                              )
                            })()}
                        </button>
                      )
                    })
                  )}
                </div>

                {/* 选中点位的详情 */}
                {selPin && (
                  <div className="gboard__detail">
                    <div className="row" style={{ marginBottom: 6 }}>
                      <b className="fs-sm">{selPin.label || selInfo?.name || '未命名'}</b>
                      <div className="grow" />
                      <button
                        className="btn btn--ghost btn--icon btn--sm"
                        onClick={() => setSelectedPin(null)}
                        aria-label="收起"
                      >
                        ✕
                      </button>
                    </div>

                    {selPin.entity_id && selInfo?.exists ? (
                      <>
                        <div className="row row--wrap" style={{ gap: 6, marginBottom: 8 }}>
                          <span className="chip chip--type">{selInfo.type}</span>
                          <span className="chip mono fs-xs">
                            {selPin.x.toFixed(3)}, {selPin.y.toFixed(3)}
                          </span>
                        </div>
                        <div className="row row--wrap" style={{ gap: 6 }}>
                          <button
                            className="btn btn--sm"
                            onClick={() => onOpenEntity(selPin.entity_id!)}
                          >
                            打开实体详情 →
                          </button>
                          <button
                            className="btn btn--sm"
                            onClick={() =>
                              setEdit({
                                kind: 'node',
                                entityId: selPin.entity_id!,
                                entityName: selInfo.name,
                                screen: { x: window.innerWidth / 2 - 165, y: 140 },
                              })
                            }
                          >
                            就地改这条
                          </button>
                        </div>
                      </>
                    ) : (
                      <p className="faint fs-xs" style={{ lineHeight: 1.7 }}>
                        这个点还没挂实体。选中下面的「未落点」再点它，或者把资料补上。
                      </p>
                    )}

                    <hr className="hr" />

                    <label className="field">
                      <span className="field__label">显示名（留空就用实体名）</span>
                      <input
                        className="input input--sm"
                        value={selPin.label}
                        placeholder={selInfo?.name ?? ''}
                        onChange={(e) => updatePin(selPin.id, { label: e.target.value })}
                      />
                    </label>

                    <label className="field">
                      <span className="field__label">
                        门户 —— 点这个点上的角标跳到
                        {selPin.portal && (
                          <>
                            {' '}
                            <b>{PORTAL_META[portalKindFor(selPin.portal)].glyph}</b>
                            <span className="faint">
                              {' '}
                              {PORTAL_META[portalKindFor(selPin.portal)].short}
                            </span>
                          </>
                        )}
                      </span>
                      <select
                        className="select select--sm"
                        value={selPin.portal ?? ''}
                        onChange={(e) => updatePin(selPin.id, { portal: e.target.value || null })}
                      >
                        <option value="">（不跳转）</option>
                        {order
                          .map((id) => maps[id])
                          .filter((m) => m && m.id !== active.id)
                          .map((m) => {
                            const k = portalKindOf(maps, active.id, m.id) ?? 'side'
                            return (
                              <option key={m.id} value={m.id}>
                                {PORTAL_META[k].glyph} {m.title}
                                {m.level?.trim() ? `（${m.level.trim()}）` : ''}
                              </option>
                            )
                          })}
                      </select>
                    </label>
                    <p className="faint fs-xs" style={{ marginTop: 4, lineHeight: 1.6 }}>
                      记号看的是两图的<strong>亲缘</strong>：▼ 是这张图自己的子孙（钻进去），
                      ▲ 是它的上一层（回外层），⇄ 是两不相干（跨空间）。改「上一级」会跟着变。
                    </p>
                    {childMaps.length > 0 && (
                      <p className="faint fs-xs" style={{ marginTop: 4, lineHeight: 1.6 }}>
                        这张图下面挂了：{childMaps.map((m) => m.title).join('、')}
                      </p>
                    )}

                    <div className="row" style={{ marginTop: 8 }}>
                      <button className="btn btn--ghost btn--sm" onClick={() => deletePin(selPin.id)}>
                        从图上拿掉
                      </button>
                    </div>
                  </div>
                )}

                {/* 未落点 */}
                <div className="gboard__side-head">
                  <span className="fs-sm">未落点的地点</span>
                  <div className="grow" />
                  <span className="faint fs-xs">{unplaced.length}</span>
                </div>
                <p className="faint fs-xs" style={{ padding: '0 0 6px', lineHeight: 1.6 }}>
                  点一下进入放点模式，再点图上位置。同一个地点可以摆在多张图上。
                </p>
                <div className="gboard__list">
                  {unplaced.length === 0 ? (
                    <p className="faint fs-xs">
                      {entities.some((e) => e.type === 'location')
                        ? '所有地点都在这张图上了。'
                        : '还没有地点实体 —— 在图上双击空白就能直接建一个。'}
                    </p>
                  ) : (
                    unplaced.map((e) => (
                      <button
                        key={e.id}
                        className={`gboard__pin ${placing?.entityId === e.id ? 'gboard__pin--on' : ''}`}
                        onClick={() => {
                          setDrawingRegion(false)
                          setPlacing((cur) =>
                            cur?.entityId === e.id ? null : { entityId: e.id, name: e.name },
                          )
                        }}
                      >
                        <span className="dot" data-entity-type={e.type} />
                        <span className="gboard__pin-name">{e.name}</span>
                      </button>
                    ))
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="gboard__side-head">
                  <span className="fs-sm">这张图上的区域</span>
                  <div className="grow" />
                  <button
                    className={`btn btn--sm ${drawingRegion ? 'btn--primary' : ''}`}
                    disabled={Boolean(placing)}
                    onClick={() => {
                      setPlacing(null)
                      setDrawingRegion((v) => !v)
                    }}
                    title="国、州、山脉、势力范围 —— 想圈什么圈什么"
                  >
                    {drawingRegion ? '结束圈选' : '＋ 圈一块'}
                  </button>
                </div>
                <p className="faint fs-xs" style={{ padding: '0 var(--p-space-3) 6px', lineHeight: 1.6 }}>
                  圈一块后在图上连着点，把范围围起来，双击或点第一个点收口。顶点是相对坐标，换底图不跑。
                </p>

                <div className="gboard__list">
                  {active.regions.length === 0 ? (
                    <p className="faint fs-xs" style={{ lineHeight: 1.7 }}>
                      还没有区域。上面「＋ 圈一块」，然后在图上点几下定个轮廓 —— 不用点得很准，之后能拖。
                    </p>
                  ) : (
                    active.regions.map((r) => {
                      const info = entityOf(r.entity_id)
                      const ghost = Boolean(r.entity_id) && info != null && !info.exists
                      return (
                        <button
                          key={r.id}
                          className={`gboard__region ${selectedRegion === r.id ? 'gboard__region--on' : ''}`}
                          onClick={() => {
                            setSelectedRegion(r.id)
                            setSelectedPin(null)
                          }}
                        >
                          <span
                            className="gboard__swatch-dot"
                            style={{
                              background: r.fill || 'var(--accent)',
                              opacity: Math.max(0.4, r.opacity),
                            }}
                          />
                          <span className="gboard__region-name">
                            {regionLabel(r)}
                            {ghost && <span className="faint fs-xs">（实体已删）</span>}
                          </span>
                          <span className="faint fs-xs">{r.points.length} 点</span>
                        </button>
                      )
                    })
                  )}
                </div>

                {/* 选中区域的编辑面板 */}
                {selRegion && (
                  <div className="gboard__detail">
                    <div className="row" style={{ marginBottom: 6 }}>
                      <b className="fs-sm">{regionLabel(selRegion)}</b>
                      <div className="grow" />
                      <button
                        className="btn btn--ghost btn--icon btn--sm"
                        onClick={() => setSelectedRegion(null)}
                        aria-label="收起"
                      >
                        ✕
                      </button>
                    </div>

                    <div className="row row--wrap" style={{ gap: 6, marginBottom: 8 }}>
                      <span className="chip mono fs-xs">{selRegion.points.length} 个顶点</span>
                      {selRInfo?.exists && <span className="chip chip--type">{selRInfo.type}</span>}
                    </div>

                    <label className="field">
                      <span className="field__label">名称（留空就用实体名）</span>
                      <input
                        className="input input--sm"
                        value={selRegion.name}
                        placeholder={selRInfo?.name ?? '北境 / 灰烬山脉'}
                        onChange={(e) => updateRegion(selRegion.id, { name: e.target.value })}
                      />
                    </label>

                    <label className="field">
                      <span className="field__label">绑到实体（可选）</span>
                      <select
                        className="select select--sm"
                        value={selRegion.entity_id ?? ''}
                        onChange={(e) =>
                          updateRegion(selRegion.id, { entity_id: e.target.value || null })
                        }
                      >
                        <option value="">（不绑定）</option>
                        {bindable.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name} · {e.type}
                          </option>
                        ))}
                      </select>
                      {!selRegion.entity_id && (
                        <span className="faint fs-xs" style={{ marginTop: 3, lineHeight: 1.5 }}>
                          绑上实体之后，这块面和它的资料就连起来了。
                        </span>
                      )}
                    </label>

                    <div className="field">
                      <span className="field__label">填充色</span>
                      <div className="row" style={{ gap: 6 }}>
                        <input
                          type="color"
                          className="input input--sm"
                          style={{ width: 46, padding: 2, flex: 'none' }}
                          value={selRegion.fill || '#c0392b'}
                          onChange={(e) => updateRegion(selRegion.id, { fill: e.target.value })}
                          aria-label="填充色"
                        />
                        <span className="mono fs-xs faint">{selRegion.fill || '默认'}</span>
                      </div>
                      <div className="gboard__swatches">
                        {REGION_PALETTE.map((c) => (
                          <button
                            key={c}
                            className={`gboard__swatch ${selRegion.fill === c ? 'gboard__swatch--on' : ''}`}
                            style={{ background: c }}
                            onClick={() => updateRegion(selRegion.id, { fill: c })}
                            aria-label={c}
                            title={c}
                          />
                        ))}
                      </div>
                    </div>

                    <label className="field">
                      <span className="field__label">透明度</span>
                      <div className="gboard__range">
                        <input
                          type="range"
                          min={0.05}
                          max={0.9}
                          step={0.01}
                          value={selRegion.opacity}
                          onChange={(e) =>
                            updateRegion(selRegion.id, { opacity: Number(e.target.value) })
                          }
                        />
                        <span className="mono fs-xs">{selRegion.opacity.toFixed(2)}</span>
                      </div>
                    </label>

                    <p className="faint fs-xs" style={{ lineHeight: 1.6 }}>
                      在图上拖白色的顶点改形状。
                    </p>

                    <div className="row row--wrap" style={{ gap: 6, marginTop: 8 }}>
                      {selRegion.entity_id && selRInfo?.exists && (
                        <button
                          className="btn btn--sm"
                          onClick={() => onOpenEntity(selRegion.entity_id!)}
                        >
                          打开实体详情 →
                        </button>
                      )}
                      <button
                        className="btn btn--ghost btn--sm"
                        disabled={selRegion.points.length <= 3}
                        onClick={() => dropLastVertex(selRegion.id)}
                        title="闭合之后发现多点了一下，用这个修"
                      >
                        去掉一个顶点
                      </button>
                      <button
                        className="btn btn--ghost btn--sm"
                        onClick={() => deleteRegion(selRegion.id)}
                      >
                        删掉这块区域
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* ---- 就地编辑浮层：复用图谱那一套 ---- */}
      {edit && (
        <GraphEditPopover
          bookId={bookId}
          target={edit}
          types={types}
          onClose={() => {
            setEdit(null)
            pendingAtRef.current = null
          }}
          onOpenDetail={(id) => onOpenEntity(id)}
          onSaved={(id) => {
            const at = pendingAtRef.current
            setEdit(null)
            pendingAtRef.current = null
            // 双击空白新建出来的地点，顺手摆到刚点的那个位置
            if (at && active) {
              addPin(active.id, {
                id: nid('pin'),
                entity_id: id,
                label: '',
                x: at.x,
                y: at.y,
                portal: null,
                kind: null,
                color: null,
                note: '',
              })
              notify('ok', '已新建并放到图上')
            }
            void load().then(onChanged)
          }}
          // 删关联：图（地图）刷新，但浮层留着 —— 连着剪几条不用反复双击
          onChanged={() => {
            void load().then(onChanged)
          }}
        />
      )}
    </div>

      {/* 层级标签的建议清单：**datalist 不是下拉** —— 想写什么写什么，
          只是把已经用过的那些递到手边，免得同一层写出三个近义词。
          放在根级而不是塞进网格里，省得它被当成第 4 列。 */}
      <datalist id="gboard-levels">
        {levels.map((lv) => (
          <option key={lv} value={lv} />
        ))}
      </datalist>

      {/* 识别结果 = 待确认清单。机器圈的东西不进地图，勾了、点了「加入」才进。 */}
      {vision && (
        <Modal
          title={
            <span>
              识别结果 · {vision.engine_label}
              <span className="faint fs-xs" style={{ marginLeft: 8 }}>
                {vision.sends_image_offsite ? '底图已发给服务商' : '底图没有离开这台机器'}
                {vision.cached ? ' · 用的上次结果' : ` · ${vision.result.elapsed_ms}ms`}
              </span>
            </span>
          }
          onClose={() => setVision(null)}
          wide
          footer={
            <>
              <span className="faint fs-xs">
                核实一下：不要的取消勾选。加进去之后还能拖顶点、改名、删掉。
              </span>
              <div className="grow" />
              <button
                className="btn btn--sm"
                disabled={visionBusy}
                onClick={() => void runVision(true)}
                title="换套参数或换个引擎再跑一次（不是从缓存读）"
              >
                {visionBusy && <span className="spinner" />}
                重跑
              </button>
              <button className="btn btn--sm" onClick={() => setVision(null)}>
                取消
              </button>
              <button
                className="btn btn--primary btn--sm"
                disabled={!visionPicked.size}
                onClick={applyVisionRegions}
              >
                加入选中的 {visionPicked.size} 块区域
              </button>
            </>
          }
        >
          {/* 引擎的说明、降级原因、隐私提醒 —— 原样显示，不吞 */}
          {vision.notes.length > 0 && (
            <div className="vpick__notes">
              {vision.notes.map((n, i) => (
                <div key={i} className="vpick__note">
                  {n}
                </div>
              ))}
            </div>
          )}

          <section className="vpick">
            <div className="vpick__head">
              <b>候选区域 {vision.result.regions.length} 块</b>
              <span className="faint fs-xs">
                勾中的会成为这张图上的区域，和手圈出来的完全一样
              </span>
              <div className="grow" />
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => setVisionPicked(new Set(vision.result.regions.map((_, i) => i)))}
              >
                全选
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => setVisionPicked(new Set())}>
                全不选
              </button>
            </div>
            {vision.result.regions.length === 0 ? (
              <p className="faint fs-sm">
                一块都没找到。线条可能太淡、断口太多，或者这张图本来就没画闭合边界 ——
                换个引擎（云端能读字，判断更准）或者手动圈。
              </p>
            ) : (
              <div className="vpick__grid">
                {vision.result.regions.map((r, i) => (
                  <label
                    key={i}
                    className={`vpick__item ${visionPicked.has(i) ? 'vpick__item--on' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={visionPicked.has(i)}
                      onChange={() => toggleVisionPick(i)}
                    />
                    <svg
                      className="vpick__thumb"
                      viewBox="0 0 1 1"
                      preserveAspectRatio="none"
                      aria-hidden
                    >
                      <polygon points={r.points.map(([x, y]) => `${x},${y}`).join(' ')} />
                    </svg>
                    <span className="vpick__meta">
                      <span className="vpick__name">{r.label || `区域 ${i + 1}`}</span>
                      <span className="faint fs-xs">
                        {r.points.length} 个顶点
                        {r.source === 'local' ? ' · 机器只认形状，不认语义' : ''}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>

          <section className="vpick">
            <div className="vpick__head">
              <b>图上认出的地名 {vision.result.texts.length} 个</b>
              <span className="faint fs-xs">
                勾中的会先标成<b>不带实体</b>的点位 —— 位置你对了之后再去右边绑实体
              </span>
              <div className="grow" />
              <button
                className="btn btn--sm"
                disabled={!visionPickedText.size}
                onClick={applyVisionTexts}
              >
                标成点位（{visionPickedText.size}）
              </button>
            </div>
            {vision.result.texts.length === 0 ? (
              <p className="faint fs-sm">
                没认出字。中文手写体本来就难认，别指望 OCR —— 云端模型能好一些。
              </p>
            ) : (
              <div className="vpick__grid">
                {vision.result.texts.map((t, i) => (
                  <label
                    key={i}
                    className={`vpick__item ${visionPickedText.has(i) ? 'vpick__item--on' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={visionPickedText.has(i)}
                      onChange={() => toggleVisionText(i)}
                    />
                    <span className="vpick__meta">
                      <span className="vpick__name">{t.text}</span>
                      <span className="faint fs-xs">
                        x {(t.x * 100).toFixed(0)}% · y {(t.y * 100).toFixed(0)}%
                        {t.confidence > 0 ? ` · 信心 ${(t.confidence * 100).toFixed(0)}%` : ''}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>

          {vision.result.usage && Object.keys(vision.result.usage).length > 0 && (
            <p className="faint fs-xs" style={{ margin: 0 }}>
              这次花了 ¥{String((vision.result.usage as Record<string, unknown>).cost_cny ?? '0')}
              （服务商{' '}
              {String((vision.result.usage as Record<string, unknown>).provider ?? '—')}，
              累计见「后台 → AI 成本看板」）
            </p>
          )}
        </Modal>
      )}
    </>
  )
}

/**
 * 面包屑：从根一路点到当前图。
 *
 * **深了要折叠**：认真写一套设定，走到「宇宙 › 位面 › 大陆 › 帝国 › 省 › 城 › 区 › 房间」
 * 是常事，八层面包屑能占掉半行，把右边的点位统计挤没。所以超过 4 层时只留
 * 「首层 › … › 最近两层」—— 首层是回总图的锚点，最近两层是刚才走过的地方，
 * 中间那段想找就点「…」摊开。
 *
 * 折叠**不删信息**：被藏起来的那几层都在「…」的浮层里，点一下直接跳过去 ——
 * 比逼人一层层往回退再往下点强。
 */
const CRUMB_MAX = 4

function Breadcrumb({
  maps,
  mapId,
  onPick,
}: {
  maps: Record<string, MapDoc>
  mapId: string
  onPick: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const chain: MapDoc[] = []
  const guard = new Set<string>()
  let cur: MapDoc | undefined = maps[mapId]
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id)
    chain.unshift(cur)
    cur = cur.parent ? maps[cur.parent] : undefined
  }

  // 点别处 / 切图就把浮层收起来
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  useEffect(() => setOpen(false), [mapId])

  if (chain.length <= 1) return null

  const folded = chain.length > CRUMB_MAX
  const head = folded ? [chain[0]] : chain
  const tail = folded ? chain.slice(-2) : []
  const middle = folded ? chain.slice(1, -2) : []

  const crumb = (m: MapDoc, showSep: boolean) => (
    <span key={m.id} className="gboard__crumb-item">
      {showSep && <span className="faint">›</span>}
      <button
        className={m.id === mapId ? 'gboard__crumb-on' : 'gboard__crumb-link'}
        onClick={() => m.id !== mapId && onPick(m.id)}
        title={m.level?.trim() ? `层级：${m.level.trim()}` : undefined}
      >
        {m.title}
      </button>
    </span>
  )

  return (
    <div className="gboard__crumb" ref={wrapRef}>
      {head.map((m) => crumb(m, false))}
      {folded && (
        <>
          <span className="faint">›</span>
          <span className="gboard__crumb-fold">
            <button
              className="gboard__crumb-more"
              onClick={() => setOpen((v) => !v)}
              title={`中间还藏着 ${middle.length} 层：${middle.map((m) => m.title).join(' › ')}`}
              aria-expanded={open}
            >
              …
            </button>
            {open && (
              <span className="gboard__crumb-pop">
                {middle.map((m) => (
                  <button
                    key={m.id}
                    className="gboard__crumb-pop-item"
                    onClick={() => {
                      setOpen(false)
                      onPick(m.id)
                    }}
                  >
                    {m.title}
                    {m.level?.trim() && <span className="faint fs-xs"> {m.level.trim()}</span>}
                  </button>
                ))}
              </span>
            )}
          </span>
        </>
      )}
      {tail.map((m) => crumb(m, true))}
    </div>
  )
}

export default GeoMapBoard
