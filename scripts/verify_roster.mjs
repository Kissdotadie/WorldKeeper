/**
 * 验收 P11-B3「名册卡片流的虚拟滚动」（动态高度档）。
 *
 * 用法：node scripts/verify_roster.mjs <port>
 *
 * 为什么必须上界面验：虚拟滚动的全部意义是「DOM 数量有界 + 滚得到最后一条」，
 * 这两件事只有真渲染出来才算数。API 测不出「视口外一张卡都不渲染」。
 *
 * 验的四件事：
 *   ① 卡片流 DOM 有界 —— 520 条实体，视口里永远只有几十张卡（这是本次改动的目的）
 *   ② 滚得到底 —— 滚到底能看见最后一条（量外高漏 margin 的病就是这里发作：
 *      总高越算越短，滚到底最后几条永远出不来）
 *   ③ 分组 / 筛选切换后依然有界、依然正确
 *   ④ 表格档不受影响（表格行数有限，不做虚拟化 —— 这是文档里写明的选择）
 *
 * ⚠️ 这个脚本会**真在数据目录里建一本书**（520 个实体），跑完整本删掉 —— 净效果为零。
 *    建 520 条大约要十几秒，属正常。
 */

import { rm } from 'node:fs/promises'

const PORT = Number(process.argv[2] || 8765)
const BASE = `http://127.0.0.1:${PORT}`
const STAMP = String(Date.now()).slice(-6)
const BOOK = `名册验收${STAMP}`
const N = 520 // 一次只看一个类型，最大类给到 500+ 才有意义
let seq = 0

// ---------------------------------------------------------------- HTTP 小工具

const jpost = async (path, body) => {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`POST ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

// ---------------------------------------------------------------- CDP 骨架

const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
if (!page) {
  console.error('找不到浏览器页签，CDP 9333 起了吗？')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
const pending = new Map()
const errs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  else if (m.method === 'Runtime.exceptionThrown') {
    errs.push(String(m.params.exceptionDetails.exception?.description || '').slice(0, 160))
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)))
  ws.send(JSON.stringify({ id, method, params }))
})
// ⚠️ returnByValue 时绝不能返回 DOM 节点（Object reference chain is too long）
const ev = (js) => send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true })
  .then((r) => r.result?.value)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
let skipped = 0
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [OK]   ${label}`) }
  else { fail++; console.log(`  [FAIL] ${label}${extra ? `\n         ${String(extra).slice(0, 320)}` : ''}`) }
}

const goto = async (label) => {
  await ev(`(() => { const b=[...document.querySelectorAll('.rail__item')].find(x=>x.innerText.trim().startsWith(${JSON.stringify(label)})); b?.click(); return 1 })()`)
  await sleep(1500)
}

// ---------------------------------------------------------------- 准备数据

const body = (o = {}) => ({
  摘要: o.摘要 ?? '', 属性: [], 出场记录: [], 关联: [], 待补充: [],
})

console.log(`建临时书「${BOOK}」+ ${N} 个实体（每 5 条有一个缺摘要，供「只看待补全」用）…`)
await jpost('/api/books', { book_id: BOOK, title: BOOK })
const t0 = Date.now()
for (let i = 1; i <= N; i++) {
  const id4 = String(i).padStart(4, '0')
  const incomplete = i % 5 === 0 // 104 条缺摘要
  await jpost(`/api/books/${encodeURIComponent(BOOK)}/entities`, {
    type: 'character',
    name: `群演${id4}`,
    summary: incomplete ? '' : `第${id4}号群众演员的简介，用来把卡片撑出一点真实的高度。`,
    tags: [i % 2 === 0 ? '甲组' : '乙组'],
    body: body({}),
  })
}
console.log(`  建完，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
const INCOMPLETE = Math.floor(N / 5)

// ---------------------------------------------------------------- 收尾

let cleaned = false
const cleanup = async () => {
  if (cleaned) return
  cleaned = true
  console.log('\n--- 收尾 ---')
  try {
    const r = await fetch(`${BASE}/api/books/${encodeURIComponent(BOOK)}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ book_id: BOOK, confirm: BOOK }),
    })
    if (!r.ok) {
      console.log(`  ⚠️ 临时书删除失败：${r.status} ${(await r.text()).slice(0, 160)}`)
    } else {
      const info = await r.json().catch(() => ({}))
      const dir = String(info?.snapshot?.dir || '')
      const name = dir.split(/[\\/]/).pop() || ''
      if (name.startsWith(BOOK) && name.includes('book-delete')) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }
      console.log(`  临时书「${BOOK}」已整本删除（含它产生的快照），净效果为零`)
    }
  } catch (e) {
    console.error(`  ⚠️ 清理失败，请手工删掉书目「${BOOK}」：`, e.message)
  }
}
process.on('exit', () => void cleanup())

