/**
 * 验收 P11-A3「异步任务」在界面上的那一半。
 *
 * 用法：node scripts/verify_jobs.mjs <port>
 *
 * 后端那一半由冒烟脚本管（走 API，验状态机 / 忙闸 / 续跑 / 记录落盘）。
 * 这里只管后端证明不了的事：
 *   1. 长任务**真的出现在界面上**（顶栏常驻小条 + 任务中心的大卡 + 真实计数）
 *   2. 「看日志 / 停止 / 续跑」这几个按钮按下去**真的有用**
 *   3. 停下来的解释是如实的（说「停在子项之间」，而不是骗人的「已停止」）
 *   4. 汇总页那个「重建索引」按钮也走任务（不再是同步干等）
 *
 * 全部走**真实的界面路径**：往正文面板的 `<input type=file>` 上挂真文件
 * （CDP 的 `DOM.setFileInputFiles`），再按「导入 N 个文件」——
 * 于是 `submitImport` 这条接线也被真的跑到了，而不是只调 API。
 *
 * ⚠️ 这个脚本会**真在数据目录里建一本书**、真导入两百个假章节，
 * 跑完把它整本删掉（三道闸全走一遍）——净效果为零。
 * 用的是真实实例（不是临时目录），所以收尾清理必须可靠。
 *
 * ---- 踩过的坑（都写在对应位置，别删）----
 * 1. CDP 里 `returnByValue` 返回值必须能序列化：返回 DOM 节点会直接报
 *    "Object reference chain is too long" 把整个脚本弄死。用 `!!`。
 * 2. 任务面板是**全局的**（`listJobs({limit:30})` 不带 book_id）——
 *    别的书的历史任务会一起列出来。所以**凡是要断言的，一律走 API
 *    按 book_id 过滤**；界面上那些「看得见」的检查只负责证明「它长出来了」。
 *    首跑就是栽在这：拿面板里别人的「完成」行当成本书的续跑完成了。
 * 3. 收尾删书前**必须等本书的任务全部进终态**。否则删到一半任务还在往
 *    目录里写，Windows 上 rmtree 会报「目录不是空的」半途停下 ——
 *    书没删干净、索引却已经清空，是最坏的状态。
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.argv[2] || 8765)
const BASE = `http://127.0.0.1:${PORT}`
// 用时间戳当书名后缀，保证不跟已有书目撞名（撞名就建不出来，脚本会一路红）
const STAMP = String(Date.now()).slice(-6)
const BOOK = `任务验收${STAMP}`
/** 导入多少个文件：够跑十几秒，来得及按停（太少会「还没按停就已经跑完了」）。
 *  实测 120 文件约 8.7s、150 约 10.8s —— 中途还要切面板、开日志，按停时会偏晚，
 *  所以给到 200（约 15s 任务 + 约 4.6s 上传），留出足够的时间窗。 */
const N_FILES = 200
let seq = 0

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
const ev = (js) => send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true })
  .then((r) => r.result?.value)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 按元素上的文字点（比按下标稳 —— 按钮会随状态换文案） */
const clickText = async (sel, text) => ev(`(() => {
  const b=[...document.querySelectorAll('${sel}')].find(x=>(x.innerText||'').trim()===${JSON.stringify(text)})
  if(!b) return false
  b.scrollIntoView({block:'center'}); b.click(); return true
})()`)
/** 切到某个左栏入口 */
const goto = async (label) => {
  await ev(`(() => { const b=[...document.querySelectorAll('.rail__item')].find(x=>x.innerText.trim().startsWith(${JSON.stringify(label)})); b?.click(); return 1 })()`)
  await sleep(1600)
}

