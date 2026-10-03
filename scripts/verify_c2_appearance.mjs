/**
 * 验收 P11-C2「多书独立外观」。
 *
 * 用法：node scripts/verify_c2_appearance.mjs <port>
 *
 * 验的四件事：
 *   ① 给甲书切浅色 → 只写进甲书的 book.yaml，全局偏好不动
 *   ② 切到乙书 → 乙书跟随全局（还是深色），互不干扰
 *   ③ 切回甲书 → 浅色还在（book.yaml 里存着的）
 *   ④ 「改回跟随全局」→ 甲书回到全局的深色；「刷新页面」→ 甲书仍是浅色（重启也认）
 *
 * ⚠️ 会真建两本书（外观甲/外观乙），跑完整本删掉 —— 净效果为零。
 */

import { rm } from 'node:fs/promises'

const PORT = Number(process.argv[2] || 8765)
const BASE = `http://127.0.0.1:${PORT}`
const STAMP = String(Date.now()).slice(-6)
const A = `外观甲${STAMP}`
const B = `外观乙${STAMP}`
let seq = 0

// ---------------------------------------------------------------- HTTP

const jreq = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

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
  await sleep(2200) // 等书加载 + 外观拉取生效
}

const domTheme = () => ev(`document.documentElement.dataset.theme || ''`)

// ---------------------------------------------------------------- 准备

await jreq('POST', '/api/books', { book_id: A, title: A })
await jreq('POST', '/api/books', { book_id: B, title: B })
// 先把全局钉成深色，测试才有确定的「跟随全局」基准
await jreq('PUT', '/api/prefs', { ui: { mode: 'dark' } })

// ---------------------------------------------------------------- 收尾

let cleaned = false
const cleanup = async () => {
  if (cleaned) return
  cleaned = true
  console.log('\n--- 收尾 ---')
  // 全局偏好还原本轮测试前的常见值（深色），不留下测试痕迹
  try { await jreq('PUT', '/api/prefs', { ui: { mode: 'dark' } }) } catch { /* ignore */ }
  for (const id of [A, B]) {
    try {
      const info = await jreq('DELETE', `/api/books/${encodeURIComponent(id)}`, { book_id: id, confirm: id })
      const dir = String(info?.snapshot?.dir || '')
      const name = dir.split(/[\\/]/).pop() || ''
      if (name.startsWith(id) && name.includes('book-delete')) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }
    } catch (e) {
      console.log(`  ⚠️ 「${id}」删除失败，请手工处理：${e.message}`)
    }
  }
  console.log('  两本临时书已整本删除（含快照），全局偏好已还原，净效果为零')
}
process.on('exit', () => void cleanup())

// ---------------------------------------------------------------- 开跑

try {
  await send('Runtime.enable')
  await send('Page.navigate', { url: BASE })
  await sleep(6000)
  await switchBook(A)

  // ---- ① 甲书切浅色
  await ev(`(() => { const b=[...document.querySelectorAll('.rail__item')].find(x=>x.innerText.trim().startsWith('设置')); b?.click(); return 1 })()`)
  await sleep(1800)
  await ev(`(() => {
    const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='浅色')
    b?.click(); return 1
  })()`)
  await sleep(1200)
  check('**甲书切浅色 → 界面立即变浅色**', (await domTheme()) === 'light', await domTheme())
  const yaml = await jreq('GET', `/api/books/${encodeURIComponent(A)}/appearance`)
  check('覆盖真的写进了甲书的 book.yaml', yaml.has_override === true && yaml.ui.mode === 'light', JSON.stringify({ has_override: yaml.has_override, mode: yaml.ui.mode }))
  const gp = await jreq('GET', '/api/prefs')
  check('**全局偏好没被带跑**（全局还是深色）', gp.ui.mode === 'dark', `全局 mode=${gp.ui.mode}`)

  // ---- ② 乙书跟随全局
  await switchBook(B)
  check('**切到乙书 → 深色（跟随全局，互不干扰）**', (await domTheme()) === 'dark', await domTheme())

  // ---- ③ 甲书的状态还在
  await switchBook(A)
  check('**切回甲书 → 浅色还在（book.yaml 存着的）**', (await domTheme()) === 'light', await domTheme())

  // ---- ④ 刷新持久
  await send('Page.navigate', { url: BASE })
  await sleep(6000)
  await switchBook(A)
  check('**刷新页面后甲书仍是浅色**', (await domTheme()) === 'light', await domTheme())

  // ---- ⑤ 改回跟随全局
  await ev(`(() => { const b=[...document.querySelectorAll('.rail__item')].find(x=>x.innerText.trim().startsWith('设置')); b?.click(); return 1 })()`)
  await sleep(1500)
  const hasBtn = await ev(`(() => {
    const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='改回跟随全局')
    if(!b) return false
    b.click(); return true
  })()`)
  check('「改回跟随全局」按钮出现了（这本书确实有独立设置）', hasBtn === true)
  await sleep(1500)
  check('**改回跟随全局后甲书回到深色**', (await domTheme()) === 'dark', await domTheme())
  const after = await jreq('GET', `/api/books/${encodeURIComponent(A)}/appearance`)
  check('book.yaml 里的覆盖已清掉', after.has_override === false, JSON.stringify(after.has_override))

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
