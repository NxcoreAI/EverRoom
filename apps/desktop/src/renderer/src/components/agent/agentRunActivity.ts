import type {
  AgentContextUsage,
  AgentEvent,
  SubagentInvocationEvent,
  SubagentInvocationNode,
} from '@nxcore/agent-contract'
import type { Translate } from '@/i18n/LocaleContext'

export type DisplayAgentToolStatus = 'pending' | 'running' | 'completed' | 'error' | 'stopped'

export interface DisplayAgentToolCall {
  id: string
  runId: string
  name: string
  /** 适配器侧人类可读标题（ACP tool_call.title）；作为 subject 的兜底展示。 */
  title?: string
  args: Record<string, unknown>
  partialResult?: unknown
  result?: unknown
  error?: string
  status: DisplayAgentToolStatus
  startedAt: string
  completedAt?: string
}

export interface AgentActivityStep {
  id: string
  sequence: number
  tool: DisplayAgentToolCall
  beforeText: string
  afterText: string
  /** 导致这次工具调用的思考段（reasoning.delta 在本 step 前的累计）。 */
  reasoningBefore: string
}

export interface AgentRunActivity {
  steps: AgentActivityStep[]
  pendingAnswer: string
  finalAnswer: string
  hasTools: boolean
  completed: boolean
  /** 最后一次工具调用之后、最终答案之前的思考段（无工具时是整段思考）。 */
  tailReasoning: string
  /** 正在流动的未封段思考（run 活跃时）：时间线尾部以 shimmer 行实时展示，
   *  下一个工具出现即封段成 step.reasoningBefore。run 结束后归入 tailReasoning。 */
  liveReasoning: string
}

/** 时间线上的子代理行：label 即「谁调用了它」的链式名（如 Slides Planner → Slides Builder）。 */
export interface AgentSubagentStep {
  id: string
  label: string
  task: string
  status: DisplayAgentToolStatus
  startedAt: string | null
  completedAt: string | null
  errorMessage: string | null
  /** 子代理自己的上下文用量快照（context.usage；缺省=未知，不渲染圆环）。 */
  contextUsage?: AgentContextUsage | null
  /** 子代理上下文压缩中（圆环呼吸）。 */
  contextCompacting?: boolean
}

export type TimelineRow =
  | { kind: 'tool'; key: string; at: number; step: AgentActivityStep }
  | { kind: 'subagent'; key: string; at: number; subagent: AgentSubagentStep }

export interface ReducedAgentRunEvents {
  tools: DisplayAgentToolCall[]
  reasoning: string
  startedAt?: string
  completedAt?: string
  streamingContent: string
  messageStarted: boolean
  messageCompleted: boolean
  lastSequence: number
}

const terminalToolStatuses = new Set<DisplayAgentToolStatus>(['completed', 'error', 'stopped'])

export function mergeAgentToolEvent(
  tools: DisplayAgentToolCall[],
  event: AgentEvent,
): DisplayAgentToolCall[] {
  const payload = event.payload as {
    toolCallId?: unknown
    name?: unknown
    title?: unknown
    args?: unknown
    partialResult?: unknown
    result?: unknown
    message?: unknown
  }
  if (typeof payload.toolCallId !== 'string') return tools

  const existing = tools.find((tool) => tool.id === payload.toolCallId)
  if (existing && terminalToolStatuses.has(existing.status)) return tools

  const status: DisplayAgentToolStatus = event.type === 'tool.completed'
    ? 'completed'
    : event.type === 'tool.failed'
      ? 'error'
      : event.type === 'tool.requested'
        ? 'pending'
        : 'running'
  const args = payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args)
    ? payload.args as Record<string, unknown>
    : existing?.args ?? {}
  const failureMessage = typeof payload.message === 'string'
    ? payload.message
    : typeof payload.result === 'string' ? payload.result : '工具调用失败。'
  const next: DisplayAgentToolCall = {
    id: payload.toolCallId,
    runId: event.runId,
    name: typeof payload.name === 'string' ? payload.name : existing?.name ?? 'tool',
    title: typeof payload.title === 'string' ? payload.title : existing?.title,
    args,
    partialResult: payload.partialResult !== undefined ? payload.partialResult : existing?.partialResult,
    result: payload.result !== undefined ? payload.result : existing?.result,
    error: event.type === 'tool.failed' ? failureMessage : existing?.error,
    status,
    startedAt: existing?.startedAt ?? event.occurredAt,
    completedAt: terminalToolStatuses.has(status) ? event.occurredAt : existing?.completedAt,
  }

  return existing
    ? tools.map((tool) => tool.id === next.id ? next : tool)
    : [...tools, next]
}

function isToolEvent(event: AgentEvent): boolean {
  return event.type === 'tool.requested'
    || event.type === 'tool.started'
    || event.type === 'tool.updated'
    || event.type === 'tool.completed'
    || event.type === 'tool.failed'
}

function userText(value: unknown, limit = 600): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text || text.startsWith('{') || text.startsWith('[')) return undefined
  return text.slice(0, limit)
}

/** 时间线工具行的图标分类：由显式映射表决定，未知工具才归入 other。 */
export type AgentToolKind =
  | 'search'
  | 'file'
  | 'document'
  | 'slides'
  | 'task'
  | 'email'
  | 'calendar'
  | 'image'
  | 'command'
  | 'schema'
  | 'connector'
  | 'action'
  | 'agent'
  | 'analysis'
  | 'other'

interface AgentToolPresentation {
  kind: AgentToolKind
  /** 无翻译函数时的中文兜底（运行中, 已完成）。 */
  zh: [string, string]
  /** i18n key（运行中, 已完成）。 */
  keys: [string, string]
}

