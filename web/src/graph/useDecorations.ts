/**
 * 贴纸（P5 9.3）—— 一层纯函数 + 一个接 store 的 hook。
 *
 * 三条定位上的规定，写在这里免得后来改乱：
 *
 * 1. **贴纸是装饰，不是内容。** 它存在 `view/decorations.json` 里，
 *    和 `entities/` 一个字都不挨着。删掉这个文件，最多图上的标记没了。
 *
 * 2. **坐标是「视图坐标」**（相对图容器左上角的像素），不是数据坐标。
 *    贴纸的意思是「我在这一屏的这个地方做了个标记」—— 跟着图缩放没有意义，
 *    按屏幕定位才能保证「换个布局它还在原来的位置」。
 *
 * 3. **按视图分区**。关系网上贴的和世界观上贴的是两回事，键就是各自的分区名
 *    （relation / catalog-xxx / meth-3d…），和 `view/scene.json`、`view/maps/` 同一套。
 */

import { useMemo } from 'react'
import { useApp } from '../state/store'
import { assetUrlOf } from '../api/client'
import type { Decoration } from './styles'

/** 贴纸的默认大小（像素，指原始宽度）。缩放倍率乘在它上面 */
export const STICKER_BASE = 96

export function nextZ(items: Decoration[]): number {
  return items.reduce((m, d) => Math.max(m, d.z ?? 0), 0) + 1
}

/**
 * 造一张新贴纸。
 *
 * 落点**叠着往外错**（第 n 张右移下移一点）而不是全堆正中间：
 * 连点几下加三张，堆在一起就只看得见最上面那张，像没加上。
 */
export function makeSticker(asset: string, index: number, z: number): Decoration {
  return {
    id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    asset,
    x: 48 + (index % 6) * 26,
    y: 40 + (index % 6) * 22,
    scale: 1,
    rot: 0,
    opacity: 1,
    z,
    locked: false,
  }
}

/** 素材相对路径 → 能直接塞进 `<img src>` 的 URL */
export function stickerSrc(asset: string): string {
  return assetUrlOf(asset)
}

/** 按 z 从小到大排好 —— 先画的在下面，大的压在上面 */
export function sortedByZ(items: Decoration[]): Decoration[] {
  return [...items].sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
}

export interface SceneStickers {
  items: Decoration[]
  add: (asset: string) => Decoration | null
  update: (id: string, patch: Partial<Decoration>) => void
  remove: (id: string) => void
  /** 换个层级：`front` 抬到最上面，`back` 压到最下面 */
  reorder: (id: string, dir: 'front' | 'back') => void
  clear: () => void
}

/**
 * 某个视图的贴纸读写。
 *
 * 面板与图层**各调一次这个 hook 也没关系** —— 它自己不存东西，
 * 读写都落在 store 里那一份（这正是「同一个东西别持两份状态」）。
 * 各自持一份的话，面板里加一张、图层里看到的还是旧的。
 */
export function useSceneStickers(sceneKey: string): SceneStickers {
  const { decorations, setSceneDecorations } = useApp()
  const items = decorations[sceneKey] ?? []

  return useMemo<SceneStickers>(
    () => ({
      items,
      add: (asset) => {
        const made = makeSticker(asset, items.length, nextZ(items))
        setSceneDecorations(sceneKey, (cur) => [...cur, made])
        return made
      },
      update: (id, patch) =>
        setSceneDecorations(sceneKey, (cur) =>
          cur.map((d) => (d.id === id ? { ...d, ...patch } : d)),
        ),
      remove: (id) => setSceneDecorations(sceneKey, (cur) => cur.filter((d) => d.id !== id)),
      reorder: (id, dir) =>
        setSceneDecorations(sceneKey, (cur) => {
          const zs = cur.map((d) => d.z ?? 0)
          const z = dir === 'front' ? Math.max(...zs, 0) + 1 : Math.min(...zs, 0) - 1
          return cur.map((d) => (d.id === id ? { ...d, z } : d))
        }),
      clear: () => setSceneDecorations(sceneKey, []),
    }),
    [items, sceneKey, setSceneDecorations],
  )
}
