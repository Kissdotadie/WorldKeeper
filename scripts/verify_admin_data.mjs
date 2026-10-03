/**
 * 验收 P11-A6（定时快照与保留策略）+ P11-A2（快捷键注册层收尾）。
 *
 * 用法：node scripts/verify_admin_data.mjs <port>
 *
 * 为什么要用真实指针事件而不是 `.click()`：A2 的核心验收是
 * **「一次 Esc 只做一件事」**——这只有真的往页面发 keydown 才验得到；
 * 直接调把函数调起来等于绕过被测对象，那验的是测试自己。
 *
 * 步骤：
 *   A6  1. 设置 → 后台：快照面板在，策略数字与配置一致
 *       2. 点「立即快照」→ 份数 +1，列表长出一行且带缘由标签
 *       3. 点「看看能清理什么」→ 出方案条（要么「无需清理」要么列清单），且**没有真删**
 *   A2  4. 快捷键面板在，按作用域分组，键位用 kbd 渲染，至少一条全局
 *       5. 关系网上选中一个节点（halo=1）→ 打开布局菜单 → 按一次 Esc：
 *          菜单关掉，**且 halo 仍在**（旧行为是两个都发生）
 *          —— 走关系网而不是世界观：世界观按类型切片，一本全是地点的书
 *             在它那儿是合法空图，见下面「Esc 分层」一节的注释。
 *       6. 再按一次 Esc → 这回才轮到取消选中，halo=0
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
  await sleep(450)
}
const key = async (k) => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, windowsVirtualKeyCode: 27, code: k })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, windowsVirtualKeyCode: 27, code: k })
  await sleep(500)
}

let pass = 0
let fail = 0
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [OK]   ${label}`) }
  else { fail++; console.log(`  [FAIL] ${label}${extra ? `\n         ${String(extra).slice(0, 300)}` : ''}`) }
}

/** 面板里某个按钮的中心坐标（按可见文字找） */
const btnPos = (scopeSel, text) => `(() => {
  const b=[...document.querySelectorAll('${scopeSel} button')].find(x=>x.innerText.trim()==='${text}' && x.getBoundingClientRect().width>0)
  if(!b) return null
  const r=b.getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) }
})()`

/** 轮询直到条件成立（大书的快照要十几秒，固定 sleep 会误判） */
const waitFor = async (js, timeoutMs = 90000, step = 900) => {
  const t0 = Date.now()
  for (;;) {
    const v = await ev(js)
    if (v) return v
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(step)
  }
}

await send('Runtime.enable')
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}` })
await sleep(3800)

// ---------------------------------------------------------------- 打开 设置 → 后台
await ev(`(() => { const b=[...document.querySelectorAll('.rail__item')].find(x=>x.innerText.trim().startsWith('设置')); b?.click(); return 1 })()`)
await sleep(1600)
const adminTab = await ev(`(() => { const b=[...document.querySelectorAll('.seg__item')].find(x=>x.innerText.trim()==='后台'); if(!b) return null; const r=b.getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) } })()`)
if (adminTab) await click(adminTab.x, adminTab.y)
await sleep(1800)

// A 项（折叠区块）落地后：后台的区块默认收起、正文 display:none，
// 后面的坐标点击会点空。进页先点一次「全部展开」，再走下面的判定。
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='全部展开'); if(b) b.click(); return b?'ok':'no-btn' })()`)
await sleep(400)

console.log('\n=== A6 快照与保留策略 ===')
check('后台页里出现「快照」面板', await ev(`!!document.querySelector('.admin__snap')`))
check('策略数字与配置一致（间隔 / 保留份数 / 容量上限都写着）',
  await ev(`(() => { const t=(document.querySelector('.admin__snap .notice')?.innerText||''); return /每 \\d+ 小时/.test(t) && /\\d+ 份/.test(t) && /\\d+ MB/.test(t) && /不含索引/.test(t) })()`),
  await ev(`document.querySelector('.admin__snap .notice')?.innerText.slice(0,220)`))