/** 时间线工具名的显式展示映射：只有这里列出的名字才使用专用文案与图标。 */
const AGENT_TOOL_PRESENTATIONS: Record<string, AgentToolPresentation> = {
  // 连接器与通用操作
  connector_apps: { kind: 'connector', zh: ['获取连接账户', '已获取连接账户'], keys: ['surface:agentExecutionTimeline.getConnectedAccounts', 'surface:agentExecutionTimeline.connectedAccountsRetrieved'] },
  connector_run: { kind: 'action', zh: ['执行连接操作', '已执行连接操作'], keys: ['surface:agentExecutionTimeline.runConnectorAction', 'surface:agentExecutionTimeline.connectorActionExecuted'] },
  connector_schema: { kind: 'schema', zh: ['查看操作要求', '已查看操作要求'], keys: ['surface:agentExecutionTimeline.viewOperationRequirements', 'surface:agentExecutionTimeline.operationRequirementsViewed'] },
  connector_search: { kind: 'search', zh: ['查找可用操作', '已查找可用操作'], keys: ['surface:agentExecutionTimeline.searchAvailableOperations', 'surface:agentExecutionTimeline.availableOperationsFound'] },
  connector_data_search: { kind: 'search', zh: ['搜索连接数据', '已搜索连接数据'], keys: ['surface:agentExecutionTimeline.searchConnectorData', 'surface:agentExecutionTimeline.connectorDataSearched'] },
  connector_record_get: { kind: 'action', zh: ['读取连接记录', '已读取连接记录'], keys: ['surface:agentExecutionTimeline.readConnectorRecord', 'surface:agentExecutionTimeline.connectorRecordRead'] },
  connector_sync_status: { kind: 'action', zh: ['查看连接同步状态', '已查看连接同步状态'], keys: ['surface:agentExecutionTimeline.viewConnectorSyncStatus', 'surface:agentExecutionTimeline.connectorSyncStatusViewed'] },
  send_notification: { kind: 'action', zh: ['发送通知', '已发送通知'], keys: ['surface:agentExecutionTimeline.sendNotification', 'surface:agentExecutionTimeline.notificationSent'] },
  submit_format_mapping: { kind: 'connector', zh: ['提交格式映射', '已提交格式映射'], keys: ['surface:agentExecutionTimeline.submitFormatMapping', 'surface:agentExecutionTimeline.formatMappingSubmitted'] },
  tool_search: { kind: 'action', zh: ['选择所需工具', '已选择所需工具'], keys: ['surface:agentExecutionTimeline.selectRequiredTool', 'surface:agentExecutionTimeline.requiredToolSelected'] },
  // Room 与文档（Markdown 文稿工具链已下线：context_room_document_*/write_*/patch_*
  // 与 document_draft 等条目不再保留；office/sheets/slides 产物类见下节）
  context_room_list: { kind: 'document', zh: ['获取 Room 列表', '已获取 Room 列表'], keys: ['surface:agentExecutionTimeline.getRoomList', 'surface:agentExecutionTimeline.roomListRetrieved'] },
  context_room_create: { kind: 'action', zh: ['创建 Room', '已创建 Room'], keys: ['surface:agentExecutionTimeline.createRoom', 'surface:agentExecutionTimeline.roomCreated'] },
  // Office 与幻灯片
  context_room_office_create: { kind: 'document', zh: ['创建 Word 文档', '已创建 Word 文档'], keys: ['surface:agentExecutionTimeline.createWordDocument', 'surface:agentExecutionTimeline.wordDocumentCreated'] },
  context_room_sheets_create: { kind: 'document', zh: ['创建电子表格', '已创建电子表格'], keys: ['surface:agentExecutionTimeline.createSpreadsheet', 'surface:agentExecutionTimeline.spreadsheetCreated'] },
  context_room_slides_create: { kind: 'slides', zh: ['创建演示文稿', '已创建演示文稿'], keys: ['surface:agentExecutionTimeline.createPresentation', 'surface:agentExecutionTimeline.presentationCreated'] },
  context_room_slides_set_page: { kind: 'slides', zh: ['生成幻灯片页面', '已生成幻灯片页面'], keys: ['surface:agentExecutionTimeline.generateSlidePage', 'surface:agentExecutionTimeline.slidePageGenerated'] },
  context_room_slides_read: { kind: 'slides', zh: ['读取幻灯片', '已读取幻灯片'], keys: ['surface:agentExecutionTimeline.readPresentation', 'surface:agentExecutionTimeline.presentationRead'] },
  context_room_slides_edit: { kind: 'slides', zh: ['编辑幻灯片', '已编辑幻灯片'], keys: ['surface:agentExecutionTimeline.editPresentation', 'surface:agentExecutionTimeline.presentationEdited'] },
  slides_draft: { kind: 'slides', zh: ['制作演示文稿', '已制作演示文稿'], keys: ['surface:agentExecutionTimeline.createDeck', 'surface:agentExecutionTimeline.deckCreated'] },
  slides_image_prewarm: { kind: 'image', zh: ['准备幻灯片配图', '已准备幻灯片配图'], keys: ['surface:agentExecutionTimeline.prewarmSlideImages', 'surface:agentExecutionTimeline.slideImagesPrewarmed'] },
  slides_layout_validate: { kind: 'slides', zh: ['校验幻灯片版式', '已校验幻灯片版式'], keys: ['surface:agentExecutionTimeline.validateSlideLayout', 'surface:agentExecutionTimeline.slideLayoutValidated'] },
  // Room 分析、纠正与待办
  context_room_context_get: { kind: 'analysis', zh: ['获取 Room 上下文', '已获取 Room 上下文'], keys: ['surface:agentExecutionTimeline.getRoomContext', 'surface:agentExecutionTimeline.roomContextRetrieved'] },
  context_room_overview_regenerate: { kind: 'analysis', zh: ['重新生成 Room 概览', '已重新生成 Room 概览'], keys: ['surface:agentExecutionTimeline.regenerateRoomOverview', 'surface:agentExecutionTimeline.roomOverviewRegenerated'] },
  context_room_correction_propose: { kind: 'analysis', zh: ['提交 Room 纠正建议', '已提交 Room 纠正建议'], keys: ['surface:agentExecutionTimeline.proposeRoomCorrection', 'surface:agentExecutionTimeline.roomCorrectionProposed'] },
  context_room_correction_apply: { kind: 'action', zh: ['应用 Room 纠正', '已应用 Room 纠正'], keys: ['surface:agentExecutionTimeline.applyRoomCorrection', 'surface:agentExecutionTimeline.roomCorrectionApplied'] },
  context_room_correction_apply_citation: { kind: 'action', zh: ['应用 Room 纠正引用', '已应用 Room 纠正引用'], keys: ['surface:agentExecutionTimeline.applyRoomCorrectionCitation', 'surface:agentExecutionTimeline.roomCorrectionCitationApplied'] },
  context_room_correction_revoke: { kind: 'action', zh: ['撤销 Room 纠正', '已撤销 Room 纠正'], keys: ['surface:agentExecutionTimeline.revokeRoomCorrection', 'surface:agentExecutionTimeline.roomCorrectionRevoked'] },
  context_room_action_delete: { kind: 'action', zh: ['删除 Room 条目', '已删除 Room 条目'], keys: ['surface:agentExecutionTimeline.deleteRoomAction', 'surface:agentExecutionTimeline.roomActionDeleted'] },
  context_room_task_create: { kind: 'task', zh: ['创建 Room 待办', '已创建 Room 待办'], keys: ['surface:agentExecutionTimeline.createRoomTask', 'surface:agentExecutionTimeline.roomTaskCreated'] },
  context_room_task_complete: { kind: 'task', zh: ['更新 Room 待办状态', '已更新 Room 待办状态'], keys: ['surface:agentExecutionTimeline.updateRoomTaskStatus', 'surface:agentExecutionTimeline.roomTaskStatusUpdated'] },
  context_room_task_read: { kind: 'task', zh: ['读取 Room 待办', '已读取 Room 待办'], keys: ['surface:agentExecutionTimeline.readRoomTask', 'surface:agentExecutionTimeline.roomTaskRead'] },
  context_room_task_start: { kind: 'task', zh: ['开始 Room 待办', '已开始 Room 待办'], keys: ['surface:agentExecutionTimeline.startRoomTask', 'surface:agentExecutionTimeline.roomTaskStarted'] },
  context_room_task_update: { kind: 'task', zh: ['更新 Room 待办', '已更新 Room 待办'], keys: ['surface:agentExecutionTimeline.updateRoomTask', 'surface:agentExecutionTimeline.roomTaskUpdated'] },
  context_room_task_clarify: { kind: 'task', zh: ['澄清 Room 待办', '已澄清 Room 待办'], keys: ['surface:agentExecutionTimeline.clarifyRoomTask', 'surface:agentExecutionTimeline.roomTaskClarified'] },
  context_room_task_attach: { kind: 'task', zh: ['附加 Room 待办材料', '已附加 Room 待办材料'], keys: ['surface:agentExecutionTimeline.attachRoomTaskMaterial', 'surface:agentExecutionTimeline.roomTaskMaterialAttached'] },
  context_room_schedule_create: { kind: 'calendar', zh: ['创建 Room 日程', '已创建 Room 日程'], keys: ['surface:agentExecutionTimeline.createRoomSchedule', 'surface:agentExecutionTimeline.roomScheduleCreated'] },
  room_task_create: { kind: 'task', zh: ['创建 Room 待办', '已创建 Room 待办'], keys: ['surface:agentExecutionTimeline.createRoomTask', 'surface:agentExecutionTimeline.roomTaskCreated'] },
  room_schedule_create: { kind: 'calendar', zh: ['创建 Room 日程', '已创建 Room 日程'], keys: ['surface:agentExecutionTimeline.createRoomSchedule', 'surface:agentExecutionTimeline.roomScheduleCreated'] },
  room_context_get: { kind: 'analysis', zh: ['读取 Room 资料', '已读取 Room 资料'], keys: ['surface:agentExecutionTimeline.readRoomContext', 'surface:agentExecutionTimeline.roomContextRead'] },
  room_analysis: { kind: 'analysis', zh: ['分析 Room 资料', '已分析 Room 资料'], keys: ['surface:agentExecutionTimeline.analyzeRoomMaterials', 'surface:agentExecutionTimeline.roomMaterialsAnalyzed'] },
  room_correction_draft: { kind: 'analysis', zh: ['起草 Room 纠正', '已起草 Room 纠正'], keys: ['surface:agentExecutionTimeline.draftRoomCorrection', 'surface:agentExecutionTimeline.roomCorrectionDrafted'] },
  // 文档分析与导入导出（document_draft / document_read_* 属已下线的 Markdown 文稿链路）
  content_analysis: { kind: 'analysis', zh: ['分析内容', '已分析内容'], keys: ['surface:agentExecutionTimeline.analyzeContent', 'surface:agentExecutionTimeline.contentAnalyzed'] },
  document_analysis: { kind: 'document', zh: ['分析文档', '已分析文档'], keys: ['surface:agentExecutionTimeline.analyzeDocument', 'surface:agentExecutionTimeline.documentAnalyzed'] },
  document_export: { kind: 'document', zh: ['导出文档', '已导出文档'], keys: ['surface:agentExecutionTimeline.exportDocument', 'surface:agentExecutionTimeline.documentExported'] },
  document_import_search: { kind: 'search', zh: ['搜索可导入文档', '已搜索可导入文档'], keys: ['surface:agentExecutionTimeline.searchImportableDocuments', 'surface:agentExecutionTimeline.importableDocumentsSearched'] },
  document_import_preview: { kind: 'document', zh: ['预览导入文档', '已预览导入文档'], keys: ['surface:agentExecutionTimeline.previewImportedDocument', 'surface:agentExecutionTimeline.importedDocumentPreviewed'] },
  document_import_commit: { kind: 'document', zh: ['导入文档到 Room', '已导入文档到 Room'], keys: ['surface:agentExecutionTimeline.importDocumentToRoom', 'surface:agentExecutionTimeline.documentImportedToRoom'] },
  document_parse_native: { kind: 'document', zh: ['解析原生文档', '已解析原生文档'], keys: ['surface:agentExecutionTimeline.parseNativeDocument', 'surface:agentExecutionTimeline.nativeDocumentParsed'] },
  document_analyze_visuals: { kind: 'document', zh: ['分析文档视觉内容', '已分析文档视觉内容'], keys: ['surface:agentExecutionTimeline.analyzeDocumentVisuals', 'surface:agentExecutionTimeline.documentVisualsAnalyzed'] },
  document_validate_artifact: { kind: 'document', zh: ['校验文档产物', '已校验文档产物'], keys: ['surface:agentExecutionTimeline.validateDocumentArtifact', 'surface:agentExecutionTimeline.documentArtifactValidated'] },
  route_mindmap_finalize: { kind: 'analysis', zh: ['确定写作路线', '已确定写作路线'], keys: ['surface:agentExecutionTimeline.finalizeWritingRoute', 'surface:agentExecutionTimeline.writingRouteFinalized'] },
  diary_source_read: { kind: 'document', zh: ['读取日记来源', '已读取日记来源'], keys: ['surface:agentExecutionTimeline.readDiarySource', 'surface:agentExecutionTimeline.diarySourceRead'] },
  // 知识库与联网
  conversation_search: { kind: 'search', zh: ['检索历史对话', '已检索历史对话'], keys: ['surface:agentExecutionTimeline.searchConversations', 'surface:agentExecutionTimeline.conversationsSearched'] },
  wiki_search: { kind: 'search', zh: ['搜索知识库', '已搜索知识库'], keys: ['surface:agentExecutionTimeline.searchWiki', 'surface:agentExecutionTimeline.wikiSearched'] },
  wiki_read: { kind: 'document', zh: ['读取知识库页面', '已读取知识库页面'], keys: ['surface:agentExecutionTimeline.readWikiPage', 'surface:agentExecutionTimeline.wikiPageRead'] },
  web_search: { kind: 'search', zh: ['搜索网页', '已搜索网页'], keys: ['surface:agentExecutionTimeline.searchWeb', 'surface:agentExecutionTimeline.webSearched'] },
  web_fetch: { kind: 'search', zh: ['获取网页', '已获取网页'], keys: ['surface:agentExecutionTimeline.fetchWeb', 'surface:agentExecutionTimeline.fetchedWeb'] },
  // 子 Agent 与调度
  agent_catalog: { kind: 'agent', zh: ['查看可用子 Agent', '已查看可用子 Agent'], keys: ['surface:agentExecutionTimeline.listSubagents', 'surface:agentExecutionTimeline.subagentsListed'] },
  agent_dispatch: { kind: 'agent', zh: ['调度子 Agent', '已调度子 Agent'], keys: ['surface:agentExecutionTimeline.dispatchSubagent', 'surface:agentExecutionTimeline.subagentDispatched'] },
  local_agent_dispatch: { kind: 'agent', zh: ['委派本机 Agent', '已委派本机 Agent'], keys: ['surface:agentExecutionTimeline.dispatchLocalAgent', 'surface:agentExecutionTimeline.localAgentDispatched'] },
  lite_assist: { kind: 'agent', zh: ['委派轻量模型', '已委派轻量模型'], keys: ['surface:agentExecutionTimeline.delegateLiteModel', 'surface:agentExecutionTimeline.liteModelDelegated'] },
  agent_conversation_query: { kind: 'agent', zh: ['查询引用的 Agent 会话', '已查询引用的 Agent 会话'], keys: ['surface:agentExecutionTimeline.queryAgentConversation', 'surface:agentExecutionTimeline.agentConversationQueried'] },
  subagent_submit_result: { kind: 'agent', zh: ['提交子 Agent 结果', '已提交子 Agent 结果'], keys: ['surface:agentExecutionTimeline.submitSubagentResult', 'surface:agentExecutionTimeline.subagentResultSubmitted'] },
  agent_schedule_list: { kind: 'calendar', zh: ['查看定时任务', '已查看定时任务'], keys: ['surface:agentExecutionTimeline.listAgentSchedules', 'surface:agentExecutionTimeline.agentSchedulesListed'] },
  agent_schedule_run: { kind: 'calendar', zh: ['运行定时任务', '已运行定时任务'], keys: ['surface:agentExecutionTimeline.runAgentSchedule', 'surface:agentExecutionTimeline.agentScheduleRun'] },
  // EverOffice 访问
  everroom: { kind: 'action', zh: ['访问 EverOffice', '已访问 EverOffice'], keys: ['surface:agentExecutionTimeline.accessEverOffice', 'surface:agentExecutionTimeline.everRoomAccessed'] },
  everroom_fetch: { kind: 'document', zh: ['读取 EverOffice 内容', '已读取 EverOffice 内容'], keys: ['surface:agentExecutionTimeline.fetchEverOfficeContent', 'surface:agentExecutionTimeline.everRoomContentFetched'] },
  everroom_list_rooms: { kind: 'action', zh: ['获取 EverOffice Room 列表', '已获取 EverOffice Room 列表'], keys: ['surface:agentExecutionTimeline.listEverOfficeRooms', 'surface:agentExecutionTimeline.everRoomRoomsListed'] },
  everroom_search: { kind: 'search', zh: ['搜索 EverOffice', '已搜索 EverOffice'], keys: ['surface:agentExecutionTimeline.searchEverOffice', 'surface:agentExecutionTimeline.everRoomSearched'] },
  everroom_read_file: { kind: 'file', zh: ['读取 EverOffice 文件', '已读取 EverOffice 文件'], keys: ['surface:agentExecutionTimeline.readEverOfficeFile', 'surface:agentExecutionTimeline.everRoomFileRead'] },
  everroom_get_rules: { kind: 'action', zh: ['查看 EverOffice 规则', '已查看 EverOffice 规则'], keys: ['surface:agentExecutionTimeline.viewEverOfficeRules', 'surface:agentExecutionTimeline.everRoomRulesViewed'] },
  everroom_get_status: { kind: 'action', zh: ['查看 EverOffice 状态', '已查看 EverOffice 状态'], keys: ['surface:agentExecutionTimeline.viewEverOfficeStatus', 'surface:agentExecutionTimeline.everRoomStatusViewed'] },
  everroom_register_file: { kind: 'action', zh: ['登记 EverOffice 文件', '已登记 EverOffice 文件'], keys: ['surface:agentExecutionTimeline.registerEverOfficeFile', 'surface:agentExecutionTimeline.everRoomFileRegistered'] },
  everroom_submit: { kind: 'action', zh: ['提交到 EverOffice', '已提交到 EverOffice'], keys: ['surface:agentExecutionTimeline.submitToEverOffice', 'surface:agentExecutionTimeline.submittedToEverOffice'] },
  everroom_submit_status: { kind: 'action', zh: ['查看 EverOffice 提交状态', '已查看 EverOffice 提交状态'], keys: ['surface:agentExecutionTimeline.viewEverOfficeSubmissionStatus', 'surface:agentExecutionTimeline.everRoomSubmissionStatusViewed'] },
  // 本地文件与命令
  read_file: { kind: 'file', zh: ['读取文件', '已读取文件'], keys: ['surface:agentExecutionTimeline.readFile', 'surface:agentExecutionTimeline.fileRead'] },
  read: { kind: 'file', zh: ['读取文件', '已读取文件'], keys: ['surface:agentExecutionTimeline.readFile', 'surface:agentExecutionTimeline.fileRead'] },
  write_file: { kind: 'file', zh: ['修改文件', '已修改文件'], keys: ['surface:agentExecutionTimeline.modifyFile', 'surface:agentExecutionTimeline.fileModified'] },
  write: { kind: 'file', zh: ['修改文件', '已修改文件'], keys: ['surface:agentExecutionTimeline.modifyFile', 'surface:agentExecutionTimeline.fileModified'] },
  edit: { kind: 'file', zh: ['修改文件', '已修改文件'], keys: ['surface:agentExecutionTimeline.modifyFile', 'surface:agentExecutionTimeline.fileModified'] },
  patch: { kind: 'file', zh: ['修改文件', '已修改文件'], keys: ['surface:agentExecutionTimeline.modifyFile', 'surface:agentExecutionTimeline.fileModified'] },
  apply_patch: { kind: 'file', zh: ['修改文件', '已修改文件'], keys: ['surface:agentExecutionTimeline.modifyFile', 'surface:agentExecutionTimeline.fileModified'] },
  glob: { kind: 'search', zh: ['查找文件', '已查找文件'], keys: ['surface:agentExecutionTimeline.findFiles', 'surface:agentExecutionTimeline.filesFound'] },
  grep: { kind: 'search', zh: ['搜索文件内容', '已搜索文件内容'], keys: ['surface:agentExecutionTimeline.searchFileContents', 'surface:agentExecutionTimeline.fileContentsSearched'] },
  list_dir: { kind: 'file', zh: ['浏览目录', '已浏览目录'], keys: ['surface:agentExecutionTimeline.browseDirectory', 'surface:agentExecutionTimeline.directoryBrowsed'] },
  ls: { kind: 'file', zh: ['浏览目录', '已浏览目录'], keys: ['surface:agentExecutionTimeline.browseDirectory', 'surface:agentExecutionTimeline.directoryBrowsed'] },
  bash: { kind: 'command', zh: ['运行命令', '已运行命令'], keys: ['surface:agentExecutionTimeline.runCommand', 'surface:agentExecutionTimeline.commandRun'] },
  shell: { kind: 'command', zh: ['运行命令', '已运行命令'], keys: ['surface:agentExecutionTimeline.runCommand', 'surface:agentExecutionTimeline.commandRun'] },
  command: { kind: 'command', zh: ['运行命令', '已运行命令'], keys: ['surface:agentExecutionTimeline.runCommand', 'surface:agentExecutionTimeline.commandRun'] },
  terminal: { kind: 'command', zh: ['运行命令', '已运行命令'], keys: ['surface:agentExecutionTimeline.runCommand', 'surface:agentExecutionTimeline.commandRun'] },
  // ACP 语义工具
  search: { kind: 'search', zh: ['搜索', '已搜索'], keys: ['surface:agentExecutionTimeline.searchGeneric', 'surface:agentExecutionTimeline.searchedGeneric'] },
  think: { kind: 'analysis', zh: ['思考', '已思考'], keys: ['surface:agentExecutionTimeline.thinking', 'surface:agentExecutionTimeline.thought'] },
  create: { kind: 'action', zh: ['创建', '已创建'], keys: ['surface:agentExecutionTimeline.createItem', 'surface:agentExecutionTimeline.createdItem'] },
  delete: { kind: 'action', zh: ['删除', '已删除'], keys: ['surface:agentExecutionTimeline.deleteItem', 'surface:agentExecutionTimeline.deletedItem'] },
  move: { kind: 'action', zh: ['移动', '已移动'], keys: ['surface:agentExecutionTimeline.moveItem', 'surface:agentExecutionTimeline.movedItem'] },
  tool: { kind: 'action', zh: ['调用工具', '已调用工具'], keys: ['surface:agentExecutionTimeline.callTool', 'surface:agentExecutionTimeline.toolCalled'] },
}

