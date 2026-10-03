/** 后端调用的唯一入口。所有请求都从这里出去，便于集中处理错误与 base 路径。 */

import type {
  AdminInfo,
  AiConfig,
  AiCatalog,
  AiExtractResult,
  AiMonitor,
  AiPrompt,
  AiPromptVersion,
  AiTestResult,
  AiUsage,
  AppearanceWhere,
  AssetItem,
  AssetsData,
  Book,
  ChapterData,
  ChapterImportResult,
  ChapterListData,
  ChapterPreviewResult,
  Decoration,
  DocData,
  DocList,
  DonateInfo,
  EntityBody,
  ConsistencyResult,
  DeleteBookResult,
  EntityDetail,
  EntityMeta,
  EntityTypeInfo,
  EntityTypesData,
  ExtractCommitResult,
  ExtractResult,
  FingerprintStatus,
  ForeshadowCommitResult,
  GraphData,
  Job,
  JobKindInfo,
  JobsActive,
  LayoutList,
  LintDeleteResult,
  LintResult,
  MapsData,
  MapDoc,
  MethodologyData,
  NodeStylePatch,
  Overview,
  PasteCommitResult,
  PastePreview,
  Prefs,
  RebuildResult,
  RosterData,
  SampleBookResult,
  SampleBookStatus,
  SearchHit,
  SkillCard,
  SkillList,
  SkillRunResult,
  SnapshotList,
  SnapshotPruneResult,
  SnapshotTakeResult,
  Stats,
  StylePack,
  StylesData,
  ThemeList,
  ThemePack,
  TimelineData,
  TypeLabelsResult,
  TypeOption,
  UiPrefs,
  VisionAnalyzeResult,
  VisionConfig,
} from './types'

/** 开发期走 vite 代理（同源 /api），打包后由 FastAPI 自身托管，所以恒为空串。 */
const BASE = ''

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

// ---------------------------------------------------------------------------
// 数据变更广播（P11-1️⃣①）
//
// 背景（已复现）：删掉一条实体后，**名册录**还留着它 —— 那个视图自己取数，
// effect 只依赖 `[bookId, type, groupBy]`，实体增删不会让它重取。
// 同类「自己取数」的视图还有世界观/地理观、方法论、伏笔、历史观/剧情线、
// 正文、技能中心等。一处一处补依赖，漏一个就又是一条幽灵条目。
//
// 所以把钩子挂在**所有请求的唯一出口**上：写操作成功 → 广播一次。
// 派生视图只要把 `dataVersion` 放进 effect 依赖，就自动跟着失效 ——
// 从「哪都别忘了刷」变成「一处递增、处处失效」，且新写的视图不会漏。
//
// 为什么排除 /api/donate/：那两个 POST（verify / ack）是**只读检查**，
// 不产生数据变更，广播了只会让全站视图白重取一遍。
// ---------------------------------------------------------------------------

type MutateListener = () => void
const mutateListeners = new Set<MutateListener>()

/** 订阅「有写操作成功」。返回取消订阅函数。 */
export function onDataMutated(fn: MutateListener): () => void {
  mutateListeners.add(fn)
  return () => {
    mutateListeners.delete(fn)
  }
}

const READ_ONLY_POSTS = ['/api/donate/']

function announceMutation(path: string, method: string): void {
  if (method === 'GET' || method === 'HEAD') return
  if (READ_ONLY_POSTS.some((p) => path.startsWith(p))) return
  for (const fn of mutateListeners) {
    try {
      fn()
    } catch {
      /* 某个订阅者抛错不该影响别的订阅者 */
    }
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 上传文件时不能自己写 Content-Type —— 浏览器要补 multipart 的 boundary
  const isForm = typeof FormData !== 'undefined' && init?.body instanceof FormData
  const headers: Record<string, string> = isForm ? {} : { 'Content-Type': 'application/json' }
  const method = (init?.method ?? 'GET').toUpperCase()

  let res: Response
  try {
    res = await fetch(BASE + path, { headers, ...init })
  } catch (err) {
    throw new ApiError(0, `连不上后端服务：${(err as Error).message}`)
  }

  if (!res.ok) {
    // FastAPI 的错误体是 {detail: "..."}，尽量把原文透出来
    let detail = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body?.detail) {
        detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
      }
    } catch {
      /* 响应体不是 JSON，保留状态行 */
    }
    throw new ApiError(res.status, detail)
  }

  if (res.status === 204) {
    announceMutation(path, method)
    return undefined as T
  }
  const data = (await res.json()) as T
  announceMutation(path, method)
  return data
}

const enc = encodeURIComponent

