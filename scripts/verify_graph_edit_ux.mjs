/**
 * 验收 P11-2️⃣①（图上编辑可发现性）。
 *
 * 用法：node scripts/verify_graph_edit_ux.mjs <port>
 *
 * 步骤：
 *   1. 清掉「看过引导」的标记 → 打开世界观（2D）→ 应弹出一次性引导
 *   2. 工具条上应有「浏览 / 编辑」两态开关，默认停在「编辑」
 *   3. 点「知道了」→ 引导消失；刷新后**不再**出现
 *   4. 切到「浏览」→ 双击节点**不应**弹编辑浮层、拖节点**不应**改位置
 *   5. 切回「编辑」→ 双击节点**应**弹编辑浮层（可发现性真的恢复了）
 */

const PORT = Number(process.argv[2] || 8799)
let seq = 0
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
const pending = new Map()
const errs = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  else if (m.method === 'Runtime.exceptionThrown') errs.push(String(m.params.exceptionDetails.exception?.description || '').slice(0, 160))
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)))
  ws.send(JSON.stringify({ id, method, params }))
})
const ev = (js) => send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }).then((r) => r.result?.value)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(500)
}
const dbl = async (x, y) => {
  for (const c of [1, 2]) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: c })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: c })
    await sleep(45)
  }
  await sleep(700)
}
const openWorld = async () => {
  await ev(`(() => { const b=[...document.querySelectorAll('.rail__item')].find(x=>x.innerText.trim().startsWith('世界观')); b?.click(); return 1 })()`)
  await sleep(1800)
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='平面'); b?.click(); return 1 })()`)
  await sleep(1500)
}
const segBtn = (label) => `(() => { const b=[...document.querySelectorAll('.graph__seg-btn')].find(x=>x.innerText.trim()==='${label}'); return b || null })()`

await send('Runtime.enable')
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}` })
await sleep(3600)
// 清掉标记，好看到引导
await ev(`localStorage.removeItem('wkv.graphGuide.v1')`)
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}` })
await sleep(3600)

const out = {}
await openWorld()

out['引导浮层出现'] = await ev(`!!document.querySelector('.gguide')`)
out['引导三条手势'] = await ev(`document.querySelectorAll('.gguide__rows li').length`)
out['工具条两态开关'] = await ev(`[...document.querySelectorAll('.graph__seg-btn')].map(b => ({ t: b.innerText.trim(), on: b.classList.contains('graph__seg-btn--on') }))`)
out['默认在编辑态'] = await ev(`document.querySelector('.graph__seg-btn--on')?.innerText.trim()`)
out['提示行'] = await ev(`document.querySelector('.graph__hint')?.innerText.trim()`)

// 点「知道了」
const okPos = await ev(`(() => { const b=[...document.querySelectorAll('.gguide .btn')].find(x=>x.innerText.trim()==='知道了'); const r=b.getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) } })()`)
await click(okPos.x, okPos.y)
out['点知道了后引导消失'] = await ev(`!document.querySelector('.gguide')`)

// 刷新后不再出现
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}` })
await sleep(3600)
await openWorld()
out['刷新后不再出现'] = await ev(`!document.querySelector('.gguide')`)

// 切到浏览
const nodeAt = `(() => { const els=[...document.querySelectorAll('[data-nid]')].filter(e=>e.getBoundingClientRect().width>0); const el=els[Math.floor(els.length/2)]; const r=el.getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), id: el.getAttribute('data-nid'), tf: el.getAttribute('transform') } })()`
const browsePos = await ev(`(() => { const b=[...document.querySelectorAll('.graph__seg-btn')].find(x=>x.innerText.trim()==='浏览'); const r=b.getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) } })()`)
await click(browsePos.x, browsePos.y)
out['切浏览后高亮项'] = await ev(`document.querySelector('.graph__seg-btn--on')?.innerText.trim()`)
out['浏览态提示行'] = await ev(`document.querySelector('.graph__hint')?.innerText.trim()`)
const n1 = await ev(nodeAt)
await dbl(n1.x, n1.y)
out['浏览态双击不弹浮层'] = await ev(`!document.querySelector('.gedit')`)
// 拖节点：位置应不变
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: n1.x, y: n1.y, button: 'left', clickCount: 1 })
for (let i = 1; i <= 6; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: n1.x + i * 12, y: n1.y + i * 9, button: 'left' })
  await sleep(30)
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: n1.x + 72, y: n1.y + 54, button: 'left', clickCount: 1 })
await sleep(700)
const n2 = await ev(nodeAt)
out['浏览态拖节点不改位置'] = n2.tf === n1.tf
out['（对照）transform 未变'] = `${n1.tf} → ${n2.tf}`

// 切回编辑 → 双击应弹浮层
const editPos = await ev(`(() => { const b=[...document.querySelectorAll('.graph__seg-btn')].find(x=>x.innerText.trim()==='编辑'); const r=b.getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) } })()`)
await click(editPos.x, editPos.y)
out['切回编辑高亮项'] = await ev(`document.querySelector('.graph__seg-btn--on')?.innerText.trim()`)
const n3 = await ev(nodeAt)
await dbl(n3.x, n3.y)
out['编辑态双击弹浮层'] = await ev(`!!document.querySelector('.gedit')`)
out['浮层里是改实体'] = await ev(`(document.querySelector('.gedit')?.innerText || '').replace(/\s+/g,' ').slice(0, 60)`)

console.log(JSON.stringify(out, null, 1))
if (errs.length) console.log('控制台异常：\n  ' + errs.slice(0, 5).join('\n  '))
ws.close()
