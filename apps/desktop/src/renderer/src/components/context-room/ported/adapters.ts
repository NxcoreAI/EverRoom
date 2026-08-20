import type { Translate } from '../../../i18n/LocaleContext'

type ClassValue = string | false | null | undefined | Record<string, boolean>

export function cn(...values: ClassValue[]) {
  return values
    .flatMap((value) => {
      if (!value) return []
      if (typeof value === 'string') return [value]
      return Object.entries(value).filter(([, enabled]) => enabled).map(([name]) => name)
    })
    .join(' ')
}

export function uiText(value?: string | null) {
  if (!value) return ''
  return CONTEXT_ROOM_DISPLAY_KEYS[value] ?? value
}

export function localizedUiText(value: string | null | undefined, t: Translate): string {
  if (!value) return ''
  const key = CONTEXT_ROOM_DISPLAY_KEYS[value]
  return key ? t(key) : value
}

const CONTEXT_ROOM_DISPLAY_KEYS: Record<string, string> = {
  '项目': 'contextRoom:display.project',
  '主题': 'contextRoom:display.topic',
  '人物': 'contextRoom:display.person',
  '长期目标': 'contextRoom:display.longTermGoal',
  '目标': 'contextRoom:display.longTermGoal',
  '议题': 'contextRoom:display.issue',
  '事件': 'contextRoom:display.event',
  '文档': 'contextRoom:display.document',
  '邮件': 'contextRoom:display.email',
  '会议': 'contextRoom:display.meeting',
  '文件': 'contextRoom:display.file',
  'Room': 'contextRoom:display.room',
  '候选': 'contextRoom:display.candidate',
  '未开始': 'contextRoom:display.notStarted',
  '进行中': 'contextRoom:display.inProgress',
  '待确认': 'contextRoom:display.pendingConfirmation',
  '已确认': 'contextRoom:display.confirmed',
  '已完成': 'contextRoom:display.completed',
  '已归档': 'contextRoom:display.archived',
  '已禁用': 'contextRoom:display.disabled',
  'AI 处理过': 'contextRoom:display.aiProcessed',
  '已发布': 'contextRoom:display.published',
  '编辑中': 'contextRoom:display.editing',
  '已索引': 'contextRoom:display.indexed',
  '人物偏好': 'contextRoom:display.personPreference',
  '项目结论': 'contextRoom:display.projectConclusion',
  '表达偏好': 'contextRoom:display.communicationPreference',
  '客户要求': 'contextRoom:display.customerRequirement',
  '云文档': 'contextRoom:display.cloudDocuments',
  'Office 文件': 'contextRoom:display.officeFiles',
  '设计与附件': 'contextRoom:display.designAndAttachments',
  '回收站': 'contextRoom:display.trash',
  '收件箱': 'contextRoom:display.inbox',
  '星标': 'contextRoom:display.starred',
  '已发送': 'contextRoom:display.sent',
  '归档': 'contextRoom:display.archive',
  '来源服务': 'contextRoom:display.sourceService',
  '账号': 'contextRoom:display.account',
  '同步状态': 'contextRoom:display.syncStatus',
  '写入权限': 'contextRoom:display.writePermission',
  '解析状态': 'contextRoom:display.parseStatus',
  '本地文件夹': 'contextRoom:display.localFolder',
  '会议纪要': 'contextRoom:display.meetingNotes',
  '已同步': 'contextRoom:display.synced',
  '可写': 'contextRoom:display.writable',
  '已解析': 'contextRoom:display.parsed',
  '已转写': 'contextRoom:display.transcribed',
  '负责人': 'contextRoom:display.owner',
  '截止日期': 'contextRoom:display.dueDate',
  '关联 Room': 'contextRoom:display.relatedRoom',
  'Agent 正在写入': 'contextRoom:display.agentWriting',
  'Agent 正在续写': 'contextRoom:display.agentContinuing',
  '正在审阅改动': 'contextRoom:display.reviewingChanges',
  '已保存': 'contextRoom:display.saved',
  '已保存草稿': 'contextRoom:display.draftSaved',
  '仅本次会话': 'contextRoom:display.thisSessionOnly',
  '版本冲突，草稿已保留': 'contextRoom:display.versionConflictDraftKept',
  '保存失败，草稿已保留': 'contextRoom:display.saveFailedDraftKept',
  '正在保存...': 'contextRoom:display.saving',
  '导入失败': 'contextRoom:display.importFailed',
  '流式写入失败': 'contextRoom:display.streamingWriteFailed',
  '删除失败，草稿已保留': 'contextRoom:display.deleteFailedDraftKept',
  '待补充 Room 的背景和资料范围。': 'contextRoom:portedContextRoom.defaultBackground',
  '明确目标并聚合相关资料。': 'contextRoom:portedContextRoom.defaultGoal',
  'Room 已创建，等待补充资料。': 'contextRoom:portedContextRoom.defaultBriefStatus',
}
