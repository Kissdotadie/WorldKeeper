/**
 * 验收 P11-A1「撤销 / 重做」在界面上的那一半。
 *
 * 用法：node scripts/verify_undo.mjs <port>
 *
 * 为什么必须上界面验：撤销栈是**前端**的东西，后端接口一个都没改
 * （撤销 = 拿旧快照走既有的 updateEntity / saveScene 覆盖回去）。
 * 冒烟脚本（走 API）碰不到它，只有真的点一次、真的按一次 Ctrl+Z 才算数。
 *
 * 测的三条写路径：
 *   ① 属性修改 —— 图上浮层改摘要（`recordEntity`）
 *   ② 关系增删 —— 图上浮层里 ✕ 删掉一条关联（`recordEntity`）
 *   ③ 完整档案表单改属性（`recordEntity` 的另一个调用点）
 *
 * ⚠️ 节点拖动（scene.json 坐标）这条路**没**进本脚本：3D 是 WebGL，
 * 拖拽要按投影坐标算屏幕位置，合成事件点不准。它在验收单里给了 30 秒手动步骤。
 *
 * ⚠️ 键位用**合成 KeyboardEvent**（`window.dispatchEvent`）而不是 CDP Input：
 * 被测的是「注册表匹配 + 输入框守卫」这段逻辑，合成事件目标明确、可重复；
 * CDP Input 还受焦点/窗口激活影响，会引入无关的抖动。
 *
 * ⚠️ 这个脚本会**真在数据目录里建一本书**（3 个实体），跑完整本删掉 —— 净效果为零。
 */

import { rm } from 'node:fs/promises'

const PORT = Number(process.argv[2] || 8765)
const BASE = `http://127.0.0.1:${PORT}`
const STAMP = String(Date.now()).slice(-6)
const BOOK = `撤销验收${STAMP}`
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
    errs.push(String(m.params.exceptionDetails.exception?.description || '').slice(0, 160))
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)))
  ws.send(JSON.stringify({ id, method, params }))
})
// ⚠️ returnByValue 时**绝不能返回 DOM 节点** —— 会直接报
// "Object reference chain is too long" 把脚本弄死。要布尔就 `!!`。
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

/** 合成一次按键（见文件头注释：测的是注册表，不是键盘驱动） */
const press = (key, mods = {}) => ev(`(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: ${JSON.stringify(key)},
    ctrlKey: ${!!mods.ctrl}, shiftKey: ${!!mods.shift}, altKey: ${!!mods.alt}, metaKey: false,
    bubbles: true, cancelable: true,
  }))
  return 1
})()`)

const goto = async (label) => {
  await ev(`(() => { const b=[...document.querySelectorAll('.rail__item')].find(x=>x.innerText.trim().startsWith(${JSON.stringify(label)})); b?.click(); return 1 })()`)
  await sleep(1500)
}

const CHIP = `(() => {
  const w=document.querySelector('.undochip')
  if(!w) return null
  const bs=[...w.querySelectorAll('button')]
  return {
    text:(w.innerText||'').replace(/\\s+/g,' ').trim(),
    undoText:(bs[0]?.innerText||'').trim(),
    undoTitle:bs[0]?.title||'',
    undoDisabled:!!bs[0]?.disabled,
    redoDisabled:!!bs[1]?.disabled,
  }
})()`
const chip = () => ev(CHIP)

const toastTexts = () => ev(`(() => [...document.querySelectorAll('.toast')].map(t=>t.innerText.replace(/\\s+/g,' ').trim()))()`)
/** 等某条提示出现（前缀匹配） */
const waitToast = async (prefix, tries = 40, gap = 250) => {
  for (let i = 0; i < tries; i++) {
    const hit = (await toastTexts() || []).find((t) => t.includes(prefix))
    if (hit) return hit
    await sleep(gap)
  }
  return null
}

// ---------------------------------------------------------------- 准备数据

/** 实体正文的五个段 —— 后端 `empty_body()` 就是这五个，少一个就会被补空 */
const body = (o = {}) => ({
  摘要: o.摘要 ?? '', 属性: o.属性 ?? [], 出场记录: o.出场记录 ?? [], 关联: o.关联 ?? [], 待补充: o.待补充 ?? [],
})

await jpost('/api/books', { book_id: BOOK, title: BOOK })
const pei = await jpost(`/api/books/${encodeURIComponent(BOOK)}/entities`, {
  type: 'character', name: '裴渊', summary: '少年', tags: ['主角'],
  body: body({ 摘要: '少年', 关联: ['师父：[[韦忠]]', '出生地：[[中州]]'] }),
})
const wei = await jpost(`/api/books/${encodeURIComponent(BOOK)}/entities`, {
  type: 'character', name: '韦忠', summary: '师父', body: body({ 摘要: '师父' }),
})
await jpost(`/api/books/${encodeURIComponent(BOOK)}/entities`, {
  type: 'location', name: '中州', summary: '地名', body: body({ 摘要: '地名' }),
})

