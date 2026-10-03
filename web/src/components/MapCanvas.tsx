/**
 * 地图画布（P4.5）。
 *
 * 一张底图 + 若干点位 + 若干区域多边形。和 Graph2D 是**同一个思路的另一面**：
 * 那边节点位置是力模拟算出来的，这边位置是人用手摆的 —— 所以这里的位置是
 * 真数据（写进 view/maps/），不是每次重算的副产品。
 *
 * 四条设计要点：
 *
 * 1. **坐标一律归一化 0~1**。存像素的话，同一张图重扫一遍分辨率变了，
 *    几百个点就全废了。归一化之后换底图不用重摆。
 * 2. **点位视觉尺寸恒定**（半径、字号都除以缩放 k）。放大是为了看清底图细节，
 *    不是为了把标记也放大成一坨。
 * 3. **拖动只改本地坐标**，松手才回写。拖一下存一次会打出一串请求，
 *    而且中途落盘存到一半的位置会很难看。
 * 4. **区域既可以用手圈，也可以由识别引擎提候选**（P4.5.3）。两条路都汇到
 *    同一份 `regions`，界面上分不出来 —— 数据层不需要知道它是人画的还是机器猜的。
 *
 * 交互与图谱就地编辑保持一致：双击 = 改，双击空白 = 新建；
 * 另有「放点」和「圈区域」两个模式，都是一次性动作，做完自动退出。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api/client'
import type { MapDoc, MapEntityInfo, MapPin, MapRegion } from '../api/types'
import { PORTAL_META, type PortalKind } from './mapShared'

interface Props {
  map: MapDoc
  /** pin 指向的实体信息（名字/类型/是否还在） */
  entityOf: (id: string | null) => MapEntityInfo | null
  selectedPinId?: string | null
  onSelectPin?: (id: string | null) => void
  /** 拖完松手：坐标回写 */
  onMovePin?: (pinId: string, x: number, y: number) => void
  /** 双击已有 pin（就地改实体，或改这个点的显示名） */
  onPinEdit?: (pin: MapPin, screen: { x: number; y: number }) => void
  /** 双击空白：就地新建地点实体并落点。at 是归一化坐标 */
  onBlankEdit?: (screen: { x: number; y: number }, at: { x: number; y: number }) => void
  /** 点 pin 上的下钻角标：跳到另一张地图 */
  onPortal?: (mapId: string) => void
  /**
   * 这条门户通到哪儿 —— 由外层按 parent 亲缘算好。
   * 图上据此换记号：▼ 钻进去 / ▲ 回外层 / ⇄ 跨空间。
   * 不传就退回中性记号，绝不假装知道。
   */
  portalKindOf?: (toMapId: string) => PortalKind
  /** 放点模式：下一个点击会落在图上，而不是选中 */
  placing?: { entityId: string; name: string } | null
  onPlaced?: (x: number, y: number) => void
  /** 搜索高亮串 */
  highlight?: string

  /* ------------------------------- 区域 ------------------------------- */

  /** 圈区域模式：点一下加一个顶点 */
  drawingRegion?: boolean
  /** 工具栏按钮：进出圈区域模式 */
  onToggleRegionDraw?: () => void
  /** 闭合了一个多边形（归一化顶点，保证 ≥3 个） */
  onRegionDrawn?: (points: [number, number][]) => void
  selectedRegionId?: string | null
  onSelectRegion?: (id: string | null) => void
  /** 拖顶点改形状：松手才回写 */
  onMoveRegionVertex?: (regionId: string, index: number, x: number, y: number) => void
  /** 拖区域**整体**平移：松手才回写（dx/dy 是归一化位移） */
  onMoveRegionWhole?: (regionId: string, dx: number, dy: number) => void
  /** 双击已有区域：打开它的编辑面板 */
  onRegionEdit?: (region: MapRegion, screen: { x: number; y: number }) => void
}

const FALLBACK = { w: 1600, h: 1000 }
const PIN_R = 9
const PORTAL_R = 8
const LABEL_FS = 13
const VERTEX_R = 6
const DRAFT_R = 5
/** 按下与松开之间超过这么多像素就算「拖动」，不当成点击 —— 平移画布不该顺手取消选中 */
const DRAG_SLOP = 5

