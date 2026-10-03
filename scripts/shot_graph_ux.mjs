/** 截图 P11-2️⃣① 的引导浮层、工具条两态、hover 环。用法：node shot_graph_ux.mjs <port> <dir> */
const PORT = Number(process.argv[2] || 8799)
const DIR = process.argv[3] || '.'
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
const fs = await import('node:fs')
const shotFile = async (file, clip) => {
  const s = await send('Page.captureScreenshot', clip ? { format: 'png', clip: { ...clip, scale: 2 } } : { format: 'png' })
  fs.writeFileSync(file, Buffer.from(s.data, 'base64'))
}
const rectOf = (sel) =>
  ev(
    "(function(){var e=document.querySelector('" + sel + "');if(!e)return null;var r=e.getBoundingClientRect();" +
      "return {x:Math.max(0,Math.round(r.x)-8),y:Math.max(0,Math.round(r.y)-8),width:Math.round(r.width)+16,height:Math.round(r.height)+16}})()",
  )
const clickSelText = async (sel, text) => {
  const p = await ev(
    "(function(){var bs=[].slice.call(document.querySelectorAll('" + sel + "'));" +
      "var b=bs.filter(function(x){return x.innerText.trim()==='" + text + "'})[0];if(!b)return null;" +
      "var r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()",
  )
  if (!p) return false
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await sleep(700)
  return true
}

await send('Runtime.enable')
await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT })
await sleep(3600)
await ev("localStorage.removeItem('wkv.graphGuide.v1')")
await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT })
await sleep(3600)
await ev("(function(){var b=[].slice.call(document.querySelectorAll('.rail__item')).filter(function(x){return x.innerText.trim().indexOf('世界观')===0})[0];if(b)b.click();return 1})()")
await sleep(1800)
await ev("(function(){var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){return x.innerText.trim()==='平面'})[0];if(b)b.click();return 1})()")
await sleep(1600)

await shotFile(DIR + '/P11-2①-引导浮层.png')

await clickSelText('.gguide .btn', '知道了')

// hover 一个节点看细灰环
const n = await ev(
  "(function(){var els=[].slice.call(document.querySelectorAll('[data-nid]')).filter(function(e){return e.getBoundingClientRect().width>0});" +
    "var el=els[Math.floor(els.length/3)];var r=el.getBoundingClientRect();" +
    "return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()",
)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: n.x, y: n.y })
await sleep(600)
console.log('hover 细环数量:', await ev("document.querySelectorAll('.graph__hoverring').length"))
console.log('节点光标:', await ev("(function(){var el=document.elementFromPoint(" + n.x + "," + n.y + ");var g=el&&el.closest?el.closest('[data-nid]'):null;return g?getComputedStyle(g).cursor:'none'})()"))

await shotFile(DIR + '/P11-2①-工具条编辑态.png', await rectOf('.graph__toolbar'))

await clickSelText('.graph__seg-btn', '浏览')
await shotFile(DIR + '/P11-2①-工具条浏览态.png', await rectOf('.graph__toolbar'))

// 恢复成编辑态 + 引导标记（别把复现实例留在奇怪状态）
await clickSelText('.graph__seg-btn', '编辑')
ws.close()
