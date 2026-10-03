/** 与后端接口一一对应的类型定义。改动后端返回结构时同步改这里。 */

export interface Book {
  book_id: string
  title: string
  author: string
  /** 题材（玄幻/科幻/…）—— 决定录入界面的示例与占位文案 */
  genre?: string
  /** 封面，素材库相对路径（covers/xxx.jpg） */
  cover?: string
  entity_count: number
  path?: string
  /** 类型 key → 界面上显示的名字（已合并内置名，未自定义的就是内置名） */
  type_labels?: Record<string, string>
}

/** 改类型显示名的返回：labels 是改完后的样子，builtin 是内置名对照 */
export interface TypeLabelsResult {
  book_id: string
  type_labels: Record<string, string>
  builtin: Record<string, string>
  config_file: string
}

export interface TypeOption {
  key: string
  label: string
  /** 仅自定义类型有；内置 8 类的颜色走 tokens.css 静态定义 */
  color?: string | null
}

/** /books/{id}/types 返回的一行（P7.6 自定义类型管理用） */
export interface EntityTypeInfo extends TypeOption {
  /** 存储子目录名（entities/<subdir>/）—— 内置类型与 key 不同（character→characters） */
  subdir: string
  /** ID 前缀（spe → spe-0001） */
  prefix: string
  builtin: boolean
  removable: boolean
  /** 名下实体数（文件系统为准） */
  count: number
}

export interface EntityTypesData {
  book_id: string
  types: EntityTypeInfo[]
  max_custom: number
}

/** 索引里的实体摘要（列表用，不含正文小节） */
export interface EntityMeta {
  id: string
  book_id: string
  type: string
  name: string
  file_path: string
  status: string | null
  first_appear: string | null
  /** 自定义图标：素材库相对路径（如 `icons/knight.png`），没有则为 null */
  icon: string | null
  summary: string | null
  updated_at: string
  /** 列表接口聚合返回 */
  aliases?: string[]
  tags?: string[]
  /** 方法论引用（名字数组）。角色信奉哪套哲学观就挂在这里。 */
  methodologies?: string[]
}

/** 实体正文的五个标准小节 */
export interface EntityBody {
  摘要: string
  属性: [string, string][]
  出场记录: [string, string][]
  关联: string[]
  待补充: string[]
}

export interface Appearance {
  chapter: string
  note: string
}

export interface Relation {
  to_name: string
  to_id: string | null
  kind: string | null
}

export interface Provenance {
  method: string
  sources: { chapter?: string; paragraph?: number; note?: string }[]
}

export interface EntityDetail extends EntityMeta {
  aliases: string[]
  tags: string[]
  methodologies: string[]
  appearances: Appearance[]
  relations: Relation[]
  body: EntityBody
  created_at: string
  provenance: Provenance
  type_label: string
}

export interface SearchHit {
  id: string
  name: string
  type: string
  summary: string | null
  snippet: string | null
}

export interface Stats {
  book_id: string
  total: number
  by_type: Record<string, number>
  relations: number
  types: TypeOption[]
}

/** 汇总页数据看板（一次往返拿完，详见后端 store.dashboard_overview） */
export interface OverviewCount {
  label: string
  count: number
}

/** 标签排行。**字段名是 `name` 不是 `label`** —— 因为它来自 entity_tags.tag，
 *  与「分档」那种自己造标签的列表不是一回事，别把两者合并成一个类型。 */
export interface OverviewTag {
  name: string
  count: number
}

export interface OverviewTopEntity {
  id: string
  name: string
  type: string
  count: number
}

/** 索引健康快照 —— 页面「什么都画不出来」时用来解释原因（后端 api_overview 附带）。 */
export interface OverviewHealth {
  data_dir: string
  book_dir: string
  book_dir_exists: boolean
  entities_dir_exists: boolean
  index_file: string
  index_file_exists: boolean
  index_file_mtime: string | null
  index_total: number
  /** 磁盘上数出来的 md 文件数；索引里有数时为 null（那时不扫盘，省时间） */
  disk_total: number | null
  /** 磁盘上有实体、索引里没有 = 索引过期，重建即可 */
  index_stale: boolean
}

