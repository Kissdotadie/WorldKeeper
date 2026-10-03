/**
 * 前端生产依赖的许可证扫描（P8 分发合规）。
 *
 * 只扫**生产依赖** —— 开发依赖（typescript / vite 等）不进构建产物，
 * 不随包分发，无需声明。
 *
 * 为什么读 `package-lock.json` 而不是 `npm ls --omit=dev --all`：
 * npm ls 会报出**幻影条目** —— 本次实测它列出了 `preact-render-to-string`，
 * 而那个包既没装在 node_modules 里、也不在 package-lock 里（是 npm 解析
 * 依赖图时的残留）。以它为准会把一个根本不会分发的包写进声明页。
 * lock 文件记录的是「真正会装上的那份」，才是分发的真实集合。
 *
 * 顺带的好处：读 lock 不需要先 `npm install`，构建流水线里不会被网络卡住。
 *
 * 用法：
 *     node scripts/scan_web_licenses.mjs            # 打印清单
 *     node scripts/scan_web_licenses.mjs --json     # 输出 JSON（给构建脚本吃）
 *
 * 退出码：发现 GPL / AGPL / SSPL 等传染性或禁商用协议 → 1，否则 0。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB = join(__dirname, '..', 'web')

/** 传染性或禁商用协议 —— 一旦命中必须换掉那个包，不能只是记一笔 */
const FORBIDDEN = ['AGPL', 'GPL', 'SSPL', 'EUPL', 'CPAL', 'OSL-3', 'RPL', 'COMMONS CLAUSE']
/** 需要挂备注的（弱著佐权 / 非标准）—— 可商用，但要在声明页说明 */
const FOOTNOTE = ['MPL', 'EPL', 'CDDL']

let lock
try {
  lock = JSON.parse(readFileSync(join(WEB, 'package-lock.json'), 'utf8'))
} catch {
  console.error('读不到 web/package-lock.json —— 请先在 web/ 下跑一次 npm install')
  process.exit(2)
}

const rows = []
for (const [path, meta] of Object.entries(lock.packages || {})) {
  if (!path.startsWith('node_modules/')) continue   // 忽略根项目自身
  if (meta.dev) continue                            // 开发依赖不进产物
  if (meta.link) continue                           // 本地软链不是第三方
  rows.push({
    name: path.slice('node_modules/'.length),
    version: meta.version || '',
    license: meta.license || '（未声明）',
  })
}
rows.sort((a, b) => a.name.localeCompare(b.name))

const up = (s) => s.toUpperCase()
const forbidden = rows.filter((r) => FORBIDDEN.some((f) => up(r.license).includes(f)))
const notes = rows.filter((r) => FOOTNOTE.some((f) => up(r.license).includes(f)))

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ count: rows.length, rows, forbidden, notes }, null, 2))
} else {
  console.log(`前端生产依赖（按 package-lock）：${rows.length} 个\n`)
  for (const r of rows) console.log(`  ${r.name.padEnd(30)} ${r.license}`)
  console.log(`\n传染性/禁商用：${forbidden.length ? forbidden.map((r) => `${r.name}(${r.license})`).join(', ') : '无'}`)
  console.log(`需挂备注：${notes.length ? notes.map((r) => `${r.name}(${r.license})`).join(', ') : '无'}`)
}

process.exit(forbidden.length ? 1 : 0)
