/**
 * 「这张图能直接改」的一次性引导（P11-2️⃣①）。
 *
 * 为什么需要：图上就地编辑（双击改名、双击空白新建、拖节点连线）P4 就做好了，
 * 但界面几乎没提示，用户根本不知道有这回事 —— 功能在，等于没有。
 *
 * 只在**第一次**打开带图的视图时弹一次，看到就记住。用 localStorage 而不是
 * 数据目录：这是「本机这个人看没看过」的界面状态，不该跟着知识库走，
 * 也不该进快照/备份（与「索引零独占状态」同一条理由）。
 */

const KEY = 'wkv.graphGuide.v1'

export function hasSeenGraphGuide(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1'
  } catch {
    // 隐私模式等禁止 localStorage：当作看过了，免得每次进来都弹
    return true
  }
}

export function markGraphGuideSeen(): void {
  try {
    window.localStorage.setItem(KEY, '1')
  } catch {
    /* 存不进去就算了，不是关键路径 */
  }
}

/** 调试用：`__wkvGraphGuideReset()` 让引导重新弹一次 */
export function resetGraphGuide(): void {
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    /* 同上 */
  }
}
