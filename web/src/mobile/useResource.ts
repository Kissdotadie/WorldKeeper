/**
 * 带内存缓存的只读数据钩子。
 *
 * 移动端每个标签页都是「进页面 → 拉数据」，来回切标签会把同一份时间线
 * 反复拉好几遍。缓存键带上 book_id，换书自然失效。
 *
 * 刻意不做失效通知：这一层是只读界面，PC 端改了数据、手机端下拉刷新一下
 * 就是最符合直觉的同步方式（`reload` 丢掉缓存重拉）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const cache = new Map<string, unknown>()

/** 整本书的数据都变了（比如 PC 端重建了索引）时手动清一下。 */
export function clearResourceCache(): void {
  cache.clear()
}

export interface Resource<T> {
  data: T | null
  error: string | null
  loading: boolean
  /** 丢掉缓存重拉 —— 下拉刷新走它 */
  reload: () => void
}

export function useResource<T>(key: string | null, load: () => Promise<T>): Resource<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [tick, setTick] = useState(0)

  // 把 loader 放进 ref：调用方几乎总是写箭头函数字面量，
  // 直接进依赖数组会让 effect 每渲染一次就跑一次。
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    if (!key) {
      setData(null)
      setError(null)
      return
    }
    const hit = cache.get(key)
    if (hit !== undefined) {
      setData(hit as T)
      setError(null)
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    setError(null)
    loadRef
      .current()
      .then((v) => {
        if (!alive) return
        cache.set(key, v)
        setData(v)
      })
      .catch((e: unknown) => {
        if (alive) setError((e as Error).message)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [key, tick])

  const reload = useCallback(() => {
    if (key) cache.delete(key)
    setTick((t) => t + 1)
  }, [key])

  return { data, error, loading, reload }
}
