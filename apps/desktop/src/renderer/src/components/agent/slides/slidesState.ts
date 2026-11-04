import type { DisplayAgentToolCall } from '../agentRunActivity'

/**
 * slides_draft 的任务阶段：渲染侧一律以「任务」而非「日志」对待。
 * - in-progress：长等待阶段（工具还在跑），卡片必须可见并给出人话阶段名；
 * - waiting：等用户做决定的停点（卡片不因后续闲聊消失）；
 * - failed / page_applied：终态，失败卡保留、完成卡有交付口。
 */
export type SlidesStage =
  | 'drafting'
  | 'style_generating'
  | 'style_extracting'
  | 'planning'
  | 'failed'
  | 'draft_ready'
  | 'plan_ready'
  | 'page_images'
  | 'page_images_confirm'
  | 'page_images_review'
  | 'page_applied'
  | 'style_images_ready'
  | 'style_card_ready'

/** 单页方案（网关透传的 plan.pages 条目：文案要点/数据/配图/方向）。 */
export interface SlidesPagePlan {
  title?: string
  points?: string[]
  data?: string
  materialHints?: string
  notes?: string
  materials?: Array<{ url: string; desc?: string }>
  /** 配图确认/过目卡：该页的生图提示词与已生成图（everroom-material:// 寻址）。 */
  imagePrompt?: string
  url?: string
  /** 该页在 plan 页序中的下标（0 起）；缺省时回落到数组下标。 */
  pageIndex?: number
  /** 过目打回：置灰展示，落页时该页退化图形版式。 */
  rejected?: boolean
  /** 后台生成失败：可手动重生成，否则该页退化。 */
  failed?: boolean
}

/** 风格纵览候选（everroom-material:// 寻址；label 是该候选的风格方向短名）。 */
export interface StyleCandidate {
  url: string
  label?: string
  generation: number
}

/** 风格卡数据（色块/字号/线框 SVG/演示页/效果文案——全部效果语言）。 */
export interface StyleCardData {
  swatches: Array<{ hex: string; label: string }>
  typography: Array<{ label: string; value: string }>
  details?: Array<{ label: string; value: string }>
  wireframes: Array<{ role: string; label: string; svg: string }>
  demoImageUrl: string | null
  effectLines: string[]
}

/** slides_draft 进度载荷（网关 onUpdate details，全量快照，取最新一条即可）。 */
export interface SlidesProgressState {
  stage: SlidesStage
  title?: string
  /** 会话最后落库时刻：轮询响应据此判新旧，防旧响应覆盖新广播。 */
  updatedAt?: number
  roomId?: string
  documentId?: string
  totalPages?: number
  doneCount?: number
  /** 已落定页号（0 起 plan 页序）。落页按完成顺序发生，页号集合是打勾的唯一依据。 */
  appliedPages?: number[]
  pages?: SlidesPagePlan[]
  narrative?: string
  warnings?: string[]
  styleSessionId?: string
  styleCandidates?: StyleCandidate[]
  styleCard?: StyleCardData
  /** 配图过目卡的重生成轮次：变化即重开折叠卡，新图才能被看到。 */
  generation?: number
  /** 成品文件（page_applied 完成后才有）。 */
  fileEntryId?: string
  fileName?: string
  /** 是否全部页落定；缺省按 stage 兜底（page_applied 且无显式 false 视为完成）。 */
  completed?: boolean
  /** 全部落定后内容稿已进回收站（可在资料面板恢复）。 */
  draftArchived?: boolean
  /** 未落定的页（0 起 plan 页序）。 */
  failedPages?: number[]
  errorMessage?: string
  errorCode?: string
  retryable?: boolean
}

/** 工具还在跑的长等待阶段。 */
export const SLIDES_IN_PROGRESS_STAGES: ReadonlySet<SlidesStage> = new Set<SlidesStage>([
  'drafting',
  'style_generating',
  'style_extracting',
  'planning',
])

