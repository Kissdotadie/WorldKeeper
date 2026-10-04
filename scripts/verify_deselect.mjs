/**
 * 验收 P11-2️⃣②（取消选中）+ A2（快捷键注册层）。
 *
 * 用法：node scripts/verify_deselect.mjs <port>
 *
 * 步骤：
 *   1. 打开「世界观」图（2D），点一个节点 → 应出现选中高亮
 *   2. 按 Esc → 高亮应消失
 *   3. 再点节点 → 再点图上空白 → 高亮应消失（且拖动画布不算点击）
 *   4. Ctrl+K 聚焦搜索、Ctrl+N 打开新建表单（A2 迁移后的回归）
 */

const PORT = Number(process.argv[2] || 8799)
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
  else if (m.method === 'Runtime.exceptionThrown') errs.push(String(m.params.exceptionDetails.exception?.description || '').slice(0, 160))
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)))
  ws.send(JSON.stringify({ id, method, params }))
})
const ev = (js) => send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }).then((r) => r.result?.value)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const key = (type, opts) => send('Input.dispatchKeyEvent', { type, ...opts })

await send('Runtime.enable')
// 世界观可能开着「自由结构」——那种模式下图上大半是 __outline__ 虚拟节点，
// 选中它们没有实体档案，侧栏那张「选中」卡（连同 ✕）就不会出现。
// 本脚本验的是**实体**选中态的取消，所以先关掉结构，回到它最初面对的场景。
await ev(`try{localStorage.setItem('wkv.outline.世界观','0')}catch(e){}`)
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}` })
await sleep(3500)

// 打开世界观（2D）
await ev(`(() => { const b=[...document.querySelectorAll('.rail__item')].find(x=>x.innerText.trim().startsWith('世界观')); b?.click(); return 1 })()`)
await sleep(1500)
// 确保 2D（有些视图默认 3D）
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='平面'); b?.click(); return 1 })()`)
await sleep(1200)

/**
 * 只数「当前选中」那一种环。
 *
 * `.graph__halo` 有四种来由：样式包的 highlight 规则、搜索命中、拖拽落点、
 * 当前选中。这本脚本验的是「选中/取消选中」，用 class 总数会被样式配置污染
 * ——比如往人物类型挂一条 highlight 规则，光样式环就多出好几个。Graph2D 现在
 * 把它们分别渲染成 data-halo="style|hit|sel|drop"，这里精确取 "sel"。
 */
const haloCount = () => ev(`document.querySelectorAll('[data-halo="sel"]').length`)
/**
 * 取一个**真的能点到**的节点。
 *
 * 早先取「所有 [data-nid] 里正中间那个」—— 世界观的结构现在有几百个节点，
 * 正中间那个十有八九在视野外（世界坐标离屏，DOM 里仍有 rect），合成点击落
 * 到别的 UI 上，于是整条序列全是 0，看起来像「选中坏了」。
 * 现在：只挑中心点落在画布内、且 elementFromPoint 确实命中它自己的节点。
 */
const nodeInfo = () => ev(`(() => {
  const svg = document.querySelector('.graph__svg')
  if (!svg) return null
  const sr = svg.getBoundingClientRect()
  for (const el of document.querySelectorAll('[data-nid]')) {
    const id = el.getAttribute('data-nid')
    // 界面自造的骨架节点（__root / __tag / __outline__:…）没有实体档案，
    // 选中它们不会开侧栏详情卡 —— ✕ 那条断言就假失败了。
    if (id.startsWith('__')) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2)
    if (x < sr.left + 4 || x > sr.right - 4 || y < sr.top + 4 || y > sr.bottom - 4) continue
    const hit = document.elementFromPoint(x, y)
    if (!hit || hit.closest('[data-nid]') !== el) continue
    return { x, y, id }
  }
  return null
})()`)

const out = {}
out['打开视图后选中环数'] = await haloCount()

// —— 1. 点节点选中 ——
const n = await nodeInfo()
if (!n) { console.log('没有可点的节点，验收中止'); ws.close(); process.exit(1) }
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: n.x, y: n.y, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: n.x, y: n.y, button: 'left', clickCount: 1 })
await sleep(900)
out[`点节点(${n.id})后选中环数`] = await haloCount()