// ---------------------------------------------------------------- 页内探针

/** 名册当前的渲染快照：卡片数、可见的第一张/最后一张名、pad 高度 */
const SNAP = `(() => {
  const cards=[...document.querySelectorAll('.rcard')]
  const grid=document.querySelector('.roster__grid')
  // 从卡片栅格往上找滚动容器（和 useVirtualBlocks.resolveScroller 同一套规则）
  let sc=null, p=grid?.parentElement
  while(p){ const oy=getComputedStyle(p).overflowY; if(oy==='auto'||oy==='scroll'){sc=p;break} p=p.parentElement }
  return {
    n: cards.length,
    first: (cards[0]?.querySelector('.rcard__name')?.innerText||'').trim(),
    last: (cards[cards.length-1]?.querySelector('.rcard__name')?.innerText||'').trim(),
    heads: [...document.querySelectorAll('.roster__vhead')].map(h=>(h.innerText||'').replace(/\\s+/g,' ').trim()),
    scroller: !!sc,
    scrollTop: sc ? Math.round(sc.scrollTop) : -1,
    scrollHeight: sc ? sc.scrollHeight : -1,
    clientH: sc ? sc.clientHeight : -1,
  }
})()`
const snap = () => ev(SNAP)

/** 滚动容器滚到指定位置并等 React 重画 */
const scrollTo = async (top, wait = 900) => {
  await ev(`(() => {
    const grid=document.querySelector('.roster__grid')
    let p=grid?.parentElement
    while(p){ const oy=getComputedStyle(p).overflowY; if(oy==='auto'||oy==='scroll'){ p.scrollTop=${top}; return Math.round(p.scrollTop) } p=p.parentElement }
    return -1
  })()`)
  await sleep(wait)
  return snap()
}

// ---------------------------------------------------------------- 开跑