type AgentToolSubjectSpec =
  | { keys: readonly string[] }
  | { pair: readonly [readonly string[], readonly string[]] }

/** 按工具名区分的参数优先级：映射里没有的工具才走通用 key 顺序。 */
const AGENT_TOOL_SUBJECTS: Record<string, AgentToolSubjectSpec> = {
  send_notification: { keys: ['title'] },
  submit_format_mapping: { keys: ['service', 'recordKind'] },
  tool_search: { keys: ['query', 'name', 'tool'] },
  context_room_create: { keys: ['title', 'topic'] },
  context_room_office_create: { keys: ['title', 'fileName'] },
  context_room_sheets_create: { keys: ['title', 'name'] },
  context_room_slides_create: { keys: ['title', 'topic'] },
  context_room_slides_set_page: { keys: ['title', 'page', 'pageNumber', 'slideIndex'] },
  context_room_slides_read: { keys: ['title', 'fileId'] },
  context_room_slides_edit: { keys: ['title', 'fileId'] },
  slides_image_prewarm: { keys: ['title', 'page', 'pageNumber', 'pageIndex'] },
  slides_layout_validate: { keys: ['title', 'page', 'pageIndex'] },
  context_room_context_get: { keys: ['roomId'] },
  context_room_correction_propose: { keys: ['title', 'correctionId'] },
  context_room_correction_apply: { keys: ['title', 'correctionId'] },
  context_room_correction_apply_citation: { keys: ['title', 'correctionId'] },
  context_room_correction_revoke: { keys: ['title', 'correctionId'] },
  context_room_action_delete: { keys: ['title', 'actionId'] },
  context_room_task_create: { keys: ['title', 'taskId'] },
  context_room_task_complete: { keys: ['title', 'taskId', 'actionId'] },
  context_room_task_read: { keys: ['title', 'taskId', 'actionId'] },
  context_room_task_start: { keys: ['title', 'taskId', 'actionId'] },
  context_room_task_update: { keys: ['title', 'taskId', 'actionId'] },
  context_room_task_clarify: { keys: ['title', 'taskId', 'actionId'] },
  context_room_task_attach: { keys: ['title', 'taskId', 'actionId'] },
  context_room_schedule_create: { keys: ['title', 'startedAt'] },
  room_task_create: { keys: ['title', 'taskId'] },
  room_schedule_create: { keys: ['title', 'startedAt'] },
  room_context_get: { keys: ['roomId'] },
  room_analysis: { keys: ['focus', 'roomId'] },
  room_correction_draft: { keys: ['instruction', 'title'] },
  content_analysis: { pair: [['sourceLabel'], ['task']] },
  document_analysis: { keys: ['question', 'fileEntryId', 'title'] },
  document_export: { keys: ['title', 'documentId'] },
  document_import_search: { keys: ['query', 'keyword'] },
  document_import_preview: { keys: ['remoteDocumentId', 'title', 'runId'] },
  document_import_commit: { keys: ['runId', 'roomId', 'title'] },
  document_parse_native: { keys: ['path', 'fileVersionId', 'artifactId', 'documentId', 'title'] },
  document_analyze_visuals: { keys: ['fileVersionId', 'artifactId', 'title'] },
  document_validate_artifact: { keys: ['fileVersionId', 'artifactId', 'title'] },
  route_mindmap_finalize: { keys: ['title', 'documentId'] },
  diary_source_read: { keys: ['sourceId', 'title'] },
  conversation_search: { keys: ['query'] },
  wiki_search: { keys: ['query'] },
  wiki_read: { keys: ['title', 'path'] },
  web_search: { keys: ['query'] },
  web_fetch: { keys: ['url'] },
  agent_dispatch: { pair: [['agentDefinitionId', 'agentId', 'agent', 'agentName'], ['task', 'assignment', 'query']] },
  local_agent_dispatch: { keys: ['task', 'assignment', 'query'] },
  lite_assist: { keys: ['task', 'query'] },
  agent_conversation_query: { keys: ['query'] },
  agent_schedule_run: { keys: ['id', 'name', 'title'] },
  everroom_fetch: { keys: ['uri', 'path', 'url'] },
  everroom_search: { keys: ['query'] },
  everroom_read_file: { keys: ['path', 'filePath', 'file_path', 'fileId'] },
  everroom_register_file: { keys: ['filename', 'title'] },
  everroom_submit: { keys: ['submissionId', 'title'] },
  everroom_submit_status: { keys: ['submissionId', 'title'] },
  read_file: { keys: ['path', 'filePath', 'file_path'] },
  read: { keys: ['path', 'filePath', 'file_path'] },
  write_file: { keys: ['path', 'filePath', 'file_path'] },
  write: { keys: ['path', 'filePath', 'file_path'] },
  edit: { keys: ['path', 'filePath', 'file_path'] },
  patch: { keys: ['path', 'filePath', 'file_path'] },
  apply_patch: { keys: ['path', 'filePath', 'file_path'] },
  glob: { keys: ['pattern', 'path'] },
  grep: { keys: ['pattern', 'path'] },
  list_dir: { keys: ['path'] },
  ls: { keys: ['path'] },
  bash: { keys: ['command', 'cmd', 'script'] },
  shell: { keys: ['command', 'cmd', 'script'] },
  command: { keys: ['command', 'cmd', 'script'] },
  terminal: { keys: ['command', 'cmd', 'script'] },
  search: { keys: ['query'] },
  create: { keys: ['path', 'filePath', 'file_path', 'title', 'name'] },
  delete: { keys: ['path', 'filePath', 'file_path', 'title', 'name'] },
  move: { keys: ['path', 'filePath', 'file_path', 'title', 'name'] },
}

