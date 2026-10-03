/**
 * d3-force-3d 的最小类型声明。
 *
 * 上游包只发 JS 不带 .d.ts（也不在 @types 里），而我们只用得到
 * forceManyBody / forceLink / forceCollide / forceX|Y|Z 这几个力，
 * 所以按用到的部分手写一份，不做完整描述 —— 比装一个泛型过宽的
 * 全量类型包更可控，出问题时也更容易看出是我们自己的断言。
 */
declare module 'd3-force-3d' {
  type NumAccessor<T> = (d: T, i: number, nodes: T[]) => number

  export interface D3Force3D<T> {
    (alpha: number): void
    strength(v: number | NumAccessor<T>): D3Force3D<T>
    distance(v: number | ((link: never, i: number, links: never[]) => number)): D3Force3D<T>
    iterations(v: number): D3Force3D<T>
  }

  export function forceManyBody<T = unknown>(): D3Force3D<T>
  export function forceLink<T = unknown>(): D3Force3D<T>
  export function forceCollide<T = unknown>(radius?: number | NumAccessor<T>): D3Force3D<T>
  export function forceX<T = unknown>(x?: number | NumAccessor<T>): D3Force3D<T>
  export function forceY<T = unknown>(y?: number | NumAccessor<T>): D3Force3D<T>
  export function forceZ<T = unknown>(z?: number | NumAccessor<T>): D3Force3D<T>
}
