/**
 * 验收 P11-B4「素材库管理页」（设置 → 素材库）。
 *
 * 用法：node scripts/verify_assets.mjs <port>
 *
 * 验的五件事：
 *   ① 设置面板里点得出「素材库」页签，六类 chips 齐全
 *   ② 上传一张背景图 → 卡片出现（名字 + 大小）
 *   ③ 没引用时点删 → confirm 是「不可撤销」文案 → 取消 → 卡片还在
 *   ④ 全局外观引用它 → 重扫引用 → 徽标变「引用 1 处」→
 *      再点删 → confirm 列出引用位置 → 确认 → 卡片消失
 *   ⑤ usage 接口里键也消失；无未捕获异常
 *
 * ⚠️ 会真建一本书（素材测××××××）、真上传一张 1×1 png 并删掉 —— 净效果为零。
 */

import { rm } from 'node:fs/promises'

const PORT = Number(process.argv[2] || 8765)
const BASE = `http://127.0.0.1:${PORT}`
const STAMP = String(Date.now()).slice(-6)
const BOOK = `素材测${STAMP}`
const ASSET = `verify-assets-${STAMP}.png`
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==',
  'base64',
)
let seq = 0

// ---------------------------------------------------------------- HTTP

const jreq = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : undefined,
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.status === 204 ? {} : r.json()
}

// ---------------------------------------------------------------- CDP 骨架

