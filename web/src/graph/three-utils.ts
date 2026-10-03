/** 3D 组件共用的小工具。 */
import * as THREE from 'three'

export const FONT_STACK = '"Noto Sans SC", system-ui, -apple-system, sans-serif'

/** 把 CSS 变量解析成 WebGL 能用的色值（var() 在 canvas/three 里不生效） */
export function cssColor(varName: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return v || fallback
}

/** 类型 → 主题色变量解析成实际色值 */
export function typeColor(type: string): string {
  if (!type) return cssColor('--text-faint', '#6b7280')
  return cssColor(`--type-${type}`, cssColor('--text-muted', '#9ca3af'))
}

/** 文字精灵：字号给足 + 圆角底衬，远了糊不了、压在亮节点上也读得清 */
export function makeLabel(
  text: string,
  color: string,
  worldHeight: number,
): THREE.Sprite {
  const font = 56
  const padX = 18
  const padY = 12
  const probe = document.createElement('canvas').getContext('2d')!
  probe.font = `600 ${font}px ${FONT_STACK}`
  const width = Math.ceil(probe.measureText(text).width) + padX * 2

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = font + padY * 2
  const ctx = canvas.getContext('2d')!
  const h = canvas.height

  const rr = h / 2
  ctx.fillStyle = 'rgba(10,12,18,0.42)'
  ctx.beginPath()
  ctx.moveTo(rr, 0)
  ctx.arcTo(width, 0, width, h, rr)
  ctx.arcTo(width, h, 0, h, rr)
  ctx.arcTo(0, h, 0, 0, rr)
  ctx.arcTo(0, 0, width, 0, rr)
  ctx.closePath()
  ctx.fill()

  ctx.font = `600 ${font}px ${FONT_STACK}`
  ctx.fillStyle = color
  ctx.textBaseline = 'middle'
  ctx.fillText(text, padX, h / 2 + 2)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }),
  )
  const scale = worldHeight / h
  sprite.scale.set(width * scale, h * scale, 1)
  return sprite
}
