/**
 * slides 进度卡载荷契约（网关 slides_draft onUpdate details 全量快照，与广播同构）。
 * 与网关 apps/gateway/src/modules/subagents/tools.ts 的阶段集合保持一致。
 */
export type SlidesProgressStage =
  | 'drafting'
  | 'draft_ready'
  | 'style_generating'
  | 'style_images_ready'
  | 'style_extracting'
  | 'style_card_ready'
  | 'planning'
  | 'plan_ready'
  | 'page_images_confirm'
  | 'page_images_review'
  | 'page_images'
  | 'page_applied'
  | 'failed'

/** 逐页快照（不同阶段只填各自相关的字段）。 */
export interface SlidesProgressPage {
  title?: string
  /** 0 起 plan 页序（配图过目卡按它定位/回传页码）。 */
  pageIndex?: number
  url?: string
  imagePrompt?: string
  rejected?: boolean
  failed?: boolean
  [key: string]: unknown
}

/** 进度卡载荷公共字段 + 各阶段附加字段。 */
export interface SlidesProgressPayload {
  stage: SlidesProgressStage
  title?: string
  /** 毫秒时间戳：所有载荷都带，渲染层据此做新旧单调守卫。 */
  updatedAt: number
  documentId?: string
  styleSessionId?: string
  totalPages?: number
  doneCount?: number
  warnings?: string[]
  narrative?: string
  generation?: number
  pages?: SlidesProgressPage[]
  /** failed 载荷：统一失败语义。 */
  errorCode?: string
  errorMessage?: string
  retryable?: boolean
  /** page_applied 最终载荷：产物出口与真实完成态。 */
  fileEntryId?: string
  fileName?: string
  completed?: boolean
  /** 全部落定后内容稿已进回收站（可在资料面板恢复）。 */
  draftArchived?: boolean
  /** 失败/退化页 0 起页码。 */
  failedPages?: number[]
}

/**
 * 配图过目卡轮询载荷（网关 /v1/slides/page-images/:documentId 响应，与广播同构）。
 * 会话已落库，网关重启后仍可轮询到；未完成页 failed:true 让前端显示「可重生成」。
 */
export interface SlidesPageImagesStatus {
  stage: 'page_images_confirm' | 'page_images_review'
  title?: string
  totalPages?: number
  doneCount?: number
  documentId?: string
  generation?: number
  updatedAt?: number
  pages?: Array<{
    pageIndex?: number
    title?: string
    imagePrompt?: string
    url?: string
    rejected?: boolean
    failed?: boolean
  }>
}