/** 等用户做决定的停点：卡片不因后续闲聊被顶掉。 */
export const SLIDES_WAITING_STAGES: ReadonlySet<SlidesStage> = new Set<SlidesStage>([
  'draft_ready',
  'style_images_ready',
  'style_card_ready',
  'page_images_confirm',
  'page_images_review',
  'failed',
])

const STYLE_STAGES = new Set<string>(['style_images_ready', 'style_card_ready'])
const PAGE_IMAGE_STAGES = new Set<string>(['page_images_confirm', 'page_images_review'])
const PROGRESS_STAGES = new Set<string>(['draft_ready', 'plan_ready', 'page_images', 'page_applied'])
const KNOWN_STAGES = new Set<string>([
  ...SLIDES_IN_PROGRESS_STAGES,
  ...STYLE_STAGES,
  ...PAGE_IMAGE_STAGES,
  ...PROGRESS_STAGES,
  'failed',
])

/** 从 slides_draft 工具调用的 partialResult 还原任务载荷；不是 PPT 任务返回 null。 */
export function slidesProgressFromToolCall(tool: DisplayAgentToolCall | undefined): SlidesProgressState | null {
  if (!tool || tool.name !== 'slides_draft') return null
  const details = tool.partialResult
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    const payload = (details as { details?: unknown }).details
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const record = payload as Record<string, unknown>
      const stage = typeof record.stage === 'string' ? record.stage : null
      if (stage && KNOWN_STAGES.has(stage) && isCompleteStagePayload(stage, record)) {
        const progress = normalizeProgress(record)
        // 工具报错但阶段载荷还停在上一个阶段：以失败卡收口，不许永远「生成中」。
        return tool.status === 'error' ? { ...progress, stage: 'failed' } : progress
      }
    }
  }
  // 兜底：工具直接报错时没有阶段载荷，也保留一张失败卡（失败不许消失）。
  if (tool.status === 'error') return { stage: 'failed' }
  return null
}

/** 各阶段的必备字段：缺了不认（宁可不渲染，也不渲染一张假卡）。 */
function isCompleteStagePayload(stage: string, record: Record<string, unknown>): boolean {
  if (STYLE_STAGES.has(stage)) return typeof record.styleSessionId === 'string'
  if (PAGE_IMAGE_STAGES.has(stage)) return typeof record.documentId === 'string' && Array.isArray(record.pages)
  if (PROGRESS_STAGES.has(stage)) return Array.isArray(record.pages)
  // 长等待阶段与 failed 不强制 pages：失败卡必须留在原地。
  return true
}

function normalizeProgress(record: Record<string, unknown>): SlidesProgressState {
  const mapped = { ...record } as Record<string, unknown>
  const isStyleStage = STYLE_STAGES.has(String(record.stage))
  if (isStyleStage) {
    // 网关载荷的候选字段叫 candidates，前端接口叫 styleCandidates——在此对齐。
    // 风格卡字段网关平铺在顶层（swatches/typography/...），前端嵌在 styleCard 下——同样对齐。
    if (Array.isArray(record.candidates) && !record.styleCandidates) {
      mapped.styleCandidates = record.candidates
    }
    if (record.stage === 'style_card_ready' && !record.styleCard) {
      mapped.styleCard = {
        swatches: record.swatches ?? [],
        typography: record.typography ?? [],
        details: record.details ?? [],
        wireframes: record.wireframes ?? [],
        demoImageUrl: record.demoImageUrl ?? null,
        effectLines: record.effectLines ?? [],
      }
    }
  }
  if (Array.isArray(record.failedPages)) {
    mapped.failedPages = record.failedPages
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  } else {
    delete mapped.failedPages
  }
  if (Array.isArray(record.appliedPages)) {
    mapped.appliedPages = record.appliedPages
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  } else {
    delete mapped.appliedPages
  }
  if (Array.isArray(record.warnings)) {
    mapped.warnings = record.warnings.filter((value): value is string => typeof value === 'string')
  } else {
    delete mapped.warnings
  }
  if (!Array.isArray(record.pages)) delete mapped.pages
  if (typeof record.completed !== 'boolean') delete mapped.completed
  if (typeof record.retryable !== 'boolean') delete mapped.retryable
  return mapped as unknown as SlidesProgressState
}

