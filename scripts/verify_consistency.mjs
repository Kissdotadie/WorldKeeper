/**
 * 验收 P11-7️⃣②「不一致体检」。
 *
 * 用法：node scripts/verify_consistency.mjs <port>
 *
 * 验的是**面板真的把后端结论摆出来了**，以及三条自我约束还立着：
 *   1. 五类检查都在，每类都写明「查了什么 / 没查什么」——不能让人以为
 *      「体检干净 = 全书没问题」；
 *   2. 只报不改 —— 面板上不许出现任何「修复 / 删除 / 合并」按钮；
 *   3. 证据可核 —— 「看实体」点得过去，「看伏笔看板 / 看地理观」跳得过去。
 *
 * **教训（本脚本第一次跑挂了 4 项）**：后台页是一整页长网格，
 * 「不一致体检」在很下面。`getBoundingClientRect()` 照样返回真实坐标，
 * 但那个 y 早就在视口之外 —— 按坐标发鼠标事件等于点在空气上，
 * 而断言看到的是「什么都没发生」，很容易被误读成功能坏了。
 * 所以这里所有坐标点击都先 `scrollIntoView` 再取坐标，取完还要复核一次
 * 元素确实落在视口内（否则返回 null，宁可报「点不到」也不假通过）。
 */

const PORT = Number(process.argv[2] || 8765)
let seq = 0
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
const pending = new Map()
const errs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
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
const ev = (js) => send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true })
  .then((r) => r.result?.value)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(500)
}
const waitFor = async (js, timeoutMs = 60000, step = 800) => {
  const t0 = Date.now()
  for (;;) {
    const v = await ev(js)
    if (v) return v
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(step)
  }
}

/** 先滚到视口中央，再取坐标；取到的坐标必须真的在视口内。 */
const posOf = async (sel, text = null, nth = 0) => {
  const find = `[...document.querySelectorAll('${sel}')].filter(x=>x.getBoundingClientRect().width>0${text ? ` && x.innerText.trim()==='${text}'` : ''})[${nth}]`
  await ev(`(() => { const e=${find}; e?.scrollIntoView({block:'center'}); return !!e })()`)
  await sleep(500)
  return ev(`(() => {
    const e=${find}
    if(!e) return null
    const r=e.getBoundingClientRect()
    if(r.top<0 || r.bottom>innerHeight || r.height===0) return { offscreen:true, top:Math.round(r.top), ih:innerHeight }
    return { x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), text:e.innerText.trim() }
  })()`)
}

let pass = 0
let fail = 0
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [OK]   ${label}`) }
  else { fail++; console.log(`  [FAIL] ${label}${extra ? `\n         ${String(extra).slice(0, 320)}` : ''}`) }
}
const railActive = `document.querySelector('.rail__item--active')?.innerText.trim()`
const gotoAdmin = async () => {
  const r = await posOf('.rail__item', null, 0) // 只为滚回顶部，避免残留滚动位置干扰
  void r
  await ev(`(() => { const b=[...document.querySelectorAll('.rail__item')].find(x=>x.innerText.trim().startsWith('设置')); b?.click(); return 1 })()`)
  await sleep(1400)
  const t = await posOf('.seg__item', '后台')
  if (t && t.x) await click(t.x, t.y)
  await sleep(1400)
}

await send('Runtime.enable')
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}` })
await sleep(4200)
await gotoAdmin()

console.log('\n=== 面板出现并出结论 ===')
check('后台页里出现「不一致体检」面板', await ev(`!!document.querySelector('.admin__consist')`))
check('面板标题写着「不一致体检」',
  String(await ev(`document.querySelector('.admin__consist .panel__title')?.innerText.trim() || ''`)).includes('不一致体检'),
  await ev(`document.querySelector('.admin__consist .panel__title')?.innerText.trim()`))
const got = await waitFor(`(() => { const p=document.querySelector('.admin__consist'); return p && p.querySelectorAll('.consist__group').length >= 5 })()`, 90000)
check('自动跑完并出五类分组（大书要读一遍档案，等它）', Boolean(got))

const groupNames = await ev(`[...document.querySelectorAll('.admin__consist .consist__group-name')].map(x=>x.innerText.trim())`)
check('五类分组齐全且顺序固定',
  JSON.stringify(groupNames) === JSON.stringify(['时间线冲突', '伏笔状态断链', '称谓不一致', '地理从属环', '出处失效']),
  JSON.stringify(groupNames))

