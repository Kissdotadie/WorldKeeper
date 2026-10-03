/** 停帧状态下拖拽转视角的手感回归（P4.5.5）。
 *
 *  停帧最怕的就是「图是省电了，但拖一下没反应」—— 那不是优化，是坏掉。
 *  这里走 CDP 的 Input 域发**真实的按下-拖动-松开**（不是合成 DOM 事件，
 *  那样 OrbitControls 根本不理），然后比对相机位置：动了 = 手感还在。
 *
 *  用法：node scripts/verify_3d_drag.mjs [url] [railItem]
 */

const PORT = process.env.CDP_PORT || '9333'
const BASE = `http://127.0.0.1:${PORT}`
const URL_ = process.argv[2] || 'http://127.0.0.1:8799/'
const RAIL = process.argv[3] || '关系网'

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

  try {
    await send('Page.navigate', { url: URL_ })
    await sleep(2500)
    const clicked = await evalJs(
      `(() => { const b=[...document.querySelectorAll('.rail__item')].find(x=>x.innerText.includes(${JSON.stringify(RAIL)})); if(!b) return 'NO'; b.click(); return 'ok' })()`,
      false,
    )
    if (clicked !== 'ok') throw new Error(`找不到导航项「${RAIL}」`)
    await sleep(9000)

    const at = JSON.parse(await evalJs(`(() => {
      const r = document.querySelector('.graph3d canvas').getBoundingClientRect()
      // 从左上角内侧起步：正中心多半压着节点，一拖就变成「拖节点」而不是
      // 「转视角」—— 那是另一个功能，不是这里要验的。
      return JSON.stringify({ x: Math.round(r.left + 60), y: Math.round(r.top + 50) })
    })()`))
    const before = JSON.parse(await evalJs(`JSON.stringify(window.__g3d.cameraPosition())`))
    const stBefore = await evalJs(`JSON.stringify(window.__g3dState?.() ?? {})`)

    // 真实拖拽：按下 → 分步移动 → 松开（每步间隔要让浏览器消化）
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    for (let i = 1; i <= 12; i++) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: at.x + i * 14, y: at.y + i * 5, button: 'left', buttons: 1,
      })
      await sleep(40)
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x + 168, y: at.y + 60, button: 'left', clickCount: 1 })
    await sleep(1200)

    const after = JSON.parse(await evalJs(`JSON.stringify(window.__g3d.cameraPosition())`))
    const stAfter = await evalJs(`JSON.stringify(window.__g3dState?.() ?? {})`)

    const d = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z)
    console.log('')
    console.log('  停帧下拖拽转视角 —— 手感回归')
    console.log('  ' + '-'.repeat(52))
    console.log(`  拖前状态  ${stBefore}`)
    console.log(`  拖后状态  ${stAfter}`)
    console.log(`  相机位移  ${d.toFixed(1)}   ${d > 5 ? '✓ 视角转得动' : '✗ 拖了没反应'}`)
    console.log('')
    process.exitCode = d > 5 ? 0 : 1
  } finally {
    close()
  }
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
