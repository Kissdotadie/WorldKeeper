/**
 * 验收 P11-B5「图上编辑补齐到时间线/伏笔」。
 *
 * 用法：node scripts/verify_b5_edit.mjs <port>
 *
 * 两半：
 *   ① 时间线三维长河 —— 双击节点 → 就地编辑浮层（复用 GraphEditPopover），
 *      改摘要落盘、浮层里删关联、就地编辑开关关掉后双击只看不动。
 *      （3D 节点不能用固定坐标点 —— 验收脚本走 __t3d.projectToScreen
 *       把节点投成真实屏幕坐标再合成双击。）
 *   ② 伏笔看板 —— 它没有图，「只读」的真缺口是**已建行的字改不了**
 *      （以前只能加/删/流转状态）。验收：✎ 改 → 改内容 → 存 → 真源文件变；
 *      取消 → 一个字不动。
 *
 * ⚠️ 会真建一本书、写一份伏笔表，跑完整本删掉 —— 净效果为零。
 */

import { rm } from 'node:fs/promises'

const PORT = Number(process.argv[2] || 8765)
const BASE = `http://127.0.0.1:${PORT}`
const STAMP = String(Date.now()).slice(-6)
const BOOK = `长河验收${STAMP}`
let seq = 0

// ---------------------------------------------------------------- HTTP 小工具

const jpost = async (path, body) => {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`POST ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.json()
}
const jget = async (path) => {
  const r = await fetch(BASE + path)
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`)
  return r.json()
}
const jput = async (path, body) => {
  const r = await fetch(BASE + path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`PUT ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

// ---------------------------------------------------------------- CDP 骨架

const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
if (!page) {
  console.error('找不到浏览器页签，CDP 9333 起了吗？')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
const pending = new Map()
const errs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  else if (m.method === 'Runtime.exceptionThrown') {
    errs.push(String(m.params.exceptionDetails.exception?.description || '').slice(0, 200))
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)))
  ws.send(JSON.stringify({ id, method, params }))
})
// ⚠️ returnByValue 时绝不能返回 DOM 节点（Object reference chain is too long）
const ev = (js) => send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true })
  .then((r) => r.result?.value)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
let skipped = 0
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [OK]   ${label}`) }
  else { fail++; console.log(`  [FAIL] ${label}${extra ? `\n         ${String(extra).slice(0, 320)}` : ''}`) }
}
const skip = (label, why = '') => {
  skipped++
  console.log(`  [SKIP] ${label}${why ? `（${why}）` : ''}`)
}

const goto = async (label) => {
  await ev(`(() => { const b=[...document.querySelectorAll('.rail__item')].find(x=>x.innerText.trim().startsWith(${JSON.stringify(label)})); b?.click(); return 1 })()`)
  await sleep(1500)
}

// ---------------------------------------------------------------- 准备数据

const body = (o = {}) => ({
  摘要: o.摘要 ?? '', 属性: [], 出场记录: o.出场记录 ?? [], 关联: o.关联 ?? [], 待补充: [],
})

await jpost('/api/books', { book_id: BOOK, title: BOOK })
const pei = await jpost(`/api/books/${encodeURIComponent(BOOK)}/entities`, {
  type: 'character', name: '裴渊', summary: '少年', first_appear: '1',
  body: body({
    摘要: '少年',
    出场记录: [['1', '替镖局押最后一趟货'], ['2', '在落霞城被盯上'], ['3', '翻出旧账']],
    关联: ['师父：[[韦忠]]'],
  }),
})
await jpost(`/api/books/${encodeURIComponent(BOOK)}/entities`, {
  type: 'character', name: '韦忠', summary: '师父', first_appear: '1',
  body: body({ 摘要: '师父', 出场记录: [['1', '磨刀'], ['2', '拒绝提议']] }),
})
// 伏笔表真源：world/foreshadow.md 的 Markdown 表格
const FS_MD = [
  '# 伏笔看板', '',
  '| 伏笔 | 埋设章节 | 预计回收 | 状态 | 备注 |',
  '|---|---|---|---|---|',
  '| 断雪刀上的裂痕 | 1 | 12 | 未回收 | 三年前留下的 | ',
].join('\n')
await jput(`/api/books/${encodeURIComponent(BOOK)}/docs/foreshadow`, { text: FS_MD })

