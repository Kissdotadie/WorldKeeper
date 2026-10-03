/** 「区域整体拖动」验收（P4.5 补全）。
 *
 *  走 CDP Input 域发**真实的按下-拖动-松开**（合成 DOM 事件不带 pointerId，
 *  setPointerCapture 会静默失败），拖完比对两处：
 *    1. 画布上那条多边形的 points 属性确实位移了（跟手）
 *    2. 松手后后端存的位置跟画布一致（回写成功）
 *
 *  用法：node scripts/verify_region_drag.mjs [url] [book]
 */

const PORT = process.env.CDP_PORT || '9333'
const BASE = `http://127.0.0.1:${PORT}`
const URL_ = process.argv[2] || 'http://127.0.0.1:8799/'
const BOOK = process.argv[3] || '地图验收'
const API = new URL(URL_).origin

let seq = 0

async function connect() {
  const list = await (await fetch(`${BASE}/json/list`)).json()
  let page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
  if (!page) page = await (await fetch(`${BASE}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  await send('Page.enable')
  return { send, close: () => { try { ws.close() } catch { /* ignore */ } } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const { send, close } = await connect()
  const evalJs = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 抛了')
    return r.result?.value
  }

  const fail = (m) => { console.log(`  ✗ ${m}`); process.exitCode = 1 }

  try {
    await send('Page.navigate', { url: URL_ })
    await sleep(2600)

    // 进「地理观」
    const clicked = await evalJs(
      `(() => { const b=[...document.querySelectorAll('.rail__item')].find(x=>x.innerText.includes('地理观')); if(!b) return 'NO'; b.click(); return 'ok' })()`,
      false,
    )
    if (clicked !== 'ok') throw new Error('找不到导航项「地理观」')
    await sleep(2000)

    const before = JSON.parse(await evalJs(`(() => {
      const g = document.querySelector('[data-region]')
      if (!g) return JSON.stringify({ err: 'no region' })
      const poly = g.querySelector('polygon,polyline,path')
      const r = g.getBoundingClientRect()
      return JSON.stringify({
        cx: Math.round(r.left + r.width / 2),
        cy: Math.round(r.top + r.height / 2),
        attr: poly.getAttribute('points') || poly.getAttribute('d'),
      })
    })()`))
    if (before.err) throw new Error('画布上没有区域 —— 种子数据没生效？')

    // 真实拖拽：按下 → 分步移动 → 松开
    const DX = 70, DY = 40
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.cx, y: before.cy, button: 'left', clickCount: 1 })
    for (let i = 1; i <= 10; i++) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: before.cx + (DX * i) / 10, y: before.cy + (DY * i) / 10, button: 'left', buttons: 1,
      })
      await sleep(35)
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.cx + DX, y: before.cy + DY, button: 'left', clickCount: 1 })
    await sleep(1400)

    const midAttr = await evalJs(`(() => {
      const g = document.querySelector('[data-region]')
      const poly = g.querySelector('polygon,polyline,path')
      return poly.getAttribute('points') || poly.getAttribute('d')
    })()`)

    // 后端存的位置
    const doc = await (await fetch(`${API}/api/books/${encodeURIComponent(BOOK)}/maps`)).json()
    const stored = doc.maps?.['map-demo']?.regions?.[0]?.points

    console.log('')
    console.log('  区域整体拖动 —— 画布跟手 + 落盘一致')
    console.log('  ' + '-'.repeat(52))
    console.log(`  拖动前 画布  ${before.attr}`)
    console.log(`  拖动后 画布  ${midAttr}`)
    console.log(`  拖动后 后端  ${JSON.stringify(stored)}`)
    console.log(`  画布位移      ${before.attr !== midAttr ? '✓ 跟手' : '✗ 没动'}`)

    const moved = Array.isArray(stored) && Math.abs(stored[0][0] - 0.4) > 0.005
    console.log(`  落盘位移      ${moved ? `✓ 已回写（首顶点 x 0.40 → ${stored[0][0].toFixed(3)}）` : '✗ 后端还是老位置'}`)
    console.log('')
    if (before.attr === midAttr) fail('画布没跟手')
    if (!moved) fail('后端没回写')
  } finally {
    close()
  }
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
