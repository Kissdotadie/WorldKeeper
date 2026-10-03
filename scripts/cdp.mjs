/** 极简 CDP 客户端 —— agent-browser 的 daemon 在这台机器上起不来时用的备胎。
 *
 * 用法：
 *   node scripts/cdp.mjs nav <url>            # 导航（顺带等 2.5s）
 *   node scripts/cdp.mjs eval "<js>"          # 在页面里跑 JS，回传 JSON
 *   node scripts/cdp.mjs shot <相对路径>       # 视口截图
 *   node scripts/cdp.mjs shotfull <相对路径>   # 整页截图（长页面用，看整体版式）
 *   node scripts/cdp.mjs scroll <y>           # 滚到某个纵向位置（配合 shot 分段拍）
 *   node scripts/cdp.mjs click "<css选择器>"   # querySelector().click()
 *   node scripts/cdp.mjs text "<css选择器>"    # 取 innerText
 *   node scripts/cdp.mjs emulate [宽] [高] [倍] # 切成手机视口（默认 414x896@3）
 *   node scripts/cdp.mjs reset                # 取消手机视口模拟
 *
 * 全局开关 `--emulate`：**跨命令生效的手机视口**。
 *   node scripts/cdp.mjs --emulate nav http://127.0.0.1:8799/m
 *   node scripts/cdp.mjs --emulate shot shots/m-01.png
 *
 * 全局开关 `--viewport[=WxH[@dpr]]`：**桌面视口**（默认 1600x1000@1）。
 *   node scripts/cdp.mjs --viewport=1600x1000 nav http://127.0.0.1:8765/
 *   node scripts/cdp.mjs --viewport=1600x1000 shot shots/x.png
 * 和 `--emulate` 的区别：`emulate` 是 `mobile:true` + 触屏（会按手机 UA/布局算），
 * 只适合验移动端；截图给人看**桌面版式**时必须用 `--viewport`，否则样张会带手机味。
 *
 * 为什么需要这个：设备尺寸覆盖是**会话级**的 —— 上一条命令里改了视口，
 * 这条命令的 WebSocket 一关就失效了，页面会弹回桌面宽度。
 * 而 cdp.mjs 的每次调用都是一个独立会话，所以每条命令都得自己带上。
 *
 * 走的端口 = 环境变量 CDP_PORT（默认 9333）。
 * Node 22 的全局 WebSocket 直接够用，不引任何依赖。
 */

const PORT = process.env.CDP_PORT || '9333'
const BASE = `http://127.0.0.1:${PORT}`

let seq = 0

