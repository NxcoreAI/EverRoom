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
  const generatedDocumentSource = /^来自《(.+)》$/u.exec(value)
  if (generatedDocumentSource) {
    return t('contextRoom:display.fromDocument', { title: generatedDocumentSource[1]! })
  }
  const editedContent = /^(.+)（已编辑）$/u.exec(value)
  if (editedContent) {
    return t('contextRoom:display.editedContent', { content: editedContent[1]! })
  }
  const timelineDocumentAdded = /^《(.+)》已收录于 Room$/u.exec(value)
  if (timelineDocumentAdded) {
    return t('contextRoom:display.timelineDocumentAdded', { title: timelineDocumentAdded[1]! })
  }
  const timelineDocumentUpdated = /^《(.+)》更新至第 (\d+) 版$/u.exec(value)
  if (timelineDocumentUpdated) {
    return t('contextRoom:display.timelineDocumentUpdated', {
      title: timelineDocumentUpdated[1]!,
      version: timelineDocumentUpdated[2]!,
    })
  }
  const timelineMeeting = /^会议《(.+)》$/u.exec(value)
  if (timelineMeeting) {
    return t('contextRoom:display.timelineMeeting', { title: timelineMeeting[1]! })
  }
  const timelineMeetingDetail = /^(\d+) 人参与，源自《(.+)》。$/u.exec(value)
  if (timelineMeetingDetail) {
    return t('contextRoom:display.timelineMeetingDetail', {
      count: timelineMeetingDetail[1]!,
      source: timelineMeetingDetail[2]!,
    })
  }
  const key = CONTEXT_ROOM_DISPLAY_KEYS[value]
  return key ? t(key) : value
}

/** Localizes Room kind values from both the persisted Chinese enum and older API aliases. */
export function localizedRoomKind(value: string | null | undefined, t: Translate): string {
  if (!value) return ''
  const aliases: Record<string, string> = {
    person: '人物',
    people: '人物',
    project: '项目',
    topic: '主题',
    goal: '长期目标',
    'long-term-goal': '长期目标',
    issue: '议题',
    event: '事件',
  }
  return localizedUiText(aliases[value.trim().toLowerCase()] ?? value, t)
}

/** The generated overview is the detail page's authoritative Room summary. */
export function localizedRoomSummary(
  background: string | null | undefined,
  generatedOverview: string | null | undefined,
  t: Translate,
): string {
  return localizedUiText(generatedOverview?.trim() || background, t)
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
  '关联对象': 'contextRoom:display.relatedObject',
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
  '待处理': 'contextRoom:display.pending',
  '未设置': 'contextRoom:display.notSet',
  '刚刚': 'contextRoom:display.justNow',
  '暂无': 'contextRoom:display.none',
  '待排期': 'contextRoom:display.toBeScheduled',
  '草稿': 'contextRoom:display.draft',
  '活跃': 'contextRoom:display.active',
  '陆远': 'contextRoom:objectDetail.defaultOwnerName',
  '当前 Room 关联实体': 'contextRoom:memory.currentRoomRelatedEntity',
  '已沉淀': 'contextRoom:wiki.captured',
  '用户确认·入库中': 'contextRoom:wiki.userConfirmedImporting',
  '归类中': 'contextRoom:wiki.classifying',
  '已撤销': 'contextRoom:wiki.reverted',
  '处理中': 'contextRoom:wiki.processing',
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
  'Room 已创建': 'contextRoom:display.timelineRoomCreated',
  '基于创建描述初始化，等待资料补充。': 'contextRoom:display.timelineRoomCreatedDetail',
  '文档内容已保存新版本。': 'contextRoom:display.timelineDocumentUpdatedDetail',
  '已作为资料归入本 Room，参与后续上下文生成。': 'contextRoom:display.timelineDocumentAddedDetail',
  '资料归类时判定为新主题，自动创建的 Room。': 'contextRoom:portedContextRoom.autoCreatedBackground',
  '确认归属并补充背景。': 'contextRoom:portedContextRoom.autoCreatedGoal',
  '自动创建，等待认领。': 'contextRoom:portedContextRoom.autoCreatedBriefStatus',
  '持续挂载的 Obsidian Vault，源文件始终保留在原目录。': 'contextRoom:portedContextRoom.obsidianVaultBackground',
  '在 EverRoom 中浏览、编辑并让 Agent 理解 Vault 内容。': 'contextRoom:portedContextRoom.obsidianVaultGoal',
}