export function agentToolKind(name: string): AgentToolKind {
  const presentation = AGENT_TOOL_PRESENTATIONS[name.toLowerCase()]
  // 映射表之外一律 other：不再用 document/read/image 之类的词根猜图标。
  return presentation ? presentation.kind : 'other'
}

export function agentToolLabel(tool: DisplayAgentToolCall, completed = tool.status === 'completed', t?: Translate): string {
  const name = tool.name.toLowerCase()
  const presentation = AGENT_TOOL_PRESENTATIONS[name]
  if (presentation) {
    return t ? t(presentation.keys[completed ? 1 : 0]) : presentation.zh[completed ? 1 : 0]
  }
  // 安全家族兜底：只保留 photo/image/calendar/email/bash 这类无歧义词根。
  // document/read/write/search/web 会误伤 document_export、everroom_search
  // 这类业务工具，因此不再按这些词根猜语义。
  if (/photo|image/.test(name)) return t ? t(completed ? 'surface:agentExecutionTimeline.imageViewed' : 'surface:agentExecutionTimeline.viewImage') : completed ? '已查看图像' : '查看图像'
  if (/calendar/.test(name)) {
    if (/create|add/.test(name)) return t ? t(completed ? 'surface:agentExecutionTimeline.calendarEventCreated' : 'surface:agentExecutionTimeline.createCalendarEvent') : completed ? '已创建日程' : '创建日程'
    return t ? t(completed ? 'surface:agentExecutionTimeline.calendarQueried' : 'surface:agentExecutionTimeline.queryCalendar') : completed ? '已查询日历' : '查询日历'
  }
  if (/scheduler/.test(name)) return t ? t(completed ? 'surface:agentExecutionTimeline.scheduledTaskHandled' : 'surface:agentExecutionTimeline.handleScheduledTask') : completed ? '已处理定时任务' : '处理定时任务'
  if (/email|mail/.test(name)) {
    if (/sync/.test(name)) return t ? t(completed ? 'surface:agentExecutionTimeline.emailSynced' : 'surface:agentExecutionTimeline.syncEmail') : completed ? '已同步邮件' : '同步邮件'
    return t ? t(completed ? 'surface:agentExecutionTimeline.emailQueried' : 'surface:agentExecutionTimeline.queryEmail') : completed ? '已查询邮件' : '查询邮件'
  }
  if (/bash|command|terminal|shell/.test(name)) return t ? t(completed ? 'surface:agentExecutionTimeline.commandRun' : 'surface:agentExecutionTimeline.runCommand') : completed ? '已运行命令' : '运行命令'
  const fallback = tool.name.replace(/[_-]+/g, ' ').trim()
  if (!fallback) return t ? t(completed ? 'surface:agentExecutionTimeline.toolCalled' : 'surface:agentExecutionTimeline.callTool') : completed ? '已调用工具' : '调用工具'
  return t ? t(completed ? 'surface:agentExecutionTimeline.executedName' : 'surface:agentExecutionTimeline.executingName', { name: fallback }) : `${completed ? '已执行' : '执行'} ${fallback}`
}