const qs = (params: Record<string, string | number | undefined | null>) => {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

// ---------------------------------------------------------------- 书目

export const listBooks = () => request<{ books: Book[]; count: number }>('/api/books')

export const createBook = (book_id: string, title: string, author = '', genre = '') =>
  request<Book>('/api/books', {
    method: 'POST',
    body: JSON.stringify({ book_id, title, author, genre }),
  })

/** 改书目元数据（书名/作者/题材/封面）。只动 book.yaml，不碰实体与正文。 */
export const updateBook = (bookId: string, patch: { title?: string; author?: string; genre?: string; cover?: string }) =>
  request<Book>(`/api/books/${encodeURIComponent(bookId)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })

/** 改类型的显示名。只动界面上的字，底层 key / 目录 / 编号一个不动。
 *  没提交的 key = 恢复内置名（后端整段重写覆盖表，不会留旧账）。 */
export const saveTypeLabels = (bookId: string, labels: Record<string, string>) =>
  request<TypeLabelsResult>(`/api/books/${encodeURIComponent(bookId)}/type-labels`, {
    method: 'PUT',
    body: JSON.stringify({ labels }),
  })

// ---------------------------------------------------------------- 自定义实体类型（P7.6）

export const listEntityTypes = (bookId: string) =>
  request<EntityTypesData>(`/api/books/${encodeURIComponent(bookId)}/types`)

export const addEntityType = (
  bookId: string,
  payload: { label: string; key: string; prefix?: string; color?: string },
) =>
  request<EntityTypeInfo>(`/api/books/${encodeURIComponent(bookId)}/types`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })

export const removeEntityType = (bookId: string, key: string) =>
  request<{ removed: string }>(
    `/api/books/${encodeURIComponent(bookId)}/types/${encodeURIComponent(key)}`,
    { method: 'DELETE' },
  )

// ---------------------------------------------------------------- 实体

export type EntitySort = 'name' | 'updated' | 'type'

export const listEntities = (bookId: string, type?: string, tag?: string, sort: EntitySort = 'name') =>
  request<{ book_id: string; count: number; items: EntityMeta[]; types: TypeOption[] }>(
    `/api/books/${encodeURIComponent(bookId)}/entities${qs({ type, tag, sort })}`,
  )

/** 汇总页数据看板：全部数字一次拿完（多一次往返就是多一次白屏） */
export const getOverview = (bookId: string) =>
  request<Overview>(`/api/books/${encodeURIComponent(bookId)}/overview`)

export const getEntity = (bookId: string, entityId: string) =>
  request<EntityDetail>(
    `/api/books/${encodeURIComponent(bookId)}/entities/${encodeURIComponent(entityId)}`,
  )

export interface EntityPayload {
  type: string
  name: string
  aliases?: string[]
  tags?: string[]
  first_appear?: string | null
  status?: string | null
  summary?: string | null
  /** 方法论标签 —— 该实体信奉/遵循的哲学观、戒律、主义、公约等 */
  methodologies?: string[]
  /**
   * 自定义图标（素材库相对路径）。
   * ⚠️ 后端的更新是**全量覆盖**：字段不带就等于清空，所以任何一处改实体
   * 都必须把自己不打算动的字段原样带回去（这一点踩过，图标差点被抹掉）。
   */
  icon?: string | null
  body?: Partial<EntityBody> | null
}

export const createEntity = (bookId: string, payload: EntityPayload) =>
  request<{ id: string; name: string; file: string }>(
    `/api/books/${encodeURIComponent(bookId)}/entities`,
    { method: 'POST', body: JSON.stringify(payload) },
  )

export const updateEntity = (bookId: string, entityId: string, payload: EntityPayload) =>
  request<{ id: string; name: string; file: string }>(
    `/api/books/${encodeURIComponent(bookId)}/entities/${encodeURIComponent(entityId)}`,
    { method: 'PUT', body: JSON.stringify(payload) },
  )

export const deleteEntity = (bookId: string, entityId: string) =>
  request<{ id: string; deleted: boolean }>(
    `/api/books/${encodeURIComponent(bookId)}/entities/${encodeURIComponent(entityId)}`,
    { method: 'DELETE' },
  )

export const getStats = (bookId: string) =>
  request<Stats>(`/api/books/${encodeURIComponent(bookId)}/stats`)

export const getTags = (bookId: string) =>
  request<{ book_id: string; tags: string[] }>(`/api/books/${encodeURIComponent(bookId)}/tags`)

export const search = (bookId: string, q: string, limit = 50) =>
  request<{ book_id: string; query: string; count: number; items: SearchHit[] }>(
    `/api/books/${encodeURIComponent(bookId)}/search${qs({ q, limit })}`,
  )

// ---------------------------------------------------------------- 批量粘贴

export interface PastePayload {
  text: string
  mode?: string | null
  type?: string
  tags?: string[]
}

/** 提交时只发用户在清单里留下的条目（后端也支持不传 drafts 的全量路径）。 */
export interface PasteCommitPayload extends PastePayload {
  drafts?: {
    name: string
    summary: string
    aliases: string[]
    tags: string[]
    attributes: [string, string][]
  }[]
  on_duplicate?: 'skip' | 'create'
}

export const previewPaste = (bookId: string, payload: PastePayload) =>
  request<PastePreview>(`/api/books/${encodeURIComponent(bookId)}/bulk-paste/preview`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })

/** 只提交用户在清单里勾选保留的条目 —— 不做静默全量落盘。 */
export const commitPaste = (bookId: string, payload: PasteCommitPayload) =>
  request<PasteCommitResult>(`/api/books/${encodeURIComponent(bookId)}/bulk-paste/commit`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })

// ---------------------------------------------------------------- 派生视图

export const getGraph = (bookId: string, opts: { types?: string[]; includeIsolated?: boolean } = {}) =>
  request<GraphData>(
    `/api/books/${encodeURIComponent(bookId)}/graph${qs({
      types: opts.types?.length ? opts.types.join(',') : undefined,
      include_isolated: opts.includeIsolated ? 'true' : undefined,
    })}`,
  )

export const getTimeline = (bookId: string, type?: string) =>
  request<TimelineData>(`/api/books/${encodeURIComponent(bookId)}/timeline${qs({ type })}`)

export const getRoster = (bookId: string, type: string, groupBy: 'none' | 'tag' | 'faction' = 'none') =>
  request<RosterData>(
    `/api/books/${encodeURIComponent(bookId)}/roster${qs({ type, group_by: groupBy })}`,
  )

// ---------------------------------------------------------------- 整册档案

export const listDocs = (bookId: string) =>
  request<DocList>(`/api/books/${encodeURIComponent(bookId)}/docs`)

export const getDoc = (bookId: string, name: string) =>
  request<DocData>(`/api/books/${encodeURIComponent(bookId)}/docs/${encodeURIComponent(name)}`)

export const saveDoc = (bookId: string, name: string, text: string) =>
  request<{ saved: boolean; path: string; columns: string[]; rows: string[][] }>(
    `/api/books/${encodeURIComponent(bookId)}/docs/${encodeURIComponent(name)}`,
    { method: 'PUT', body: JSON.stringify({ text }) },
  )

// ---------------------------------------------------------------- 外观系统

export const listAssets = () => request<AssetsData>('/api/assets')

/** 素材相对路径 → 可直接访问的 URL。`icons/knight.png` → `/api/assets/icons/knight.png/raw` */
export const assetUrlOf = (ref: string): string => {
  if (!ref) return ''
  if (ref.startsWith('/') || ref.startsWith('http')) return ref
  const [kind, ...rest] = ref.split('/')
  return `/api/assets/${enc(kind)}/${rest.map(enc).join('/')}/raw`
}

/** 上传素材。同名直接覆盖（后端行为）。 */
export const uploadAsset = (kind: string, file: File) => {
  const fd = new FormData()
  fd.append('file', file, file.name)
  return request<AssetItem>(`/api/assets/${enc(kind)}`, { method: 'POST', body: fd })
}

export const deleteAsset = (kind: string, name: string) =>
  request<{ deleted: boolean }>(`/api/assets/${enc(kind)}/${enc(name)}`, { method: 'DELETE' })

/** 全部素材的引用位置（C4/B4：删之前先看会影响谁） */
export interface AssetRef {
  label: string
  file: string
}
export interface AssetUsageData {
  usages: Record<string, AssetRef[]>
}
export const getAssetUsage = () => request<AssetUsageData>('/api/assets/usage')

export const listThemes = () => request<ThemeList>('/api/themes')

export const getTheme = (name: string) => request<ThemePack>(`/api/themes/${enc(name)}`)

export const saveTheme = (name: string, pack: ThemePack) =>
  request<{ saved: boolean; name: string }>(`/api/themes/${enc(name)}`, {
    method: 'PUT',
    body: JSON.stringify(pack),
  })

export const deleteTheme = (name: string) =>
  request<{ deleted: boolean }>(`/api/themes/${enc(name)}`, { method: 'DELETE' })

export const importTheme = (file: File) => {
  const fd = new FormData()
  fd.append('file', file, file.name)
  return request<{ imported: boolean; name: string }>('/api/themes/import', {
    method: 'POST',
    body: fd,
  })
}

/** 导出走浏览器下载，不经 fetch —— 让 Content-Disposition 生效 */
export const themeExportUrl = (name: string) => `/api/themes/${enc(name)}/export`

export const getPrefs = () => request<Prefs>('/api/prefs')

export const savePrefs = (patch: Record<string, unknown>) =>
  request<{ saved: boolean; prefs: Prefs }>('/api/prefs', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })

export const appearanceWhere = () => request<AppearanceWhere>('/api/appearance/where')

// ---------------------------------------------------------------- 布局存档

export const listLayouts = (bookId: string) =>
  request<LayoutList>(`/api/books/${enc(bookId)}/layouts`)

export const getLayout = (bookId: string, name: string) =>
  request<{ name: string; layout: unknown }>(
    `/api/books/${enc(bookId)}/layouts/${enc(name)}`,
  )

export const saveLayout = (bookId: string, name: string, layout: unknown) =>
  request<{ saved: boolean; name: string; active: string }>(
    `/api/books/${enc(bookId)}/layouts/${enc(name)}`,
    { method: 'PUT', body: JSON.stringify({ layout }) },
  )

export const deleteLayout = (bookId: string, name: string) =>
  request<{ deleted: boolean; active: string }>(
    `/api/books/${enc(bookId)}/layouts/${enc(name)}`,
    { method: 'DELETE' },
  )

export const setActiveLayout = (bookId: string, name: string) =>
  request<{ active: string }>(`/api/books/${enc(bookId)}/layouts/active`, {
    method: 'PUT',
    body: JSON.stringify({ name }),
  })

// ---------------------------------------------------------------- 后台

export const adminInfo = () => request<AdminInfo>('/api/admin/info')

export const adminLogs = (lines = 200) =>
  request<{ lines: string[]; path: string }>(`/api/admin/logs${qs({ lines })}`)

export const rebuildIndex = (bookId?: string) =>
  request<RebuildResult>(`/api/admin/rebuild-index${qs({ book_id: bookId })}`, {
    method: 'POST',
  })

// ---------------------------------------------------------------- 异步任务（P11-A3）
//
// 长活儿（重建索引 / 批量 AI 抽取 / 批量导入）走这一组：排成后台任务，
// 界面只负责轮询看进度。同步那几个入口留着给脚本用，界面不再走它们。

/** 有哪些任务类型（含「可不可以续跑」与一句说明）。 */
export const jobKinds = () =>
  request<{ kinds: JobKindInfo[] }>('/api/jobs/kinds')

/** 当前在跑的那个 + 排队情况（顶栏常驻小条用它，很便宜）。 */
export const jobsActive = () => request<JobsActive>('/api/jobs/active')

export const listJobs = (opts: { bookId?: string; status?: string; limit?: number } = {}) =>
  request<{ jobs: Job[]; count: number }>(
    `/api/jobs${qs({ book_id: opts.bookId, status: opts.status, limit: opts.limit ?? 30 })}`,
  )

/** 单个任务。`after` 给上次拿到的最大 event_seq —— 只回新日志，轮询体量恒定。 */
export const getJob = (jobId: string, after?: number) =>
  request<Job>(`/api/jobs/${enc(jobId)}${qs({ after })}`)

export const cancelJob = (jobId: string) =>
  request<Job>(`/api/jobs/${enc(jobId)}/cancel`, { method: 'POST' })

/** 续跑：同一份参数再排一个任务，跳过上次已完成的部分。**会真的再跑一次**。 */
export const resumeJob = (jobId: string) =>
  request<Job>(`/api/jobs/${enc(jobId)}/resume`, { method: 'POST' })

export const deleteJob = (jobId: string) =>
  request<{ deleted: string }>(`/api/jobs/${enc(jobId)}`, { method: 'DELETE' })

/** 重建索引 → 后台任务。 */
export const rebuildIndexJob = (bookId?: string) =>
  request<Job>('/api/admin/rebuild-index/job', {
    method: 'POST',
    body: JSON.stringify({ book_id: bookId ?? null }),
  })

/** 批量 AI 抽取 → 后台任务。 */
export const extractWithAiJob = (
  bookId: string,
  chapterNos: number[] = [],
  opts: { provider?: string; refresh?: boolean } = {},
) =>
  request<Job>(`/api/books/${enc(bookId)}/chapters/extract/ai/job`, {
    method: 'POST',
    body: JSON.stringify({
      chapter_nos: chapterNos,
      provider: opts.provider ?? null,
      refresh: opts.refresh ?? false,
    }),
  })

/** 批量导入章节 → 后台任务（文件先落任务暂存目录，所以重启也能续跑）。 */
export const importChaptersJob = (
  bookId: string,
  files: File[],
  overwrite = false,
  onProgress?: (pct: number) => void,
) => {
  const fd = new FormData()
  for (const f of files) fd.append('files', f, f.name)
  const url = `${BASE}/api/books/${enc(bookId)}/chapters/import/job${qs({ overwrite: overwrite ? 'true' : '' })}`
  return postForm<Job>(url, fd, onProgress)
}

/** 带上传进度的 POST。fetch 拿不到上传进度，所以这里用 XHR（导入必须看得见进度）。 */
function postForm<T>(url: string, fd: FormData, onProgress?: (pct: number) => void) {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      let data: Record<string, unknown> = {}
      try {
        data = JSON.parse(xhr.responseText) as Record<string, unknown>
      } catch {
        /* 非 JSON 错误体 */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as unknown as T)
      else {
        // detail 可能是字符串，也可能是 {message, job_id}（409 忙闸那种）
        const d = data.detail
        const msg = typeof d === 'string' ? d : (d as { message?: string })?.message
        reject(new ApiError(xhr.status, msg ?? `${xhr.status} ${xhr.statusText}`))
      }
    }
    xhr.onerror = () => reject(new ApiError(0, '连不上后端服务'))
    xhr.send(fd)
  })
}

/** 实体体检：扫出名字不像专名的实体（只读，不动文件）。 */
export const adminLint = (bookId: string) =>
  request<LintResult>(`/api/admin/lint${qs({ book_id: bookId })}`)

/** 批量删除体检勾中的实体（后端先快照再删）。 */
export const adminLintDelete = (bookId: string, ids: string[]) =>
  request<LintDeleteResult>('/api/admin/lint/delete', {
    method: 'POST',
    body: JSON.stringify({ book_id: bookId, ids }),
  })

/** 删除整本书（后端先整本快照再删，返回快照路径供恢复）。 */
export const deleteBook = (bookId: string, confirm: string) =>
  request<DeleteBookResult>(`/api/books/${encodeURIComponent(bookId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ book_id: bookId, confirm }),
  })