let pass = 0
let fail = 0
let skipped = 0
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [OK]   ${label}`) }
  else { fail++; console.log(`  [FAIL] ${label}${extra ? `\n         ${String(extra).slice(0, 320)}` : ''}`) }
}
/** 环境不满足前提时如实跳过（不假装通过、也不算失败）——比编一个必红的断言诚实 */
const skip = (label, why = '') => {
  skipped++
  console.log(`  [SKIP] ${label}${why ? `（${why}）` : ''}`)
}

// ---------------------------------------------------------------- 任务 API（断言的真源）

const bookJobs = async () => {
  const r = await fetch(`${BASE}/api/jobs?book_id=${encodeURIComponent(BOOK)}&limit=100`)
  return ((await r.json()).jobs) || []
}
/** 等本书里出现某个任务（按条件找），返回它 */
const waitBookJob = async (pred, tries = 300, gap = 300) => {
  for (let i = 0; i < tries; i++) {
    const hit = (await bookJobs()).find(pred)
    if (hit) return hit
    await sleep(gap)
  }
  return null
}
const TERMINAL = ['done', 'failed', 'cancelled', 'interrupted']
const waitTerminal = async (id, tries = 400, gap = 300) => {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`${BASE}/api/jobs/${id}`)
    if (r.ok) {
      const j = await r.json()
      if (TERMINAL.includes(j.status)) return j
    }
    await sleep(gap)
  }
  return null
}

const HERO = `(() => {
  const h=document.querySelector('.job__hero')
  if(!h) return null
  const bar=document.querySelector('.job__bar-fill')
  return {
    text:(h.innerText||'').replace(/\\s+/g,' ').trim().slice(0,240),
    width: bar ? Math.round(bar.getBoundingClientRect().width) : 0,
    hasStop: [...h.querySelectorAll('button')].some(b=>(b.innerText||'').trim()==='停止'),
  }
})()`

const JOBS = `(() => [...document.querySelectorAll('.job__item')].map(el => ({
  badge:(el.querySelector('.job__badge')?.innerText||'').trim(),
  text:(el.innerText||'').replace(/\\s+/g,' ').trim().slice(0,200),
  buttons:[...el.querySelectorAll('button')].map(b=>(b.innerText||'').trim()),
})))()`

const waitRow = async (badge, tries = 80, gap = 300) => {
  for (let i = 0; i < tries; i++) {
    const hit = (await ev(JOBS) || []).find((r) => r.badge === badge)
    if (hit) return hit
    await sleep(gap)
  }
  return null
}

// ---------------------------------------------------------------- 准备

// 面板是全局的：先记下开跑前有没有别人的任务，决定「空态」那几项要不要跳过
const jobsBefore = ((await (await fetch(`${BASE}/api/jobs?limit=1`)).json()).jobs) || []
const panelWasEmpty = jobsBefore.length === 0

const mk = await fetch(`${BASE}/api/books`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ book_id: BOOK, title: BOOK }),
})
if (!mk.ok) {
  console.error(`建临时书失败（${mk.status}）：${(await mk.text()).slice(0, 200)}`)
  process.exit(1)
}
const stage = await mkdtemp(join(tmpdir(), 'wkv-jobs-files-'))
const filePaths = []
for (let i = 1; i <= N_FILES; i++) {
  const p = join(stage, `第${i}章 测试.md`)
  await writeFile(p, `# 第${i}章 测试\n\n这是第${i}章的正文。\n`, 'utf8')
  filePaths.push(p)
}

