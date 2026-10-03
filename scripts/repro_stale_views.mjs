/**
 * 复现「删掉实体后，某些视图还留着它」。
 *
 * 用法：
 *   node scripts/repro_stale_views.mjs <port> [--delete] [--probe=名字片段]
 *
 * 流程：
 *   A 逐个视图打开，记下探针在不在（基线）
 *   B --delete：从「全部实体」界面上把它删掉（走真实的界面删除路径）
 *   C **不刷新页面**再逐个视图看一遍 —— 谁还留着，谁就是没失效的那个
 *
 * 只在副本实例（WKV_DATA_DIR 注入）上用，别对着真实数据跑。
 */

const PORT = Number(process.argv[2] || 8799)
const DO_DELETE = process.argv.includes('--delete')
const PROBE = (process.argv.find((a) => a.startsWith('--probe=')) || '').split('=')[1] ||
  'ZZ_RESIDUE_PROBE'

const NAMES = ['汇总', '世界观', '地理观', '名册录', '方法论', '历史观', '时间线', '剧情线', '伏笔', '关系网', '全部实体', '正文', '技能中心', '工具箱', '设置']

let seq = 0
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
const pending = new Map()
const errs = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  else if (m.method === 'Runtime.exceptionThrown') {
    errs.push(String(m.params.exceptionDetails.exception?.description || '').slice(0, 160))
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)))
  ws.send(JSON.stringify({ id, method, params }))
})
const ev = (js) => send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }).then((r) => r.result?.value)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Runtime.enable')
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}` })
await sleep(3500)
// 删除会弹 confirm，先让它自动通过
await ev('window.confirm = () => true; "confirm-stubbed"')

/** 点左侧导航项 */
const openView = async (name) => {
  await ev(`(() => {
    const b = [...document.querySelectorAll('.rail__item')].find((x) => x.innerText.trim().startsWith(${JSON.stringify(name)}))
    if (!b) return 'NO'
    b.click(); return 'ok'
  })()`)
  await sleep(600)
}

/** 当前 dock 里有没有探针字样 */
const probeVisible = () => ev(`(() => {
  const dock = document.querySelector('.dock') || document.body
  return dock.innerText.includes(${JSON.stringify(PROBE)})
})()`)

const scan = async () => {
  const out = {}
  for (const n of NAMES) {
    await openView(n)
    out[n] = await probeVisible()
  }
  return out
}

console.log(`探针：${PROBE}`)
const before = await scan()
console.log('删除前——出现探针的视图：', Object.entries(before).filter(([, v]) => v).map(([k]) => k).join('、') || '（无）')

if (!DO_DELETE) {
  console.log('\n（未加 --delete，只报基线）')
  ws.close()
  process.exit(0)
}

// ---- B 从界面上删掉它 ----
await openView('全部实体')
await ev(`(() => {
  const input = document.querySelector('.search__input')
  if (!input) return 'NO_SEARCH'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, ${JSON.stringify(PROBE)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return 'searched'
})()`)
await sleep(1200)

const hit = await ev(`(() => {
  const rows = [...document.querySelectorAll('.etable__tr, .card, [class*=etable] tr')]
  const row = rows.find((r) => r.innerText.includes(${JSON.stringify(PROBE)}))
  if (!row) return 'NO_ROW'
  row.click(); return 'row-clicked'
})()`)
await sleep(1200)

const delBtn = await ev(`(() => {
  const b = [...document.querySelectorAll('.dock button')].find((x) => x.innerText.trim() === '删除')
  if (!b) return 'NO_DELETE_BTN'
  b.click(); return 'delete-clicked'
})()`)
await sleep(1800)

const readAfterDelete = await ev(`(() => {
  const dock = document.querySelector('.dock') || document.body
  const i = dock.innerText.indexOf(${JSON.stringify(PROBE)})
  return { stillThere: i >= 0, ctx: i >= 0 ? dock.innerText.slice(Math.max(0, i - 60), i + 60) : '' }
})()`)
console.log(`\n删除动作：${hit} / ${delBtn}`)
console.log(`删除后立刻看：探针还在页面上吗 → ${readAfterDelete.stillThere ? '还在' : '已消失'}`)
if (readAfterDelete.stillThere) console.log(`  上下文：…${readAfterDelete.ctx.replace(/\s+/g, ' ')}…`)

// ---- C 不刷新页面，逐视图复查 ----
const after = await scan()
const stale = Object.entries(after).filter(([k, v]) => v && before[k]).map(([k]) => k)
console.log('\n删除后（未刷新页面）仍出现探针的视图：')
console.log(stale.length ? '  ❌ ' + stale.join('、') : '  ✅ 全部视图都已同步')
console.log('（对照）删除前就出现的视图：', Object.entries(before).filter(([, v]) => v).map(([k]) => k).join('、') || '（无）')

if (errs.length) console.log('\n控制台异常：\n  ' + errs.slice(0, 5).join('\n  '))
ws.close()