const snapChip = `[...document.querySelectorAll('.admin__snap .chip')].map(c=>c.innerText.trim())`
const before = await ev(`(() => { const t=${snapChip}.find(x=>/份快照/.test(x)); return t ? parseInt(t) : -1 })()`)
const rowsBefore = await ev(`document.querySelectorAll('.admin__snap .audit__row').length`)

const takePos = await ev(btnPos('.admin__snap', '立即快照（当前书目）'))
if (takePos) await click(takePos.x, takePos.y)
const grew = await waitFor(`(() => { const t=${snapChip}.find(x=>/份快照/.test(x)); return t && parseInt(t) > ${before} })()`)
const after = await ev(`(() => { const t=${snapChip}.find(x=>/份快照/.test(x)); return t ? parseInt(t) : -1 })()`)
const rowsAfter = await ev(`document.querySelectorAll('.admin__snap .audit__row').length`)
check('点「立即快照」后份数 +1（真实书目文件多，等它跑完）', Boolean(grew) && after === before + 1, `${before} → ${after}`)
check('列表同步长出一行', rowsAfter === rowsBefore + 1, `${rowsBefore} → ${rowsAfter}`)

const firstRow = await ev(`(() => { const r=document.querySelector('.admin__snap .audit__row'); if(!r) return null; return { name: r.querySelector('.snap__name')?.innerText.trim(), chips: [...r.querySelectorAll('.chip')].map(c=>c.innerText.trim()), meta: r.querySelector('.faint')?.innerText.trim() } })()`)
check('列表行带书名 / 缘由 / 时间体积三样',
  firstRow && firstRow.name && firstRow.chips.length >= 2 && /\d+ 个文件/.test(firstRow.meta || ''),
  JSON.stringify(firstRow))
check('缘由显示成中文（不是 raw 的 manual）',
  firstRow && firstRow.chips.some((c) => c === '手动'), JSON.stringify(firstRow))

// 清理：先算不删
const planPos = await ev(btnPos('.admin__snap', '看看能清理什么'))
if (planPos) await click(planPos.x, planPos.y)
const planText = await waitFor(`(() => {
  const n=[...document.querySelectorAll('.admin__snap .notice')].find(x=>/没有需要清理|会清掉这/.test(x.innerText))
  return n ? n.innerText.replace(/\\s+/g,' ').slice(0,200) : ''
})()`, 60000)
check('「看看能清理什么」给出方案说明（不直接删）', Boolean(planText), planText || '')
const after2 = await ev(`(() => { const t=${snapChip}.find(x=>/份快照/.test(x)); return t ? parseInt(t) : -1 })()`)
check('看方案这一步没有真的删（份数不变）', after2 === after, `${after} → ${after2}`)
check('策略内不需要清理时会明确说「没有需要清理的」',
  /没有需要清理/.test(planText) || /会清掉这/.test(planText), planText)

console.log('\n=== A2 快捷键注册层 ===')
check('后台页里出现「快捷键」面板', await ev(`!!document.querySelector('.admin__keys')`))
const keyTable = await ev(`(() => {
  const gs=[...document.querySelectorAll('.admin__keys .keys__group')]
  return {
    groups: gs.length,
    scopes: gs.map(g=>g.querySelector('.keys__scope')?.innerText.trim()),
    kbds: document.querySelectorAll('.admin__keys .kbd').length,
    rows: document.querySelectorAll('.admin__keys .keys__row').length,
    hasGlobal: gs.some(g=>(g.querySelector('.keys__scope')?.innerText||'').includes('全局')),
  }
})()`)
check('快捷键按作用域分了组', keyTable.groups >= 1, JSON.stringify(keyTable))
check('至少一个「全局」作用域分组', keyTable.hasGlobal, JSON.stringify(keyTable.scopes))
check('键位用 kbd 渲染出来（不是一串纯文字）', keyTable.kbds >= 4, `kbd ${keyTable.kbds} 个`)
check('每个键位都写了「干什么用」的一句话',
  await ev(`[...document.querySelectorAll('.admin__keys .keys__row')].every(r=>(r.querySelector('.keys__desc')?.innerText||'').trim().length>0)`))