export interface Overview {
  book_id: string
  entities: { total: number; by_type: Record<string, number> }
  relations: { total: number; linked: number; dangling: number }
  tags: { total: number; top: OverviewTag[] }
  /** 完备度 0~4 分各有多少条，下标即分数 */
  completeness: { average: number; buckets: number[] }
  /** 关系度数分档（含空档，横轴稳定）与连线最多的实体 */
  degree: { buckets: OverviewCount[]; top: OverviewTopEntity[] }
  chapters: {
    count: number
    words: number
    series: { no: number | null; title: string; words: number }[]
  }
  appearances: { chapter: string; count: number }[]
  types: TypeOption[]
  /** 索引健康快照（老后端可能没有这个字段，读的时候要兜） */
  health?: OverviewHealth
}

/** 实体体检筛出的一条可疑记录（后端 audit.scan）。 */
/** 示例书的现状（P11-7️⃣③）：默认名字能不能用、库里已有哪几本示例书。 */
export interface SampleBookStatus {
  default_id: string
  default_title: string
  /** 已被占用的书目 ID —— 界面据此提示「换个名字」 */
  taken: string[]
  /** 库里已有的示例书（book.yaml 里带 sample: true） */
  samples: Book[]
}

export interface SampleBookResult {
  book_id: string
  title: string
  entities: number
  chapters: number
  docs: number
  maps: number
}

/** 整本删除的结果。`snapshot` 是删除前的自动快照 —— 后悔了从那儿捞。 */
export interface DeleteBookResult {
  deleted: boolean
  book_id: string
  title: string
  snapshot: { dir: string; count: number } | null
}

export interface LintItem {
  id: string
  name: string
  type: string
  /** 问题分类：adverb / verb_phrase / redup / interjection … */
  kind: string
  /** 可以直接给人看的理由 */
  reason: string
  /** high = 几乎确定是垃圾（默认勾选）；mid = 像垃圾，但留给人自己判断 */
  severity: 'high' | 'mid'
}

export interface LintResult {
  book_id: string
  /** 索引里的实体总数 */
  total: number
  /** 筛出来的可疑条数 */
  flagged: number
  high: number
  mid: number
  items: LintItem[]
}

export interface LintDeleteResult {
  deleted: number
  ids: string[]
  failed: string[]
  /** 删除前的自动快照（回滚用），没删文件时为 null */
  snapshot: { dir: string; count: number; files: string[] } | null
}

/** 不一致体检里的一条证据 —— 两处记录对不上，总得让人看见是哪两处。 */
export interface ConsistencyEvidence {
  label: string
  text?: string
  /** 证据落在某个实体上（可点击跳过去） */
  entity_id?: string
  /** 证据落在一份世界观档案里（foreshadow / geography / chronology …） */
  doc?: string
}

export interface ConsistencyEntityRef {
  entity_id: string
  name: string
  type: string
}

/** 不一致体检里的一条结论（后端 consistency.scan）。 */
export interface ConsistencyItem {
  id: string
  /** 五类检查之一：timeline / foreshadow / naming / geo / provenance */
  check: string
  check_name: string
  /** 与技能中心共用的性质词表：时间线 / 地理 / 称谓 / 出处 / 伏笔 … */
  nature: string
  severity: 'high' | 'mid' | 'low'
  title: string
  detail: string
  evidence: ConsistencyEvidence[]
  entities: ConsistencyEntityRef[]
  doc: string | null
}

/** 一类检查的分组统计 + 明细。 */
export interface ConsistencyCheckGroup {
  id: string
  name: string
  nature: string
  /** 这类检查到底查了什么 */
  covers: string
  /** 哪些留给 AI 判（纯规则做不到的） */
  leaves: string
  total: number
  /** 超出上限没列出来的条数 */
  omitted: number
  severity: Record<string, number>
  items: ConsistencyItem[]
  /** 各类自己的补充口径（比对了多少条、文档多少行…） */
  [k: string]: unknown
}

export interface ConsistencyResult {
  book_id: string
  checked_entities: number
  checked_chapters: number
  /** 是否连出处一起查了 */
  deep: boolean
  total: number
  severity: Record<string, number>
  clean: boolean
  checks: ConsistencyCheckGroup[]
  items: ConsistencyItem[]
  /** 与技能中心共用的词表 */
  natures: string[]
  severities: string[]
  generated_at: string
}

/** 批量粘贴解析出的草稿（预览用，未落盘） */
export interface PasteDraft {
  name: string
  attributes: [string, string][]
  aliases: string[]
  tags: string[]
  summary: string
  exists?: boolean
}

export interface PastePreview {
  mode: 'table' | 'list' | 'plain' | 'empty'
  count: number
  drafts: PasteDraft[]
  warnings: string[]
  book_id: string
  type: string
}

