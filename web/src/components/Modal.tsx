import { type ReactNode } from 'react'
import { useShortcuts } from '../lib/shortcuts'

interface Props {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  /** 再宽一档 —— 树形预览那类「左边名字右边判定」的内容用得着 */
  xwide?: boolean
}

export function Modal({ title, onClose, children, footer, wide = false, xwide = false }: Props) {
  // Esc 关弹窗走全局注册表（P11-A2）。优先级 200 —— 弹窗永远是最上面那一层，
  // 它在的时候 Esc 就该关它，而不是顺手把底下的图上选中也取消了。
  useShortcuts(
    [
      {
        id: 'modal.esc',
        keys: 'Esc',
        scope: 'global',
        desc: '关闭弹窗',
        priority: 200,
        run: () => onClose(),
      },
    ],
    [onClose],
  )

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`modal ${wide ? 'modal--wide' : ''} ${xwide ? 'modal--xwide' : ''}`}
        role="dialog"
        aria-modal="true"
      >
        <header className="modal__header">
          <div className="modal__title">{title}</div>
          <div className="grow" />
          <button className="btn btn--ghost btn--icon" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>
  )
}