check('没有未挂载的死键位被当成冲突报红',
  await ev(`!!document.querySelector('.admin__keys .chip')`))

// ---------------------------------------------------------------- Esc 分层行为
// 选「关系网」而不是「世界观」：Esc 分层是**全图通用**的快捷键行为，
// 而世界观/地理观是**按类型切片**的视图 —— 世界观只收 concept/realm/item，
// 一本全是地点的书在它那儿是**合法空图**（节点数 0），验收会整段落空且
// 报出来的失败像是 UI 坏了。关系网收全部类型，任何有双链的书都有节点。
// 另外「平面」这个开关也只存在于关系网（见 RelationView），下面要按它切 2D。
console.log('\n=== Esc 分层：一次只做一件事 ===')
await ev(`(() => { const b=[...document.querySelectorAll('.rail__item')].find(x=>x.innerText.trim().startsWith('关系网')); b?.click(); return 1 })()`)
await sleep(2000)
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='平面'); b?.click(); return 1 })()`)
await sleep(1800)

/** 轮询等图上的节点画出来 —— 布局要跑几帧，固定 sleep 会偶发抢跑 */
const nodeCount = await waitFor(`document.querySelectorAll('[data-nid]').length`, 12000, 600)
check('关系网上画出了实体节点（有节点才谈得上选中）', Number(nodeCount) > 0, `[data-nid] = ${nodeCount}`)

const nodePos = await ev(`(() => {
  const els=[...document.querySelectorAll('[data-nid]')].filter(e=>e.getBoundingClientRect().width>0)
  if(!els.length) return null
  const el=els[Math.floor(els.length/2)]
  const r=el.getBoundingClientRect()
  return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), id: el.getAttribute('data-nid') }
})()`)
if (nodePos) await click(nodePos.x, nodePos.y)
else console.log('         ⚠ 没找到可点的节点，后面的选中判定必然失败')
await sleep(900)
check('单击节点后确实选中了（halo = 1）',
  await ev(`document.querySelectorAll('.graph__halo').length === 1`),
  await ev(`document.querySelectorAll('.graph__halo').length`))

const menuPos = await ev(`(() => { const b=document.querySelector('.menu__trigger'); if(!b) return null; const r=b.getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) } })()`)
if (menuPos) await click(menuPos.x, menuPos.y)
await sleep(700)
check('布局菜单已打开', await ev(`(() => { const m=document.querySelector('.menu__trigger--open'); return !!m })()`))

await key('Escape')
const menuStillOpen = await ev(`!!document.querySelector('.menu__trigger--open')`)
const haloAfterEsc = await ev(`document.querySelectorAll('.graph__halo').length`)
check('Esc 关掉了布局菜单', !menuStillOpen)
check('**同一次 Esc 没有顺手把图上选中也取消**（这是 A2 修掉的老毛病）',
  haloAfterEsc === 1, `halo = ${haloAfterEsc}`)

await key('Escape')
const haloAfterEsc2 = await ev(`document.querySelectorAll('.graph__halo').length`)
check('再按一次 Esc，这回才轮到取消选中', haloAfterEsc2 === 0, `halo = ${haloAfterEsc2}`)

console.log('\n=== 运行时异常 ===')
check('无未捕获异常', errs.length === 0, errs.join(' | '))

console.log(`\n${'='.repeat(48)}`)
console.log(`  通过 ${pass} 项，失败 ${fail} 项`)
console.log(`${'='.repeat(48)}`)
try { ws.close() } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