/** 参数值转摘要文本：映射里的 pageIndex/slideIndex 是数字，也要能作为目标展示。 */
function subjectValue(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return userText(value, 80)
}

function firstSubjectValue(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = subjectValue(args[key])
    if (value) return value
  }
  return undefined
}

export function agentToolSubject(tool: DisplayAgentToolCall): string | undefined {
  const name = tool.name.toLowerCase()
  // PPT 的阶段与内容由进度卡承载；时间线不再显示 generate/style/draft 这类内部参数值。
  if (name === 'slides_draft') return undefined
  if (name.startsWith('connector_')) {
    const service = userText(tool.args.service, 40)
    const operation = userText(tool.args.name, 80) ?? userText(tool.args.query, 80)
    if (service && operation) return `${service} · ${operation}`
    if (operation) return operation
    if (service) return service
  }
  const subject = AGENT_TOOL_SUBJECTS[name]
  if (subject) {
    if ('pair' in subject) {
      const primary = firstSubjectValue(tool.args, subject.pair[0])
      const target = firstSubjectValue(tool.args, subject.pair[1])
      if (primary && target) return `${primary} · ${target}`
      if (primary) return primary
      if (target) return target
    } else {
      const value = firstSubjectValue(tool.args, subject.keys)
      if (value) return value
    }
    // 映射内但该工具没有专用目标参数时，只用适配器标题兜底，不回落到通用 key 顺序。
    return userText(tool.title, 80)
  }
  if (AGENT_TOOL_PRESENTATIONS[name]) return userText(tool.title, 80)
  for (const key of [
    'command', 'cmd', 'script', 'code', 'input', 'task', 'assignment',
    'query', 'search_query', 'keyword', 'prompt', 'path', 'filePath', 'file_path', 'title', 'documentTitle', 'url',
  ]) {
    const value = userText(tool.args[key], 80)
    if (value) return value
  }
  return userText(tool.title, 80)
}

