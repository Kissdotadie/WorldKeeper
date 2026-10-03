/** 自定义类型的动态类型色注入（P7.6）。
 *
 * tokens.css 只静态定义了内置 8 类的 `--type-*` 变量与
 * `[data-entity-type]` 映射。自定义类型的颜色是**按书配置**的
 * （book.yaml custom_types），只能运行时注入一段 <style>。
 *
 * 两件事都要做，缺一不可：
 * 1. `:root { --type-<key>: <色> }` —— 图谱节点、图表取色走 `var(--type-<key>)`
 * 2. `[data-entity-type='<key>'] { --type-color: <色> }` —— 卡片/chip 的
 *    `--type-color` 管线靠这条映射，内置类型在 tokens.css 里有、自定义的没有
 *
 * store 的 `types`（来自 listEntities 的 type_options）已带自定义类型的 color。
 */

import { useMemo } from 'react'
import { useApp } from '../state/store'

export function TypeColorStyle() {
  const { types } = useApp()
  const css = useMemo(() => {
    const custom = types.filter((t) => t.color)
    if (!custom.length) return ''
    const root = custom.map((t) => `--type-${t.key}:${t.color}`).join(';')
    const scoped = custom
      .map((t) => `[data-entity-type='${t.key}']{--type-color:${t.color}}`)
      .join('')
    return `:root{${root}}${scoped}`
  }, [types])
  if (!css) return null
  return <style>{css}</style>
}

export default TypeColorStyle