export interface PasteCommitResult {
  book_id: string
  type: string
  created: number
  /** 同名被跳过的条目名 */
  skipped: string[]
  /** 本次与已有实体重名的条目名 */
  conflicts: string[]
  items: { id: string; name: string; file: string }[]
}

export interface AdminInfo {
  data_dir: string
  program_dir: string
  index_file: string
  logs_dir: string
  frozen: boolean
  index_ready: boolean
}

/** 一个在工具外被动过（或消失了）的内容文件（P11-A5）。 */
export interface FingerprintChange {
  /** 相对书目录的路径，如 entities/characters/裴渊.md */
  path: string
  /** added = 新出现的；removed = 不见了；touched = 只改了时间戳；modified = 内容变了 */
  kind: 'added' | 'removed' | 'touched' | 'modified'
  /** 内容真的变了（sha1 不同）。false 只出现在 kind='touched' */
  content_changed: boolean
}

export interface FingerprintStatus {
  /** 之前有没有记过基线。false 表示这一次刚刚建立，从这一刻起才开始盯着 */
  has_baseline: boolean
  /** 基线的建立时间 */
  stored_at: string
  /** 纳入指纹的文件总数 */
  tracked: number
  /** 逐条差异（最多 200 条，多了会截断并置 truncated） */
  changed: FingerprintChange[]
  /** 内容真变了的条数 —— 这个数大于 0 才值得提醒 */
  content_changed: number
  /** 只是时间戳变了、内容没动的条数（复制/同步盘/还原会造成） */
  meta_only: number
  truncated: boolean
  /** 仅在「这次顺手建了基线」时出现 */
  baseline_just_created?: boolean
  baseline_count?: number
}

export interface RebuildResult {
  book_id?: string
  entities?: number
  elapsed_seconds?: number
  books?: { book_id: string; entities: number; elapsed_seconds: number }[]
  total_entities?: number
}

/** 一份快照（P11-A6）。`reason` 是它为什么被存下来：auto / manual / lint-delete … */
export interface SnapshotItem {
  name: string
  /** 快照目录的绝对路径（后悔时照着这儿找文件） */
  dir: string
  book_id: string
  reason: string
  /** 清单里记的存盘时刻 `YYYY-MM-DD HH:MM:SS` */
  created_at: string
  mtime: number
  /** 份内的文件数 */
  count: number
  bytes: number
  /** 老快照可能没有清单（目录是手建的），界面要能如实标出来 */
  has_manifest: boolean
}

export interface SnapshotPolicy {
  auto_enabled: boolean
  interval_hours: number
  /** 最多保留几份（保新删旧） */
  keep_count: number
  /** 快照目录总量上限（MB）；0 = 只看份数 */
  max_total_mb: number
}

export interface SnapshotList {
  snapshots: SnapshotItem[]
  count: number
  total_bytes: number
  policy: SnapshotPolicy
  /** 从没自动存过就是 null */
  last_auto: { ts: number; at: string; books: string[] } | null
}

export interface SnapshotTakeResult {
  taken: { book_id: string; dir: string; count: number }[]
  failed: { book_id: string; error: string }[]
  count: number
  total_bytes: number
}

export interface SnapshotPruneResult {
  removed: { name: string; bytes: number; book_id: string }[]
  freed_bytes: number
  /** 清完之后留下的份数 */
  kept: number
  failed: { name: string; error: string }[]
  dry_run: boolean
}

// ---------------------------------------------------------------- 异步任务（P11-A3）

/** 任务状态机。`interrupted` = 程序上次退出时它还没跑完（如实标，不假装还在跑）。 */
export type JobStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface JobEvent {
  /** 全局递增，界面的增量轮询游标 */
  seq: number
  at: string
  level: 'info' | 'ok' | 'warn'
  text: string
}

export interface Job {
  id: string
  /** rebuild / ai-extract / import */
  kind: string
  kind_label: string
  /** 这类任务是干什么的（列表上空着进度时用来解释） */
  hint: string
  book_id: string | null
  title: string
  status: JobStatus
  total: number
  done: number
  unit: string
  message: string
  error: string | null
  traceback?: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  elapsed_seconds: number | null
  /** 已完成 / 已处理过的子项键（续跑跳过它们） */
  items_done: string[]
  /** 续跑时从上一个任务带过来的「已做过」的键 */
  skip: string[]
  /** 当前子项的细信息，如 { chapter_no, title } */
  detail: Record<string, unknown> | null
  /** 产物：随任务类型不同（导入是 imported/skipped，AI 是 candidates/per_chapter…） */
  result: Record<string, unknown>
  events?: JobEvent[]
  /** 内存里最大 event_seq，增量轮询的游标 */
  event_seq: number
  events_dropped: number
  percent: number
  /** 我前面还排着几个 */
  queue_ahead: number
  can_cancel: boolean
  can_resume: boolean
  resumable: boolean
  resumed_from: string | null
  resumed_by: string | null
  args?: Record<string, unknown>
  request_id?: string
}

