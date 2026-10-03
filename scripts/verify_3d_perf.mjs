/** 三维「不该烧的帧有没有烧」的量化验收（P4.5.5）。
 *
 *  为什么要有这么个脚本：三维卡不卡是**肉眼说不清**的事 —— 「感觉有点卡」
 *  可能来自 60fps 常驻重绘、可能来自 4K 屏上按 2.5 倍像素比渲染、也可能只是
 *  主观。所以这里只量三件事，全是可以证伪的数字：
 *
 *    1. 定型之后静置 3 秒，渲染帧数应当接近 0（停帧生效）
 *    2. 鼠标动一下，帧数应当立刻回到 60fps 量级（手感没被停帧牺牲）
 *    3. 松手 ~0.5 秒后应当重新归零（不会一路烧下去）
 *
 *  用法（先起好测试实例和 headless Chrome，见 scripts/cdp.mjs 的头注释）：
 *      node scripts/verify_3d_perf.mjs [url] [railItem]
 *  默认 url = http://127.0.0.1:8799/ ，railItem = 关系网
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
      `(() => { const b=[...document.querySelectorAll('.rail__item')].find(x=>x.innerText.includes(${JSON.stringify(RAIL)})); if(!b) return 'NO RAIL'; b.click(); return 'ok' })()`,
      false,
    )
    if (clicked !== 'ok') throw new Error(`找不到导航项「${RAIL}」`)

    // 等力模拟收敛 + 取景过渡走完
    await sleep(9000)

    // 给渲染器挂计数器：WebGLRenderer.render 每被调用一次 +1。
    await evalJs(`(() => {
      const g = window.__g3d
      if (!g) return 'NO GRAPH'
      if (!window.__patched) {
        const r = g.renderer()
        const o = r.render.bind(r)
        window.__shots = 0
        r.render = (...a) => { window.__shots++; return o(...a) }
        window.__patched = true
      }
      window.__count = (ms) => new Promise(res => { window.__shots = 0; setTimeout(() => res(window.__shots), ms) })
      return 'patched'
    })()`)

    const st0 = await evalJs(`JSON.stringify(window.__g3dState?.() ?? {})`)
    const idle = await evalJs(`window.__count(3000)`)

    // 用 CDP 的 Input 域发**真实鼠标移动**（不是合成 DOM 事件）——
    // 这样才能连 OrbitControls 一起走到，等于真的有人在图上划。
    // 先问到画布在屏幕上的位置。
    const box = await evalJs(`(() => {
      const r = document.querySelector('.graph3d canvas').getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    })()`)
    const c = JSON.parse(box)
    for (let i = 0; i < 10; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x + i * 6, y: c.y + i * 3 })
    }
    const during = await evalJs(`window.__count(300)`)
    await sleep(800)
    const after = await evalJs(`window.__count(2000)`)
    const st1 = await evalJs(`JSON.stringify(window.__g3dState?.() ?? {})`)

    const fps = (n, ms) => (n / ms) * 1000

    console.log('')
    console.log('  三维渲染开关验收（P4.5.5）')
    console.log('  ' + '-'.repeat(52))
    console.log(`  ① 静置 3.0s          ${String(idle).padStart(5)} 帧   ${idle <= 3 ? '✓ 已停帧' : '✗ 还在烧'}`)
    console.log(`  ② 鼠标划过 0.3s      ${String(during).padStart(5)} 帧   ${during >= 8 ? '✓ 立刻唤醒' : '✗ 没醒'}`)
    console.log(`  ③ 松手后 2.0s        ${String(after).padStart(5)} 帧   ${after <= 3 ? '✓ 又睡回去' : '✗ 一路烧下去'}`)
    console.log('')
    console.log(`  静置 fps ≈ ${fps(idle, 3000).toFixed(1)}   交互 fps ≈ ${fps(during, 300).toFixed(0)}`)
    console.log(`  状态（定型前）${st0}`)
    console.log(`  状态（交互后）${st1}`)
    console.log('')

    const pass = idle <= 3 && during >= 8 && after <= 3
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