/** 示例书现状：默认名字能不能用、库里已有哪几本示例书。 */
export const sampleBookStatus = () => request<SampleBookStatus>('/api/sample-book/status')

/** 生成示例书（只写新建的那本书，不碰任何已有书目与正文）。 */
export const makeSampleBook = (bookId: string, title: string) =>
  request<SampleBookResult>('/api/sample-book', {
    method: 'POST',
    body: JSON.stringify({ book_id: bookId, title }),
  })

/** 不一致体检：五类一致性检查（只读，报告只给人看，不自动改任何东西）。 */
export const adminConsistency = (bookId: string, deep = true) =>
  request<ConsistencyResult>(
    `/api/admin/consistency${qs({ book_id: bookId, deep: deep ? '1' : '0' })}`,
  )

/** 快照清单 + 当前策略 + 上次自动快照时间（只读）。 */
export const adminSnapshots = () => request<SnapshotList>('/api/admin/snapshots')

/** 手动「立即快照」；不传 bookId 则每本书各存一份。 */
export const snapshotNow = (bookId?: string, reason = 'manual') =>
  request<SnapshotTakeResult>('/api/admin/snapshots', {
    method: 'POST',
    body: JSON.stringify({ book_id: bookId ?? null, reason }),
  })

/** 按策略清理旧快照；dryRun 只算不删（界面先给人看一眼要清掉哪些）。 */
export const pruneSnapshots = (dryRun = false) =>
  request<SnapshotPruneResult>('/api/admin/snapshots/prune', {
    method: 'POST',
    body: JSON.stringify({ dry_run: dryRun }),
  })