/** 一条 PPT 任务：工具调用 + 其进度快照。 */
export interface SlidesTaskEntry {
  tool: DisplayAgentToolCall
  progress: SlidesProgressState
}

/** 把全部 run 的 slides_draft 调用摊平成任务列表（新的在前）。 */
export function slidesTaskEntries(toolCallsByRun: Record<string, DisplayAgentToolCall[]>): SlidesTaskEntry[] {
  return Object.values(toolCallsByRun)
    .flat()
    .map((tool) => ({ tool, progress: slidesProgressFromToolCall(tool) }))
    .filter((entry): entry is SlidesTaskEntry => entry.progress !== null)
    .sort((left, right) => Date.parse(right.tool.startedAt) - Date.parse(left.tool.startedAt))
}

/** 同一任务的身份：优先文档，其次风格会话，最后标题；全缺时各算各的。 */
function taskKey(entry: SlidesTaskEntry): string {
  return entry.progress.documentId
    ?? entry.progress.styleSessionId
    ?? (entry.progress.title ? `title:${entry.progress.title}` : `tool:${entry.tool.id}`)
}

export interface SlidesTaskSelection {
  /** 最新一张任务卡（完整渲染）。 */
  primary: SlidesTaskEntry | null
  /** 其余仍在等用户决定的卡（最多凑到 3 张完整卡）。 */
  waiting: SlidesTaskEntry[]
  /** 已完成的旧卡：一行「已完成《标题》· 打开」紧凑回执。 */
  receipts: SlidesTaskEntry[]
  /** 折叠起来的任务数（含被顶掉的旧卡）。 */
  foldedCount: number
}

const MAX_FULL_CARDS = 3
const MAX_RECEIPTS = 3

/**
 * 任务槽选择：只把「还在等用户决定 / 还在跑」的任务留成完整卡，最多 3 张，其余折叠计数。
 * 已完成、已停止、已失败的任务一律收成一行回执——工作结束（无论成败）就不该有
 * 常驻卡片占着对话区；失败回执自带「再试一次」。
 * 同一文档出现更新的 slides_draft 调用后，旧调用即视为被顶掉（不重复展示）。
 */
export function selectSlidesTasks(entries: SlidesTaskEntry[], maxFullCards: number = MAX_FULL_CARDS): SlidesTaskSelection {
  if (entries.length === 0) return { primary: null, waiting: [], receipts: [], foldedCount: 0 }
  const isSuperseded = (entry: SlidesTaskEntry): boolean => {
    const key = taskKey(entry)
    return entries.some((other) => other !== entry
      && Date.parse(other.tool.startedAt) > Date.parse(entry.tool.startedAt)
      && taskKey(other) === key)
  }
  const seen = new Set<string>()
  const kept = entries.filter((entry) => {
    if (isSuperseded(entry)) return false
    const key = taskKey(entry)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const isCompleted = (entry: SlidesTaskEntry): boolean => entry.progress.stage === 'page_applied'
    && entry.progress.completed !== false
    && entry.tool.status === 'completed'
  const isStopped = (entry: SlidesTaskEntry): boolean => entry.tool.status === 'stopped'
  const isFailed = (entry: SlidesTaskEntry): boolean => entry.progress.stage === 'failed'
    || entry.tool.status === 'error'
  const isReceipt = (entry: SlidesTaskEntry): boolean => isCompleted(entry) || isStopped(entry) || isFailed(entry)
  // 等待态 + 仍在跑的任务保留成完整卡（并行任务不能只剩最新一张）。
  const actionable = kept.filter((entry) => !isReceipt(entry))
  const shownFull = actionable.slice(0, Math.max(1, maxFullCards))
  const receipts = kept.filter(isReceipt).slice(0, MAX_RECEIPTS)
  const foldedCount = (actionable.length - shownFull.length)
    + Math.max(0, kept.filter(isReceipt).length - MAX_RECEIPTS)
  return { primary: shownFull[0] ?? null, waiting: shownFull.slice(1), receipts, foldedCount }
}