const epath = `/api/books/${encodeURIComponent(BOOK)}/entities/${encodeURIComponent(pei.id)}`
const summaryOf = async () => (await jget(epath)).summary
const relsOf = async () => (await jget(epath)).body?.关联 ?? []

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
  await send('DOM.enable')
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

  // -------------------------------------------------------------- 空栈
  console.log('\n=== 还没改过东西时，控件根本不出现 ===')
  check('刚进这本书时，顶栏没有撤销控件（不做空控件）', (await chip()) === null, JSON.stringify(await chip()))
  await press('z', { ctrl: true })
  await sleep(600)
  check('没东西可撤时按 Ctrl+Z 不出提示、也不报错',
    !(await toastTexts() || []).some((t) => t.includes('已撤销')), JSON.stringify(await toastTexts()))

  // -------------------------------------------------------------- 图上浮层：改摘要
  console.log('\n=== 属性修改（图上浮层）→ 撤销 → 重做 ===')
  await goto('关系')
  await ev(`(() => {
    const b=[...document.querySelectorAll('.seg__item')].find(x=>(x.innerText||'').trim()==='平面')
    b?.click(); return !!b
  })()`)
  await sleep(1800)
  const hasNode = await ev(`!!document.querySelector('[data-nid="${pei.id}"]')`)
  check('关系图平面模式下看得见「裴渊」这个节点', hasNode === true)
  if (!hasNode) {
    skip('图上就地编辑那一段', '节点没渲染出来（这本书的关系图可能空着）')
  } else {
    // 双击节点 → 就地编辑浮层（走真实事件路径，不是直接改 state）
    await ev(`(() => {
      const el=document.querySelector('[data-nid="${pei.id}"]')
      const r=el.getBoundingClientRect()
      el.dispatchEvent(new MouseEvent('dblclick',{
        bubbles:true, cancelable:true, clientX:r.left+r.width/2, clientY:r.top+r.height/2,
      }))
      return 1
    })()`)
    await sleep(1200)
    const popover = await ev(`!!document.querySelector('.gedit')`)
    check('双击节点打开就地编辑浮层', popover === true)
    if (popover) {
      const beforeSummary = await summaryOf()
      // 改摘要（React 受控组件：走原生 setter + input 事件）
      await ev(`(() => {
        const ta=document.querySelector('.gedit textarea')
        if(!ta) return 0
        const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set
        setter.call(ta, '少年·改过')
        ta.dispatchEvent(new Event('input',{bubbles:true}))
        return 1
      })()`)
      await sleep(300)
      await ev(`(() => { const b=document.querySelector('.gedit__actions .btn--primary'); b?.click(); return !!b })()`)
      await sleep(1500)
      check('保存之后摘要真的落到档案里', (await summaryOf()) === '少年·改过', String(await summaryOf()))

      const c1 = await chip()
      check('**顶栏出现撤销控件**', Boolean(c1), JSON.stringify(c1))
      check('控件上写清了要撤的是哪一步', c1 && c1.undoText.includes('改属性') && c1.undoText.includes('裴渊'),
        JSON.stringify(c1))
      check('此时只能撤不能重做', c1 && c1.undoDisabled === false && c1.redoDisabled === true,
        JSON.stringify(c1))

      await press('z', { ctrl: true })
      await sleep(1200)
      check('**Ctrl+Z 把摘要撤回去了**', (await summaryOf()) === beforeSummary, String(await summaryOf()))
      check('提示里说了撤的是哪一步', Boolean(await waitToast('已撤销：改属性')), JSON.stringify(await toastTexts()))
      const c2 = await chip()
      check('撤完变成「只能重做」', c2 && c2.undoDisabled === true && c2.redoDisabled === false, JSON.stringify(c2))

      await press('z', { ctrl: true, shift: true })
      await sleep(1200)
      check('**Ctrl+Shift+Z 又重做回改后的样子**', (await summaryOf()) === '少年·改过', String(await summaryOf()))

      await press('y', { ctrl: true })
      await sleep(800)
      check('Ctrl+Y（Windows 习惯键）也不报错', (await summaryOf()) === '少年·改过', String(await summaryOf()))

      await press('z', { ctrl: true })
      await sleep(1200)
      check('再按一次 Ctrl+Z 又回到原值', (await summaryOf()) === beforeSummary, String(await summaryOf()))
      await press('z', { ctrl: true })
      await sleep(800)
      check('栈空了之后按 Ctrl+Z 是安全的（值不动、界面不崩）',
        (await summaryOf()) === beforeSummary && (await chip()) !== undefined)

      // 把浮层关掉，免得挡着后面的点击
      await ev(`(() => { const b=document.querySelector('.gedit__head button'); b?.click(); return !!b })()`)
      await sleep(500)
    }
  }

  // -------------------------------------------------------------- 关系增删
  console.log('\n=== 关系增删（图上浮层里 ✕ 删一条）→ 撤销 ===')
  const relsBefore = await relsOf()
  if (!(await ev(`!!document.querySelector('[data-nid="${pei.id}"]')`))) {
    skip('删关联那一段', '节点没渲染出来')
  } else {
    await ev(`(() => {
      const el=document.querySelector('[data-nid="${pei.id}"]')
      const r=el.getBoundingClientRect()
      el.dispatchEvent(new MouseEvent('dblclick',{
        bubbles:true, cancelable:true, clientX:r.left+r.width/2, clientY:r.top+r.height/2,
      }))
      return 1
    })()`)
    await sleep(1200)
    const relRows = await ev(`document.querySelectorAll('.gedit__rel').length`)
    check('浮层里列出了「裴渊」现有的关联', (relRows || 0) >= 2, `列出 ${relRows} 条`)
    await ev(`(() => { const b=document.querySelector('.gedit__rel-del'); b?.click(); return !!b })()`)
    await sleep(1500)
    const relsAfter = await relsOf()
    check('✕ 真的删掉了一条关联', relsAfter.length === relsBefore.length - 1,
      `${relsBefore.length} → ${relsAfter.length}`)
    const c3 = await chip()
    check('撤销控件写着「删掉一条关联」', c3 && c3.undoText.includes('删掉一条关联'), JSON.stringify(c3))

    await press('z', { ctrl: true })
    await sleep(1400)
    const relsBack = await relsOf()
    check('**Ctrl+Z 把那条关联还回来了**（真源是档案里的 [[双链]]，不是图）',
      relsBack.length === relsBefore.length && relsBack.some((x) => x.includes('中州') || x.includes('韦忠')),
      JSON.stringify(relsBack))
    await ev(`(() => { const b=document.querySelector('.gedit__head button'); b?.click(); return !!b })()`)
    await sleep(400)
  }

  // -------------------------------------------------------------- 3D 没被改坏
  // A1 动过 Graph3D（加了一个「拖完报出来」的口子 + 一份已存坐标的副本），
  // 那是编译器管不到的 WebGL 代码 —— 至少确认三维这张图还能画出来、不报错。
  console.log('\n=== 三维图没被这次改动改坏 ===')
  const errsBefore3d = errs.length
  await ev(`(() => { const b=[...document.querySelectorAll('.seg__item')].find(x=>(x.innerText||'').trim()==='立体'); b?.click(); return !!b })()`)
  await sleep(3500)
  const canvas3d = await ev(`(() => {
    const c=document.querySelector('canvas')
    if(!c) return null
    return { w: Math.round(c.getBoundingClientRect().width), h: Math.round(c.getBoundingClientRect().height) }
  })()`)
  check('切到立体模式后三维画布真的铺开了', Boolean(canvas3d) && canvas3d.w > 100 && canvas3d.h > 100,
    JSON.stringify(canvas3d))
  check('三维图起来的过程中没有未捕获异常', errs.length === errsBefore3d,
    errs.slice(errsBefore3d).join(' | '))

  // -------------------------------------------------------------- 完整档案（表单那条路）
  console.log('\n=== 完整档案表单（EntityForm）→ 撤销 ===')
  await goto('名册')
  await sleep(800)
  // 名册默认是卡片流（.rcard 带 onClick）；切到表格更好点。两种都兜住。
  await ev(`(() => { const b=[...document.querySelectorAll('.seg__item')].find(x=>(x.innerText||'').trim()==='表格'); b?.click(); return !!b })()`)
  await sleep(900)
  const opened = await ev(`(() => {
    const row=[...document.querySelectorAll('tr')].find(el=>(el.innerText||'').includes('裴渊'))
    if(row){ row.click(); return true }
    const card=[...document.querySelectorAll('.rcard')].find(el=>(el.innerText||'').includes('裴渊'))
    if(card){ card.click(); return true }
    return false
  })()`)
  await sleep(1500)
  const editBtn = await ev(`(() => {
    const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='编辑' && !x.disabled)
    if(!b) return false
    b.click(); return true
  })()`)
  check('名册里点开实体、能按到「编辑」', opened === true && editBtn === true,
    JSON.stringify({ opened, editBtn }))
  if (editBtn) {
    await sleep(1200)
    const modal = await ev(`!!document.querySelector('.modal')`)
    check('打开的是完整档案表单', modal === true)
    const s0 = await summaryOf()
    await ev(`(() => {
      const ta=[...document.querySelectorAll('.modal textarea')][0]
      if(!ta) return 0
      const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set
      setter.call(ta, '表单改的摘要')
      ta.dispatchEvent(new Event('input',{bubbles:true}))
      return 1
    })()`)
    await sleep(300)
    await ev(`(() => { const b=document.querySelector('.modal__footer .btn--primary'); b?.click(); return !!b })()`)
    await sleep(1800)
    check('表单保存后摘要变了', (await summaryOf()) === '表单改的摘要', String(await summaryOf()))
    const c4 = await chip()
    check('这条写入也进了撤销栈', c4 && c4.undoText.includes('改属性'), JSON.stringify(c4))
    await press('z', { ctrl: true })
    await sleep(1300)
    check('**Ctrl+Z 把表单那次改动也撤回去了**', (await summaryOf()) === s0, String(await summaryOf()))
  } else {
    skip('完整档案表单那一段', '没能打开详情/编辑')
  }

  // -------------------------------------------------------------- 闸
  console.log('\n=== 闸：这一条在这之后又被改过 → 拒绝撤销（不静默覆盖）===')
  const guarded = await ev(`(() => {
    const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='编辑')
    if(!b) return false
    b.click(); return true
  })()`)
  if (!guarded) {
    skip('闸那一段', '需要完整档案表单才能构造「改完又被人动过」')
  } else {
    await sleep(1200)
    await ev(`(() => {
      const ta=[...document.querySelectorAll('.modal textarea')][0]
      const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set
      setter.call(ta, '闸测试·第一次')
      ta.dispatchEvent(new Event('input',{bubbles:true}))
      return 1
    })()`)
    await sleep(300)
    await ev(`(() => { const b=document.querySelector('.modal__footer .btn--primary'); b?.click(); return !!b })()`)
    await sleep(1600)
    check('（构造）表单改成了「闸测试·第一次」', (await summaryOf()) === '闸测试·第一次', String(await summaryOf()))

    // 背地里改一刀（模拟 AI 抽取落盘 / 你在外部编辑器改 md 之后重扫）
    await jput(epath, {
      type: 'character', name: '裴渊', aliases: [], tags: ['主角'], methodologies: [],
      first_appear: null, status: null, icon: null, body: body({ 摘要: '别人偷偷改的', 关联: ['师父：[[韦忠]]'] }),
    })
    check('（构造）别人把摘要改成了「别人偷偷改的」', (await summaryOf()) === '别人偷偷改的', String(await summaryOf()))

    await press('z', { ctrl: true })
    await sleep(1500)
    const t = await waitToast('撤销没成功')
    check('**撤销被拒绝了，并且说清了原因**', Boolean(t) && t.includes('又被改过'), JSON.stringify(t))
    check('**别人的改动一个字都没被盖掉**（这是这道闸的全部意义）',
      (await summaryOf()) === '别人偷偷改的', String(await summaryOf()))
  }

  // -------------------------------------------------------------- 换书清空
  console.log('\n=== 换书 → 撤销栈清空（跨书的旧快照会盖错东西）===')
  await ev(`(() => {
    const s=document.querySelector('.topbar select.select')
    if(!s) return 0
    const opts=[...s.options].filter(o=>o.value!==${JSON.stringify(BOOK)})
    if(!opts.length) return 0
    const setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set
    setter.call(s, opts[0].value)
    s.dispatchEvent(new Event('change',{bubbles:true}))
    return 1
  })()`)
  await sleep(2200)
  check('换到别的书之后，撤销控件消失了', (await chip()) === null, JSON.stringify(await chip()))

  // -------------------------------------------------------------- 输入框守卫
  console.log('\n=== 输入框里按 Ctrl+Z 不抢（那是浏览器自己的文本撤销）===')
  const typed = await ev(`(() => {
    const i=document.querySelector('input.input, input[type=search], .search input')
    if(!i) return null
    i.focus()
    const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set
    setter.call(i, '写了一半的字')
    i.dispatchEvent(new Event('input',{bubbles:true}))
    return document.activeElement===i
  })()`)
  if (!typed) {
    skip('输入框守卫那一段', '页面上没找到可聚焦的输入框')
  } else {
    await press('z', { ctrl: true })
    await sleep(900)
    check('焦点在输入框里按 Ctrl+Z，不会触发应用级撤销（没有「已撤销」提示）',
      !(await toastTexts() || []).some((t) => t.includes('已撤销')), JSON.stringify(await toastTexts()))
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
