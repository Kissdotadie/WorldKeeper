/** 时间线三维（Timeline3D）停帧验收（P4.5.5）。
 *
 *  Timeline3D 是手写 renderer，拿不到实例，所以这里不数 renderer.render，
 *  改数**全局 rAF 的登记次数** —— 页面上只有这一个三维循环在用 rAF，
 *  静置时它应当归零，鼠标一动应当立刻回到 60fps 量级，松手后归零。
 *
 *  用法：node scripts/verify_3d_timeline.mjs [url]
 */

const PORT = process.env.CDP_PORT || '9333'
const BASE = `http://127.0.0.1:${PORT}`
const URL_ = process.argv[2] || 'http://127.0.0.1:8799/'

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
    const step = await evalJs(`(() => {
      const rail = [...document.querySelectorAll('.rail__item')].find(x=>x.innerText.includes('时间线'))
      if (!rail) return 'NO RAIL'
      rail.click()
      return 'ok'
    })()`, false)
    if (step !== 'ok') throw new Error('进不去时间线')
    await sleep(1500)
    const step2 = await evalJs(`(() => {
      const b = [...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='三维长河')
      if (!b) return 'NO BTN'
      b.click()
      return 'ok'
    })()`, false)
    if (step2 !== 'ok') throw new Error('没有「三维长河」按钮')
    await sleep(4000)

    // 装 rAF 计数器
    await evalJs(`(() => {
      if (!window.__rafPatch) {
        const o = window.requestAnimationFrame.bind(window)
        window.__raf = 0
        window.requestAnimationFrame = (cb) => { window.__raf++; return o(cb) }
        window.__rafPatch = true
      }
      window.__count = (ms) => new Promise(res => { window.__raf = 0; setTimeout(() => res(window.__raf), ms) })
      return 'ok'
    })()`)

    const idle = await evalJs(`window.__count(2000)`)
    const at = JSON.parse(await evalJs(`(() => {
      const r = document.querySelector('.graph3d--timeline canvas').getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    })()`))

    // 真实拖拽（OrbitControls 需要真事件）
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    for (let i = 1; i <= 10; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x + i * 10, y: at.y + i * 4, button: 'left', buttons: 1 })
      await sleep(35)
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x + 100, y: at.y + 40, button: 'left', clickCount: 1 })
    const during = await evalJs(`window.__count(1200)`)

    // 等阻尼滑行停稳
    await sleep(1500)
    const after = await evalJs(`window.__count(2000)`)

    console.log('')
    console.log('  时间线三维（Timeline3D）停帧验收')
    console.log('  ' + '-'.repeat(52))
    console.log(`  ① 静置 2.0s        ${String(idle).padStart(5)} 次 rAF   ${idle <= 3 ? '✓ 已停帧' : '✗ 常驻 60fps'}`)
    console.log(`  ② 拖拽 1.2s        ${String(during).padStart(5)} 次 rAF   ${during >= 30 ? '✓ 立刻唤醒' : '✗ 没醒'}`)
    console.log(`  ③ 稳住后 2.0s      ${String(after).padStart(5)} 次 rAF   ${after <= 3 ? '✓ 滑行结束就睡' : '✗ 睡不回去'}`)
    console.log('')
    const pass = idle <= 3 && during >= 30 && after <= 3
    console.log(pass ? '  结论：通过' : '  结论：未通过')
    console.log('')
    process.exitCode = pass ? 0 : 1
  } finally {
    close()
  }
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