async function withPage(fn) {
  const list = await (await fetch(`${BASE}/json/list`)).json()
  let page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
  if (!page) {
    page = await (await fetch(`${BASE}/json/new?about:blank`, { method: 'PUT' })).json()
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

  const pending = new Map()
  const events = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else if (m.method) {
      events.push(m)
    }
  }

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, (m) =>
        m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result),
      )
      ws.send(JSON.stringify({ id, method, params }))
    })

  try {
    await send('Page.enable')
    return await fn(send, events)
  } finally {
    try { ws.close() } catch { /* 关不上就算了 */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const argv = process.argv.slice(2)
  // ---- 全局开关：--emulate[=WxH | WxH | W H]，每条命令各自生效 ----
  let emu = null
  const emuIdx = argv.findIndex((a) => a === '--emulate' || a.startsWith('--emulate='))
  if (emuIdx >= 0) {
    const inline = argv[emuIdx].includes('=') ? argv[emuIdx].split('=')[1] : ''
    const sizeArg = inline || argv[emuIdx + 1] || ''
    const consumed = inline ? 1 : 2
    const m = /^(\d+)x(\d+)(?:@(\d+))?$/.exec(sizeArg.trim())
    if (m) {
      emu = { width: +m[1], height: +m[2], dpr: +(m[3] || 3) }
      argv.splice(emuIdx, consumed)
    } else {
      emu = { width: 414, height: 896, dpr: 3 }
      argv.splice(emuIdx, 1)
    }
  }

  // ---- 全局开关：--viewport[=WxH[@dpr]]，桌面视口（mobile:false、不动 UA、不开触屏）----
  let vp = null
  const vpIdx = argv.findIndex((a) => a === '--viewport' || a.startsWith('--viewport='))
  if (vpIdx >= 0) {
    const inline = argv[vpIdx].includes('=') ? argv[vpIdx].split('=')[1] : ''
    const sizeArg = inline || argv[vpIdx + 1] || ''
    const consumed = inline ? 1 : 2
    const m = /^(\d+)x(\d+)(?:@([\d.]+))?$/.exec(sizeArg.trim())
    if (m) {
      vp = { width: +m[1], height: +m[2], dpr: +(m[3] || 1) }
      argv.splice(vpIdx, consumed)
    } else {
      vp = { width: 1600, height: 1000, dpr: 1 }
      argv.splice(vpIdx, 1)
    }
  }

  const [cmd, ...rest] = argv
  if (!cmd) {
    console.error('用法：nav <url> | eval <js> | shot <path> | click <sel> | text <sel>')
    process.exit(2)
  }

  const out = await withPage(async (send) => {
    if (emu) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: emu.width,
        height: emu.height,
        deviceScaleFactor: emu.dpr,
        mobile: true,
      })
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    }
    if (vp) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: vp.dpr,
        mobile: false,
      })
    }
    switch (cmd) {
      case 'nav': {
        await send('Page.navigate', { url: rest[0] })
        await sleep(2500)
        return 'navigated'
      }
      case 'eval': {
        const r = await send('Runtime.evaluate', {
          expression: rest[0],
          returnByValue: true,
          awaitPromise: true,
        })
        return r.result?.value
      }
      case 'shot':
      case 'shotfull': {
        const r = await send('Page.captureScreenshot', {
          format: 'png',
          // 整页：不等视口，直接把整张长图渲染出来（长看板分段拍不如一张看完）
          ...(cmd === 'shotfull' ? { captureBeyondViewport: true } : {}),
        })
        const { writeFileSync } = await import('node:fs')
        const p = new URL(`../${rest[0]}`, import.meta.url)
        writeFileSync(p, Buffer.from(r.data, 'base64'))
        return `saved ${rest[0]}`
      }
      case 'shotclip': {
        // shotclip <path> <x,y,w,h[,scale]> —— 只截视口里的一块。
        // 高清样张套路：--viewport=1600x1000@2 拿到 2x 位图，再 clip 出目标区域。
        const nums = String(rest[1] || '').split(',').map(Number)
        const [x, y, w, h, scale] = nums
        if (![x, y, w, h].every((v) => v >= 0) || !w || !h) {
          return 'shotclip 需要参数 x,y,w,h[,scale]'
        }
        const r = await send('Page.captureScreenshot', {
          format: 'png',
          clip: { x, y, width: w, height: h, scale: scale || 1 },
        })
        const { writeFileSync } = await import('node:fs')
        writeFileSync(new URL(`../${rest[0]}`, import.meta.url), Buffer.from(r.data, 'base64'))
        return `saved ${rest[0]}`
      }
      case 'scroll': {
        // 默认滚文档；给了选择器就滚那个容器（移动端是 .mob__body 在滚）
        const sel = rest[1] ? JSON.stringify(rest[1]) : 'null'
        const r = await send('Runtime.evaluate', {
          expression: `(() => {
            const box = document.querySelector(${sel})
            const el = box || document.scrollingElement || document.documentElement
            el.scrollTop = ${Number(rest[0]) || 0}
            return { top: el.scrollTop, target: box ? ${sel} : 'document' }
          })()`,
          returnByValue: true,
        })
        await sleep(350)
        return r.result?.value
      }
      case 'emulate': {
        const width = Number(rest[0]) || 414
        const height = Number(rest[1]) || 896
        const dpr = Number(rest[2]) || 3
        await send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: dpr,
          mobile: true,
        })
        // 触屏也一起开 —— 不然 `hover` 那些样式会按鼠标算，看不出手机上的真实观感
        await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
        return `emulated ${width}x${height}@${dpr}`
      }
      case 'reset': {
        await send('Emulation.clearDeviceMetricsOverride')
        await send('Emulation.setTouchEmulationEnabled', { enabled: false })
        return 'reset'
      }
      case 'click': {
        const r = await send('Runtime.evaluate', {
          expression: `(() => { const el = document.querySelector(${JSON.stringify(rest[0])}); if (!el) return 'NO MATCH'; el.click(); return 'clicked ' + el.tagName; })()`,
          returnByValue: true,
        })
        return r.result?.value
      }
      case 'text': {
        const r = await send('Runtime.evaluate', {
          expression: `document.querySelector(${JSON.stringify(rest[0])})?.innerText ?? 'NO MATCH'`,
          returnByValue: true,
        })
        return r.result?.value
      }
      default:
        throw new Error(`未知命令：${cmd}`)
    }
  })

  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2))
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