export interface JobKindInfo {
  kind: string
  label: string
  resumable: boolean
  hint: string
}

export interface JobsActive {
  running: Job | null
  queued: number
  queue: Job[]
}

// ---------------------------------------------------------------- 派生视图

export interface GraphNode {
  id: string
  name: string
  type: string
  degree: number
  unresolved: boolean
  status: string | null
  first_appear: string | null
  /** 实体自带的图标（素材相对路径） */
  icon?: string | null
  /** 标签。样式系统的「按标签批量上色」靠它 */
  tags?: string[]
}

export interface GraphEdge {
  source: string
  target: string
  kind: string | null
}

export interface GraphData {
  book_id: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  resolved_nodes: number
  dangling_nodes: number
  type_labels: Record<string, string>
}

export interface TimelineEntry {
  entity_id: string
  name: string
  type: string
  note: string
  kind: 'first' | 'appearance'
}

export interface TimelineChapter {
  chapter: string
  order: number | null
  entries: TimelineEntry[]
}

export interface TimelineData {
  book_id: string
  chapter_count: number
  entry_count: number
  chapters: TimelineChapter[]
  types: TypeOption[]
}

export interface RosterItem {
  id: string
  name: string
  type: string
  status: string | null
  first_appear: string | null
  summary: string | null
  updated_at: string
  /** 自定义图标：素材库相对路径（icons/xxx.png），没有则为 null */
  icon: string | null
  aliases: string[]
  tags: string[]
  appearance_count: number
  relation_count: number
  /** 0~4，越高说明这条登记得越完整 */
  completeness: number
}

export interface RosterData {
  book_id: string
  type: string
  type_label: string
  count: number
  items: RosterItem[]
  groups: Record<string, string[]>
  average_completeness: number
}

// ---------------------------------------------------------------- 整册档案

/** `world/` 下的一份档案（纪年表、剧情线、伏笔看板……） */
export interface DocData {
  book_id: string
  name: string
  title: string
  hint: string
  exists: boolean
  path: string
  /** 原始 Markdown —— 它才是真源，表格只是它的一个视图 */
  text: string
  columns: string[]
  rows: string[][]
  /** 文件还不存在时给出的骨架正文 */
  template: string
}

export interface DocSpec {
  name: string
  title: string
  hint: string
  columns: string[]
  exists: boolean
}

export interface DocList {
  book_id: string
  docs: DocSpec[]
  count: number
}

// ---------------------------------------------------------------- 外观系统

/** data/assets/<kind>/ 下的一份素材 */
export interface AssetItem {
  kind: string
  name: string
  stem: string
  ext: string
  size: number
  mtime: number
  /** 直接当 <img src> / @font-face src 用 */
  url: string
}

export interface AssetsData {
  kinds: string[]
  assets: Record<string, AssetItem[]>
}

export interface ThemeSpec {
  name: string
  description: string
  builtin: boolean
  modes: string[]
  file?: string
}

export interface ThemeList {
  themes: ThemeSpec[]
  active: string
  count: number
}

/** 主题包：只覆盖 CSS 变量，不动结构 */
export interface ThemePack {
  schema: number
  name: string
  description: string
  builtin: boolean
  vars: {
    dark?: Record<string, string>
    light?: Record<string, string>
  }
}

export type BackgroundKind = 'none' | 'color' | 'gradient' | 'image'

export interface BackgroundPref {
  kind: BackgroundKind
  /** kind=color 时的底色 */
  color: string
  /** kind=gradient 的起止色与角度 */
  from: string
  to: string
  angle: number
  /** kind=image 时的素材文件名 */
  image: string
  fit: 'cover' | 'contain' | 'repeat'
  /** 背景模糊（px） */
  blur: number
  /** 压暗程度 0~0.9，保文字可读 */
  dim: number
}

export interface UiPrefs {
  theme: string
  mode: 'dark' | 'light'
  font_scale: number
  /** 素材 stem；空串 = 用内置字体 */
  font_ui: string
  font_mono: string
  sidebar_open: boolean
  background: BackgroundPref
  /** 背景开启时的面板不透明度 0.5~1 */
  panel_alpha: number
  /** 顶栏/侧栏/弹窗是否用毛玻璃（backdrop-filter）。默认关 —— 大面积模糊很吃合成性能 */
  panel_blur: boolean
}

