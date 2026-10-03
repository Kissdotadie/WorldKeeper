/** 逐个打开每个导航项，检查懒加载视图是否正常渲染、控制台有没有报错。 */
const PORT = 9333
const BASE = `http://127.0.0.1:${PORT}`
let seq = 0

async function withPage(fn) {
  const list = await (await fetch(`${BASE}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  const pending = new Map()
  const errs = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errs.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
    } else if (m.method === 'Runtime.exceptionThrown') {
      errs.push('EXC: ' + String(m.params.exceptionDetails.exception?.description || '').slice(0, 200))
    }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
  try { await send('Runtime.enable'); await send('Page.enable'); return await fn(send, errs) }
  finally { try { ws.close() } catch { /* ignore */ } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (send, js) =>
  send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }).then((r) => r.result?.value)

const NAMES = ['汇总', '世界观', '地理观', '名册录', '方法论', '历史观', '时间线', '剧情线', '伏笔', '关系网', '全部实体', '正文', '技能中心', '工具箱', '设置']

await withPage(async (send, errs) => {
  const out = []
  for (const n of NAMES) {
    const clicked = await ev(send, `(() => {
      const b = [...document.querySelectorAll('.rail__item')].find((x) => x.innerText.trim().startsWith(${JSON.stringify(n)}))
      if (!b) return 'NO_RAIL_ITEM'
      b.click()
      return 'ok'
    })()`)
    await sleep(700)
    const st = await ev(send, `(() => {
      const load = document.querySelector('.dock__loading')
      const g = document.querySelector('.dv-active-group')
      const txt = (g?.innerText || '').replace(/\\s+/g, ' ').trim()
      return { loading: !!load, len: txt.length, head: txt.slice(0, 40) }
    })()`)
    out.push({ view: n, clicked, ...st })
  }
  console.log(JSON.stringify({ views: out, errors: errs.slice(0, 10) }, null, 1))
})