const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
if (!page) { console.error('找不到浏览器页签，CDP 9333 起了吗？'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
const pending = new Map()
const errs = []
let lastDialog = null
let dialogAccept = false // 下一个 confirm 要不要点「确定」
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  else if (m.method === 'Runtime.exceptionThrown') {
    errs.push(String(m.params.exceptionDetails.exception?.description || '').slice(0, 200))
  } else if (m.method === 'Page.javascriptDialogOpening') {
    lastDialog = String(m.params.message || '')
    void send('Page.handleJavaScriptDialog', { accept: dialogAccept })
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)))
  ws.send(JSON.stringify({ id, method, params }))
})
// 上一次运行若死在 confirm 上，页签里可能留着模态对话框 —— 先无条件关一下。
// ⚠️ 对话框开着时其余 CDP 命令全部阻塞，所以这条必须先发、不能 await。
void send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {})
const ev = (js) => send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }).then((r) => r.result?.value)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [OK]   ${label}`) }
  else { fail++; console.log(`  [FAIL] ${label}${extra ? `\n         ${String(extra).slice(0, 300)}` : ''}`) }
}

/** 顶栏切书 */
const switchBook = async (id) => {
  await ev(`(() => {
    const s=document.querySelector('.topbar select.select')
    if(!s) return 0
    const setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set
    setter.call(s, ${JSON.stringify(id)})
    s.dispatchEvent(new Event('change',{bubbles:true}))
    return 1
  })()`)
  await sleep(2200)
}

/** 打开 设置 → 素材库 页签 */
const openAssetsTab = async () => {
  await ev(`(() => {
    const b=[...document.querySelectorAll('.rail__item')].find(x=>x.innerText.trim().startsWith('设置'))
    b?.click(); return 1
  })()`)
  await sleep(1500)
  await ev(`(() => {
    const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='素材库')
    b?.click(); return 1
  })()`)
  await sleep(1500)
}

const cardCount = () => ev(`document.querySelectorAll('.assets-admin__card').length`)
const badgeText = () => ev(`(() => {
  const c=document.querySelector('.assets-admin__card')
  if(!c) return ''
  const chip=[...c.querySelectorAll('.chip')].find(x=>/引用|未引用/.test(x.innerText))
  return chip ? chip.innerText.trim() : ''
})()`)

// ---------------------------------------------------------------- 准备

// 清场：前几轮如果死在半路，可能残留 verify-assets-*.png —— 全部清掉再开始，
// 否则卡片数对不上（验收靠数卡片，盘上有脏数据结论就不可信）
{
  const leftovers = (await jreq('GET', '/api/assets/backgrounds')).items
    .filter((x) => x.name.startsWith('verify-assets-'))
  for (const x of leftovers) {
    await jreq('DELETE', `/api/assets/backgrounds/${encodeURIComponent(x.name)}`).catch(() => undefined)
  }
  if (leftovers.length) console.log(`  （清场：删掉 ${leftovers.length} 个上轮残留的测试素材）`)
}

await jreq('POST', '/api/books', { book_id: BOOK, title: BOOK })
// 记住全局 background 现状，收尾还原
const prefsBefore = await jreq('GET', '/api/prefs')
const bgBefore = JSON.parse(JSON.stringify(prefsBefore?.ui?.background ?? null))

// ---------------------------------------------------------------- 收尾

let cleaned = false
const cleanup = async () => {
  if (cleaned) return
  cleaned = true
  console.log('\n--- 收尾 ---')
  try {
    // 还原全局 background（测试只动过这一个键）；素材本体已随删除链路清掉，兜底再删一次
    if (bgBefore) await jreq('PUT', '/api/prefs', { ui: { background: bgBefore } })
  } catch { /* ignore */ }
  try { await jreq('DELETE', `/api/assets/backgrounds/${encodeURIComponent(ASSET)}`) } catch { /* 可能已删 */ }
  try {
    const info = await jreq('DELETE', `/api/books/${encodeURIComponent(BOOK)}`, { book_id: BOOK, confirm: BOOK })
    const dir = String(info?.snapshot?.dir || '')
    const name = dir.split(/[\\/]/).pop() || ''
    if (name.startsWith(BOOK) && name.includes('book-delete')) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  } catch (e) {
    console.log(`  ⚠️ 「${BOOK}」删除失败，请手工处理：${e.message}`)
  }
  console.log('  临时书已整本删除（含快照）、素材已清、全局 background 已还原 —— 净效果为零')
}
process.on('exit', () => void cleanup())

// ---------------------------------------------------------------- 开跑

try {
  await send('Runtime.enable')
  // 不 enable Page 域就收不到 javascriptDialogOpening —— confirm 会把渲染进程
  // 同步阻塞死，evaluate 永远不返回（第一次跑就死在这，整脚本挂死）
  await send('Page.enable')
  await send('Page.navigate', { url: BASE })
  await sleep(6000)
  await switchBook(BOOK)

  // ---- ① 页签可达、六类 chips
  await openAssetsTab()
  const titleOk = await ev(`!!document.querySelector('.assets-admin')`)
  check('设置面板里点「素材库」→ 页面出现', titleOk === true)
  const chipN = await ev(`document.querySelectorAll('.assets-admin .chip').length`)
  check('六类素材 chips 齐全（背景/贴纸/图标/封面/底图/字体）', chipN >= 6, `chips=${chipN}`)

  // ---- ② API 上传 → 刷新 → 卡片出现
  const fd = new FormData()
  fd.append('file', new File([PNG], ASSET, { type: 'image/png' }))
  await jreq('POST', `/api/assets/backgrounds`, fd)
  // 素材清单是应用启动时拉的 —— 整页刷新才拿得到新上传的
  await send('Page.navigate', { url: BASE })
  await sleep(6000)
  await switchBook(BOOK)
  await openAssetsTab()
  check('上传后卡片出现', (await cardCount()) === 1, `cards=${await cardCount()}`)
  const nameShown = await ev(`document.querySelector('.assets-admin__name')?.innerText || ''`)
  check('卡片显示的是上传的文件名', nameShown === ASSET, nameShown)
  const sizeShown = await ev(`document.querySelector('.assets-admin__meta .faint')?.innerText || ''`)
  check('卡片显示大小', /\d+\s*(B|KB|MB)/.test(sizeShown), sizeShown)

  // ---- ③ 未引用时点删：confirm 是「不可撤销」文案，取消则不删
  dialogAccept = false
  lastDialog = null
  await ev(`(() => { const b=[...document.querySelectorAll('.assets-admin__card button')].find(x=>x.innerText.trim()==='删'); b?.click(); return 1 })()`)
  await sleep(800)
  check('未引用时 confirm 提示「不可撤销」', (lastDialog || '').includes('不可撤销'), lastDialog)
  check('点了取消 → 卡片还在', (await cardCount()) === 1)

  // ---- ④ 全局外观引用它 → 重扫 → 徽标变「引用 1 处」
  await jreq('PUT', '/api/prefs', { ui: { background: { kind: 'image', url: `/api/assets/backgrounds/${encodeURIComponent(ASSET)}/raw` } } })
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='重扫引用'); b?.click(); return 1 })()`)
  await sleep(1200)
  check('**引用后徽标变「引用 1 处」**', (await badgeText()).includes('引用 1 处'), await badgeText())

  // ---- ⑤ 再点删：confirm 列出引用位置；确认 → 卡片消失
  dialogAccept = false
  lastDialog = null
  await ev(`(() => { const b=[...document.querySelectorAll('.assets-admin__card button')].find(x=>x.innerText.trim()==='删'); b?.click(); return 1 })()`)
  await sleep(800)
  check('**有引用时 confirm 列出引用位置（全局外观偏好）**', (lastDialog || '').includes('全局外观偏好'), lastDialog)
  dialogAccept = true
  lastDialog = null
  await ev(`(() => { const b=[...document.querySelectorAll('.assets-admin__card button')].find(x=>x.innerText.trim()==='删'); b?.click(); return 1 })()`)
  await sleep(2000)
  check('**确认后卡片消失**', (await cardCount()) === 0, `cards=${await cardCount()}`)
  const usage = await jreq('GET', '/api/assets/usage')
  check('usage 里这个素材也没了', !(`${'backgrounds'}/${ASSET}` in usage.usages), JSON.stringify(Object.keys(usage.usages)).slice(0, 250))

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