export interface Prefs {
  ui: UiPrefs
  [key: string]: unknown
}

// ---------------------------------------------------------------- 布局存档

export interface LayoutMeta {
  name: string
  panel_count: number | null
  size: number
}

export interface LayoutList {
  book_id: string
  active: string
  names: string[]
  layouts: LayoutMeta[]
  count: number
  file: string
}

export interface AppearanceWhere {
  assets_dir: string
  themes_dir: string
  preferences_file: string
  kinds: Record<string, { dir: string; count: number }>
  free_hint: string
}

// --------------------------------------------------------------------------
// 方法论（P2）
// --------------------------------------------------------------------------

/** 一条方法论 + 信奉它的实体 */
export interface MethodologyItem {
  name: string
  /** 已建成 methodology 实体时才有 */
  id: string | null
  holders: { id: string; name: string; type: string }[]
  count: number
  summary: string
  tags: string[]
  aliases: string[]
  has_entity: boolean
  updated_at: string
}

export interface MethodologyData {
  book_id: string
  count: number
  items: MethodologyItem[]
  /** 被引用但还没建成实体的方法论名 */
  missing: string[]
  tags: string[]
  holders_total: number
}

// --------------------------------------------------------------------------
// 章节正文（P2）
// --------------------------------------------------------------------------

export interface ChapterBrief {
  chapter_no: number
  title: string
  volume: string
  source_file: string
  imported_at: string
  word_count: number
  file_path: string | null
}

export interface ChapterStats {
  chapters: number
  words: number
  volumes: string[]
}

export interface ChapterListData {
  book_id: string
  count: number
  items: ChapterBrief[]
  stats: ChapterStats
  dir: string
}

export interface ChapterData extends ChapterBrief {
  book_id: string
  text: string
}

export interface ChapterImportResult {
  book_id: string
  imported: number
  skipped: number
  failed: number
  items: ChapterBrief[]
  skipped_items: { file: string; chapter_no: number; reason: string }[]
  errors: { file: string; error: string }[]
  stats: ChapterStats
}

/** 批量导入预检的单条结果（只解析不落盘） */
export interface ChapterPreviewItem {
  file: string
  ok: boolean
  chapter_no?: number
  title?: string
  volume?: string
  word_count?: number
  /** 章号已在库里 —— 冲突，默认跳过，勾覆盖才替换 */
  exists?: boolean
  /** 同批撞章号：值为先占用该章号的文件名 */
  dup_in_batch?: string | null
  error?: string
}

export interface ChapterPreviewResult {
  book_id: string
  total: number
  new: number
  conflicts: number
  failed: number
  items: ChapterPreviewItem[]
}

/** 规则抽取出的候选（未落盘，等人工勾选） */
/** 体检判定 —— 后端 lint 引擎对候选名的形态判断（人名词规则分类型生效） */
export interface LintVerdict {
  ok: boolean
  severity: 'high' | 'mid' | null
  kind: string | null
  reason: string | null
}

export interface ExtractCandidate {
  name: string
  type: string
  count: number
  confidence: number
  reasons: string[]
  chapters: number[]
  samples: string[]
  /** 出处：首次出现在哪一章的哪一段 */
  first_at: { chapter_no: number; para: number } | null
  exists: boolean
  entity_id: string | null
  /** 同句共现到的已知方法论 —— 抽取阶段自动挂的「信奉什么」 */
  methodologies: string[]
  /** 每条方法论的证据（出现次数 / 是否明确表态 / 出处句子） */
  methodology_evidence: Record<
    string,
    { count: number; strong: boolean; chapter_no: number; para: number; sentence: string }
  >
  /** 体检判定 —— 疑似非名词性片段的候选据此默认不勾 */
  lint?: LintVerdict
}

export interface ExtractAppearance {
  name: string
  entity_id: string
  count: number
  chapters: number[]
  samples: string[]
}

export interface ExtractResult {
  book_id: string
  candidates: ExtractCandidate[]
  appearances: ExtractAppearance[]
  stats: {
    chapters: number
    chars: number
    candidates: number
    new_candidates: number
    known_hits: number
  }
  picked_chapters: number[]
  type_options: TypeOption[]
  /** 候选里被体检判为「疑似垃圾」的条数 */
  suspect?: number
}

