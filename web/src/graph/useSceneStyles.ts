/**
 * 三维外观 —— 所有「图」共用的那一套视图装饰。
 *
 * **存哪**：`view/scene.json` 的 `styles` 段。**一份全局的，不分图** ——
 * 「辉光」「节点疏密」「按类型换图标」本来就是你给这套书定的观感：
 * 在关系网里调好了，世界观没道理又变成另一个样子。
 *
 * **和 `graphs` 段的区别**：`graphs[<key>].positions` 是**每张图各自**的锁定坐标
 * （每张图的形状本来就不一样），所以「重新排版」只作废当前这张图的坐标，
 * 不会把别的图也搅乱。
 *
 * **为什么抽出来**：原来只有关系网有这么一整套控制，世界观/地理观的三维全景
 * 光秃秃的、时间线更是什么都没有。拷贝第二遍就意味着以后每加一个外观选项
 * 都要改三处，而且三处迟早会长歪。
 *
 * ⚠️ 铁律：这里写的一切都只进 `scene.json`，**绝不碰 `entities/`** ——
 * 「这个实体长什么样」是内容，「这张图上的节点画成什么形状」是装饰。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../api/client'
import type { AssetItem } from '../api/types'
import { useToast } from '../state/store'
import type { Spacing } from './Graph3D'

export interface SceneStylesApi {
  /** 类型 key → 素材库相对路径，如 `icons/character.png` */
  typeIcons: Record<string, string>
  glow: boolean
  spacing: Spacing
  /** 素材库里的图标，供下拉选 */
  icons: AssetItem[]
  /** 布局令牌：+1 就让图按当前参数重跑一次模拟 */
  layoutToken: number

  setGlow: (v: boolean) => void
  setTypeIcon: (typeKey: string, ref: string) => void
  uploadIcon: (typeKey: string, file: File) => Promise<void>
  refreshIcons: () => void
  /**
   * 重新排版：先作废这张图的锁定坐标，再让图重跑一次模拟。
   * 不传 `nextSpacing` 就是按当前疏密重排。
   */
  relayout: (sceneKey: string, nextSpacing?: Spacing) => Promise<void>
}

export function useSceneStyles(bookId: string | null): SceneStylesApi {
  const { notify } = useToast()
  const [typeIcons, setTypeIcons] = useState<Record<string, string>>({})
  // 辉光**默认关**（P4.5.5）。原来默认开着，理由是「好看」，但那是一次典型的
  // 喧宾夺主：unreal bloom 是每帧好几遍的后处理，2K 屏上直接把 GPU 喂满，
  // 而这个工具是给你看设定的，不是给你看特效的。想开随时能开，选择权在你。
  const [glow, setGlowState] = useState(false)
  const [spacing, setSpacingState] = useState<Spacing>('normal')
  const [icons, setIcons] = useState<AssetItem[]>([])
  const [layoutToken, setLayoutToken] = useState(0)

  // setTypeIcon 要读「当前那份」再改：放 setState 回调里写盘会被 StrictMode 跑两遍
  const iconsRef = useRef(typeIcons)
  iconsRef.current = typeIcons

  const refreshIcons = useCallback(() => {
    api
      .listAssets()
      .then((r) => setIcons(r.assets.icons ?? []))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!bookId) return
    api
      .getScene(bookId)
      .then((r) => {
        const st = r.scene?.styles
        if (st?.typeIcons) setTypeIcons(st.typeIcons)
        if (typeof st?.glow === 'boolean') setGlowState(st.glow)
        if (st?.spacing) setSpacingState(st.spacing)
      })
      .catch(() => undefined)
    refreshIcons()
  }, [bookId, refreshIcons])

  /** 落盘失败只提示、不改内存 —— 界面别因为存不上就跟着抖 */
  const persist = useCallback(
    async (patch: { typeIcons?: Record<string, string>; glow?: boolean; spacing?: Spacing }) => {
      if (!bookId) return
      try {
        const cur = await api.getScene(bookId)
        const scene = cur.scene ?? {}
        await api.saveScene(bookId, {
          ...scene,
          styles: { ...(scene.styles ?? {}), ...patch },
        })
      } catch (e) {
        notify('err', `视图样式没存上：${(e as Error).message}`)
      }
    },
    [bookId, notify],
  )

  const setGlow = useCallback(
    (v: boolean) => {
      setGlowState(v)
      void persist({ glow: v })
    },
    [persist],
  )

  const setTypeIcon = useCallback(
    (typeKey: string, ref: string) => {
      const next = { ...iconsRef.current }
      if (ref) next[typeKey] = ref
      else delete next[typeKey]
      setTypeIcons(next)
      void persist({ typeIcons: next })
    },
    [persist],
  )

  const uploadIcon = useCallback(
    async (typeKey: string, file: File) => {
      try {
        const item = await api.uploadAsset('icons', file)
        refreshIcons()
        setTypeIcon(typeKey, `icons/${item.name}`)
        notify('ok', `已上传 ${item.name}，并套到这一类的节点上`)
      } catch (e) {
        notify('err', `上传失败：${(e as Error).message}`)
      }
    },
    [refreshIcons, setTypeIcon, notify],
  )

  const relayout = useCallback(
    async (sceneKey: string, nextSpacing?: Spacing) => {
      if (!bookId) return
      try {
        await api.clearSceneGraph(bookId, sceneKey)
      } catch {
        /* 本来就没锁过坐标，直接重排即可 */
      }
      if (nextSpacing) {
        setSpacingState(nextSpacing)
        void persist({ spacing: nextSpacing })
      }
      setLayoutToken((t) => t + 1)
    },
    [bookId, persist],
  )

  return {
    typeIcons,
    glow,
    spacing,
    icons,
    layoutToken,
    setGlow,
    setTypeIcon,
    uploadIcon,
    refreshIcons,
    relayout,
  }
}

export default useSceneStyles