export const health = () =>
  request<{ app: string; version: string; status: string }>('/api/health')

// ---------------------------------------------------------------- 数据指纹

/** 比一遍「上次记下的样子」和磁盘现在的样子（只读）。 */
export const getFingerprint = (bookId: string) =>
  request<FingerprintStatus>(`/api/books/${enc(bookId)}/fingerprint`)

/** 「我确实在外面改过，按现状接受」—— 只重建指纹，不碰索引。 */
export const refreshFingerprint = (bookId: string) =>
  request<FingerprintStatus>(`/api/books/${enc(bookId)}/fingerprint/refresh`, {
    method: 'POST',
  })

// ---------------------------------------------------------------- 技能中心

export const listSkills = () => request<SkillList>('/api/skills')

export const getSkill = (id: string) => request<SkillCard>(`/api/skills/${encodeURIComponent(id)}`)

export const createSkill = (body: {
  name: string
  template: string
  scene?: string
  skill_id?: string
}) => request<SkillCard>('/api/skills', { method: 'POST', body: JSON.stringify(body) })

export const updateSkill = (
  id: string,
  patch: { name?: string; scene?: string; template?: string },
) =>
  request<SkillCard>(`/api/skills/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })

export const deleteSkill = (id: string) =>
  request<{ deleted: string }>(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const cloneSkill = (id: string, name?: string) =>
  request<SkillCard>(`/api/skills/${encodeURIComponent(id)}/clone`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })

/** 跑一张技能卡。只读：读正文 → AI 分析 → 返回结果，不落盘、不改正文。 */
export const runSkill = (
  id: string,
  body: { bookId: string; chapterNos: number[]; focus: string },
) =>
  request<SkillRunResult>(`/api/skills/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    body: JSON.stringify({
      book_id: body.bookId,
      chapter_nos: body.chapterNos,
      focus: body.focus,
    }),
  })