const epath = `/api/books/${encodeURIComponent(BOOK)}/entities/${encodeURIComponent(pei.id)}`
const summaryOf = async () => (await jget(epath)).summary
const fsText = async () => (await jget(`/api/books/${encodeURIComponent(BOOK)}/docs/foreshadow`)).rows

// ---------------------------------------------------------------- 收尾

let cleaned = false
const cleanup = async () => {
  if (cleaned) return
  cleaned = true
  console.log('\n--- 收尾 ---')
  try {
    const r = await fetch(`${BASE}/api/books/${encodeURIComponent(BOOK)}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ book_id: BOOK, confirm: BOOK }),
    })
    if (!r.ok) {
      console.log(`  ⚠️ 临时书删除失败：${r.status} ${(await r.text()).slice(0, 160)}`)
    } else {
      const info = await r.json().catch(() => ({}))
      const dir = String(info?.snapshot?.dir || '')
      const name = dir.split(/[\\/]/).pop() || ''
      if (name.startsWith(BOOK) && name.includes('book-delete')) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }
      console.log(`  临时书「${BOOK}」已整本删除（含它产生的快照），净效果为零`)
    }
  } catch (e) {
    console.error(`  ⚠️ 清理失败，请手工删掉书目「${BOOK}」：`, e.message)
  }
}
process.on('exit', () => void cleanup())

// ---------------------------------------------------------------- 开跑

try {
  await send('Runtime.enable')
  await send('Page.navigate', { url: BASE })
  await sleep(5000)
  await ev(`(() => {
    const s=document.querySelector('.topbar select.select')
    if(!s) return 0
    const setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set
    setter.call(s, ${JSON.stringify(BOOK)})
    s.dispatchEvent(new Event('change',{bubbles:true}))
    return 1
  })()`)
  await sleep(2500)

  // ============================================================ ① 时间线长河
  console.log('\n=== ① 三维长河：双击节点 → 就地编辑浮层 ===')
  await goto('时间线')
  await ev(`(() => { const b=[...document.querySelectorAll('.seg__item')].find(x=>(x.innerText||'').trim()==='三维长河'); b?.click(); return !!b })()`)
  await sleep(4000) // 3D 场景建起来要几秒

  const t3d = await ev(`(() => {
    const t = window.__t3d
    if (!t || !t.nodes || !t.nodes.length) return null
    // 挑「裴渊」的首现节点（名字挂在首现点上），投成屏幕坐标
    const n = t.nodes.find((x) => x.name === '裴渊' && x.kind === 'first') || t.nodes[0]
    const p = t.projectToScreen(n.pos)
    return { id: n.entityId, name: n.name, x: Math.round(p.x), y: Math.round(p.y), behind: !!p.behind }
  })()`)
  check('三维长河画出来了，且能拿到节点', Boolean(t3d), JSON.stringify(t3d))
  if (!t3d) {
    skip('长河双击编辑那一段', '拿不到 __t3d 调试口')
  } else {
    check('节点投影在视口内（没被投到镜头背后）', !t3d.behind && t3d.x > 0 && t3d.y > 0, JSON.stringify(t3d))

    // 真实双击该坐标
    await ev(`(() => {
      const c=document.querySelector('.graph3d--timeline canvas')
      if(!c) return 0
      const opts={ bubbles:true, cancelable:true, clientX:${t3d.x}, clientY:${t3d.y}, button:0 }
      c.dispatchEvent(new MouseEvent('mousedown', opts))
      c.dispatchEvent(new MouseEvent('mouseup', opts))
      c.dispatchEvent(new MouseEvent('click', opts))
      c.dispatchEvent(new MouseEvent('mousedown', opts))
      c.dispatchEvent(new MouseEvent('mouseup', opts))
      c.dispatchEvent(new MouseEvent('click', opts))
      c.dispatchEvent(new MouseEvent('dblclick', opts))
      return 1
    })()`)
    await sleep(1500)
    let popover = await ev(`!!document.querySelector('.gedit')`)
    check('**双击长河节点弹出就地编辑浮层**', popover === true)
    if (popover) {
      const s0 = await summaryOf()
      await ev(`(() => {
        const ta=document.querySelector('.gedit textarea')
        if(!ta) return 0
        const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set
        setter.call(ta, '长河上改的摘要')
        ta.dispatchEvent(new Event('input',{bubbles:true}))
        return 1
      })()`)
      await sleep(300)
      await ev(`(() => { const b=document.querySelector('.gedit__actions .btn--primary'); b?.click(); return !!b })()`)
      await sleep(1800)
      check('**浮层保存后摘要真的落了盘**', (await summaryOf()) === '长河上改的摘要', String(await summaryOf()))
      // 时间线要自己刷出来（onChanged → reload）
      const reloaded = await ev(`(() => {
        const t=window.__t3d
        return !!t && Array.isArray(t.nodes) && t.nodes.length > 0
      })()`)
      check('保存后时间线重建了（场景还在，没有白屏）', reloaded === true)
    }

    // 就地编辑开关关掉 → 双击只看不动
    await ev(`(() => {
      const cb=[...document.querySelectorAll('input[type=checkbox]')].find(x=>x.closest('label')?.innerText.includes('就地编辑'))
      if(cb?.checked) cb.click(); return 1
    })()`)
    await sleep(800)
    await ev(`(() => {
      const c=document.querySelector('.graph3d--timeline canvas')
      if(!c) return 0
      const opts={ bubbles:true, cancelable:true, clientX:${t3d.x}, clientY:${t3d.y}, button:0 }
      c.dispatchEvent(new MouseEvent('dblclick', opts))
      return 1
    })()`)
    await sleep(1200)
    check('**关掉「就地编辑」后双击不再弹浮层**', !(await ev(`!!document.querySelector('.gedit')`)))
    // 开回来，别把界面留在关着的状态
    await ev(`(() => {
      const cb=[...document.querySelectorAll('input[type=checkbox]')].find(x=>x.closest('label')?.innerText.includes('就地编辑'))
      if(cb && !cb.checked) cb.click(); return 1
    })()`)
    await sleep(500)
  }

  // ============================================================ ② 伏笔行编辑
  console.log('\n=== ② 伏笔看板：✎ 改 → 改字 → 存 ===')
  await goto('伏笔')
  await sleep(1500)
  const rows0 = await fsText()
  check('伏笔表有一行种子数据', rows0.length === 1, JSON.stringify(rows0))
  const editBtn = await ev(`(() => {
    const b=[...document.querySelectorAll('.fs-row button')].find(x=>(x.innerText||'').trim()==='✎ 改')
    if(!b) return false
    b.click(); return true
  })()`)
  check('✎ 改 按钮点开了编辑行', editBtn === true)
  if (editBtn) {
    await sleep(500)
    await ev(`(() => {
      const inp=document.querySelector('.fs-row--edit input[aria-label=伏笔内容]')
      if(!inp) return 0
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set
      setter.call(inp, '断雪刀的裂痕里藏着半张图')
      inp.dispatchEvent(new Event('input',{bubbles:true}))
      return 1
    })()`)
    await sleep(300)
    await ev(`(() => {
      const b=[...document.querySelectorAll('.fs-row--edit button')].find(x=>(x.innerText||'').trim()==='存')
      b?.click(); return !!b
    })()`)
    await sleep(1800)
    const rows1 = await fsText()
    check('**改完的字落进了 world/foreshadow.md**', rows1[0]?.[0] === '断雪刀的裂痕里藏着半张图', JSON.stringify(rows1))

    // 取消不动字
    await ev(`(() => {
      const b=[...document.querySelectorAll('.fs-row button')].find(x=>(x.innerText||'').trim()==='✎ 改')
      b?.click(); return !!b
    })()`)
    await sleep(400)
    await ev(`(() => {
      const b=[...document.querySelectorAll('.fs-row--edit button')].find(x=>(x.innerText||'').trim()==='取消')
      b?.click(); return !!b
    })()`)
    await sleep(1200)
    const rows2 = await fsText()
    check('取消后一个字没动', rows2[0]?.[0] === '断雪刀的裂痕里藏着半张图', JSON.stringify(rows2))
  }

  console.log('\n=== 运行时异常 ===')
  check('无未捕获异常', errs.length === 0, errs.join(' | '))
} finally {
  await cleanup()
  console.log(`\n${'='.repeat(48)}`)
  console.log(`  通过 ${pass} 项，失败 ${fail} 项${skipped ? `，跳过 ${skipped} 项` : ''}`)
  console.log(`${'='.repeat(48)}`)
  try { ws.close() } catch { /* ignore */ }
  process.exitCode = fail ? 1 : 0
}