export interface ExtractCommitResult {
  book_id: string
  created: number
  skipped: number
  items: { id: string; name: string; type: string; file: string }[]
  skipped_items: { name: string; reason: string; entity_id?: string }[]
}

// ---------------------------------------------------------------- 技能中心

/** 技能卡（提示词模板库）。只做「读」：产出分析，不改正文一个字。 */
export interface SkillCard {
  id: string
  name: string
  scene: string
  placeholders: string[]
  /** 内置卡不可改不可删，只能复制成自定义 */
  builtin: boolean
  updated_at: string
  /** 详情才有模板正文；列表不带 */
  template?: string
}

export interface SkillList {
  items: SkillCard[]
  builtin: number
  custom: number
  readonly_notice: string
}

export interface SkillRunResult {
  skill_id: string
  skill_name: string
  book_id: string
  chapters: number[]
  content: string
  truncated: boolean
  prompt_chars: number
  provider: string
  model: string
  tokens: { prompt: number; completion: number; total: number }
  cost_cny: number
  latency_ms: number
  privacy_hint: string
  readonly_notice: string
}

// ---------------------------------------------------------------- AI 层

export interface AiProviderInfo {
  key: string
  label: string
  base_url: string
  model: string
  enabled: boolean
  is_default: boolean
  has_key: boolean
  key_masked: string
  price_input: number
  price_output: number
}

export interface AiBudget {
  monthly_limit_cny: number
  warn_at_percent: number
}

export interface AiConfig {
  default: string
  providers: AiProviderInfo[]
  budget: AiBudget
  privacy_hint: string
}

/**
 * AI 服务商申请引导（新手向，`app/ai/catalog.py` 供内容）。
 *
 * 为什么内容在后端：改文案不用重新构建界面 —— 与识别引擎目录同一套做法。
 */
export interface AiCatalogProvider {
  id: string
  label: string
  /** 只标一家：新手第一次配，选它最不容易卡住 */
  recommended?: boolean
  /** 「国内直连，不需要代理」这类大实话，新手最先要问的就是这个 */
  access: string
  url: string
  url_label: string
  /** 填进「AI 服务商」那一栏的原样值 */
  base_url: string
  model: string
  /** 只给量级，不写死数字（价目表改得勤） */
  pricing: string
  /** 一句话讲清「注册 → 充值 → 在哪建 key」 */
  signup: string
  note: string
}

export interface AiCatalogStep {
  n: number
  title: string
  detail: string
}

export interface AiCatalog {
  intro: { title: string; api: string; key: string; where: string }
  steps: AiCatalogStep[]
  providers: AiCatalogProvider[]
  local: AiCatalogProvider[]
  cost: { title: string; body: string }
  disclaimer: string
  privacy: string
  note: string
}

export interface AiTestResult {
  provider: string
  ok: boolean
  latency_ms: number
  model: string
  reply: string
  error: string
}

export interface AiUsageBucket {
  calls: number
  prompt_tokens: number
  completion_tokens: number
  cost_cny: number
  cache_hits: number
}

export interface AiUsage {
  total: AiUsageBucket
  month: AiUsageBucket & { month: string }
  by_book: Record<string, AiUsageBucket>
  by_provider: Record<string, AiUsageBucket>
  recent_chapters: {
    ts: string
    book_id: string
    chapter_no: number
    provider: string
    model: string
    prompt_tokens: number
    completion_tokens: number
    cost_cny: number
    cache_hit: boolean
  }[]
  budget: AiBudget
  month_percent: number | null
}

export interface AiMonitor {
  active: boolean
  started_at: string
  label: string
  calls: number
  tokens: number
  prompt_tokens: number
  completion_tokens: number
  cost_cny: number
}

export interface AiPrompt {
  name: string
  label: string
  content: string
  version: number
  updated_at: string
  is_default: boolean
  placeholders: string[]
  sha1: string
}

export interface AiPromptVersion {
  version: number
  is_current: boolean
  size: number
  sha1: string
  preview: string
}

export interface AiCandidate extends ExtractCandidate {
  summary?: string
  source?: string
}

export interface AiChange {
  name: string
  exists: boolean
  entity_id: string | null
  field: string
  detail: string
  evidence: string
  para: number | null
  chapter_no: number
}

export interface AiForeshadow {
  content: string
  evidence: string
  chapter_no: number
  para: number | null
}