// ---------------------------------------------------------------- 方法论

export const getMethodologies = (bookId: string, tag?: string) =>
  request<MethodologyData>(
    `/api/books/${enc(bookId)}/methodologies${qs({ tag })}`,
  )

/** 批量给实体挂/摘一条方法论 */
export const attachMethodology = (
  bookId: string,
  methodology: string,
  entityIds: string[],
  mode: 'add' | 'remove' = 'add',
) =>
  request<{ methodology: string; mode: string; changed: number }>(
    `/api/books/${enc(bookId)}/methodologies/attach`,
    { method: 'POST', body: JSON.stringify({ methodology, entity_ids: entityIds, mode }) },
  )

// ---------------------------------------------------------------- 章节正文

export const listChapters = (bookId: string) =>
  request<ChapterListData>(`/api/books/${enc(bookId)}/chapters`)

export const getChapter = (bookId: string, no: number) =>
  request<ChapterData>(`/api/books/${enc(bookId)}/chapters/${no}`)

/** 一个文件 = 一章。多个文件一次传。onProgress 收 0-100 的上传百分比。 */
export const importChapters = (
  bookId: string,
  files: File[],
  overwrite = false,
  onProgress?: (pct: number) => void,
) => {
  const fd = new FormData()
  for (const f of files) fd.append('files', f, f.name)
  const url = `${BASE}/api/books/${enc(bookId)}/chapters/import${qs({ overwrite: overwrite ? 'true' : '' })}`
  // fetch 拿不到上传进度，批量导入要进度条，这里用 XHR
  return new Promise<ChapterImportResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      let data: Record<string, unknown> = {}
      try {
        data = JSON.parse(xhr.responseText) as Record<string, unknown>
      } catch {
        /* 非 JSON 错误体 */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as unknown as ChapterImportResult)
      } else {
        reject(new ApiError(xhr.status, String(data.detail ?? `${xhr.status} ${xhr.statusText}`)))
      }
    }
    xhr.onerror = () => reject(new ApiError(0, '连不上后端服务'))
    xhr.send(fd)
  })
}

/** 批量导入预检：只解析不落盘，返回每个文件的章号与冲突标记。 */
export const previewImportChapters = (bookId: string, files: File[]) => {
  const fd = new FormData()
  for (const f of files) fd.append('files', f, f.name)
  return request<ChapterPreviewResult>(
    `/api/books/${enc(bookId)}/chapters/import/preview`,
    { method: 'POST', body: fd },
  )
}