export function agentToolCommand(tool: DisplayAgentToolCall): string | undefined {
  if (!/bash|command|terminal|shell/.test(tool.name.toLowerCase())) return undefined
  for (const key of ['command', 'cmd', 'script', 'code', 'input']) {
    const value = userText(tool.args[key], 12_000)
    if (value) return value
  }
  return undefined
}

export function agentToolResultSummary(result: unknown, t?: Translate): string | undefined {
  if (!result) return undefined
  if (typeof result === 'string') {
    try {
      return agentToolResultSummary(JSON.parse(result), t)
    } catch {
      return result.trim().slice(0, 120) || undefined
    }
  }
  if (typeof result !== 'object' || Array.isArray(result)) return undefined
  const record = result as Record<string, unknown>
  for (const key of ['results', 'items', 'messages', 'events', 'photos']) {
    if (Array.isArray(record[key])) return t
      ? t('surface:agentExecutionTimeline.countResults', { count: record[key].length })
      : `获得 ${record[key].length} 条结果`
  }
  for (const key of ['summary', 'message', 'title', 'documentTitle']) {
    const value = userText(record[key], 120)
    if (value) return value
  }
  for (const key of ['structuredContent', 'details', 'navigation', 'document', 'patch']) {
    const nested = record[key]
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue
    const value = agentToolResultSummary(nested, t)
    if (value) return value
  }
  return undefined
}

function punctuate(text: string): string {
  return /[。！？]$/.test(text) ? text : `${text}。`
}