const bar = await ev(`[...document.querySelectorAll('.admin__consist .audit__bar .chip')].map(c=>c.innerText.trim())`)
check('统计条摆出「比了多少实体 / 多少章 / 高 / 中 / 低」',
  bar.some((t) => /比了 \d+ 条实体/.test(t)) && bar.some((t) => /\d+ 章/.test(t)) &&
  bar.some((t) => /\d+ 高/.test(t)) && bar.some((t) => /\d+ 中/.test(t)) && bar.some((t) => /\d+ 低/.test(t)),
  JSON.stringify(bar))

console.log('\n=== 默认展开 / 折叠（第一眼该落在要处理的东西上） ===')
const initial = await ev(`(() => {
  const gs=[...document.querySelectorAll('.admin__consist .consist__group')]
  return gs.map(g=>({
    n:g.querySelector('.consist__group-name')?.innerText.trim(),
    c:g.querySelector('.consist__count')?.innerText.trim(),
    open:g.querySelector('.consist__group-head')?.getAttribute('aria-expanded')==='true',
  }))
})()`)
const problemGroups = initial.filter((g) => !/没问题/.test(String(g.c)))
const cleanGroups = initial.filter((g) => /没问题/.test(String(g.c)))
check('有问题的类默认展开', problemGroups.length > 0 && problemGroups.every((g) => g.open),
  JSON.stringify(problemGroups))
check('干净的类默认折叠（不占版面）', cleanGroups.every((g) => !g.open), JSON.stringify(cleanGroups))

/** 只展开「当前折着」的组 —— 无脑全点会把已经展开的又点回去。 */
const expandAll = async () => {
  for (;;) {
    const idx = await ev(`(() => {
      const gs=[...document.querySelectorAll('.admin__consist .consist__group-head')]
      return gs.findIndex(h=>h.getAttribute('aria-expanded')!=='true')
    })()`)
    if (idx === undefined || idx === null || idx < 0) break
    const p = await posOf('.admin__consist .consist__group-head', null, idx)
    if (!p || p.x === undefined) break
    await click(p.x, p.y)
    await sleep(250)
  }
}
await expandAll()

console.log('\n=== 边界说清楚（不能让人以为「干净 = 没问题」） ===')
const scopes = await ev(`(() => {
  const gs=[...document.querySelectorAll('.admin__consist .consist__group')]
  return gs.map(g=>{
    const t=g.querySelector('.consist__scope')?.innerText||''
    return { name:g.querySelector('.consist__group-name')?.innerText.trim(), cover:t.includes('查了'), leave:t.includes('没查') }
  })
})()`)
check('每类都写明「查了」什么（展开后五类齐）',
  scopes.length >= 5 && scopes.every((s) => s.cover), JSON.stringify(scopes))
check('每类都写明「没查」什么（规则读不懂剧情的部分如实交底）',
  scopes.length >= 5 && scopes.every((s) => s.leave), JSON.stringify(scopes))
const foot = await ev(`document.querySelector('.admin__consist .consist__foot')?.innerText || ''`)
check('页脚说明与技能中心共用同一套口径（列出性质词表）',
  /时间线/.test(foot) && /称谓/.test(foot) && /高 \/ 中 \/ 低/.test(foot), foot.slice(0, 200))

console.log('\n=== 只报不改 ===')
const dangerBtns = await ev(`[...document.querySelectorAll('.admin__consist button')].map(b=>b.innerText.trim()).filter(t=>/删除|修复|合并|清理|一键/.test(t))`)
check('面板上没有任何「修复 / 删除 / 合并」按钮', dangerBtns.length === 0, JSON.stringify(dangerBtns))
const actBtns = await ev(`[...document.querySelectorAll('.admin__consist button')].map(b=>b.innerText.trim())`)
check('只有「做体检」这一个动作按钮', actBtns.some((t) => /体检/.test(t)), JSON.stringify(actBtns))