export const deleteChapter = (bookId: string, no: number) =>
  request<{ deleted: boolean }>(`/api/books/${enc(bookId)}/chapters/${no}`, {
    method: 'DELETE',
  })

export const patchChapter = (
  bookId: string,
  no: number,
  patch: { title?: string; volume?: string; chapter_no?: number },
) =>
  request<ChapterData>(`/api/books/${enc(bookId)}/chapters/${no}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })

// ---------------------------------------------------------------- 规则抽取

/** 跑一遍规则抽取，拿回待确认清单（不落盘） */
export const extractCandidates = (bookId: string, chapterNos: number[] = []) =>
  request<ExtractResult>(`/api/books/${enc(bookId)}/chapters/extract`, {
    method: 'POST',
    body: JSON.stringify({ chapter_nos: chapterNos }),
  })

export const commitExtraction = (
  bookId: string,
  items: {
    name: string
    type: string
    summary?: string
    methodologies?: string[]
    chapters?: number[]
    first_at?: { chapter_no: number; para: number } | null
  }[],
  updateExisting = false,
) =>
  request<ExtractCommitResult>(
    `/api/books/${enc(bookId)}/chapters/extract/commit`,
    { method: 'POST', body: JSON.stringify({ items, update_existing: updateExisting }) },
  )

// ---------------------------------------------------------------- AI 层

export const getAiConfig = () => request<AiConfig>('/api/ai/config')

/** 服务商申请引导（新手向）。内容归后端，改文案不用重新构建界面。 */
export const getAiCatalog = () => request<AiCatalog>('/api/ai/catalog')

export const saveAiProvider = (
  name: string,
  patch: Partial<{
    label: string
    base_url: string
    model: string
    api_key: string
    enabled: boolean
    price_input: number
    price_output: number
  }>,
) =>
  request<{ saved: boolean }>(`/api/ai/providers/${enc(name)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })

export const setAiDefault = (key: string) =>
  request<{ saved: boolean }>('/api/ai/default', {
    method: 'PUT',
    body: JSON.stringify({ key }),
  })

export const testAiProvider = (name: string) =>
  request<AiTestResult>(`/api/ai/providers/${enc(name)}/test`, { method: 'POST' })

export const saveAiBudget = (patch: { monthly_limit_cny: number; warn_at_percent: number }) =>
  request<{ saved: boolean }>('/api/ai/budget', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })

export const getAiUsage = (bookId?: string) =>
  request<AiUsage>(`/api/ai/usage${qs({ book_id: bookId })}`)

export const getAiMonitor = () => request<AiMonitor>('/api/ai/monitor')

export const setAiMonitor = (active: boolean, label = '') =>
  request<{ active: boolean }>('/api/ai/monitor', {
    method: 'PUT',
    body: JSON.stringify({ active, label }),
  })

export const getAiPrompt = (name: string) =>
  request<AiPrompt>(`/api/ai/prompts/${enc(name)}`)

