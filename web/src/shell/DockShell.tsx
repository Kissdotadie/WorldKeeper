/**
 * dockview 的薄壳。
 *
 * 这里刻意什么都不做 —— 不订阅业务状态、不持有布局逻辑，只把「就绪」这一个事件转出去。
 * 布局变化、活动面板变化都在 `App.tsx` 里通过 api 订阅，
 * 这样将来换布局引擎（或者做 P4 的三维工作台）时要改的只有两个文件。
 */

import { DockviewReact, type DockviewReadyEvent } from 'dockview'
import 'dockview/dist/styles/dockview.css'
import { PANEL_COMPONENTS } from './panels'

export function DockShell({ onReady }: { onReady: (event: DockviewReadyEvent) => void }) {
  return (
    <DockviewReact
      className="dock"
      components={PANEL_COMPONENTS}
      onReady={onReady}
      // 拖到面板边缘就拆出新格；默认阈值要拖很远才触发，调小一点
      dndEdges={{ size: { value: 120, type: 'pixels' } }}
      singleTabMode="fullwidth"
    />
  )
}

export default DockShell
