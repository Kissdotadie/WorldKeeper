/** 快捷键表（P11-A2 的验收项：**快捷键表可见且有作用域**）。
 *
 * 这张表的数据直接从注册表读（`shortcutCatalog()`），不是手写的一份文档 ——
 * 手写的那份一定会和代码漂移，而且漂移了没人发现。
 *
 * 「灰掉」的条目不是坏了，是**需要先打开对应视图**才生效（快捷键随组件挂载注册）。
 * 这一点必须写在界面上，否则看到一片灰会以为功能没了。
 */

import { useState } from 'react'
import { shortcutCatalog, shortcutConflicts } from '../lib/shortcuts'
import { Panel } from '../components/Panel'
import { GUIDE_REOPEN_EVENT } from './WelcomeGuide'

/** 读一次快照。注册表是模块级 Map，不读进 state 的话 React 不知道它变了。 */
function snapshot() {
  return { groups: shortcutCatalog(), conflicts: shortcutConflicts() }
}

export function ShortcutPanel() {
  const [snap, setSnap] = useState(snapshot)
  const [openScope, setOpenScope] = useState<string | null>(null)

  const reload = () => setSnap(snapshot())

  const { groups, conflicts } = snap
  const total = groups.reduce((s, g) => s + g.items.length, 0)
  const live = groups.reduce((s, g) => s + g.items.filter((i) => i.active).length, 0)

  return (
    <Panel
      title="快捷键"
      className="admin__keys"
      collapsible
      sectionId="admin:keys"
      actions={
        <div className="row" style={{ gap: 'var(--p-space-2)' }}>
          <button
            className="btn btn--sm"
            title="第一次打开时那份一分钟引导"
            onClick={() => window.dispatchEvent(new Event(GUIDE_REOPEN_EVENT))}
          >
            重看新手引导
          </button>
          <button className="btn btn--sm" onClick={reload}>
            重新读取
          </button>
        </div>
      }
    >
      <div className="notice" style={{ marginBottom: 'var(--p-space-3)' }}>
        <div>
          这张表<b>由代码里的注册表直接生成</b>，不是另外手写的一份 —— 所以不会和实际行为漂移。
          快捷键按<b>作用域</b>分：全局键任何时候都管用，图/地图上的键要先打开那个视图。
          <b>灰掉的</b>表示此刻没有挂载对应视图，打开它就会亮起来。
        </div>
      </div>

      <div className="audit__bar">
        <span className="chip">{total} 条快捷键</span>
        <span className="chip chip--accent">{live} 条此刻生效</span>
        {conflicts.length > 0 ? (
          <span className="chip" style={{ color: 'var(--danger)' }}>
            {conflicts.length} 处键位冲突
          </span>
        ) : (
          <span className="chip">无键位冲突</span>
        )}
      </div>

      {conflicts.length > 0 && (
        <div className="notice notice--warn" style={{ marginBottom: 'var(--p-space-3)' }}>
          {conflicts.map((c) => (
            <div key={`${c.scope}-${c.keys}`} className="fs-xs">
              <code>{c.keys}</code>（{c.scope}）被 {c.ids.length} 个动作同时占用：{c.ids.join('、')}
              {' '}—— 只有优先级最高的那个会生效，请给其中一个换键位或改优先级。
            </div>
          ))}
        </div>
      )}

      {groups.length === 0 ? (
        <div className="empty">
          <div className="empty__title">还没读到任何快捷键</div>
          <div className="fs-sm">多打开几个视图再回来点「重新读取」。</div>
        </div>
      ) : (
        <div className="keys">
          {groups.map((g) => {
            const collapsed = openScope !== null && openScope !== g.scope
            return (
              <section className="keys__group" key={g.scope}>
                <button
                  className="keys__head"
                  onClick={() => setOpenScope(openScope === g.scope ? null : g.scope)}
                  aria-expanded={!collapsed}
                >
                  <span className="keys__scope">{g.label}</span>
                  <span className="faint fs-xs">
                    {g.items.filter((i) => i.active).length}/{g.items.length} 生效
                  </span>
                  <span className="grow" />
                  <span className="faint fs-xs">{collapsed ? '展开' : '收起'}</span>
                </button>
                {!collapsed && (
                  <ul className="keys__list">
                    {g.items.map((s) => (
                      <li key={s.id} className={`keys__row ${s.active ? '' : 'keys__row--off'}`}>
                        <span className="keys__keys">
                          {s.keys.split('+').map((k) => (
                            <kbd key={k} className="kbd">
                              {k}
                            </kbd>
                          ))}
                        </span>
                        <span className="keys__desc">{s.desc}</span>
                        {!s.active && <span className="chip">未挂载</span>}
                        <span className="faint fs-xs mono keys__id">{s.id}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      )}
    </Panel>
  )
}