export const saveAiPrompt = (name: string, content: string) =>
  request<AiPrompt>(`/api/ai/prompts/${enc(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })

export const getAiPromptVersions = (name: string) =>
  request<{ versions: AiPromptVersion[] }>(`/api/ai/prompts/${enc(name)}/versions`)

export const rollbackAiPrompt = (name: string, version: number) =>
  request<{ rolled_back: boolean }>(`/api/ai/prompts/${enc(name)}/rollback`, {
    method: 'POST',
    body: JSON.stringify({ version }),
  })

/** AI 抽取：单章粒度逐章跑，返回候选/变更/伏笔与逐章花费。 */
export const extractWithAi = (
  bookId: string,
  chapterNos: number[] = [],
  opts: { provider?: string; refresh?: boolean } = {},
) =>
  request<AiExtractResult>(`/api/books/${enc(bookId)}/chapters/extract/ai`, {
    method: 'POST',
    body: JSON.stringify({
      chapter_nos: chapterNos,
      provider: opts.provider ?? null,
      refresh: opts.refresh ?? false,
    }),
  })

/** 确认过的伏笔落进伏笔看板。 */
export const commitForeshadow = (
  bookId: string,
  items: { content: string; chapter_no?: number; para?: number; note?: string }[],
) =>
  request<ForeshadowCommitResult>(`/api/books/${enc(bookId)}/foreshadow/commit`, {
    method: 'POST',
    body: JSON.stringify({ items }),
  })

// ---------------------------------------------------------------- 3D 场景（P4）

/** 3D 锁定坐标与相机 —— 装饰层，存 view/scene.json，与内容物理隔离。 */
export interface SceneGraphState {
  positions?: Record<string, { x: number; y: number; z: number }>
  camera?: { x: number; y: number; z: number }
  play_chapter?: number
}

/** 视图装饰（不是知识库内容）：类型→图标映射、是否开辉光、疏密… 存 view/scene.json */
export interface SceneStyles {
  typeIcons?: Record<string, string>
  glow?: boolean
  spacing?: 'compact' | 'normal' | 'loose'
}

export interface SceneState {
  schema?: number
  graphs?: Record<string, SceneGraphState>
  styles?: SceneStyles
}

export const getScene = (bookId: string) =>
  request<{ exists: boolean; scene: SceneState }>(
    `/api/books/${enc(bookId)}/scene`,
  )

export const saveScene = (bookId: string, scene: SceneState) =>
  request<{ saved: boolean }>(`/api/books/${enc(bookId)}/scene`, {
    method: 'PUT',
    body: JSON.stringify({ scene }),
  })

/** 丢掉全部锁定坐标 —— 「重新排版」用。 */
export const clearScene = (bookId: string) =>
  request<{ deleted: boolean }>(`/api/books/${enc(bookId)}/scene`, { method: 'DELETE' })

/** 只丢某一张图的锁定坐标，保留样式等其余装饰（重新排版按钮用）。 */
export const clearSceneGraph = (bookId: string, key: string) =>
  request<{ cleared: boolean; reason?: string }>(
    `/api/books/${enc(bookId)}/scene/graphs/${enc(key)}`,
    { method: 'DELETE' },
  )

// --------------------------------------------------------------------------
// 可视化样式（P5）
//
// 三组东西，都是**装饰层**，全落 `view/`：
// - 样式包（`view/styles/`）：一键变换整套观感
// - 单节点覆盖（`view/nodes.json`）：手动调过的那个节点，切包也不被冲掉
// - 贴纸（`view/decorations.json`）：按视图分区
// --------------------------------------------------------------------------

/** 样式包目录 + 当前生效的整包。连整包一起给，避免「先画默认色再闪一下」。 */
export const getStyles = (bookId: string, signal?: AbortSignal) =>
  request<StylesData>(`/api/books/${enc(bookId)}/styles`, { signal })

export const setActivePack = (bookId: string, id: string) =>
  request<{ active: string; pack: StylePack }>(`/api/books/${enc(bookId)}/styles/active`, {
    method: 'PUT',
    body: JSON.stringify({ id }),
  })

/** 新建样式包。`from` = 以现成的包为底改；不传就是默认长相。 */
export const createStylePack = (bookId: string, name: string, from?: string) =>
  request<{ created: boolean; pack: StylePack; active: string }>(
    `/api/books/${enc(bookId)}/styles`,
    { method: 'POST', body: JSON.stringify({ name, from }) },
  )

export const saveStylePack = (bookId: string, pack: StylePack) =>
  request<{ saved: boolean; pack: StylePack; file: string }>(
    `/api/books/${enc(bookId)}/styles/${enc(pack.id)}`,
    { method: 'PUT', body: JSON.stringify({ pack }) },
  )

/** 删自建包；**内置包不删，恢复出厂** —— 返回里会说是哪一种。 */
export const deleteStylePack = (bookId: string, id: string) =>
  request<{ deleted?: boolean; restored?: boolean; pack?: StylePack; active?: string }>(
    `/api/books/${enc(bookId)}/styles/${enc(id)}`,
    { method: 'DELETE' },
  )

export const getNodeStyles = (bookId: string) =>
  request<{ nodes: Record<string, NodeStylePatch>; count: number; file: string }>(
    `/api/books/${enc(bookId)}/node-styles`,
  )

export const saveNodeStyles = (bookId: string, nodes: Record<string, NodeStylePatch>) =>
  request<{ saved: boolean; count: number; nodes: Record<string, NodeStylePatch> }>(
    `/api/books/${enc(bookId)}/node-styles`,
    { method: 'PUT', body: JSON.stringify({ nodes }) },
  )

export const getDecorations = (bookId: string) =>
  request<{ scenes: Record<string, Decoration[]>; count: number; file: string }>(
    `/api/books/${enc(bookId)}/decorations`,
  )

export const saveDecorations = (bookId: string, scenes: Record<string, Decoration[]>) =>
  request<{ saved: boolean; scenes: Record<string, Decoration[]> }>(
    `/api/books/${enc(bookId)}/decorations`,
    { method: 'PUT', body: JSON.stringify({ scenes }) },
  )

// --------------------------------------------------------------------------
// 地图（P4.5）
//
// 文档式接口：整体读、整体写。摆点是个连续动作（拖一下动一次），
// 拆成细粒度接口只会打出一串请求，而地图数据本身很小。
// 后端按内容哈希**增量落盘**：只重写真正变了的那几张图（回执里给 written/removed），
// 所以这里的契约没变，写盘代价却从「300 张图」降到「1 张图」。
// --------------------------------------------------------------------------

export const getMaps = (bookId: string) =>
  request<MapsData>(`/api/books/${enc(bookId)}/maps`)

/** 整体覆盖写。传的是 `{schema, maps, order}` 这层文档。 */
export const saveMaps = (
  bookId: string,
  doc: { schema?: number; maps: Record<string, MapDoc>; order: string[] },
) =>
  request<{ saved: boolean; file: string; map_count: number; written: number; removed: number }>(
    `/api/books/${enc(bookId)}/maps`,
    { method: 'PUT', body: JSON.stringify(doc) },
  )

export const deleteMap = (bookId: string, mapId: string) =>
  request<{ deleted: boolean; remaining: number }>(
    `/api/books/${enc(bookId)}/maps/${enc(mapId)}`,
    { method: 'DELETE' },
  )

/** 上传一张地图底图，返回素材条目（`.name` 拿去拼 `maps/<name>`）。 */
export const uploadMapImage = (file: File) => {
  const fd = new FormData()
  fd.append('file', file)
  return request<AssetItem>('/api/assets/maps', { method: 'POST', body: fd })
}

// --------------------------------------------------------------------------
// 识别引擎（P4.5.3）
//
// 跑识别只是**拿候选**，后端一个字都不写盘；落盘走上面那个 `saveMaps`。
// 所以这里没有「保存识别结果」这种函数，也不需要。
// --------------------------------------------------------------------------

export const getVisionConfig = () => request<VisionConfig>('/api/vision/config')

export const saveVisionConfig = (patch: Record<string, unknown>) =>
  request<{ saved: boolean; config: Record<string, unknown> }>('/api/vision/config', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })

export const getVisionEngines = () => request<VisionConfig>('/api/vision/engines')

export const clearVisionCache = () =>
  request<{ cleared: boolean; removed: number }>('/api/vision/cache', { method: 'DELETE' })

/** 跑一次识别。`image` 是素材相对路径（`maps/x.png`），也可以改给 `map_id`。 */
export const analyzeVision = (
  bookId: string,
  body: {
    image?: string
    map_id?: string
    engine?: string
    options?: Record<string, unknown>
    /** 跳过缓存强制重跑 */
    refresh?: boolean
  },
) =>
  request<VisionAnalyzeResult>(`/api/books/${enc(bookId)}/vision/analyze`, {
    method: 'POST',
    body: JSON.stringify(body),
  })

// ---------------------------------------------------------------- P7：别名 / 合并 / 导出 / 工具箱

export interface AliasRow {
  alias: string
  entity_id: string
  entity_name: string
  type: string
  /** name = 这一行是实体主名（同物异名的合并入口要靠它被搜到） */
  via: 'name' | 'alias'
}

/** 冲突表：别名 → 占用它的多个实体（同一实体重复出现不算冲突） */
export type AliasConflicts = Record<
  string,
  { entity_id: string; name: string; type: string; via: 'name' | 'alias' }[]
>

export const listAliases = (bookId: string) =>
  request<{ aliases: AliasRow[]; count: number; conflicts: AliasConflicts }>(
    `/api/books/${enc(bookId)}/aliases`,
  )

export interface MergeResult {
  target: string
  source: string
  absorbed_names: string[]
  moved_links: number
  skipped_ambiguous: string[]
}

export const mergeEntity = (bookId: string, targetId: string, sourceId: string) =>
  request<MergeResult>(`/api/books/${enc(bookId)}/entities/${enc(targetId)}/merge`, {
    method: 'POST',
    body: JSON.stringify({ source_id: sourceId }),
  })

/** 整书导出是文件下载，不走 request（它假定响应是 JSON） */
export const bookExportUrl = (bookId: string) => `/api/books/${enc(bookId)}/export`

export interface ToolLinkItem {
  name: string
  url: string
  note: string
}

export interface ToolsData {
  version: number
  groups: { key: 'free-chat' | 'image-gen'; label: string; links: ToolLinkItem[] }[]
}

export const getTools = () => request<ToolsData>('/api/tools')

export const saveTools = (data: ToolsData) =>
  request<ToolsData>('/api/tools', { method: 'PUT', body: JSON.stringify(data) })

// ---- 打赏与交流群（P11-3️⃣②）----

export const getDonateInfo = () => request<DonateInfo>('/api/donate')

/** 清掉「已自动恢复」这类告警。包体被改那类清不掉（它是实时状态）。 */
export const ackDonateAlerts = () =>
  request<{ ok: boolean; acknowledged_at: string }>('/api/donate/ack', { method: 'POST' })

/** 强制重跑一次自检（设置页的「重新检查」） */
export const verifyDonate = () => request<DonateInfo>('/api/donate/verify', { method: 'POST' })

// ---- 更新提示（P11-C1）：只查、只提示，绝不下载替换 ----

export interface UpdateCheckInfo {
  /** 真的去远端查过了吗（没配置地址/被关闭时是 false，reason 里说明原因） */
  checked: boolean
  skipped?: boolean
  reason?: string
  current?: string
  latest?: string
  has_update?: boolean
  notes?: string
  url?: string
  error?: string
  enabled?: boolean
  configured?: boolean
  interval_hours?: number
}

export const getUpdateCheck = (force = false) =>
  request<UpdateCheckInfo>(`/api/app/update-check${force ? '?force=true' : ''}`)

// ---- 书目独立外观（P11-C2）：每本书可以各持一套主题/字体/背景 ----

export interface BookAppearance {
  /** 解析后的完整 ui（书目覆盖 > 全局偏好 > 出厂默认） */
  ui: UiPrefs
  /** 这本书有没有自己的独立设置（false = 正在跟随全局） */
  has_override: boolean
  scope: 'book'
}

export const getBookAppearance = (bookId: string) =>
  request<BookAppearance>(`/api/books/${encodeURIComponent(bookId)}/appearance`)

/** 只传改动的键 —— 没动过的键继续跟随全局（稀疏覆盖） */
export const saveBookAppearance = (bookId: string, ui: Partial<UiPrefs>) =>
  request<BookAppearance>(`/api/books/${encodeURIComponent(bookId)}/appearance`, {
    method: 'PUT',
    body: JSON.stringify({ ui }),
  })

/** 清掉这本书的独立设置，改回跟随全局（不碰全局偏好） */
export const resetBookAppearance = (bookId: string) =>
  request<BookAppearance>(`/api/books/${encodeURIComponent(bookId)}/appearance`, {
    method: 'PUT',
    body: JSON.stringify({ reset: true }),
  })