export interface AiExtractResult {
  book_id: string
  candidates: AiCandidate[]
  changes: AiChange[]
  foreshadow: AiForeshadow[]
  per_chapter: {
    chapter_no: number
    status: 'ok' | 'cache' | 'error' | 'budget_stop'
    provider?: string
    model?: string
    prompt_version?: number
    tokens?: number
    cost_cny?: number
    candidates?: number
    changes?: number
    foreshadow?: number
    error?: string
    kind?: string
  }[]
  totals: {
    chapters_run: number
    chapters_failed: number
    tokens: number
    cost_cny: number
  }
  /** 候选里被体检判为「疑似垃圾」的条数 */
  suspect?: number
  privacy_hint: string
}

export interface ForeshadowCommitResult {
  added: number
  skipped: number
  added_items: string[]
  skipped_items: string[]
  total: number
  path: string
}

// --------------------------------------------------------------------------
// 地图（P4.5）
//
// 底图是用户自己传的图片，图上每个点（pin）指向一个 location 实体。
// 「点在哪」属装饰（view/maps/，一图一文件），「点是什么」属内容（entities/*.md）。
// 坐标一律**归一化 0~1**，换分辨率不重摆。
// --------------------------------------------------------------------------

/** 图上的一枚点位 */
export interface MapPin {
  id: string
  /** 指向的实体 id；为空表示先放了个标记，还没挂实体 */
  entity_id: string | null
  /** 覆盖显示名（默认取实体名） */
  label: string
  x: number
  y: number
  /** 点它跳到的另一张地图 id —— 层层下钻的入口 */
  portal: string | null
  /** 自由分类，留给样式系统按类上色 */
  kind: string | null
  color: string | null
  note: string
}

/** 手绘 / 识别出来的区域多边形 */
export interface MapRegion {
  id: string
  name: string
  entity_id: string | null
  /** [[x, y], ...] 归一化顶点，至少 3 个 */
  points: [number, number][]
  fill: string | null
  opacity: number
}

export interface MapDoc {
  id: string
  title: string
  /** 素材库相对路径，如 `maps/north.jpg` */
  image: string
  /** 底图原始像素尺寸（SVG viewBox 用） */
  width: number
  height: number
  /** 上级地图 id；顶层为 null */
  parent: string | null
  /**
   * 层级标签，**自由文本**（"世界" / "位面" / "十八层地狱" / "第三平行宇宙"…）。
   * 故意不做枚举：每种小说分层的方式都不一样。只用于显示与配色，
   * 既不决定 parent 也不决定缩进 —— 缩进只跟 parent 的深度走。
   */
  level: string
  note: string
  pins: MapPin[]
  regions: MapRegion[]
}

export interface MapEntityInfo {
  name: string
  type: string
  status: string | null
  /** false = 实体已删，那个点该画成虚的 */
  exists: boolean
}

export interface MapsData {
  book_id: string
  exists: boolean
  schema: number
  maps: Record<string, MapDoc>
  order: string[]
  /** 只用返回 pin 涉及的实体，省掉逐个请求 */
  entities: Record<string, MapEntityInfo>
  limits: {
    max_pins_per_map: number
    max_regions_per_map: number
    max_points_per_region: number
    max_maps: number
  }
}

// --------------------------------------------------------------------------
// 识别引擎（P4.5.3）
//
// 引擎只出**候选**：候选区域要人勾了才进地图，一个字都不入库。
// 与 AI 抽取同一套规矩。
// --------------------------------------------------------------------------

/** 一个引擎选项。`auto` 的 sends_image_offsite 不是固定的 —— 它取决于本地能不能用 */
export interface VisionEngineOption {
  id: string
  label: string
  available: boolean
  /** 不可用的原因（含怎么装）。可用时是空串 */
  reason: string
  /** 选它之后**这次**实际会走哪个引擎 */
  will_use: string
  will_use_label: string
  /** 选它之后图会不会离开这台机器 —— 必须让人一眼看见 */
  sends_image_offsite: boolean
  hint: string
}

/** 引擎目录里的一条 —— 「去哪下载 / 怎么装 / 什么许可」（用户 2026-10-03 拍板：引擎不进包）。 */
export interface VisionCatalogItem {
  id: string
  label: string
  /** 它在整条链路里干什么，如「基座（必需）」「OCR（推荐）」 */
  role: string
  license: string
  /** pip 包名（空格分隔的多个包）。云端那组没有这项 */
  pip?: string
  /** 体积量级，给人一个心理准备 */
  size: string
  /** 官方下载 / 控制台地址 —— 只放官方，不放第三方镜像 */
  url: string
  url_label: string
  /**
   * `verified` = 作者本机真跑通过；`code` = 代码已就位但没条件实测。
   * 界面据此显示徽标，不把「可能能用」说成「能用」。
   */
  adapted?: string
  /** 必需件（不分装不了任何识别） */
  needed?: boolean
  /** 云端那组的服务商线索，与 AI 服务商配置里那个 key 对得上 */
  provider_hint?: string
  note: string
}

