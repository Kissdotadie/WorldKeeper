/** 「图上删关系」验收（P4.5 补全 ②）。
 *
 *  流程：关系网里双击「灰堡城」→ 弹出就地编辑浮层 → 关联清单里点 ✕
 *        → 比对后端档案里的「关联」段确实少了一行。
 *
 *  用法：node scripts/verify_graph_rel_delete.mjs [url] [book] [entityId]
 */

const PORT = process.env.CDP_PORT || '9333'
const BASE = `http://127.0.0.1:${PORT}`
const URL_ = process.argv[2] || 'http://127.0.0.1:8799/'
const BOOK = process.argv[3] || '地图验收'
const ENT = process.argv[4] || 'loc-0002'
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

  const relsOf = async () => {
    const doc = await (await fetch(`${API}/api/books/${encodeURIComponent(BOOK)}/entities/${ENT}`)).json()
    return doc.body?.关联 ?? []
  }

  try {
    const relsBefore = await relsOf()

    await send('Page.navigate', { url: URL_ })
    await sleep(2600)
    const clicked = await evalJs(
      `(() => { const b=[...document.querySelectorAll('.rail__item')].find(x=>x.innerText.includes('关系网')); if(!b) return 'NO'; b.click(); return 'ok' })()`,
      false,
    )
    if (clicked !== 'ok') throw new Error('找不到导航项「关系网」')
    await sleep(2500)

    // 切到平面档 —— 三维是 canvas，没有 DOM 节点可点；平面档的节点带 data-nid
    const flat = await evalJs(
      `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='平面'); if(!b) return 'NO'; b.click(); return 'ok' })()`,
      false,
    )
    if (flat !== 'ok') throw new Error('找不到「平面」模式按钮')
    await sleep(3000)

    // 找到这个节点在屏幕上的位置（2D / 3D 都可能命中，挑可见的那个）
    const at = JSON.parse(await evalJs(`(() => {
      const els = [...document.querySelectorAll('[data-nid="${ENT}"]')]
      for (const el of els) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) })
      }
      return JSON.stringify({ err: 'no visible node', n: els.length })
    })()`))
    if (at.err) throw new Error(`关系网里找不到节点 —— ${at.err}（命中 ${at.n} 个）`)

    // 双击 → 就地编辑浮层
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 2 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 2 })
    await sleep(1500)

    const panel = JSON.parse(await evalJs(`(() => {
      const box = document.querySelector('.gedit__rels')
      const rows = [...document.querySelectorAll('.gedit__rel')].map(r => r.querySelector('.gedit__rel-text')?.innerText ?? '')
      return JSON.stringify({ has: !!box, rows })
    })()`))

    console.log('')
    console.log('  图上删关系 —— 浮层清单 → 点 ✕ → 档案真的少了那一行')
    console.log('  ' + '-'.repeat(52))
    console.log(`  档案拖动前  ${JSON.stringify(relsBefore)}`)
    console.log(`  浮层关联清单 ${panel.has ? JSON.stringify(panel.rows) : '✗ 没弹出关联清单'}`)

    if (!panel.has) { console.log('  ✗ 双击没弹出就地编辑浮层'); process.exitCode = 1; return }

    // 点第一行的 ✕
    const clickedDel = await evalJs(
      `(() => { const b=document.querySelector('.gedit__rel-del'); if(!b) return 'NO'; b.click(); return 'ok' })()`,
      false,
    )
    if (clickedDel !== 'ok') { console.log('  ✗ 找不到 ✕ 按钮'); process.exitCode = 1; return }
    await sleep(1800)

    const probe = JSON.parse(await evalJs(`(() => JSON.stringify({
      gedit: document.querySelectorAll('.gedit').length,
      relsBox: document.querySelectorAll('.gedit__rels').length,
      rows: [...document.querySelectorAll('.gedit__rel')].map(r => r.querySelector('.gedit__rel-text')?.innerText ?? ''),
    }))()`))

    const relsAfter = await relsOf()
    const rowsAfter = probe.rows

    console.log(`  档案拖动后  ${JSON.stringify(relsAfter)}`)
    console.log(`  浮层刷新后  ${JSON.stringify(rowsAfter)}   （浮层在=${probe.gedit} 清单块=${probe.relsBox}）`)

    // 接着删第二条 —— 浮层应当还留着，不用重新双击节点
    const clickedDel2 = await evalJs(
      `(() => { const b=document.querySelector('.gedit__rel-del'); if(!b) return 'NO'; b.click(); return 'ok' })()`,
      false,
    )
    await sleep(1800)
    const probe2 = JSON.parse(await evalJs(`(() => JSON.stringify({
      gedit: document.querySelectorAll('.gedit').length,
      relsBox: document.querySelectorAll('.gedit__rels').length,
      rows: [...document.querySelectorAll('.gedit__rel')].map(r => r.querySelector('.gedit__rel-text')?.innerText ?? ''),
    }))()`))
    const relsAfter2 = await relsOf()
    console.log(`  连删第二条  ${clickedDel2 === 'ok' ? '✓ 浮层里还有 ✕ 可点' : '✗ 浮层已关，删不了第二条'}`)
    console.log(`  再删后档案  ${JSON.stringify(relsAfter2)}   浮层在=${probe2.gedit} 清单块=${probe2.relsBox}`)

    const gone = relsBefore.length === relsAfter.length + 1
    console.log(`  结果        ${gone ? '✓ 档案少了一条，浮层跟着刷新' : '✗ 档案没变'}`)
    console.log('')
    if (!gone) process.exitCode = 1
    if (relsBefore.length >= 2) {
      const gone2 = relsAfter2.length === relsAfter.length - 1
      console.log(`  连删能力    ${gone2 && clickedDel2 === 'ok' ? '✓ 连删两条不用重开浮层' : '✗ 第二条没删掉'}`)
      console.log('')
      if (!gone2) process.exitCode = 1
    }
  } finally {
    close()
  }
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