export function MapCanvas({
  map,
  entityOf,
  selectedPinId,
  onSelectPin,
  onMovePin,
  onPinEdit,
  onBlankEdit,
  onPortal,
  portalKindOf,
  placing,
  onPlaced,
  highlight = '',
  drawingRegion = false,
  onToggleRegionDraw,
  onRegionDrawn,
  selectedRegionId,
  onSelectRegion,
  onMoveRegionVertex,
  onMoveRegionWhole,
  onRegionEdit,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const sizeRef = useRef({ w: 900, h: 600 })
  const [size, setSize] = useState({ w: 900, h: 600 })
  const [t, setT] = useState({ k: 1, x: 0, y: 0 })
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [broken, setBroken] = useState(false)

  // 拖动中的临时坐标：松手前不回写，免得打出一串请求
  const [dragging, setDragging] = useState<{ id: string; x: number; y: number } | null>(null)
  /** 正在拖的区域顶点（同样松手才回写） */
  const [vDrag, setVDrag] = useState<{ regionId: string; index: number; x: number; y: number } | null>(
    null,
  )
  /** 正在拖的区域**整体**：ox/oy 是按下时的图坐标，dx/dy 是累计位移 */
  const [rDrag, setRDrag] = useState<{
    regionId: string
    ox: number
    oy: number
    dx: number
    dy: number
  } | null>(null)

  /** 圈区域时已经落下的顶点（归一化）。空数组 = 还没开始。 */
  const [draft, setDraft] = useState<[number, number][]>([])
  /** 跟随指针的预览点 */
  const [cursor, setCursor] = useState<[number, number] | null>(null)

  const panRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const downRef = useRef<{ x: number; y: number } | null>(null)
  const hoverRef = useRef<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const fittedForRef = useRef('')

  // 底图真实像素：后端存了就用存的，没存（手改过地图文件）就现量
  useEffect(() => {
    setBroken(false)
    if (!map.image) {
      setNatural(null)
      return
    }
    let alive = true
    const img = new Image()
    img.onload = () => {
      if (alive) setNatural({ w: img.naturalWidth, h: img.naturalHeight })
    }
    img.onerror = () => {
      if (alive) {
        setNatural(null)
        setBroken(true)
      }
    }
    img.src = api.assetUrlOf(map.image)
    return () => {
      alive = false
      img.onload = null
      img.onerror = null
    }
  }, [map.image])

  const W = map.width || natural?.w || FALLBACK.w
  const H = map.height || natural?.h || FALLBACK.h

  // ---- 尺寸跟踪 ----
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth || 900
      const h = el.clientHeight || 600
      sizeRef.current = { w, h }
      setSize({ w, h })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fitTo = useCallback((w: number, h: number) => {
    const box = sizeRef.current
    const k = Math.min(box.w / w, box.h / h) * 0.96
    setT({ k, x: (box.w - w * k) / 2, y: (box.h - h * k) / 2 })
  }, [])

  // 换地图、或者底图尺寸量出来了，就重新适配一次
  const fitKey = `${map.id}:${W}x${H}`
  useEffect(() => {
    if (fittedForRef.current === fitKey) return
    fittedForRef.current = fitKey
    fitTo(W, H)
  }, [fitKey, W, H, fitTo])

  useEffect(() => {
    fitTo(W, H)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size])

  // 退出圈区域模式就清掉草稿，别让它赖在画布上
  useEffect(() => {
    if (!drawingRegion) {
      setDraft([])
      setCursor(null)
    }
  }, [drawingRegion])

  // ---- 缩放（非 passive 才能 preventDefault） ----
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      const rect = el.getBoundingClientRect()
      const sx = ev.clientX - rect.left
      const sy = ev.clientY - rect.top
      setT((prev) => {
        const k = Math.min(8, Math.max(0.05, prev.k * (ev.deltaY < 0 ? 1.14 : 1 / 1.14)))
        const gx = (sx - prev.x) / prev.k
        const gy = (sy - prev.y) / prev.k
        return { k, x: sx - gx * k, y: sy - gy * k }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  /** 屏幕点 → 归一化图坐标 */
  const toUnit = (clientX: number, clientY: number) => {
    const rect = wrapRef.current!.getBoundingClientRect()
    const gx = (clientX - rect.left - t.x) / t.k
    const gy = (clientY - rect.top - t.y) / t.k
    return { x: gx / W, y: gy / H }
  }

  // 圈区域时画布是「点一下加一个点」，不能再兼做平移 ——
  // 否则每一次点都会变成一次微小拖动，顶点加不上。
  const canPan = !drawingRegion && !placing

  const onBgPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    downRef.current = { x: e.clientX, y: e.clientY }
    if (!canPan) return
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    panRef.current = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (drawingRegion) {
      const p = toUnit(e.clientX, e.clientY)
      setCursor([clamp01(p.x), clamp01(p.y)])
    }

    const vd = vDrag
    if (vd) {
      const p = toUnit(e.clientX, e.clientY)
      setVDrag({ ...vd, x: clamp01(p.x), y: clamp01(p.y) })
      return
    }

    const rd = rDrag
    if (rd) {
      const p = toUnit(e.clientX, e.clientY)
      setRDrag({ ...rd, dx: p.x - rd.ox, dy: p.y - rd.oy })
      return
    }

    const drag = dragging
    if (drag) {
      const p = toUnit(e.clientX, e.clientY)
      setDragging({ id: drag.id, x: clamp01(p.x), y: clamp01(p.y) })
      return
    }

    const pan = panRef.current
    if (!pan) return
    setT((prev) => ({
      ...prev,
      x: pan.tx + (e.clientX - pan.x),
      y: pan.ty + (e.clientY - pan.y),
    }))
  }

  const endPointer = () => {
    panRef.current = null
    if (vDrag) {
      onMoveRegionVertex?.(vDrag.regionId, vDrag.index, vDrag.x, vDrag.y)
      setVDrag(null)
    }
    if (rDrag) {
      // 位移小到看不见就别回写 —— 纯点击不该产生一次「保存」
      if (Math.hypot(rDrag.dx, rDrag.dy) * 1000 > 2) {
        onMoveRegionWhole?.(rDrag.regionId, rDrag.dx, rDrag.dy)
      }
      setRDrag(null)
    }
    if (dragging) {
      onMovePin?.(dragging.id, dragging.x, dragging.y)
      setDragging(null)
    }
  }

  /** 真的点了一下（不是拖完松手） */
  const isRealClick = (e: React.MouseEvent) => {
    const d = downRef.current
    return !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) <= DRAG_SLOP
  }

  const k = t.k
  const unit = 1 / Math.max(0.05, k) // 把「屏幕像素」换算回图坐标

  /** 把一个多边形闭合落库。at 传了就先削掉双击带进来的重复顶点。 */
  const closeDraft = (at?: { x: number; y: number }) => {
    const pts = draft.slice()
    if (at) {
      // 双击在浏览器里是「click → click → dblclick」，
      // 那两次 click 各自在同一处加了一个顶点，先削掉它们再闭合。
      const lim = 8 * unit
      while (pts.length > 0) {
        const [lx, ly] = pts[pts.length - 1]
        if (Math.hypot((lx - at.x) * W, (ly - at.y) * H) < lim) pts.pop()
        else break
      }
    }
    if (pts.length < 3) {
      // 点不够，围不成面 —— 保持原样让用户接着点
      setDraft(pts)
      return
    }
    setDraft([])
    setCursor(null)
    onRegionDrawn?.(pts)
  }

  const popDraft = () => setDraft((d) => d.slice(0, -1))

  // ---- 画布上的点击 ----
  const onCanvasClick = (e: React.MouseEvent) => {
    const el = e.target as Element
    if (el.closest?.('[data-pin]')) return
    if (!isRealClick(e)) return

    if (drawingRegion) {
      const p = toUnit(e.clientX, e.clientY)
      setDraft((d) => [...d, [clamp01(p.x), clamp01(p.y)]])
      return
    }
    if (placing) {
      const p = toUnit(e.clientX, e.clientY)
      onPlaced?.(clamp01(p.x), clamp01(p.y))
      return
    }
    // 点空白 = 取消选择
    onSelectRegion?.(null)
    onSelectPin?.(null)
  }

  const onCanvasDouble = (e: React.MouseEvent) => {
    const el = e.target as Element
    if (el.closest?.('[data-pin]')) return
    const p = toUnit(e.clientX, e.clientY)
    const at = { x: clamp01(p.x), y: clamp01(p.y) }

    if (drawingRegion) {
      closeDraft(at)
      return
    }
    if (placing) return
    if (!onBlankEdit) return
    onBlankEdit({ x: e.clientX, y: e.clientY }, at)
  }

  // ---- 高亮 ----
  const hl = highlight.trim().toLowerCase()
  const pinName = useCallback(
    (pin: MapPin) => pin.label || entityOf(pin.entity_id)?.name || '未命名',
    [entityOf],
  )
  const hitIds = useMemo(() => {
    if (!hl) return null
    const s = new Set<string>()
    for (const pin of map.pins) {
      if (pinName(pin).toLowerCase().includes(hl)) s.add(pin.id)
    }
    return s
  }, [hl, map.pins, pinName])

  const dimAll = hitIds != null && hitIds.size > 0

  const hint = drawingRegion
    ? '圈区域：点一下加一个顶点 · 双击 或 点第一个顶点 闭合成面 · Esc 取消'
    : placing
      ? '放点模式：点图上任意位置放下这个地点 · 按 Esc 取消'
      : '滚轮缩放 · 拖动平移 · 拖点位挪位置 · 双击点位改 · 双击空白新建 · 点区域选中'

  const cursorStyle = drawingRegion
    ? 'crosshair'
    : placing
      ? 'crosshair'
      : vDrag || dragging
        ? 'grabbing'
        : panRef.current
          ? 'grabbing'
          : 'grab'

  return (
    <div className={`gmap ${drawingRegion ? 'gmap--drawing' : ''}`} ref={wrapRef}>
      <svg
        className="gmap__svg"
        width={size.w}
        height={size.h}
        onPointerDown={onBgPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerLeave={endPointer}
        onClick={onCanvasClick}
        onDoubleClick={onCanvasDouble}
        style={{ cursor: cursorStyle }}
      >
        <g transform={`translate(${t.x},${t.y}) scale(${k})`}>
          {/* 底图。没有底图时给一块纸色，至少让人知道这块是画布 */}
          {map.image ? (
            <image
              href={api.assetUrlOf(map.image)}
              x={0}
              y={0}
              width={W}
              height={H}
              preserveAspectRatio="none"
              style={{ pointerEvents: 'none' }}
            />
          ) : (
            <rect className="gmap__blank" x={0} y={0} width={W} height={H} />
          )}
          <rect className="gmap__frame" x={0} y={0} width={W} height={H} />

          {/* 区域多边形（在点位下面） */}
          {map.regions.map((r) => {
            const isSel = selectedRegionId === r.id
            // 被拖动的顶点要实时跟手，其余顶点用原值
            const vTrans = (p: [number, number], i: number): [number, number] =>
              vDrag && vDrag.regionId === r.id && i === vDrag.index
                ? ([vDrag.x, vDrag.y] as [number, number])
                : p
            // 整体拖动：所有顶点跟着位移
            const wTrans = (p: [number, number]): [number, number] =>
              rDrag && rDrag.regionId === r.id
                ? ([clamp01(p[0] + rDrag.dx), clamp01(p[1] + rDrag.dy)] as [number, number])
                : p
            const pts: [number, number][] = r.points
              .map((p, i) => vTrans(wTrans(p), i))
            return (
              <g
                key={r.id}
                data-region={r.id}
                className={`gmap__region ${isSel ? 'gmap__region--on' : ''}`}
                style={{
                  cursor: drawingRegion ? 'crosshair' : 'pointer',
                  // 圈选时别让已有的面把点击吃掉，不然顶点加不上
                  pointerEvents: drawingRegion ? 'none' : undefined,
                }}
                onPointerDown={(e) => {
                  // 拖区域**整体**平移（顶点手柄上不触发 —— 那是改形状）
                  if (drawingRegion || e.button !== 0) return
                  if ((e.target as Element).closest?.('[data-vertex]')) return
                  e.stopPropagation()
                  ;(e.target as Element).setPointerCapture?.(e.pointerId)
                  const p = toUnit(e.clientX, e.clientY)
                  onSelectRegion?.(r.id)
                  setRDrag({ regionId: r.id, ox: clamp01(p.x), oy: clamp01(p.y), dx: 0, dy: 0 })
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  if (!isRealClick(e)) return
                  onSelectRegion?.(r.id)
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  onSelectRegion?.(r.id)
                  onRegionEdit?.(r, { x: e.clientX, y: e.clientY })
                }}
              >
                <RegionShape region={r} points={pts} W={W} H={H} unit={unit} />
                {/* 选中后长出顶点手柄，拖着改形状 */}
                {isSel &&
                  pts.map(([x, y], i) => (
                    <circle
                      key={i}
                      className="gmap__rvertex"
                      data-vertex={i}
                      cx={x * W}
                      cy={y * H}
                      r={VERTEX_R * unit}
                      style={{ strokeWidth: 1.5 * unit }}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        if (e.button !== 0) return
                        ;(e.target as Element).setPointerCapture?.(e.pointerId)
                        setVDrag({ regionId: r.id, index: i, x, y })
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ))}
              </g>
            )
          })}

          {/* 正在圈的那个面 */}
          {drawingRegion && draft.length > 0 && (
            <g className="gmap__draft">
              <polyline
                points={[...draft, ...(cursor ? [cursor] : [])]
                  .map(([x, y]) => `${x * W},${y * H}`)
                  .join(' ')}
                style={{ fill: 'none', strokeWidth: 2 * unit }}
              />
              {draft.length >= 3 && cursor && (
                <line
                  x1={draft[0][0] * W}
                  y1={draft[0][1] * H}
                  x2={cursor[0] * W}
                  y2={cursor[1] * H}
                  style={{ strokeWidth: 1 * unit }}
                />
              )}
              {draft.length >= 3 && (
                <polygon
                  points={draft.map(([x, y]) => `${x * W},${y * H}`).join(' ')}
                  style={{ strokeWidth: 0, opacity: 0.18 }}
                />
              )}
              {draft.map(([x, y], i) => (
                <circle
                  key={i}
                  className={`gmap__draft-v ${i === 0 ? 'gmap__draft-v--first' : ''}`}
                  cx={x * W}
                  cy={y * H}
                  r={(i === 0 ? DRAFT_R * 1.5 : DRAFT_R) * unit}
                  style={{ strokeWidth: 1.5 * unit, pointerEvents: i === 0 ? 'auto' : 'none' }}
                  onClick={(e) => {
                    // 点第一个顶点 = 收口
                    e.stopPropagation()
                    closeDraft()
                  }}
                >
                  {i === 0 && <title>点这里闭合</title>}
                </circle>
              ))}
            </g>
          )}

          {/* 点位 */}
          {map.pins.map((pin) => {
            const base = dragging?.id === pin.id ? dragging : null
            const ux = base ? base.x : pin.x
            const uy = base ? base.y : pin.y
            const info = entityOf(pin.entity_id)
            const ghost = Boolean(pin.entity_id) && info != null && !info.exists
            const isSel = selectedPinId === pin.id
            const isHot = hover === pin.id
            const dim = dimAll && !hitIds!.has(pin.id)
            const name = pinName(pin)
            const color = pin.color || (info?.type ? `var(--type-${info.type}, var(--accent))` : 'var(--accent)')
            const r = PIN_R * unit

            return (
              <g
                key={pin.id}
                data-pin={pin.id}
                transform={`translate(${ux * W},${uy * H})`}
                style={{
                  // 圈区域时点位让路，免得挡住顶点
                  cursor: drawingRegion ? 'crosshair' : placing ? 'crosshair' : 'pointer',
                  opacity: dim ? 0.25 : 1,
                  pointerEvents: drawingRegion ? 'none' : undefined,
                }}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  if (placing) return
                  ;(e.target as Element).setPointerCapture?.(e.pointerId)
                  setDragging({ id: pin.id, x: ux, y: uy })
                }}
                onPointerEnter={() => {
                  hoverRef.current = pin.id
                  setHover(pin.id)
                }}
                onPointerLeave={() => {
                  if (hoverRef.current === pin.id) {
                    hoverRef.current = null
                    setHover((h) => (h === pin.id ? null : h))
                  }
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  if (placing || drawingRegion) return
                  setDragging(null)
                  onSelectPin?.(pin.id)
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  onPinEdit?.(pin, { x: e.clientX, y: e.clientY })
                }}
              >
                {(isSel || isHot) && <circle className="gmap__halo" r={r * 2.1} />}
                <circle
                  className={`gmap__pin ${ghost ? 'gmap__pin--ghost' : ''}`}
                  r={r}
                  style={{
                    fill: ghost ? 'transparent' : color,
                    stroke: isSel ? 'var(--accent)' : 'var(--bg-app)',
                    strokeWidth: (isSel ? 2.5 : 1.5) * unit,
                  }}
                />
                {pin.portal && (() => {
                  // 记号必须说实话：往下钻 / 回外层 / 跨空间 是三种完全不同的动作，
                  // 原来都画 ⊞，点之前根本猜不到会发生什么。
                  const kind: PortalKind = portalKindOf?.(pin.portal) ?? 'side'
                  const meta = PORTAL_META[kind]
                  return (
                    <g
                      className={`gmap__portal gmap__portal--${kind}`}
                      transform={`translate(${r * 1.25},${-r * 1.25})`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        onPortal?.(pin.portal!)
                      }}
                    >
                      <title>{meta.hint}</title>
                      <circle r={PORTAL_R * unit} />
                      <text
                        textAnchor="middle"
                        dominantBaseline="central"
                        style={{ fontSize: PORTAL_R * 1.35 * unit }}
                      >
                        {meta.glyph}
                      </text>
                    </g>
                  )
                })()}
                <text
                  className="gmap__label"
                  y={r * 1.9 + LABEL_FS * 0.6 * unit}
                  textAnchor="middle"
                  style={{ fontSize: LABEL_FS * unit }}
                >
                  {name}
                </text>
              </g>
            )
          })}
        </g>
      </svg>

      <div className="gmap__tools">
        <button className="btn btn--sm" onClick={() => fitTo(W, H)} title="把整张图收进视野">
          适应窗口
        </button>
        <button className="btn btn--sm" onClick={() => setT((p) => ({ ...p, k: Math.min(8, p.k * 1.25) }))}>
          放大
        </button>
        <button className="btn btn--sm" onClick={() => setT((p) => ({ ...p, k: Math.max(0.05, p.k / 1.25) }))}>
          缩小
        </button>

        {onToggleRegionDraw && (
          <button
            className={`btn btn--sm ${drawingRegion ? 'btn--primary' : ''}`}
            onClick={onToggleRegionDraw}
            disabled={Boolean(placing)}
            title="在地图上圈一块面：国、州、山脉、势力范围都可以"
          >
            {drawingRegion ? '退出圈选' : '＋ 圈区域'}
          </button>
        )}
        {drawingRegion && draft.length > 0 && (
          <button className="btn btn--sm" onClick={popDraft} title="撤掉刚点的那个顶点">
            撤销一点
          </button>
        )}
        {drawingRegion && (
          <button
            className="btn btn--sm"
            disabled={draft.length < 3}
            onClick={() => closeDraft()}
            title={draft.length < 3 ? '至少要三个顶点才围得成面' : '闭合，存成一块区域'}
          >
            闭合成面
          </button>
        )}

        <span className="gmap__hint faint fs-xs">{hint}</span>
      </div>

      {placing && <div className="gmap__mode-tip">正在放「{placing.name}」—— 点图上位置即可</div>}
      {drawingRegion && !placing && (
        <div className="gmap__mode-tip">
          圈区域 · 已加 <b>{draft.length}</b> 个顶点
          {draft.length >= 3 ? '（可以闭合了）' : '（至少三个）'}
        </div>
      )}

      {broken && (
        <div className="gmap__broken">
          <b>底图读不到</b>
          <span className="fs-sm faint">
            素材 <span className="mono">{map.image}</span> 不在了。点位还在，重新传一张图即可继续。
          </span>
        </div>
      )}
    </div>
  )
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

function RegionShape({
  region,
  points,
  W,
  H,
  unit,
}: {
  region: MapRegion
  points: [number, number][]
  W: number
  H: number
  unit: number
}) {
  if (points.length < 3) return null
  const pts = points.map(([x, y]) => `${x * W},${y * H}`).join(' ')
  const fill = region.fill || 'var(--accent)'
  const cx = (points.reduce((s, p) => s + p[0], 0) / points.length) * W
  const cy = (points.reduce((s, p) => s + p[1], 0) / points.length) * H
  return (
    <>
      <polygon className="gmap__region-fill" points={pts} style={{ fill, opacity: region.opacity }} />
      <polygon className="gmap__region-line" points={pts} style={{ fill: 'none', stroke: fill, strokeWidth: 2 * unit }} />
      {region.name && (
        <text
          className="gmap__region-name"
          x={cx}
          y={cy}
          textAnchor="middle"
          dominantBaseline="central"
          style={{ fontSize: 15 * unit }}
        >
          {region.name}
        </text>
      )}
    </>
  )
}

export default MapCanvas
