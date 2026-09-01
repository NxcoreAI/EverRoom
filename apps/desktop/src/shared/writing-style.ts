/** Writing style 共享 DTO（gateway /v1/writing-style* 契约的桌面侧镜像）。 */

export type WritingStyleConfidenceTier = 'empty' | 'sparse' | 'established' | 'mature'
export type WritingStyleOrigin = 'user' | 'agent'

export interface WritingStyleSettingsDto {
  completionEnabled: boolean
  generationEnabled: boolean
  configVersion: number
}

export interface WritingStyleUserContentDto {
  content: string
  /** 用户是否编辑过（编辑即接管：refresh 不再自动覆盖）。 */
  userEdited: boolean
  /** 接管后系统是否有新沉淀（提示"可重新生成"）。 */
  systemUpdateAvailable: boolean
  updatedAt: string
}

export interface WritingStyleProfileDto {
  profileVersion: number
  confidenceTier: WritingStyleConfidenceTier
  sampleDocumentCount: number
  sampleCharCount: number
  sections: {
    vocabulary: string[]
    sentence: string[]
    structure: string[]
    /** LLM 定性层展示行（未触发或失败时为空数组）。 */
    qualitative: string[]
  }
  /** §7.4 合成好的注入块；两注入点各自按开关取用。 */
  injection: {
    completion: string | null
    generation: string | null
  }
  /** 行为信号摘要（§4 扩展）：指令归类计数 + 用户手改 agent 输出的方向统计。 */
  behavior: WritingStyleBehaviorDto
  lastRefreshedAt: string | null
}

export interface WritingStyleBehaviorDto {
  instructionCounts: Array<{ label: string; count: number }>
  recentInstructions: string[]
  revisionCount: number
  /** 平均长度变化比（负 = 用户改短）；null = 无样本。 */
  averageLenDeltaRatio: number | null
  exclamationDelta: number
}

export interface WritingStyleCorpusEntryDto {
  documentId: string
  roomId: string
  title: string
  charCount: number
  origin: WritingStyleOrigin
  excluded: boolean
  status: string
  extractedAt: string
}