let cleaned = false
const cleanup = async () => {
  if (cleaned) return
  cleaned = true
  console.log('\n--- 收尾 ---')
  const notes = []
  try {
    // 1) 先把本书的任务全部收干净（跑着的先停、再等终态），否则删书会被写入拖垮
    let js = await bookJobs()
    for (const j of js) {
      if (!TERMINAL.includes(j.status)) {
        await fetch(`${BASE}/api/jobs/${j.id}/cancel`, { method: 'POST' }).catch(() => undefined)
      }
    }
    for (let i = 0; i < 100; i++) {
      js = await bookJobs()
      if (js.every((j) => TERMINAL.includes(j.status))) break
      await sleep(300)
    }
    const stuck = js.filter((j) => !TERMINAL.includes(j.status)).map((j) => j.id)
    if (stuck.length) notes.push(`⚠️ 有任务没能停下来：${stuck.join(',')}`)

    // 2) 删任务记录（这时都能删了）
    for (const j of js) {
      const r = await fetch(`${BASE}/api/jobs/${j.id}`, { method: 'DELETE' })
      if (!r.ok) notes.push(`删任务记录 ${j.id} 失败：${r.status}`)
    }

    // 3) 整本书删掉（body 要 book_id 和 confirm 两个字段，只发 confirm 会 422）
    const del = await fetch(`${BASE}/api/books/${encodeURIComponent(BOOK)}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ book_id: BOOK, confirm: BOOK }),
    })
    if (!del.ok) {
      console.log(`  ⚠️ 临时书删除失败：${del.status} ${(await del.text()).slice(0, 160)}`)
      return
    }
    const info = await del.json().catch(() => ({}))
    console.log(`  临时书「${BOOK}」已整本删除，${js.length} 条任务记录已清`)

    // 4) 删书会留一份快照（产品自己的安全网）—— 这是测试垃圾，顺手收掉。
    //    只认「本次这本书」的快照目录，别的一概不碰。
    const snapDir = String(info?.snapshot?.dir || '')
    if (snapDir) {
      const name = snapDir.split(/[\\/]/).pop() || ''
      if (name.startsWith(BOOK) && name.includes('book-delete')) {
        await rm(snapDir, { recursive: true, force: true }).catch(() => undefined)
        console.log(`  已清掉这次删除产生的快照 ${name}`)
      } else {
        console.log(`  （快照路径没认出来，留着不动：${snapDir}）`)
      }
    }
    for (const n of notes) console.log(`  ${n}`)
    console.log('  净效果为零')
  } catch (e) {
    console.error(`  ⚠️ 清理失败，请手工删掉书目「${BOOK}」：`, e.message)
  }
  await rm(stage, { recursive: true, force: true }).catch(() => undefined)
}
process.on('exit', () => void cleanup())

try {
  await send('Runtime.enable')
  await send('DOM.enable')
  await send('Page.navigate', { url: BASE })
  await sleep(5000)

  // 选到那本临时书
  await ev(`(() => {
    const s=document.querySelector('.topbar select.select')
    if(!s) return 0
    const setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set
    setter.call(s, ${JSON.stringify(BOOK)})
    s.dispatchEvent(new Event('change',{bubbles:true}))
    return 1
  })()`)
  await sleep(2500)

  // -------------------------------------------------------------- 空态
  console.log('\n=== 任务中心：入口、空态、说人话 ===')
  await goto('任务')
  check('左栏「任务」入口能打开任务中心',
    (await ev(`!!document.querySelector('.job')`)) === true)
  if (panelWasEmpty) {
    check('没有任务时说清楚「现在没有任务在跑」',
      (await ev(`document.body.innerText.includes('现在没有任务在跑')`)) === true)
    check('空态里教了「长活儿都会排到这里来」',
      (await ev(`document.body.innerText.includes('都会排到这里来')`)) === true)
    check('空态下列出三类任务各自是干什么的',
      (await ev(`['重建索引','批量 AI 抽取','批量导入章节'].every(t=>document.body.innerText.includes(t))`)) === true)
    check('写清了「可续跑」这件事',
      (await ev(`document.body.innerText.includes('可续跑')`)) === true)
  } else {
    skip('空态那几句文案', `这台实例上本来就有 ${jobsBefore.length}+ 条任务记录，面板不是空的`)
  }

  // -------------------------------------------------------------- 真界面路径提交导入
  console.log(`\n=== 从正文面板真的导入 ${N_FILES} 个文件（走界面那条路）===`)
  await goto('正文')
  const doc = await send('DOM.getDocument', { depth: -1 })
  const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
  check('正文面板里有文件选择框', Boolean(q && q.nodeId), JSON.stringify(q))
  await send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: filePaths })
  // ⚠️ 别用固定 sleep 等预检 —— 上百个文件的解析耗时随机器而变，
  // 等短了按钮还是 disabled，后面会**连锁全红**（看起来像产品坏了）。
  // 这里**轮询到按钮真的可用**为止（最多 30 秒）。
  const grabBtn = `[...document.querySelectorAll('button')].find(x=>(x.innerText||'').startsWith('导入 ${N_FILES}'))`
  const readBtn = `(() => { const b=${grabBtn}; return b ? { text:b.innerText.trim(), disabled:b.disabled } : null })()`
  const ready0 = await ev(readBtn)
  check(`选了文件之后出现「导入 ${N_FILES} 个文件」按钮`, Boolean(ready0), JSON.stringify(ready0))
  let ready = ready0
  const tReady = Date.now()
  while (ready && ready.disabled && Date.now() - tReady < 30000) {
    await sleep(400)
    ready = await ev(readBtn)
  }
  check(`预检跑完后「导入 ${N_FILES} 个文件」按钮变成可点`,
    Boolean(ready) && !ready.disabled,
    `等了 ${Math.round((Date.now() - tReady) / 1000)}s：${JSON.stringify(ready)}`)
  const didImport = await ev(`(() => { const b=${grabBtn}; if(!b || b.disabled) return false; b.click(); return true })()`)
  check(`能按到「导入 ${N_FILES} 个文件」`, didImport === true)

  // 本书的第一个导入任务（后面停止 / 续跑都拿它当参照）
  const first = await waitBookJob((j) => j.kind === 'import')
  check('**任务真的排进了队列**（按 book_id 查得到）',
    Boolean(first), '本书的导入任务没出现')

  // -------------------------------------------------------------- 看得见
  console.log('\n=== 长任务在界面上看得见 ===')
  // ⚠️ 小条要等「上传 + 落暂存盘」的 POST 返回后才会出现 —— 实测 200 个文件
  // 这个 POST 要 ~4.6s，再加一轮轮询延迟，约 6s 才见得到。窗口给到 30s。
  let chip = null
  const tChip = Date.now()
  for (let i = 0; i < 120; i++) {
    chip = await ev(`(() => {
      const c=document.querySelector('.jobchip')
      if(!c) return null
      const f=document.querySelector('.jobchip__fill')
      return { text:(c.innerText||'').replace(/\\s+/g,' ').trim(),
               width: f ? Math.round(parseFloat(getComputedStyle(f).width)) : 0 }
    })()`)
    if (chip) break
    await sleep(250)
  }
  check('**顶栏出现常驻小条**（切到别的面板也看得见进度）', Boolean(chip),
    `等了 ${Math.round((Date.now() - tChip) / 1000)}s 还没出现 —— 任务跑太快？把 N_FILES 调大`)
  check('小条上写着任务类型',
    chip && chip.text.includes('批量导入章节'), JSON.stringify(chip))
  // 刚建出来的任务进度是 0%，此时进度条宽度本来就是 0 —— 等它真的推进再说
  let chipW = chip ? chip.width : 0
  for (let i = 0; i < 60 && chipW === 0; i++) {
    await sleep(250)
    chipW = (await ev(`(() => { const f=document.querySelector('.jobchip__fill'); return f ? Math.round(parseFloat(getComputedStyle(f).width)) : 0 })()`)) || 0
  }
  check('小条上的进度条真的在推进（宽度 > 0）', chipW > 0, `宽度 ${chipW}px`)

  // 小条是顶栏的，哪儿都看得见；大卡在「任务中心」面板里 ——
  // dockview 的面板切走后可能被卸载，所以先切过去再查大卡。
  await goto('任务')
  let hero = await ev(HERO)
  check('**任务中心的大卡显示正在跑的任务**', Boolean(hero), '大卡没出现，可能任务已经跑完')
  check('大卡上有进度条，且已推进（宽度 > 0）', hero && hero.width > 0, JSON.stringify(hero))
  check(`大卡上写着真实的计数「N / ${N_FILES} 个文件」`,
    hero && new RegExp(`/\\s*${N_FILES}`).test(hero.text), JSON.stringify(hero))
  check('大卡上有「停止」按钮', hero && hero.hasStop, JSON.stringify(hero))

  // 从别的界面切回来，进度还在（这是「人可以走开」的证据）
  await goto('汇总')
  await goto('任务')
  hero = await ev(HERO)
  check('**切去别的面板再回来，任务照跑**（进度没断）', Boolean(hero), JSON.stringify(hero))

  // -------------------------------------------------------------- 日志
  console.log('\n=== 日志能点开，且是后端真记的 ===')
  check('能按到「看日志」', (await clickText('.job__hero button', '看日志')) === true)
  await sleep(1300)
  const log = await ev(`(() => {
    const el=document.querySelector('.job__log')
    if(!el) return null
    return { lines: el.querySelectorAll('.job__line').length,
             text:(el.innerText||'').slice(0, 400),
             mono: getComputedStyle(el).fontFamily }
  })()`)
  check('点「看日志」能展开日志框', Boolean(log), '日志框没出现')
  check('日志里真的有后端记的行（含逐项入册的痕迹）',
    log && log.lines > 0 && (log.text.includes('开始执行') || log.text.includes('入册')),
    JSON.stringify(log))
  check('日志用等宽字体（好读、对齐）',
    log && /mono|Cascadia|Consolas/i.test(log.mono), String(log && log.mono))

  // -------------------------------------------------------------- 停止
  console.log('\n=== 停止：停在安全点，且如实说 ===')
  // 停之前先确认它还在跑（否则「按停」这个动作本身就不成立）
  const preStop = first ? await (await fetch(`${BASE}/api/jobs/${first.id}`)).json() : null
  if (preStop && preStop.status !== 'running') {
    skip('按「停止」把任务停在半路', `任务已经到 ${preStop.status} 了，来不及按停（把 N_FILES 调大）`)
  } else {
    check('能按到「停止」', (await clickText('.job__hero button', '停止')) === true)
  }
  const cancelRow = await waitRow('已停止', 80, 300)
  check('**停止后历史里出现「已停止」的记录**', Boolean(cancelRow), JSON.stringify(cancelRow))
  check('已停止的解释说的是「停在子项之间、已完成的部分保留着」',
    cancelRow && cancelRow.text.includes('停在子项之间') && cancelRow.text.includes('保留'),
    JSON.stringify(cancelRow))
  check('**已停止的记录上有「续跑」按钮**（这才是能接着做的那条路）',
    cancelRow && cancelRow.buttons.includes('续跑'),
    JSON.stringify(cancelRow && cancelRow.buttons))
  check('停完顶栏小条收起来了',
    (await ev(`!!document.querySelector('.jobchip')`)) === false)

  const stopped = first ? await waitTerminal(first.id, 60, 300) : null
  check('后端也确认这个任务是「已停止」（不是界面自己编的）',
    Boolean(stopped) && stopped.status === 'cancelled', JSON.stringify(stopped && stopped.status))
  const doneBefore = stopped ? (stopped.items_done || []).length : 0
  check('按停时确实只做了一部分（说明真的按在了半路）',
    doneBefore > 0 && doneBefore < N_FILES, `已完成 ${doneBefore} / ${N_FILES}`)

  // -------------------------------------------------------------- 续跑
  console.log('\n=== 续跑：只补没做完的 ===')
  const didResume = await ev(`(() => {
    const rows=[...document.querySelectorAll('.job__item')]
    const row=rows.find(el=>(el.querySelector('.job__badge')?.innerText||'').trim()==='已停止')
    const b=row && [...row.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='续跑')
    if(!b) return false
    b.scrollIntoView({block:'center'}); b.click(); return true
  })()`)
  check('能按到「续跑」', didResume === true)
  const second = await waitBookJob(
    (j) => j.kind === 'import' && first && j.resumed_from === first.id, 120, 300)
  check('**续跑真的派生出一个新任务**（并记得它从谁那里续的）',
    Boolean(second), JSON.stringify(second && { id: second.id, resumed_from: second.resumed_from }))
  check('续跑任务带着「要跳过哪些」的清单（=上次已经做完的）',
    Boolean(second) && (second.skip || []).length === doneBefore,
    second ? `skip=${(second.skip || []).length}，上次完成=${doneBefore}` : '')
  const done2 = second ? await waitTerminal(second.id, 400, 400) : null
  check('续跑最后跑到「完成」', Boolean(done2) && done2.status === 'done',
    JSON.stringify(done2 && { status: done2.status, error: done2.error }))
  check(`完成时覆盖 ${N_FILES} 项（跳过 + 新做 = 全部）`,
    Boolean(done2) && (done2.items_done || []).length === N_FILES,
    done2 ? `items_done=${(done2.items_done || []).length}` : '')

  const chapters = await (await fetch(
    `${BASE}/api/books/${encodeURIComponent(BOOK)}/chapters`)).json()
  check(`**${N_FILES} 章都进了库**（停止 + 续跑这一路没丢章、也没重复）`,
    chapters.count === N_FILES, `实际 ${chapters.count} 章`)

  // -------------------------------------------------------------- 汇总页的重建
  console.log('\n=== 汇总页「重建索引」也走任务（不再同步干等）===')
  await goto('汇总')
  const clickedRebuild = await ev(`(() => {
    // ⚠️ action-card 的按钮 innerText 是「重建索引\\n索引坏了/删了/改乱了，一键恢复」，
    // 用 === '重建索引' 永远匹配不到，必须按开头匹配。
    const b=[...document.querySelectorAll('button')].find(x=>{
      const t=(x.innerText||'').trim()
      return t.startsWith('重建索引') && !x.disabled
    })
    if(!b) return false
    b.scrollIntoView({block:'center'}); b.click(); return true
  })()`)
  check('汇总页能按到「重建索引」', clickedRebuild === true)
  const rebuild = await waitBookJob((j) => j.kind === 'rebuild', 80, 300)
  check('**点按钮后排进任务中心**（不再原地同步等）', Boolean(rebuild), '没等到重建任务')
  check('重建那条标着「重建索引」这个类型', rebuild && rebuild.kind === 'rebuild',
    JSON.stringify(rebuild && rebuild.title))

  // -------------------------------------------------------------- 重启后的如实交底
  console.log('\n=== 界面能如实呈现「中断（未跑完）」===')
  const interruptCopy = await ev(`document.body.innerText.includes('续跑')`)
  check('界面上能读懂的「续跑」入口存在', interruptCopy === true)

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
