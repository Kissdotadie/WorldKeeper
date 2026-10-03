/**
 * 验收 P11-B6「移动端搜索打磨」。
 *
 * 用法：node scripts/verify_b6_search.mjs <port>
 *
 * 验的六件事：
 *   ① 390×844 移动仿真下搜索框可用、防抖后出结果、**命中被 <mark> 标出**
 *   ② 点结果 → **键盘收起**（activeElement 不再是输入框）+ 词被记进历史
 *   ③ 返回后「最近搜索」chips 出现；点 chip 一键回填并重新出结果
 *   ④ **刷新后历史还在**（localStorage 持久）
 *   ⑤ 单条 ✕ 可删；「清空」一键清光
 *   ⑥ 无未捕获异常
 *
 * ⚠️ 会真建一本书（搜索测××××××）跑完整本删掉；历史键收尾清掉 —— 净效果为零。
 */

const PORT = Number(process.argv[2] || 8765)
const BASE = `http://127.0.0.1:${PORT}`
const STAMP = String(Date.now()).slice(-6)
const BOOK = `搜索测${STAMP}`
const HIST_KEY = 'wkv.msearch.history'
const TERM = '裴渊'
let seq = 0

// ---------------------------------------------------------------- HTTP

const jreq = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.json()
}
const jpost = (p, b) => jreq('POST', p, b)

// ---------------------------------------------------------------- CDP 骨架

