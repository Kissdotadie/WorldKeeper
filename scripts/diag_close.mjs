/** 诊断：侧栏「选中」卡右上角的 ✕ 到底点到了什么 */
const PORT = Number(process.argv[2] || 8799)
let seq = 0
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))); ws.send(JSON.stringify({ id, method, params })) })
const ev = (js) => send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }).then((r) => r.result?.value)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(800)
}

await send('Runtime.enable')
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}` })
await sleep(3500)
await ev(`(() => { const b=[...document.querySelectorAll('.rail__item')].find(x=>x.innerText.trim().startsWith('世界观')); b?.click(); return 1 })()`)
await sleep(1500)
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='平面'); b?.click(); return 1 })()`)
await sleep(1200)

const n = await ev(`(() => { const els=[...document.querySelectorAll('[data-nid]')]; const el=els[Math.floor(els.length/2)]; const r=el.getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), id: el.getAttribute('data-nid') } })()`)
await click(n.x, n.y)
console.log('选中后 halo:', await ev(`document.querySelectorAll('.graph__halo').length`))
console.log('✕ 元素:', await ev(`(() => {
  const bs = [...document.querySelectorAll('.panel__close')]
  return bs.map(b => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), cx: Math.round(r.x+r.width/2), cy: Math.round(r.y+r.height/2), vis: getComputedStyle(b).visibility, disp: getComputedStyle(b).display, pe: getComputedStyle(b).pointerEvents } })
})()`))
console.log('该点命中:', await ev(`(() => {
  const b = document.querySelector('.panel__close'); if (!b) return 'no btn'
  const r = b.getBoundingClientRect()
  const el = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2)
  return el ? el.tagName + '.' + (el.getAttribute('class')||'') : 'none'
})()`))
console.log('视口:', await ev(`({ w: innerWidth, h: innerHeight, sx: scrollX, sy: scrollY })`))
console.log('侧栏 rect:', await ev(`(() => { const s = document.querySelector('.catalog__side'); if(!s) return 'no side'; const r = s.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })()`))
ws.close()