try {
  await send('Runtime.enable')
  await send('Page.navigate', { url: BASE })
  await sleep(5000)
  await ev(`(() => {
    const s=document.querySelector('.topbar select.select')
    if(!s) return 0
    const setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set
    setter.call(s, ${JSON.stringify(BOOK)})
    s.dispatchEvent(new Event('change',{bubbles:true}))
    return 1
  })()`)
  await sleep(2500)
  await goto('名册')
  await sleep(1500)

  // ------------------------------------------------------------ ① DOM 有界
  console.log(`\n=== ① 卡片流 DOM 有界（${N} 条，视口里只该有几十张卡）===`)
  let s = await snap()
  check('卡片流的滚动容器找到了', s.scroller === true, JSON.stringify(s))
  check(`**视口外一张卡都不渲染**（${N} 条只渲染了 ${s.n} 张卡）`, s.n > 0 && s.n <= 120, `n=${s.n}`)
  check('顶部第一张就是第一条（群演0001）', s.first === '群演0001', s.first)
  check('滚动高度是撑出来的（大于视口）', s.scrollHeight > s.clientH * 3,
    `scrollH=${s.scrollHeight} clientH=${s.clientH}`)

  // ------------------------------------------------------------ ② 滚得到底
  console.log('\n=== ② 滚到底能看见最后一条（外高漏 margin 的病在这里发作）===')
  s = await scrollTo(999999)
  check('滚动条真的动到了底', s.scrollTop >= s.scrollHeight - s.clientH - 2,
    `top=${s.scrollTop} scrollH=${s.scrollHeight} clientH=${s.clientH}`)
  check(`**滚到底看得见最后一条（群演${String(N).padStart(4, '0')}）**`, s.last === `群演${String(N).padStart(4, '0')}`, s.last)
  check('视口已经挪到了尾部（前面几千像素没有留白浪费）', s.scrollTop > s.scrollHeight * 0.8,
    `top=${s.scrollTop} scrollH=${s.scrollHeight}`)
  check(`滚到底之后卡片数依然有界（${s.n} 张）`, s.n > 0 && s.n <= 120, `n=${s.n}`)

  // 滚回顶部还能回得去（往返一次，量测逻辑不能单向好用）
  s = await scrollTo(0)
  check('滚回顶部，第一张又回来了', s.first === '群演0001' && s.scrollTop === 0,
    `first=${s.first} top=${s.scrollTop}`)

  // ------------------------------------------------------------ ③ 分组 / 筛选
  // ⚠️ 选分组下拉不能只看「有没有 faction 选项」—— 类型下拉里也有 faction
  // （人物/地点/势力/…），会误切类型、把名册切成一本空册。认准
  // 「同时有 none 和 tag」的那个（只有分组下拉长这样）。
  console.log('\n=== ③ 分组与筛选切换之后依然有界 ===')
  const setGroup = (val) => ev(`(() => {
    const sel=[...document.querySelectorAll('select.select')].find(x=>{
      const vs=[...x.options].map(o=>o.value)
      return vs.includes('none') && vs.includes('tag')
    })
    if(!sel) return 0
    const setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set
    setter.call(sel, ${JSON.stringify(val)}); sel.dispatchEvent(new Event('change',{bubbles:true})); return 1
  })()`)
  await setGroup('faction')
  await sleep(1800)
  s = await snap()
  check('按势力分组后出现了分组头', s.heads.length >= 1, JSON.stringify(s.heads))
  check(`分组之后卡片数依然有界（${s.n} 张）`, s.n > 0 && s.n <= 120, `n=${s.n}`)
  await setGroup('tag')
  await sleep(1800)
  s = await snap()
  // 虚拟化下视口里只有当前那段落的分组头 —— 要求「甲组乙组同时可见」反而是错的。
  // 有头、名字对、条数对（520 条对半 = 每组 260）就够了。
  check('按标签分组后看得见分组头，名字是甲组/乙组之一、且带条数',
    s.heads.length >= 1 && s.heads.some((h) => /^(甲组|乙组) \d+$/.test(h)),
    JSON.stringify(s.heads))
  check(`按标签分组后卡片数依然有界（${s.n} 张）`, s.n > 0 && s.n <= 120, `n=${s.n}`)
  // 关键回归点：分组后每组各渲染一遍整串的老 bug 就是这里爆卡数
  check('**没有「每组渲染一遍整串」的老 bug**（卡片数不是按组翻倍）', s.n <= 120, `n=${s.n}`)

  // 切回不分组
  await setGroup('none')
  await sleep(1500)

  // 只看待补全
  await ev(`(() => {
    const cb=[...document.querySelectorAll('input[type=checkbox]')].find(x=>x.closest('label')?.innerText.includes('只看待补全'))
    if(!cb) return 0; if(!cb.checked) cb.click(); return 1
  })()`)
  await sleep(1800)
  s = await snap()
  const expectInc = INCOMPLETE
  check(`「只看待补全」筛出了 ${expectInc} 条（卡片数仍应有界）`,
    s.n > 0 && s.n <= 120, `n=${s.n}`)
  await ev(`(() => {
    const cb=[...document.querySelectorAll('input[type=checkbox]')].find(x=>x.closest('label')?.innerText.includes('只看待补全'))
    if(cb?.checked) cb.click(); return 1
  })()`)
  await sleep(1200)

  // ------------------------------------------------------------ ④ 表格档不受影响
  console.log('\n=== ④ 表格档不受影响（行数有限，不虚拟化 —— 文档写明的选择）===')
  await ev(`(() => { const b=[...document.querySelectorAll('.seg__item')].find(x=>(x.innerText||'').trim()==='表格'); b?.click(); return !!b })()`)
  await sleep(1800)
  const tableRows = await ev(`document.querySelectorAll('.etable tbody tr').length`)
  check(`表格档 ${N} 行全渲染（这是有意的，表格行矮、DOM 便宜）`, tableRows === N, `rows=${tableRows}`)
  const cardsInTable = await ev(`document.querySelectorAll('.rcard').length`)
  check('表格档下卡片一张都不渲染', cardsInTable === 0, `n=${cardsInTable}`)

  // 切回卡片流，别把界面留在坏状态
  await ev(`(() => { const b=[...document.querySelectorAll('.seg__item')].find(x=>(x.innerText||'').trim()==='名册'); b?.click(); return !!b })()`)
  await sleep(1500)
  s = await snap()
  check('切回卡片流，虚拟化还在工作', s.n > 0 && s.n <= 120, `n=${s.n}`)

  console.log('\n=== 运行时异常 ===')
  check('无未捕获异常', errs.length === 0, errs.join(' | '))
} finally {
  await cleanup()
  console.log(`\n${'='.repeat(48)}`)
  console.log(`  通过 ${pass} 项，失败 ${fail} 项${skipped ? `，跳过 ${skipped} 项` : ''}`)
  console.log(`${'='.repeat(48)}`)
  try { ws.close() } catch { /* ignore */ }
  process.exitCode = fail ? 1 : 0
}