const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
if (!page) { console.error('找不到浏览器页签，CDP 9333 起了吗？'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
const pending = new Map()
const errs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  else if (m.method === 'Runtime.exceptionThrown') {
    errs.push(String(m.params.exceptionDetails.exception?.description || '').slice(0, 200))
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)))
  ws.send(JSON.stringify({ id, method, params }))
})
const ev = (js) => send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }).then((r) => r.result?.value)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [OK]   ${label}`) }
  else { fail++; console.log(`  [FAIL] ${label}${extra ? `\n         ${String(extra).slice(0, 300)}` : ''}`) }
}

/** 移动仿真：390×844（iPhone 14 尺寸档） */
const emulateMobile = () =>
  send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  })

const switchBook = async (id) => {
  await ev(`(() => {
    const s=document.querySelector('.mob__book')
    if(!s) return 0
    const setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set
    setter.call(s, ${JSON.stringify(id)})
    s.dispatchEvent(new Event('change',{bubbles:true}))
    return 1
  })()`)
  await sleep(2200)
}

/** 往受 React 控制的移动端搜索框写值（直接改 .value 不触发 onChange） */
const typeQuery = async (v) => {
  await ev(`(() => {
    const el=document.querySelector('.msearch__in')
    const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set
    setter.call(el, ${JSON.stringify(v)})
    el.dispatchEvent(new Event('input',{bubbles:true}))
    return true
  })()`)
  await sleep(1100) // 防抖 220ms + 请求
}

const histOf = () => ev(`JSON.parse(localStorage.getItem(${JSON.stringify(HIST_KEY)}) || '[]')`)

// ---------------------------------------------------------------- 准备

await jpost('/api/books', { book_id: BOOK, title: BOOK })
await jpost(`/api/books/${encodeURIComponent(BOOK)}/entities`, {
  type: 'character', name: '裴渊', summary: '落霞城少年镖师', first_appear: '1',
  body: { 摘要: '落霞城少年镖师，替镖局押最后一趟货', 属性: [], 出场记录: [], 关联: [], 待补充: [] },
})

// ---------------------------------------------------------------- 收尾

let cleaned = false
const cleanup = async () => {
  if (cleaned) return
  cleaned = true
  console.log('\n--- 收尾 ---')
  try {
    await ev(`localStorage.removeItem(${JSON.stringify(HIST_KEY)})`)
    await send('Emulation.clearDeviceMetricsOverride').catch(() => undefined)
  } catch { /* ignore */ }
  try {
    const info = await jreq('DELETE', `/api/books/${encodeURIComponent(BOOK)}`, { book_id: BOOK, confirm: BOOK })
    const dir = String(info?.snapshot?.dir || '')
    const name = dir.split(/[\\/]/).pop() || ''
    if (name.startsWith(BOOK) && name.includes('book-delete')) {
      const { rm } = await import('node:fs/promises')
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  } catch (e) {
    console.log(`  ⚠️ 「${BOOK}」删除失败，请手工处理：${e.message}`)
  }
  console.log('  临时书已整本删除（含快照）、搜索历史键已清 —— 净效果为零')
}
process.on('exit', () => void cleanup())

// ---------------------------------------------------------------- 开跑

try {
  await send('Runtime.enable')
  await send('Page.enable')
  await emulateMobile()
  await send('Page.navigate', { url: `${BASE}/m` })
  await sleep(6000)
  await switchBook(BOOK)

  // ---- ① 搜索可用 + 命中高亮
  check('移动端搜索框在', await ev(`!!document.querySelector('.msearch__in')`))
  await typeQuery(TERM)
  const hitN = await ev(`document.querySelectorAll('.mrow').length`)
  check('**防抖后出结果**', (hitN ?? 0) > 0, `rows=${hitN}`)
  const marked = await ev(`(() => {
    const m=document.querySelector('.mrow mark')
    return m ? m.innerText : ''
  })()`)
  check('**命中文字被 <mark> 标出且标的对**', marked === TERM, `mark=${JSON.stringify(marked)}`)

  // ---- ② 点结果：收键盘 + 记历史
  await ev(`(() => { const b=document.querySelector('.mrow'); b?.click(); return 1 })()`)
  await sleep(1200)
  const hash = await ev(`window.location.hash`)
  check('点结果进了实体卡', String(hash).includes('entity'), hash)
  const focused = await ev(`document.activeElement?.className || ''`)
  check('**键盘收起（焦点不在输入框）**', !String(focused).includes('msearch__in'), focused)
  let h = await histOf()
  check('**点过的词记进了历史**', Array.isArray(h) && h.includes(TERM), JSON.stringify(h))

  // ---- ③ 返回 → 最近搜索 chips → 点 chip 回填
  await ev(`(() => { const b=document.querySelector('.mob__back'); b?.click(); return 1 })()`)
  await sleep(1200)
  const chipTxt = await ev(`document.querySelector('.mhist')?.innerText || ''`)
  check('「最近搜索」chips 出现且含该词', chipTxt.includes(TERM), chipTxt)
  await ev(`(() => { const c=document.querySelector('.mhist'); c?.click(); return 1 })()`)
  await sleep(1400)
  const qval = await ev(`document.querySelector('.msearch__in')?.value || ''`)
  check('点 chip 一键回填搜索词', qval === TERM, qval)
  const hitN2 = await ev(`document.querySelectorAll('.mrow').length`)
  check('回填后自动重新出结果', (hitN2 ?? 0) > 0, `rows=${hitN2}`)

  // ---- ④ 刷新后历史还在
  await send('Page.navigate', { url: `${BASE}/m` })
  await sleep(6000)
  await switchBook(BOOK)
  const chipTxt2 = await ev(`document.querySelector('.mhist')?.innerText || ''`)
  check('**刷新后历史还在（localStorage 持久）**', chipTxt2.includes(TERM), chipTxt2)

  // ---- ⑤ 单删 + 清空
  await ev(`(() => { const x=document.querySelector('.mhist__x'); x?.click(); return 1 })()`)
  await sleep(600)
  h = await histOf()
  check('单条 ✕ 删掉历史', Array.isArray(h) && h.length === 0, JSON.stringify(h))
  const chipGone = await ev(`!document.querySelector('.mhist')`)
  check('删光后「最近搜索」整节消失', chipGone === true)

  // 造一条再点「清空」
  await typeQuery(TERM)
  await ev(`(() => { const b=document.querySelector('.mrow'); b?.click(); return 1 })()`)
  await sleep(1200)
  await ev(`(() => { const b=document.querySelector('.mob__back'); b?.click(); return 1 })()`)
  await sleep(1200)
  await ev(`(() => { const c=document.querySelector('.msec__clear'); c?.click(); return 1 })()`)
  await sleep(600)
  h = await histOf()
  check('「清空」一键清光', Array.isArray(h) && h.length === 0, JSON.stringify(h))

  console.log('\n=== 运行时异常 ===')
  check('无未捕获异常', errs.length === 0, errs.join(' | '))
} finally {
  await cleanup()
  console.log(`\n${'='.repeat(48)}`)
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`)
  console.log(`${'='.repeat(48)}`)
  try { ws.close() } catch { /* ignore */ }
  process.exitCode = fail ? 1 : 0
}
