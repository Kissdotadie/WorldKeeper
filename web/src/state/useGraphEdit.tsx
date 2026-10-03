/**
 * 图上就地编辑的接线层。
 *
 * 分工：图组件只管「把事件和坐标抛出来」，这里管弹浮层、调接口、刷新数据。
 * 于是关系网、世界观、地理观各接两三行即可 —— 编辑能力不散在四个视图里。
 */

import { useMemo, useState } from 'react'
import { GraphEditPopover, type GraphEditTarget } from '../components/GraphEditPopover'
import { useUndo } from './undo'
import type { TypeOption } from '../api/types'

export interface ScreenPt {
  x: number
  y: number
}

export interface WorldPt {
  x: number
  y: number
  z: number
}

/** 图组件需要的那组 props —— 直接展开到 <Graph2D /> / <Graph3D /> 上 */
export interface GraphEditProps {
  /** 就地编辑开关（P11-2️⃣①）。默认开 */
  editable: boolean
  onToggleEditable: (next: boolean) => void
  linkMode: boolean
  onNodeEdit: (id: string, name: string, screen: ScreenPt, nearType?: string) => void
  onCanvasEdit: (screen: ScreenPt, world?: WorldPt, nearType?: string) => void
  onLink: (
    fromId: string,
    fromName: string,
    toId: string,
    toName: string,
    screen: ScreenPt,
  ) => void
  /** 拖完一个节点（P11-A1）：报给撤销栈，撤销 = 放回原处。图组件不传就完全不记录。 */
  onNodeDropped?: (
    id: string,
    to: WorldPt,
    from: WorldPt | null,
  ) => void
}

interface Options {
  bookId: string | null
  types: TypeOption[]
  /** scene.json 里这本图的分区键（relation / world / geo…）—— 撤销坐标时要指到具体哪张图 */
  sceneKey?: string
  /** 数据变了（新建或改动落盘后）：视图重新拉图 */
  onChanged: (id?: string, world?: WorldPt) => void
  onOpenDetail?: (id: string) => void
}

export function useGraphEdit({ bookId, types, sceneKey, onChanged, onOpenDetail }: Options) {
  const [target, setTarget] = useState<GraphEditTarget | null>(null)
  const [linkMode, setLinkMode] = useState(false)
  // 编辑开关（P11-2️⃣①）。**默认开**：以前编辑是常开的，改成默认关会让
  // 老用户觉得「功能没了」；这里只是把它从隐形变成明面上的两态开关。
  const [editable, setEditable] = useState(true)
  const { recordNodePosition } = useUndo()

  const toggleEditable = useMemo(
    () => (next: boolean) => {
      setEditable(next)
      // 切到浏览态时顺手退掉连线模式与半截浮层 ——
      // 否则「浏览」了却还挂着一根连线草稿，很莫名其妙
      if (!next) {
        setLinkMode(false)
        setTarget(null)
      }
    },
    [],
  )

  const graphProps = useMemo<GraphEditProps>(
    () => ({
      editable,
      onToggleEditable: toggleEditable,
      linkMode,
      onNodeEdit: (id, name, screen) => setTarget({ kind: 'node', entityId: id, entityName: name, screen }),
      onCanvasEdit: (screen, world, nearType) =>
        setTarget({ kind: 'blank', screen, world, defaultType: nearType }),
      onLink: (fromId, fromName, toId, toName, screen) =>
        setTarget({ kind: 'link', entityId: fromId, entityName: fromName, toId, toName, screen }),
      // 拖完节点 → 记一步「挪动」到撤销栈（连着拖同一个节点会在栈里合并成一步）
      onNodeDropped: (id, to, from) => {
        if (!bookId || !sceneKey) return
        recordNodePosition({ bookId, sceneKey, nodeId: id, before: from, after: to })
      },
    }),
    [linkMode, editable, toggleEditable, bookId, sceneKey, recordNodePosition],
  )

  // 连线模式是「一次性动作」，连完自动关掉，免得下次拖节点又变成连线
  const closeAll = () => {
    setTarget(null)
    setLinkMode(false)
  }

  const layer =
    target && bookId ? (
      <GraphEditPopover
        bookId={bookId}
        target={target}
        types={types}
        onClose={() => setTarget(null)}
        onOpenDetail={onOpenDetail}
        onSaved={(id, world) => {
          onChanged(id, world)
          closeAll()
        }}
        // 删关联：只刷新图，浮层留着 —— 剪枝是连续动作，不要每删一条都重开
        onChanged={(id) => onChanged(id)}
      />
    ) : null

  return { target, linkMode, setLinkMode, editable, setEditable: toggleEditable, graphProps, layer, closeAll }
}