function comparableText(text: string): string {
  return text.toLowerCase().replace(/[\s，。；：！？、,.!?;:「」『』“”\"'（）()]/g, '')
}

function resultRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return resultRecord(JSON.parse(value))
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function filterActivityText(
  text: string,
  tool: DisplayAgentToolCall,
  nextTool?: DisplayAgentToolCall,
): string {
  const subject = agentToolSubject(tool)
  const labels = [agentToolLabel(tool, false), agentToolLabel(tool, true)]
  const repeated = new Set(labels.flatMap((label) => [
    label,
    `正在${label}`,
    ...(subject ? [`${label}${subject}`, `正在${label}${subject}`] : []),
  ]).map(comparableText))

  if (nextTool) {
    const nextLabel = agentToolLabel(nextTool, false)
    for (const prefix of ['', '接下来', '下一步', '然后']) repeated.add(comparableText(`${prefix}${nextLabel}`))
  }

  return (text.match(/[^。！？!?]+[。！？!?]?/g) ?? [text])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !repeated.has(comparableText(sentence)))
    .join('')
}

export function agentToolStageText(
  tool: DisplayAgentToolCall,
  t?: Translate,
): string {
  if (tool.status === 'pending' || tool.status === 'running') {
    return ''
  }
  if (tool.status === 'error') {
    const error = tool.error?.slice(0, 120)
    if (t && (!error || error === '工具调用失败' || error === '工具调用失败。')) {
      return t('surface:agentExecutionTimeline.failed')
    }
    return punctuate(error || '工具调用失败')
  }
  if (tool.status === 'stopped') return t ? t('surface:agentExecutionTimeline.stopped') : '操作已停止。'

  const result = agentToolResultSummary(tool.result ?? tool.partialResult, t)
  if (!result) return ''
  const comparableResult = comparableText(result)
  const subject = agentToolSubject(tool)
  if (
    comparableResult === comparableText(subject ?? '')
    || comparableResult === comparableText(agentToolLabel(tool, false, t))
    || comparableResult === comparableText(agentToolLabel(tool, true, t))
    || /^(已)?(操作)?(完成|成功)$/.test(comparableResult)
  ) return ''
  return punctuate(result)
}

/**
 * run 活动的增量折叠器：事件按 seq 升序逐个喂入，避免每个事件都全量重放
 * 整个 run 的历史（全量重放是 O(N²)，工具多、流式 delta 多时把渲染线程卡死）。
 * 折叠器自身可变，快照（snapshotAgentRunActivity）输出不可变的展示对象。
 */
export interface AgentRunActivityAccumulator {
  steps: AgentActivityStep[]
  tools: DisplayAgentToolCall[]
  pendingText: string
  /** 尚未归入某个 step 的思考增量（reasoning.delta）：新工具出现时封段。 */
  pendingReasoning: string
  completedContent: string
  completed: boolean
  savedAnswer: string
}

export function createAgentRunActivityAccumulator(savedAnswer = ''): AgentRunActivityAccumulator {
  return { steps: [], tools: [], pendingText: '', pendingReasoning: '', completedContent: '', completed: false, savedAnswer }
}

/** 折叠单个事件，返回是否有可观察变化（无变化时调用方可跳过重渲染）。 */
export function foldAgentRunActivityEvent(acc: AgentRunActivityAccumulator, event: AgentEvent): boolean {
  if (isToolEvent(event)) {
    const nextTools = mergeAgentToolEvent(acc.tools, event)
    const payload = event.payload as { toolCallId?: unknown }
    if (typeof payload.toolCallId !== 'string') return false
    const tool = nextTools.find((candidate) => candidate.id === payload.toolCallId)
    if (!tool) return false
    const index = acc.steps.findIndex((step) => step.id === tool.id)
    if (index === -1) {
      const text = acc.pendingText.trim()
      if (text && acc.steps.length) {
        const previous = acc.steps[acc.steps.length - 1]!
        previous.afterText = filterActivityText(text, previous.tool, tool)
      }
      acc.steps.push({
        id: tool.id,
        sequence: event.seq,
        tool,
        beforeText: text && !acc.steps.length ? filterActivityText(text, tool) : '',
        afterText: '',
        // 思考按工具调用决策分段：新工具出现时，把之前的思考封进这个 step。
        reasoningBefore: acc.pendingReasoning,
      })
      acc.pendingText = ''
      acc.pendingReasoning = ''
    } else {
      acc.steps[index] = { ...acc.steps[index]!, tool }
    }
    acc.tools = nextTools
    return true
  }

  if (event.type === 'message.started') {
    // pi 自动重试重启消息体（#199）：丢弃上一波半截正文，从零重新累计。
    // 思考段同理清空——重启后重新流的 reasoning 会重新分段。
    let changed = false
    if (acc.pendingText) {
      acc.pendingText = ''
      changed = true
    }
    if (acc.pendingReasoning) {
      acc.pendingReasoning = ''
      changed = true
    }
    return changed
  }

  if (event.type === 'reasoning.delta') {
    // 思考增量归入当前段：有 step 后落在 tail（答案前思考），否则等首个工具封段。
    const delta = (event.payload as { delta?: unknown }).delta
    if (typeof delta !== 'string' || !delta) return false
    acc.pendingReasoning += delta
    return true
  }

  if (event.type === 'message.delta') {
    const delta = (event.payload as { delta?: unknown }).delta
    if (typeof delta !== 'string' || !delta) return false
    acc.pendingText += delta
    return true
  }

  if (event.type === 'message.completed') {
    const content = (event.payload as { content?: unknown }).content
    if (typeof content !== 'string') return false
    acc.completedContent = content
    return true
  }

  if (
    event.type === 'run.failed'
    || event.type === 'run.cancelled'
    || event.type === 'run.interrupted'
  ) {
    const status: DisplayAgentToolStatus = event.type === 'run.failed' ? 'error' : 'stopped'
    acc.tools = acc.tools.map((tool) => tool.status === 'pending' || tool.status === 'running'
      ? { ...tool, status, completedAt: event.occurredAt }
      : tool)
    for (let index = 0; index < acc.steps.length; index += 1) {
      const tool = acc.tools.find((candidate) => candidate.id === acc.steps[index]!.id)
      if (tool) acc.steps[index] = { ...acc.steps[index]!, tool }
    }
    return true
  }

  if (event.type === 'run.completed') {
    if (acc.completed) return false
    acc.completed = true
    return true
  }

  return false
}

/** 按 seq 升序折叠一批事件（历史回放用；实时事件已在收到时保证升序）。 */
export function foldAgentRunActivityEvents(
  acc: AgentRunActivityAccumulator,
  events: AgentEvent[],
): boolean {
  let changed = false
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (foldAgentRunActivityEvent(acc, event)) changed = true
  }
  return changed
}

/** 输出不可变快照：steps 复制一份，避免折叠器后续变异污染已进入 React 状态的对象。 */
export function snapshotAgentRunActivity(acc: AgentRunActivityAccumulator): AgentRunActivity {
  const steps = acc.steps.map((step) => ({ ...step }))
  const hasTools = steps.length > 0
  if (!hasTools) {
    return {
      steps,
      pendingAnswer: '',
      finalAnswer: (acc.completedContent || acc.savedAnswer).trim(),
      hasTools,
      completed: acc.completed,
      // 没有工具调用：整段思考都是 tail（ReasoningBlock 整块展示）。
      tailReasoning: acc.pendingReasoning,
      liveReasoning: acc.completed ? '' : acc.pendingReasoning,
    }
  }

  const pendingAnswer = acc.completed ? '' : (acc.pendingText || acc.completedContent || acc.savedAnswer).trim()
  const finalAnswer = acc.completed
    ? (acc.pendingText || acc.completedContent || acc.savedAnswer).trim()
    : ''

  return {
    steps,
    pendingAnswer,
    finalAnswer,
    hasTools,
    completed: acc.completed,
    tailReasoning: acc.pendingReasoning,
    liveReasoning: acc.completed ? '' : acc.pendingReasoning,
  }
}

export function reduceAgentRunActivity(
  events: AgentEvent[],
  savedAnswer = '',
): AgentRunActivity {
  const acc = createAgentRunActivityAccumulator(savedAnswer)
  foldAgentRunActivityEvents(acc, events)
  return snapshotAgentRunActivity(acc)
}

