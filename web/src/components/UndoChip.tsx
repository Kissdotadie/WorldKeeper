/**
 * 顶栏的撤销 / 重做小控件（P11-A1）。
 *
 * 为什么要有它：快捷键是隐形的 —— 不点出来，用户根本不知道「刚才那一步能撤」。
 * 这个控件同时承担三件事：
 *   ① 让能力**看得见**（有东西可撤时才出现，撤完就淡下去）；
 *   ② 把**要撤的是哪一步**写在 `title` 和悬停提示里（撤销最怕撤错东西）；
 *   ③ 给不想记快捷键的人一条可点的路。
 *
 * 单独放一个文件而不并进快捷表里：顶栏是首屏的一部分，这里只依赖一个很轻的
 * context，不能把重东西带进首屏包（同 JobChip 的理由）。
 */

import { useUndo } from '../state/undo'

export function UndoChip() {
  const { canUndo, canRedo, undoLabel, redoLabel, undo, redo } = useUndo()
  // 没得撤也没得重做 → 整个控件不出现（空控件比没有更碍眼）
  if (!canUndo && !canRedo) return null
  return (
    <div className="undochip">
      <button
        className="undochip__btn"
        disabled={!canUndo}
        title={canUndo ? `撤销：${undoLabel}（Ctrl+Z）` : '没有可撤销的改动了'}
        aria-label="撤销"
        onClick={() => void undo()}
      >
        <span aria-hidden>↶</span>
        <span className="undochip__txt ellipsis">{undoLabel ?? '撤销'}</span>
      </button>
      <button
        className="undochip__btn undochip__btn--quiet"
        disabled={!canRedo}
        title={canRedo ? `重做：${redoLabel}（Ctrl+Shift+Z / Ctrl+Y）` : '没有可重做的'}
        aria-label="重做"
        onClick={() => void redo()}
      >
        <span aria-hidden>↷</span>
      </button>
    </div>
  )
}