export interface VisionCatalogInstall {
  label: string
  commands: string[]
  note: string
}

export interface VisionCatalog {
  local: VisionCatalogItem[]
  cloud: VisionCatalogItem[]
  install: Record<'source_run' | 'installed' | 'manual', VisionCatalogInstall>
  note: string
  license_note: string
}

export interface VisionConfig {
  engine: string
  engines: VisionEngineOption[]
  /** 当前选择对应的那一条 */
  current: VisionEngineOption
  /** 云端那节引用的服务商名字（密钥不在这里） */
  cloud_provider: string
  privacy: string
  local: Record<string, unknown>
  cloud: Record<string, unknown>
  /** 引擎目录：本地引擎 + 云端控制台 + 安装方法 */
  catalog: VisionCatalog
  limits: { max_image_bytes: number; cache_max_files: number }
  where: { config: string; cache: string }
  note: string
}

export interface VisionRegionCandidate {
  /** 归一化多边形，至少三个点 */
  points: [number, number][]
  /** 模型给的标签（本地引擎一般没有） */
  label: string
  /** 引擎自报的信心，不是概率。本地一律 0 */
  confidence: number
  source: string
}

export interface VisionTextCandidate {
  text: string
  x: number
  y: number
  confidence: number
  source: string
  /** 归一化的 [x, y, w, h]，用来在图上框给人对位置 */
  box: [number, number, number, number] | null
}

export interface VisionResult {
  engine: string
  engine_label: string
  sends_image_offsite: boolean
  regions: VisionRegionCandidate[]
  texts: VisionTextCandidate[]
  width: number
  height: number
  elapsed_ms: number
  /** 降级原因、跳过了什么 —— 界面必须原样显示，不许吞 */
  notes: string[]
  usage: Record<string, unknown>
}

export interface VisionAnalyzeResult {
  book_id: string
  image: { ref: string; bytes: number; sha256: string }
  requested_engine: string
  engine: string
  engine_label: string
  sends_image_offsite: boolean
  cached: boolean
  result: VisionResult
  notes: string[]
}

// ---------------------------------------------------------------------------
// 可视化样式（P5）
//
// 真正的定义在 `graph/styles.ts` —— 那里是**解析逻辑**（颜色、形状、优先级）
// 的老家，类型跟着逻辑走才不会被拆散在两个文件里。这里只是让 api 层
// 的调用方不必去 graph/ 里绕一圈。
// ---------------------------------------------------------------------------

export type {
  Decoration,
  GraphSpec,
  NodeShape,
  NodeStylePatch,
  PackMeta,
  PaletteId,
  StylePack,
  StyleRule,
  StylesData,
} from '../graph/styles'

// ---------------------------------------------------------------------------
// 打赏与交流群（P11-3️⃣②）
//
// 二维码的**真源在程序包里**（app/assets/donate/），哈希写在代码里
// （app/donate_manifest.py）。接口永远从包内吐图，所以数据目录里那份副本
// 怎么改都不会影响界面显示的码；被改过则自动覆盖回原图并留一条告警。
// 告警**不会自己消失**，只有人点「已知悉」才清。
// ---------------------------------------------------------------------------

export interface DonateItemInfo {
  exists: boolean
  url: string | null
  /** 界面上的名字（支付宝 / 微信支付 / QQ 群） */
  label: string
  sha256: string | null
  bytes: number | null
  /** ok / bundle_tampered / absent */
  state: string
}

export interface DonateAlert {
  level: 'warn' | 'critical'
  /** bundle_tampered / mirror_unfixed / mirror_restored */
  code: string
  title: string
  detail: string
  at: string
}

export interface DonateInfo {
  enabled: boolean
  items: { alipay: DonateItemInfo; wechat: DonateItemInfo; qqgroup: DonateItemInfo }
  /** ok / repaired / tampered / absent */
  integrity: 'ok' | 'repaired' | 'tampered' | 'absent'
  /** 需要人看一眼的提示。空数组 = 一切正常 */
  alerts: DonateAlert[]
  /** URL 随机后缀，换码一次变一次 */
  token: string
  checked_at: string
  // 刻意没有任何文件路径字段 —— 防替换说明不反过来给人指道（作者要求）
}