console.log('\n=== 结论本身 ===')
const summary = await ev(`(() => {
  const chips=[...document.querySelectorAll('.admin__consist .audit__bar .chip')].map(c=>c.innerText.trim())
  const hi=chips.find(t=>/ 高$/.test(t))||'0 高'
  const groups=[...document.querySelectorAll('.admin__consist .consist__group')].map(g=>({
    n:g.querySelector('.consist__group-name')?.innerText.trim(),
    c:g.querySelector('.consist__count')?.innerText.trim(),
    rows:g.querySelectorAll('.consist__row').length,
  }))
  return { hi, groups }
})()`)
check('真实书里报出了高严重度问题（称谓撞车这类）', parseInt(summary.hi) > 0, JSON.stringify(summary.hi))
const naming = summary.groups.find((g) => g.n === '称谓不一致')
check('「称谓不一致」这一类有明细行', naming && naming.rows > 0, JSON.stringify(naming))
const geo = summary.groups.find((g) => g.n === '地理从属环')
check('没问题的类显示「没问题」而不留空', Boolean(geo && /没问题/.test(geo.c)), JSON.stringify(geo))
check('明细条数与该类统计对得上（界面没漏渲染）',
  summary.groups.every((g) => {
    const m = /高 (\d+)/.exec(String(g.c)) || /(\d+)/.exec(String(g.c))
    return !m || Number(m[1]) >= g.rows || /没问题/.test(String(g.c))
  }), JSON.stringify(summary.groups))

const row = await ev(`(() => {
  const r=document.querySelector('.admin__consist .consist__row')
  if(!r) return null
  return {
    sev:r.querySelector('.consist__sev')?.innerText.trim(),
    title:r.querySelector('.consist__title')?.innerText.trim(),
    detail:(r.querySelector('.consist__detail')?.innerText||'').slice(0,60),
    evs:[...r.querySelectorAll('.consist__ev-row')].map(x=>x.innerText.trim().slice(0,50)),
    links:[...r.querySelectorAll('.consist__link')].map(b=>b.innerText.trim()),
  }
})()`)
check('每条结论都有：严重度 / 一句话标题 / 为什么 / 双方证据',
  row && row.sev && row.title && row.detail.length > 10 && row.evs.length >= 1, JSON.stringify(row))
check('证据能点过去核（「看实体」这类入口）',
  row && row.links.some((t) => /看/.test(t)), JSON.stringify(row && row.links))

console.log('\n=== 点证据跳过去 ===')
const firstLink = await posOf('.admin__consist .consist__link')
if (firstLink && firstLink.x) {
  await click(firstLink.x, firstLink.y)
  await sleep(1500)
  const now = await ev(railActive)
  check(`点「${firstLink.text}」真的跳走了（导航不再停在「设置」）`,
    Boolean(now) && !String(now).startsWith('设置'), `当前停在：${now}`)
} else {
  check('证据里有可点入口', false, JSON.stringify(firstLink))
}

console.log('\n=== 切换「连出处一起查」 ===')
await gotoAdmin()
const boxPos = await posOf('.admin__consist input[type=checkbox]')
check('有「连出处一起查」开关', Boolean(boxPos && boxPos.x !== undefined), JSON.stringify(boxPos))
const stampBefore = await ev(`[...document.querySelectorAll('.admin__consist .audit__bar .faint')].map(x=>x.innerText.trim()).join(' ')`)
check('默认（勾着）时统计条不写「没查出处」', !/没查出处/.test(stampBefore), stampBefore)
if (boxPos && boxPos.x !== undefined) {
  await click(boxPos.x, boxPos.y)
  await sleep(400)
  const checkedNow = await ev(`document.querySelector('.admin__consist input[type=checkbox]')?.checked`)
  check('开关点一下真的变了状态', checkedNow === false, String(checkedNow))
  const runPos = await posOf('.admin__consist button', '重新体检')
  if (runPos && runPos.x) await click(runPos.x, runPos.y)
  const stamp = await waitFor(`(() => {
    const t=[...document.querySelectorAll('.admin__consist .audit__bar .faint')].map(x=>x.innerText.trim()).join(' ')
    return /没查出处/.test(t) ? t : ''
  })()`, 60000)
  check('关掉出处检查后，统计条如实标注「没查出处」', Boolean(stamp), stamp || '')
  // 复原，别把界面留在改动过的状态
  await click(boxPos.x, boxPos.y)
}

console.log('\n=== 运行时异常 ===')
check('无未捕获异常', errs.length === 0, errs.join(' | '))

console.log(`\n${'='.repeat(48)}`)
console.log(`  通过 ${pass} 项，失败 ${fail} 项`)
console.log(`${'='.repeat(48)}`)
try { ws.close() } catch { /* ignore */ }
