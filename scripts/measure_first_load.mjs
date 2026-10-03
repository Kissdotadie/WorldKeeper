/** 量首屏：全新导航后（不点任何图视图），统计实际下载的 JS 体积。 */
const PORT = 9333
const BASE = `http://127.0.0.1:${PORT}`
let seq = 0

const list = await (await fetch(`${BASE}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)))
  ws.send(JSON.stringify({ id, method, params }))
})

await send('Network.enable')
await send('Network.clearBrowserCache')
const url = process.argv[2] || 'http://127.0.0.1:8765'

// `--fresh`：先清掉本地存的布局与偏好，量「第一次打开」的首屏。
// 不清的话量到的是「用户自己的布局」——里面本来就开着几张图，3D 包是该下的，
// 把它算进首屏不公平（但也要量，能看出布局恢复的代价）。
if (process.argv.includes('--fresh')) {
  await send('Page.navigate', { url })
  await new Promise((r) => setTimeout(r, 1500))
  await send('Runtime.evaluate', { expression: 'localStorage.clear(); sessionStorage.clear()' })
  await send('Network.clearBrowserCache')
}
await send('Page.navigate', { url })
await new Promise((r) => setTimeout(r, 4000))

const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const res = performance.getEntriesByType('resource').filter(e => e.name.includes('/assets/'))
    const js = res.filter(e => e.name.endsWith('.js'))
    const sum = (a) => a.reduce((s, e) => s + (e.encodedBodySize || e.transferSize || 0), 0)
    return {
      jsCount: js.length,
      jsBytes: sum(js),
      jsFiles: js.map(e => e.name.split('/').pop() + ' ' + Math.round((e.encodedBodySize||0)/1024) + 'KB'),
      cssBytes: sum(res.filter(e => e.name.endsWith('.css'))),
      fetched3d: js.some(e => e.name.includes('vendor-3d')),
    }
  })()`,
  returnByValue: true,
})
const v = r.result.value
console.log(`首屏 JS 文件数: ${v.jsCount}`)
console.log(`首屏 JS 合计  : ${(v.jsBytes / 1024).toFixed(0)} KB (gzip 传输)`)
console.log(`首屏 CSS 合计 : ${(v.cssBytes / 1024).toFixed(0)} KB (gzip 传输)`)
console.log(`是否下载了 3D 包: ${v.fetched3d ? '是（不该）' : '否（正确，按需加载）'}`)
console.log('明细：')
for (const f of v.jsFiles) console.log('  ' + f)
ws.close()
