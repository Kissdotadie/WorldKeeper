/**
 * 贴纸层（P5 9.3）—— 盖在图上面的那一层标记。
 *
 * 两个组件在这里：
 *   · `StickerLayer` —— 挂进图容器里的那层（渲染 + 拖拽/缩放/旋转）
 *   · `StickerPanel` —— 侧栏里的那个面板（挑素材、上传、进编辑态、清空）
 *
 * 一条性能上的要紧事：**拖动时不写 store**。
 *
 * 贴纸位置存在全局 store 里（理由见 store.tsx），但 store 一变，
 * 所有读它的面板都会重渲 —— 包括那张几百个节点的图。顺着手指每帧改一次 store，
 * 就等于每帧重画一次整张图。所以拖的时候只改这一层自己的**临时值**（`live`），
 * 松手才落一次。反正落盘本来就是防抖的，中间那些值谁都不需要。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '../state/store'
import * as api from '../api/client'
import { useShortcuts } from '../lib/shortcuts'
import type { Decoration } from '../graph/styles'
import {
  STICKER_BASE,
  sortedByZ,
  stickerSrc,
  useSceneStickers,
} from '../graph/useDecorations'

const MIN_SCALE = 0.2
const MAX_SCALE = 6

type Mode = 'move' | 'scale' | 'rotate'

/** 拖动过程中的临时值。松手才写进 store */
interface Live {
  id: string
  mode: Mode
  x: number
  y: number
  scale: number
  rot: number
  /** 按下那一刻：贴纸中心在图层坐标里的位置 */
  cx: number
  cy: number
  /** 按下那一刻：指针在图层坐标里的位置 */
  px: number
  py: number
  /** 按下那一刻的原始尺寸与角度，缩放/旋转都按它算增量 */
  scale0: number
  rot0: number
  /** 按下那一刻，指针相对中心的距离与角度 */
  dist0: number
  ang0: number
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export interface StickerLayerProps {
  sceneKey: string
  /** 编辑态：开着才能拖。关着的时候整层是「看得见但点不着」 */
  editing: boolean
  onSelectedChange?: (id: string | null) => void
}

export function StickerLayer({ sceneKey, editing, onSelectedChange }: StickerLayerProps) {
  const { items, update, remove, reorder } = useSceneStickers(sceneKey)
  const layerRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [live, setLive] = useState<Live | null>(null)

  useEffect(() => {
    onSelectedChange?.(selected)
  }, [selected, onSelectedChange])

  // 选中被删掉 / 换视图之后，别留着一个指向空气的选中态
  useEffect(() => {
    if (selected && !items.some((d) => d.id === selected)) setSelected(null)
  }, [items, selected])

  const pick = (id: string | null) => setSelected(id)

  const local = (e: React.PointerEvent) => {
    const rect = layerRef.current?.getBoundingClientRect()
    return rect
      ? { px: e.clientX - rect.left, py: e.clientY - rect.top }
      : { px: 0, py: 0 }
  }

  const begin = (e: React.PointerEvent, d: Decoration, mode: Mode) => {
    if (!editing) return
    e.stopPropagation()
    e.preventDefault()
    pick(d.id)
    // 锁定只锁「位置」：缩放、旋转、透明度、层级照旧能动 ——
    // 锁的是别被手滑挪走，不是把这张贴纸变成死物
    if (d.locked && mode === 'move') return
    const { px, py } = local(e)
    // 合成事件（自动化测试、某些触控驱动）给的 pointerId 捕获不到，别让它炸掉整个拖动
    try {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    } catch {
      /* 捕获不到就靠 pointermove 继续跟，功能不受影响 */
    }
    setLive({
      id: d.id,
      mode,
      x: d.x,
      y: d.y,
      scale: d.scale,
      rot: d.rot,
      cx: d.x,
      cy: d.y,
      px,
      py,
      scale0: d.scale,
      rot0: d.rot,
      dist0: Math.max(1, Math.hypot(px - d.x, py - d.y)),
      ang0: (Math.atan2(py - d.y, px - d.x) * 180) / Math.PI,
    })
  }

  const move = (e: React.PointerEvent, d: Decoration) => {
    if (!live || live.id !== d.id) return
    const { px, py } = local(e)
    if (live.mode === 'move') {
      setLive({ ...live, x: live.cx + (px - live.px), y: live.cy + (py - live.py) })
    } else if (live.mode === 'scale') {
      // 按「指针到中心的距离」等比例缩放：不用管手柄本身在哪儿，手感更稳
      const dist = Math.hypot(px - live.cx, py - live.cy)
      setLive({ ...live, scale: clamp((live.scale0 * dist) / live.dist0, MIN_SCALE, MAX_SCALE) })
    } else {
      const ang = (Math.atan2(py - live.cy, px - live.cx) * 180) / Math.PI
      // Shift 吸附到 15° 一档，摆正的时候省事
      const raw = live.rot0 + (ang - live.ang0)
      setLive({ ...live, rot: e.shiftKey ? Math.round(raw / 15) * 15 : raw })
    }
  }

  const end = () => {
    if (!live) return
    update(live.id, { x: live.x, y: live.y, scale: live.scale, rot: live.rot })
    setLive(null)
  }

  // Delete 删掉选中的那张（P11-A2：走全局注册表）。
  // 不带修饰键的键在输入框里默认不触发，所以这里不必再自己判 INPUT/TEXTAREA ——
  // 注册表已经拦掉了，而且拦得更全（contentEditable 也算）。
  useShortcuts(
    [
      {
        id: 'sticker.delete',
        keys: 'Delete',
        scope: 'global',
        desc: '删除选中的贴纸',
        when: () => editing && Boolean(selected),
        run: (e) => {
          e.preventDefault()
          if (!selected) return
          remove(selected)
          setSelected(null)
        },
      },
      {
        id: 'sticker.delete.backspace',
        keys: 'Backspace',
        scope: 'global',
        desc: '删除选中的贴纸（同 Delete）',
        when: () => editing && Boolean(selected),
        run: (e) => {
          e.preventDefault()
          if (!selected) return
          remove(selected)
          setSelected(null)
        },
      },
    ],
    [editing, selected, remove],
  )

  const sel = selected ? items.find((d) => d.id === selected) ?? null : null

  return (
    <div
      ref={layerRef}
      className={`sticker-layer ${editing ? 'sticker-layer--edit' : ''}`}
      // 编辑态下空白处点击 = 取消选中。图层本身仍是 pointer-events:none，
      // 所以这一点击不会挡住图的平移 —— 只有贴纸本身接得住指针
      onPointerDown={() => pick(null)}
    >
      {sortedByZ(items).map((d) => {
        const isLive = live?.id === d.id
        const x = isLive ? live!.x : d.x
        const y = isLive ? live!.y : d.y
        const scale = isLive ? live!.scale : d.scale
        const rot = isLive ? live!.rot : d.rot
        const w = STICKER_BASE * scale
        const on = selected === d.id
        return (
          <div
            key={d.id}
            className={`sticker ${on && editing ? 'sticker--on' : ''} ${
              d.locked ? 'sticker--locked' : ''
            }`}
            style={{
              left: x,
              top: y,
              width: w,
              height: w,
              zIndex: d.z ?? 0,
              opacity: d.opacity,
              transform: `translate(-50%, -50%) rotate(${rot}deg)`,
              pointerEvents: editing ? 'auto' : 'none',
              cursor: editing ? (d.locked ? 'not-allowed' : 'grab') : 'default',
            }}
            onPointerDown={(e) => begin(e, d, 'move')}
            onPointerMove={(e) => move(e, d)}
            onPointerUp={end}
            onPointerCancel={end}
          >
            <img
              src={stickerSrc(d.asset)}
              alt={d.asset}
              draggable={false}
              style={{ transform: d.flip ? 'scaleX(-1)' : undefined }}
            />
            {on && editing && !d.locked && (
              <>
                {/* 右下角：缩放。左上角留给拖动 */}
                <span
                  className="sticker__h sticker__h--scale"
                  title="拖动缩放"
                  onPointerDown={(e) => begin(e, d, 'scale')}
                  onPointerMove={(e) => move(e, d)}
                  onPointerUp={end}
                  onPointerCancel={end}
                />
                {/* 正上方：旋转 */}
                <span
                  className="sticker__h sticker__h--rot"
                  title="拖动旋转（按住 Shift 吸附 15°）"
                  onPointerDown={(e) => begin(e, d, 'rotate')}
                  onPointerMove={(e) => move(e, d)}
                  onPointerUp={end}
                  onPointerCancel={end}
                />
              </>
            )}
          </div>
        )
      })}

      {/* 选中那张的小工具条。放在层左下角而不是贴着贴纸 ——
          贴着贴纸会随旋转跑到奇怪的地方，还可能飘出图外点不着 */}
      {editing && sel && (
        <div className="sticker-bar" onPointerDown={(e) => e.stopPropagation()}>
          <span className="faint fs-xs">透明度</span>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={sel.opacity}
            onChange={(e) => update(sel.id, { opacity: Number(e.target.value) })}
            style={{ width: 72 }}
          />
          <button className="btn btn--ghost btn--sm" onClick={() => reorder(sel.id, 'front')} title="抬到最上层">
            上移一层
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => reorder(sel.id, 'back')} title="压到最下层">
            下移一层
          </button>
          <button
            className={`btn btn--ghost btn--sm ${sel.flip ? 'btn--on' : ''}`}
            onClick={() => update(sel.id, { flip: !sel.flip })}
            title="水平翻转"
          >
            ⇄
          </button>
          <button
            className={`btn btn--ghost btn--sm ${sel.locked ? 'btn--on' : ''}`}
            onClick={() => update(sel.id, { locked: !sel.locked })}
            title={sel.locked ? '解锁：可以拖了' : '锁定位置：只留缩放旋转与透明度'}
          >
            {sel.locked ? '🔒' : '🔓'}
          </button>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => {
              remove(sel.id)
              setSelected(null)
            }}
            title="删掉这一张"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}

export interface StickerPanelProps {
  sceneKey: string
  editing: boolean
  onEditingChange: (v: boolean) => void
  /** 一句话说明这个视图的贴纸用在哪，例如「标在地图上的势力范围」 */
  hint?: string
}

/**
 * 侧栏里的贴纸面板：挑素材、上传、进退编辑态。
 *
 * 素材全部来自素材库的 `stickers` 一类 —— 和「节点图标（icons）」分开，
 * 因为用途不同：图标是「这个实体长什么样」，贴纸是「我在这张图上贴了个东西」。
 */
export function StickerPanel({ sceneKey, editing, onEditingChange, hint }: StickerPanelProps) {
  const { assets, notify, reloadAppearance } = useApp()
  const { items, add, clear } = useSceneStickers(sceneKey)
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const stickers = assets?.assets?.stickers ?? []

  const upload = useCallback(
    async (file: File) => {
      setBusy(true)
      try {
        const item = await api.uploadAsset('stickers', file)
        await reloadAppearance()
        // 素材的存档格式是「类别/文件名」（icons/x.png、stickers/x.png），
        // assetUrlOf 靠斜杠分段找目录 —— 漏了前缀就会请求到不存在的地址
        add(`stickers/${item.name}`)
        notify('ok', `已上传并贴上「${item.name}」`)
      } catch (e) {
        notify('err', `上传失败：${(e as Error).message}`)
      } finally {
        setBusy(false)
      }
    },
    [add, notify, reloadAppearance],
  )

  return (
    <>
      <div className="row row--wrap" style={{ gap: 6, marginBottom: 8 }}>
        <button
          className={`btn btn--sm ${editing ? 'btn--primary' : ''}`}
          onClick={() => onEditingChange(!editing)}
        >
          {editing ? '结束编辑' : '贴纸编辑'}
        </button>
        {items.length > 0 && (
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => {
              clear()
              notify('ok', '这个视图的贴纸已清空')
            }}
            title="只清本视图，别的视图贴的还在"
          >
            清空（{items.length}）
          </button>
        )}
        <label className="btn btn--ghost btn--sm" title="上传一张图进素材库，并直接贴上来">
          {busy ? '上传中…' : '上传'}
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
      </div>

      {stickers.length === 0 ? (
        <p className="faint fs-xs" style={{ lineHeight: 1.7 }}>
          素材库里还没有贴纸。点上面「上传」丢一张图进来 —— 素材统一收在
          <span className="mono"> data/assets/stickers/</span>，和实体数据分开存。
        </p>
      ) : (
        <div className="sticker-pick">
          {stickers.map((s) => (
            <button
              key={s.name}
              className="sticker-pick__item"
              title={`贴一张「${s.stem}」`}
              onClick={() => {
                add(`stickers/${s.name}`)
                if (!editing) onEditingChange(true)
                notify('info', `贴上了「${s.stem}」——拖动摆位置，右下角拖大小`)
              }}
            >
              <img src={s.url} alt={s.stem} draggable={false} />
            </button>
          ))}
        </div>
      )}

      <p className="faint fs-xs" style={{ marginTop: 8, lineHeight: 1.7 }}>
        {hint ? `${hint}。` : ''}
        位置按<strong>屏幕</strong>记，不跟图缩放走 —— 所以换个布局，贴纸还在原来的地方。
        存 <span className="mono">view/decorations.json</span>，和实体档案物理隔离。
      </p>
    </>
  )
}

export default StickerLayer
