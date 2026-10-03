/**
 * 验收 P11-B2「帮助与上手引导」。
 *
 * 用法：node scripts/verify_guide.mjs <port>
 *
 * 验的四件事（对应验收标准「引导可跳过且不再提示」）：
 *   ① 首次访问（无 done 标记）→ 引导自动出现；步进器能用
 *   ② 「跳过，不再提示」→ 引导关闭 + 标记落 localStorage
 *   ③ 刷新页面 → 引导**不再**出现（这是验收的核心）
 *   ④ 设置 → 后台 → 快捷键面板「重看新手引导」→ 能再次叫出来；
 *      走到最后一步「开始使用」也能正常收尾
 *
 * 纯前端功能，不建书不落盘；结束时**清掉** done 标记，
 * 让你下次刷新时能亲手看一次引导（看完点跳过即可）。
 */

const PORT = Number(process.argv[2] || 8765)
const BASE = `http://127.0.0.1:${PORT}`
const DONE_KEY = 'wkv.guide.done'
let seq = 0

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

const guideOpen = () => ev(`(() => {
  const d=document.querySelector('.modal-backdrop[aria-label=新手引导]')
  return d ? (d.querySelector('.modal__title')?.innerText || 'open') : null
})()`)
const clickBtn = (text) => ev(`(() => {
  const b=[...document.querySelectorAll('.modal-backdrop[aria-label=新手引导] button')]
    .find(x=>(x.innerText||'').trim()===${JSON.stringify(text)})
  if(!b) return false
  b.click(); return true
})()`)

try {
  await send('Runtime.enable')
  await send('Page.navigate', { url: BASE })
  await sleep(5000)

  // ① 首次访问
  await ev(`localStorage.removeItem(${JSON.stringify(DONE_KEY)})`)
  await send('Page.navigate', { url: BASE })
  await sleep(5000)
  let g = await guideOpen()
  check('首次访问 → 引导自动出现', typeof g === 'string' && g.includes('1/5'), String(g))
  check('第一页是欢迎页', typeof g === 'string' && g.includes('欢迎'), String(g))

  // 步进
  await clickBtn('下一步'); await sleep(300)
  g = await guideOpen()
  check('下一步 → 第二页（建一本书）', typeof g === 'string' && g.includes('2/5'), String(g))
  await clickBtn('下一步'); await sleep(300)
  g = await guideOpen()
  check('再下一步 → 第三页', typeof g === 'string' && g.includes('3/5'), String(g))
  await clickBtn('上一步'); await sleep(300)
  g = await guideOpen()
  check('上一步 → 退回第二页', typeof g === 'string' && g.includes('2/5'), String(g))
  await clickBtn('上一步'); await sleep(300)
  g = await guideOpen()
  check('退回第一页后「上一步」按钮消失', typeof g === 'string' && g.includes('1/5'), String(g))

  // ② 跳过
  await clickBtn('跳过，不再提示'); await sleep(500)
  check('跳过后引导关闭', (await guideOpen()) === null)
  check('跳过标记落了 localStorage', (await ev(`localStorage.getItem(${JSON.stringify(DONE_KEY)})`)) === '1')

  // ③ 不再提示
  await send('Page.navigate', { url: BASE })
  await sleep(5000)
  check('**刷新页面 → 引导不再出现**（验收核心）', (await guideOpen()) === null)

  // ④ 重看入口
  await ev(`(() => { const b=[...document.querySelectorAll('.rail__item')].find(x=>x.innerText.trim().startsWith('设置')); b?.click(); return 1 })()`)
  await sleep(2000)
  await ev(`(() => { const b=[...document.querySelectorAll('.panel-seg .seg__item')].find(x=>(x.innerText||'').trim()==='后台'); b?.click(); return 1 })()`)
  await sleep(2500)
  const reopen = await ev(`(() => {
    const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='重看新手引导')
    if(!b) return false
    b.click(); return true
  })()`)
  check('快捷键面板里有「重看新手引导」', reopen === true)
  await sleep(600)
  g = await guideOpen()
  check('重看 → 引导再次出现', typeof g === 'string' && g.includes('1/5'), String(g))

  // 走到最后一页收尾
  for (let i = 0; i < 4; i++) { await clickBtn('下一步'); await sleep(250) }
  g = await guideOpen()
  check('连点四下到最后一页（5/5）', typeof g === 'string' && g.includes('5/5'), String(g))
  await clickBtn('开始使用'); await sleep(500)
  check('「开始使用」正常收尾', (await guideOpen()) === null)

  console.log('\n=== 运行时异常 ===')
  check('无未捕获异常', errs.length === 0, errs.join(' | '))

  // 收尾：清掉标记，让你下次刷新亲手看一次
  await ev(`localStorage.removeItem(${JSON.stringify(DONE_KEY)})`)
  console.log('\n（done 标记已清除：你下次刷新页面会看到一次引导，点「跳过」即可）')
} finally {
  console.log(`\n${'='.repeat(48)}`)
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`)
  console.log(`${'='.repeat(48)}`)
  try { ws.close() } catch { /* ignore */ }
  process.exitCode = fail ? 1 : 0
}