// —— 2. Esc 取消 ——
await key('keyDown', { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
await key('keyUp', { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
await sleep(700)
out['Esc 后选中环数'] = await haloCount()

// —— 3. 再选中 → 点空白取消 ——
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: n.x, y: n.y, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: n.x, y: n.y, button: 'left', clickCount: 1 })
await sleep(900)
out['再次点节点后选中环数'] = await haloCount()

/**
 * 找一个**确实是画布空白**的点。
 *
 * 早先直接取 `.dock svg` 的左上角内缩 24px —— 但 `.dock svg` 会命中 dockview
 * 面板标题栏里的图标 svg，算出来的坐标落在 `HEADER.panel__header` 上，
 * 于是「点空白」根本没点到画布，验收一直假失败。
 * 现在改成：在真正的画布 `.graph__svg` 内打网格扫描，用 elementFromPoint
 * 校验该点确实落在画布上、且不在任何节点/工具条上。
 */
const bg = await ev(`(() => {
  const svg = document.querySelector('.graph__svg')
  if (!svg) return null
  const r = svg.getBoundingClientRect()
  const isBlank = (x, y) => {
    const el = document.elementFromPoint(x, y)
    if (!el) return false
    if (el.closest('[data-nid]')) return false          // 压在节点上
    if (el.closest('button, .graph__toolbar, .graph__legend, .graph__hint')) return false
    // 必须是画布本身（svg 或它内部的 rect/g 背景层）
    return el === svg || svg.contains(el)
  }
  for (let py = r.top + 12; py < r.bottom - 12; py += 24) {
    for (let px = r.left + 12; px < r.right - 12; px += 24) {
      if (isBlank(px, py)) {
        const el = document.elementFromPoint(px, py)
        return { x: Math.round(px), y: Math.round(py), hit: el.tagName + '.' + (el.getAttribute('class') || '') }
      }
    }
  }
  return null
})()`)
if (!bg) { console.log('找不到画布空白点（画布是否没打开？）'); ws.close(); process.exit(1) }
out['空白点'] = `${bg.x},${bg.y} → ${bg.hit}`
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bg.x, y: bg.y, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bg.x, y: bg.y, button: 'left', clickCount: 1 })
await sleep(900)
out['点空白后选中环数'] = await haloCount()

// —— 3b. 拖动画布不应把选中丢掉 ——
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: n.x, y: n.y, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: n.x, y: n.y, button: 'left', clickCount: 1 })
await sleep(700)
const beforeDrag = await haloCount()
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bg.x, y: bg.y, button: 'left', clickCount: 1 })
for (let i = 1; i <= 6; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bg.x + i * 14, y: bg.y + i * 8, button: 'left' })
  await sleep(30)
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bg.x + 84, y: bg.y + 48, button: 'left', clickCount: 1 })
await sleep(700)
out['拖动画布前 halo 数'] = beforeDrag
out['拖动画布后选中环数'] = await haloCount()

// —— 3c. 侧栏详情卡的 ✕ 也能取消选中（P11-2️⃣②）——
// 上一步拖过画布，节点屏幕坐标已经变了，必须重新取一次
const n2 = await nodeInfo()
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: n2.x, y: n2.y, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: n2.x, y: n2.y, button: 'left', clickCount: 1 })
await sleep(800)
out['✕ 出现前 halo 数'] = await haloCount()
const closeBtn = await ev(`(() => {
  const b = document.querySelector('.panel__close')
  if (!b) return null
  const r = b.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})()`)
out['✕ 按钮存在'] = !!closeBtn
if (closeBtn) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: closeBtn.x, y: closeBtn.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: closeBtn.x, y: closeBtn.y, button: 'left', clickCount: 1 })
  await sleep(800)
}
out['点 ✕ 后选中环数'] = await haloCount()
out['点 ✕ 后详情卡收起'] = await ev(`!document.querySelector('.panel__close')`)

// —— 4. A2 迁移回归：Ctrl+K 聚焦搜索、Ctrl+N 开表单 ——
await key('keyDown', { key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 })
await key('keyUp', { key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 })
await sleep(400)
out['Ctrl+K 后搜索框聚焦'] = await ev(`document.activeElement?.classList?.contains('search__input')`)
await key('keyDown', { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
await key('keyUp', { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
await sleep(300)
out['搜索框里 Esc 后失焦'] = await ev(`!document.activeElement?.classList?.contains('search__input')`)

await key('keyDown', { key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 2 })
await key('keyUp', { key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, modifiers: 2 })
await sleep(700)
out['Ctrl+N 后新建表单出现'] = await ev(`!!document.querySelector('.modal, [class*=form]')`)
await key('keyDown', { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
await key('keyUp', { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
await sleep(400)
out['Esc 关掉表单'] = await ev(`!document.querySelector('.modal, [class*=form]')`)

console.log(JSON.stringify(out, null, 1))
if (errs.length) console.log('控制台异常：\n  ' + errs.slice(0, 5).join('\n  '))
ws.close()
