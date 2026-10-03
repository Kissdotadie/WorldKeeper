/**
 * 折叠区块的开合状态。
 *
 * 背景（用户 2026-10-04 反馈）：「设置、后台什么的里面，大家都是一长溜下去，
 * 没完没了」—— AdminView 一屏竖了十几个面板，AppearanceView 六个，
 * 全都要往下滚很久才能找到想要的那一块。改成统一的「限高区块 + 展开按钮」。
 *
 * 为什么状态放这儿而不是各页面 useState：
 *   ① 「全部展开 / 全部收起」要能一键广播到当前页所有区块，散在各页就广播不了；
 *   ② 开合是纯界面状态（和 WelcomeGuide 的 done 标记同一性质），
 *      不值得进偏好文件，落 localStorage 即可 —— 刷新后保持你上次的摆法；
 *   ③ 隐私模式下 localStorage 会抛异常，这里全部 try/catch 兜住，退化为「默认值」。
 *
 * 与 viewIntent 的区别：viewIntent 是「跨面板传一次话」，用完即弃；
 * 这里是「持久化的界面偏好」，要跨刷新记住。
 */

import { useSyncExternalStore } from 'react'

const PREFIX = 'wkv.section.'

/** 已验证过的开合状态（内存缓存）。让 getSnapshot 稳定返回同一个布尔值，避免重渲风暴。 */
const known = new Map<string, boolean>()
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

function persist(id: string, v: boolean) {
  try {
    localStorage.setItem(PREFIX + id, v ? '1' : '0')
  } catch {
    /* 隐私模式 / 禁用存储：本次会话内仍然生效，只是不跨刷新 */
  }
}

function readStored(id: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(PREFIX + id)
    if (raw === '1') return true
    if (raw === '0') return false
  } catch {
    /* 同上，忽略 */
  }
  return fallback
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function getOpen(id: string, fallback: boolean): boolean {
  const hit = known.get(id)
  if (hit !== undefined) return hit
  const v = readStored(id, fallback)
  known.set(id, v)
  return v
}

/** 单个区块的开合读写（给「点击标题行」用） */
export function setSectionOpen(id: string, v: boolean): void {
  if (known.get(id) === v) return
  known.set(id, v)
  persist(id, v)
  notify()
}

/**
 * 一键全部展开 / 全部收起。
 *
 * 只作用于**本次会话已经渲染过**的区块（`known` 里的那些）——
 * 还没被渲染的区块保持各自的默认值，等它出现时按默认走。
 * 这样不会把「从来没打开过的页面」也悄悄写成全收起。
 */
export function setAllSectionsOpen(v: boolean): void {
  let changed = false
  for (const id of [...known.keys()]) {
    if (known.get(id) !== v) {
      known.set(id, v)
      persist(id, v)
      changed = true
    }
  }
  if (changed) notify()
}

/** 抹掉所有记忆，回到默认（给「重置界面状态」用） */
export function forgetSections(): void {
  for (const id of [...known.keys()]) {
    try {
      localStorage.removeItem(PREFIX + id)
    } catch {
      /* 忽略 */
    }
  }
  known.clear()
  notify()
}

/** 非折叠面板用的哨兵 id —— 这些面板永远展开，不参与「全部展开/收起」 */
export const ALWAYS_OPEN = '\u0000always'

/**
 * 订阅某个区块的开合状态。
 *
 * @param id       区块标识（全局唯一，建议带页面前缀，如 `admin:index`）
 * @param fallback 没存过、也没点过时用哪个（默认展开）
 */
export function useSectionOpen(id: string, fallback = true): [boolean, (v: boolean) => void] {
  const open = useSyncExternalStore(
    subscribe,
    () => getOpen(id, fallback),
    () => fallback,
  )
  return [open, (v: boolean) => setSectionOpen(id, v)]
}
