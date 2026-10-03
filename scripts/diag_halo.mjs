/** 诊断：点空白后那个 halo 到底是什么（选中？hover？搜索高亮？） */
const PORT = Number(process.argv[2] || 8799)
let seq = 0
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
const pending = new Map()
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))); ws.send(JSON.stringify({ id, method, params })) })
const ev = (js) => send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }).then((r) => r.result?.value)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Runtime.enable')
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}` })
await sleep(3500)
await ev(`(() => { const b=[...document.querySelectorAll('.rail__item')].find(x=>x.innerText.trim().startsWith('世界观')); b?.click(); return 1 })()`)
await sleep(1500)
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='平面'); b?.click(); return 1 })()`)
await sleep(1200)

const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(800)
}

const n = await ev(`(() => {
  const els = [...document.querySelectorAll('[data-nid]')]
  const el = els[Math.floor(els.length / 2)]
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), id: el.getAttribute('data-nid') }
})()`)
await click(n.x, n.y)
console.log('点节点后 halos:', await ev(`[...document.querySelectorAll('.graph__halo')].map(h => ({ parent: h.parentElement?.getAttribute('data-nid'), cls: h.getAttribute('class'), stroke: h.getAttribute('style') }))`))

const bg = await ev(`(() => { const svg = document.querySelector('.dock svg'); const r = svg.getBoundingClientRect(); return { x: Math.round(r.x+24), y: Math.round(r.y+24), w: Math.round(r.width), h: Math.round(r.height) } })()`)
await click(bg.x, bg.y)
console.log('点空白后 halos:', await ev(`[...document.querySelectorAll('.graph__halo')].map(h => ({ parent: h.parentElement?.getAttribute('data-nid'), cls: h.getAttribute('class'), stroke: h.getAttribute('style') }))`))
console.log('搜索框的值:', await ev(`document.querySelector('.search__input')?.value`))
console.log('悬停目标(24,24):', await ev(`(() => { const el = document.elementFromPoint(${bg.x}, ${bg.y}); return el ? el.tagName + '.' + (el.getAttribute('class')||'') : 'none' })()`))
ws.close()
