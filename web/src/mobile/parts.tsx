/** 移动端共用的小零件。都是纯展示，不含业务。 */

import type { ReactNode } from 'react'
import type { TypeOption } from '../api/types'

/**
 * 类型 chip：小圆点 + 类型名。
 *
 * 颜色不在这里算 —— 挂 `data-entity-type` 属性，
 * 由 tokens.css 里那条 `[data-entity-type='x'] { --type-color: ... }` 统一给，
 * 和 PC 端走同一套映射，将来加类型只改一处。
 */
export function TypeChip({ type, label }: { type: string; label?: string }) {
  return (
    <span className="mchip" data-entity-type={type}>
      <i className="mchip__dot" />
      {label ?? type}
    </span>
  )
}

export function Empty({ icon, title, hint }: { icon?: string; title: string; hint?: string }) {
  return (
    <div className="mempty">
      {icon && <div className="mempty__icon">{icon}</div>}
      <div className="mempty__title">{title}</div>
      {hint && <div className="mempty__hint">{hint}</div>}
    </div>
  )
}

export function Loading({ text = '读取中……' }: { text?: string }) {
  return <div className="mload">{text}</div>
}

export function ErrBox({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="merr">
      <div className="merr__text">{text}</div>
      {onRetry && (
        <button className="mbtn mbtn--ghost" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  )
}

/** 分节标题。 */
export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="msec">
      <span className="msec__t">{children}</span>
      {right && <span className="msec__r">{right}</span>}
    </div>
  )
}

/** 类型 key → 显示名。名称可在「设置 → 类型显示名」里改，所以不能写死。 */
export function labelerOf(types: TypeOption[]): (type: string) => string {
  const map = new Map(types.map((t) => [t.key, t.label]))
  return (type: string) => map.get(type) ?? type
}

/** 把 `[[双链]]` 文本拆成可点的段落 —— 移动端只做展示，不做编辑。 */
export function linkify(
  text: string,
  onPick: (name: string) => void,
  keyPrefix = '',
): ReactNode[] {
  const out: ReactNode[] = []
  const re = /\[\[([^[\]]+)\]\]/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const name = m[1].trim()
    out.push(
      <button
        key={`${keyPrefix}${i++}`}
        className="mlink"
        onClick={() => onPick(name)}
        type="button"
      >
        {name}
      </button>,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