export function reduceAgentRunEvents(events: AgentEvent[]): ReducedAgentRunEvents {
  const reduced: ReducedAgentRunEvents = {
    tools: [],
    reasoning: '',
    streamingContent: '',
    messageStarted: false,
    messageCompleted: false,
    lastSequence: 0,
  }
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    reduced.lastSequence = Math.max(reduced.lastSequence, event.seq)
    if (event.type === 'run.accepted' && !reduced.startedAt) reduced.startedAt = event.occurredAt
    if (event.type === 'run.started') reduced.startedAt = event.occurredAt
    if (
      event.type === 'run.completed' ||
      event.type === 'run.cancelled' ||
      event.type === 'run.failed' ||
      event.type === 'run.interrupted'
    ) {
      reduced.completedAt = event.occurredAt
      if (event.type !== 'run.completed') {
        const terminalStatus: DisplayAgentToolStatus = event.type === 'run.failed' ? 'error' : 'stopped'
        reduced.tools = reduced.tools.map((tool) => tool.status === 'pending' || tool.status === 'running'
          ? { ...tool, status: terminalStatus, completedAt: event.occurredAt }
          : tool)
      }
    }
    if (isToolEvent(event)) reduced.tools = mergeAgentToolEvent(reduced.tools, event)
    if (event.type === 'reasoning.delta') {
      const delta = (event.payload as { delta?: unknown }).delta
      if (typeof delta === 'string') reduced.reasoning += delta
    }
    if (event.type === 'message.started') {
      // run 中途再次 message.started = 运行时丢弃上一波半截输出从头重生成
      // （pi 自动重试，#199）：清空累计，防止多波 delta 拼出重复正文。
      // 首个 message.started 不清——a2a/cli 等运行时的 reasoning 可能先于它到达。
      if (reduced.messageStarted) {
        reduced.streamingContent = ''
        reduced.reasoning = ''
      }
      reduced.messageStarted = true
    }
    if (event.type === 'message.delta') {
      const delta = (event.payload as { delta?: unknown }).delta
      if (typeof delta === 'string') reduced.streamingContent += delta
    }
    if (event.type === 'message.completed') {
      const content = (event.payload as { content?: unknown }).content
      if (typeof content === 'string') reduced.streamingContent = content
      reduced.messageCompleted = true
    }
  }
  return reduced
}

export function subagentInvocationStatus(status: SubagentInvocationNode['status']): DisplayAgentToolStatus {
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'timed_out') return 'error'
  if (status === 'cancelled' || status === 'interrupted') return 'stopped'
  if (status === 'running') return 'running'
  return 'pending'
}

/**
 * 子代理展示名：父是本 run 直接挂「名字」；父是另一条调用（子代理调子代理）
 * 沿父链回溯拼成 "Slides Planner → Slides Builder"，箭头指向被调方。
 */
export function subagentChainLabel(
  invocation: SubagentInvocationNode,
  byId: Map<string, SubagentInvocationNode>,
  rootRunId: string,
): string {
  const chain = [invocation.agentName]
  const visited = new Set([invocation.id])
  let cursor = invocation
  while (cursor.parentRunId && cursor.parentRunId !== rootRunId && !visited.has(cursor.parentRunId)) {
    const parent = byId.get(cursor.parentRunId)
    if (!parent) break
    visited.add(parent.id)
    chain.unshift(parent.agentName)
    cursor = parent
  }
  return chain.join(' → ')
}

/**
 * 调度类工具（agent_dispatch / content_analysis / document_analysis）的结果
 * details 里带回它创建的子调用 id；该调用已作为子代理行展示时工具行不再重复。
 */
export function dispatchedInvocationId(tool: DisplayAgentToolCall): string | undefined {
  const record = tool.result ?? tool.partialResult
  if (!record || typeof record !== 'object') return undefined
  const details = (record as { details?: unknown }).details
  if (!details || typeof details !== 'object') return undefined
  const id = (details as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}

/** 工具步骤与子代理行按发生时间归并成一条竖直时间线（V8 sort 稳定，同刻保持原序）。 */
export function buildTimelineRows(
  steps: AgentActivityStep[],
  invocations: SubagentInvocationNode[],
  rootRunId: string,
): TimelineRow[] {
  const byId = new Map(invocations.map((invocation) => [invocation.id, invocation]))
  const rows: TimelineRow[] = (byId.size
    ? steps.filter((step) => {
      const invocationId = dispatchedInvocationId(step.tool)
      return !invocationId || !byId.has(invocationId)
    })
    : steps
  ).map((step) => ({
    kind: 'tool' as const,
    key: step.id,
    at: Date.parse(step.tool.startedAt) || 0,
    step,
  }))
  for (const invocation of invocations) {
    rows.push({
      kind: 'subagent',
      key: `subagent-${invocation.id}`,
      at: Date.parse(invocation.startedAt ?? invocation.createdAt) || 0,
      subagent: {
        id: invocation.id,
        label: subagentChainLabel(invocation, byId, rootRunId),
        task: invocation.task,
        status: subagentInvocationStatus(invocation.status),
        startedAt: invocation.startedAt,
        completedAt: invocation.completedAt,
        errorMessage: invocation.errorMessage ?? (invocation.errorCode ? `错误码 ${invocation.errorCode}` : null),
        contextUsage: invocation.contextUsage ?? null,
        contextCompacting: invocation.contextCompacting === true,
      },
    })
  }
  return rows.sort((left, right) => left.at - right.at)
}

/**
 * 一次子代理调用的工具流折叠：过滤 tool.* 事件按 seq 递增喂入
 * mergeAgentToolEvent（runId 适配为 invocationId，仅作行标识用）。
 * 子代理与主 run 同一套运行时事件结构，折叠逻辑与主时间线完全一致。
 */
export function foldSubagentToolEvents(
  tools: DisplayAgentToolCall[],
  invocationId: string,
  events: SubagentInvocationEvent[],
): DisplayAgentToolCall[] {
  let next = tools
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (!isToolEvent({ type: event.type } as AgentEvent)) continue
    next = mergeAgentToolEvent(next, {
      id: event.id,
      sessionId: '',
      runId: invocationId,
      seq: event.seq,
      type: event.type,
      occurredAt: event.occurredAt,
      payload: event.payload,
    })
  }
  return next
}

/** 全量归约：历史回放/测试用。 */
export function reduceSubagentInvocationTools(
  invocationId: string,
  events: SubagentInvocationEvent[],
): DisplayAgentToolCall[] {
  return foldSubagentToolEvents([], invocationId, events)
}

/** 会话级上下文状态：最新用量快照 + 是否处于压缩中（hydrate 重放与实时事件共用）。 */
export interface AgentContextState {
  usage: AgentContextUsage | null
  compacting: boolean
}

/**
 * 折叠 context.usage / context.compaction 事件。事件按 occurredAt 排序后
 * 「后到者胜」：用量取最新快照，压缩态取最新信号。跨 run 的事件序列号
 * 互不相干，故不用 seq 排序。
 */
export function reduceAgentContextState(events: AgentEvent[]): AgentContextState {
  const sorted = [...events].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
  const state: AgentContextState = { usage: null, compacting: false }
  for (const event of sorted) {
    if (event.type === 'context.usage') {
      const payload = event.payload as Partial<AgentContextUsage>
      if (typeof payload?.contextWindow === 'number' && payload.contextWindow > 0) {
        const segments = Array.isArray(payload.segments)
          ? payload.segments.filter((segment): segment is NonNullable<AgentContextUsage['segments']>[number] => (
            typeof segment?.key === 'string' && typeof segment?.tokens === 'number'
          ))
          : undefined
        state.usage = {
          tokens: typeof payload.tokens === 'number' ? payload.tokens : null,
          contextWindow: payload.contextWindow,
          percent: typeof payload.percent === 'number' ? payload.percent : null,
          ...(segments?.length ? { segments } : {}),
        }
      }
    } else if (event.type === 'context.compaction') {
      state.compacting = (event.payload as { active?: unknown }).active === true
    }
  }
  return state
}
