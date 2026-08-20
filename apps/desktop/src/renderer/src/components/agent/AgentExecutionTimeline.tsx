import {
  AlertCircle,
  Brain,
  CalendarDays,
  Check,
  ChevronRight,
  Circle,
  FileJson,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  Mail,
  Play,
  Plug,
  Search,
  Square,
  Terminal,
  Wrench,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocale, type Translate } from '@/i18n/LocaleContext'

import {
  agentToolCommand,
  agentToolLabel,
  agentToolResultSummary,
  agentToolStageText,
  agentToolSubject,
  type AgentRunActivity,
  type DisplayAgentToolCall,
} from './agentRunActivity'

type ToolKind = 'search' | 'memory' | 'file' | 'email' | 'calendar' | 'image' | 'command' | 'schema' | 'connector' | 'action' | 'other'

export function toolKind(name: string): ToolKind {
  const normalized = name.toLowerCase()
  if (normalized === 'connector_search') return 'search'
  if (normalized === 'connector_schema') return 'schema'
  if (normalized === 'connector_apps') return 'connector'
  if (normalized === 'connector_run') return 'action'
  if (/photo|image/.test(normalized)) return 'image'
  if (/calendar|scheduler/.test(normalized)) return 'calendar'
  if (/memory/.test(normalized)) return 'memory'
  if (/email|mail/.test(normalized)) return 'email'
  if (/search|web|fetch|browser/.test(normalized)) return 'search'
  if (/read|write|edit|patch|glob|grep|file|document/.test(normalized)) return 'file'
  if (/bash|command|terminal|shell/.test(normalized)) return 'command'
  return 'other'
}

function detailText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value.trim().slice(0, 12_000) || undefined
  try {
    return JSON.stringify(value, null, 2).slice(0, 12_000)
  } catch {
    return String(value)
  }
}

function durationMs(startedAt: string, completedAt: string | undefined, now: number): number {
  const start = Date.parse(startedAt)
  const end = completedAt ? Date.parse(completedAt) : now
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0
}

function formatDuration(duration: number, t: Translate): string {
  if (duration < 1_000) return t('surface:agentExecutionTimeline.1Sec')
  const seconds = Math.max(1, Math.round(duration / 1_000))
  if (seconds < 60) return t('surface:agentExecutionTimeline.countSec', { count: seconds })
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder
    ? t('surface:agentExecutionTimeline.minutesMinSecondsSec', { minutes, seconds: remainder })
    : t('surface:agentExecutionTimeline.countMin', { count: minutes })
}

function ToolIcon({ kind }: { kind: ToolKind }) {
  const Icon = {
    action: Play,
    calendar: CalendarDays,
    command: Terminal,
    connector: Plug,
    email: Mail,
    file: FileText,
    image: ImageIcon,
    memory: Brain,
    other: Wrench,
    schema: FileJson,
    search: Search,
  }[kind]
  return <Icon aria-hidden="true" />
}

function StatusIcon({ status }: { status: DisplayAgentToolCall['status'] }) {
  if (status === 'completed') return <Check aria-hidden="true" />
  if (status === 'error') return <AlertCircle aria-hidden="true" />
  if (status === 'stopped') return <Square aria-hidden="true" />
  if (status === 'running') return <LoaderCircle className="spin" aria-hidden="true" />
  return <Circle aria-hidden="true" />
}

function statusLabel(status: DisplayAgentToolCall['status'], t: Translate): string {
  if (status === 'completed') return t('surface:agentExecutionTimeline.completed')
  if (status === 'error') return t('surface:agentExecutionTimeline.failed')
  if (status === 'stopped') return t('surface:agentExecutionTimeline.stopped')
  if (status === 'running') return t('surface:agentExecutionTimeline.running')
  return t('surface:agentExecutionTimeline.waiting')
}

function localizeAgentActivityText(value: string | undefined, t: Translate): string | undefined {
  if (!value) return value
  const exactKeys: Record<string, string> = {
    '获取连接账户': 'surface:agentExecutionTimeline.getConnectedAccounts',
    '已获取连接账户': 'surface:agentExecutionTimeline.connectedAccountsRetrieved',
    '执行连接操作': 'surface:agentExecutionTimeline.runConnectorAction',
    '已执行连接操作': 'surface:agentExecutionTimeline.connectorActionExecuted',
    '查看操作要求': 'surface:agentExecutionTimeline.viewOperationRequirements',
    '已查看操作要求': 'surface:agentExecutionTimeline.operationRequirementsViewed',
    '查找可用操作': 'surface:agentExecutionTimeline.searchAvailableOperations',
    '已查找可用操作': 'surface:agentExecutionTimeline.availableOperationsFound',
    '准备创建选项': 'surface:agentExecutionTimeline.prepareCreationOptions',
    '已准备创建选项': 'surface:agentExecutionTimeline.creationOptionsPrepared',
    '获取文档列表': 'surface:agentExecutionTimeline.getDocumentList',
    '已获取文档列表': 'surface:agentExecutionTimeline.documentListRetrieved',
    '读取文档': 'surface:agentExecutionTimeline.readDocument',
    '已读取文档': 'surface:agentExecutionTimeline.documentRead',
    '获取 Room 列表': 'surface:agentExecutionTimeline.getRoomList',
    '已获取 Room 列表': 'surface:agentExecutionTimeline.roomListRetrieved',
    '准备文档修改': 'surface:agentExecutionTimeline.prepareDocumentChanges',
    '已准备文档修改': 'surface:agentExecutionTimeline.documentChangesPrepared',
    '提交文档修改': 'surface:agentExecutionTimeline.commitDocumentChanges',
    '已提交文档修改': 'surface:agentExecutionTimeline.documentChangesCommitted',
    '生成文档修改': 'surface:agentExecutionTimeline.generateDocumentChanges',
    '已生成文档修改': 'surface:agentExecutionTimeline.documentChangesGenerated',
    '写入文档内容': 'surface:agentExecutionTimeline.writeDocumentContent',
    '已写入文档内容': 'surface:agentExecutionTimeline.documentContentWritten',
    '开始创建文档': 'surface:agentExecutionTimeline.startDocumentCreation',
    '已开始创建文档': 'surface:agentExecutionTimeline.documentCreationStarted',
    '提交新文档': 'surface:agentExecutionTimeline.commitNewDocument',
    '已提交新文档': 'surface:agentExecutionTimeline.newDocumentCommitted',
    '选择所需工具': 'surface:agentExecutionTimeline.selectRequiredTool',
    '已选择所需工具': 'surface:agentExecutionTimeline.requiredToolSelected',
    '查看图像': 'surface:agentExecutionTimeline.viewImage',
    '已查看图像': 'surface:agentExecutionTimeline.imageViewed',
    '创建日程': 'surface:agentExecutionTimeline.createCalendarEvent',
    '已创建日程': 'surface:agentExecutionTimeline.calendarEventCreated',
    '查询日历': 'surface:agentExecutionTimeline.queryCalendar',
    '已查询日历': 'surface:agentExecutionTimeline.calendarQueried',
    '处理定时任务': 'surface:agentExecutionTimeline.handleScheduledTask',
    '已处理定时任务': 'surface:agentExecutionTimeline.scheduledTaskHandled',
    '查询个人记忆': 'surface:agentExecutionTimeline.queryMemory',
    '已查询个人记忆': 'surface:agentExecutionTimeline.memoryQueried',
    '同步邮件': 'surface:agentExecutionTimeline.syncEmail',
    '已同步邮件': 'surface:agentExecutionTimeline.emailSynced',
    '查询邮件': 'surface:agentExecutionTimeline.queryEmail',
    '已查询邮件': 'surface:agentExecutionTimeline.emailQueried',
    '查询会议': 'surface:agentExecutionTimeline.queryMeeting',
    '已查询会议': 'surface:agentExecutionTimeline.meetingQueried',
    '查询日记': 'surface:agentExecutionTimeline.queryDiary',
    '已查询日记': 'surface:agentExecutionTimeline.diaryQueried',
    '搜索网页': 'surface:agentExecutionTimeline.searchWeb',
    '已搜索网页': 'surface:agentExecutionTimeline.webSearched',
    '读取文件': 'surface:agentExecutionTimeline.readFile',
    '已读取文件': 'surface:agentExecutionTimeline.fileRead',
    '修改文件': 'surface:agentExecutionTimeline.modifyFile',
    '已修改文件': 'surface:agentExecutionTimeline.fileModified',
    '运行命令': 'surface:agentExecutionTimeline.runCommand',
    '已运行命令': 'surface:agentExecutionTimeline.commandRun',
    '已调用工具': 'surface:agentExecutionTimeline.toolCalled',
    '调用工具': 'surface:agentExecutionTimeline.callTool',
  }
  const exactKey = exactKeys[value]
  if (exactKey) return t(exactKey)
  const documentRead = /^《(.+)》当前有 (\d+) 个可编辑内容块，基于版本 (\d+) 处理。$/.exec(value)
  if (documentRead) {
    return t('surface:agentExecutionTimeline.titleHasCountEditableBlocksAndWillBe', {
      title: documentRead[1]!, count: documentRead[2]!, version: documentRead[3]!,
    })
  }
  const changeScope = /^修改范围已确定：(.+?)[。！!？?]?$/.exec(value)
  if (changeScope) return t('surface:agentExecutionTimeline.changeScopeConfirmedSummary', { summary: changeScope[1]! })
  const itemChange = /^第 (\d+) 项为(新增内容|替换内容|删除内容|文档修改)(?:，建议内容 (\d+) 字)?。$/.exec(value)
  if (itemChange) {
    const actionKeys: Record<string, string> = {
      新增内容: 'surface:agentExecutionTimeline.insertContent',
      替换内容: 'surface:agentExecutionTimeline.replaceContent',
      删除内容: 'surface:agentExecutionTimeline.deleteContent',
      文档修改: 'surface:agentExecutionTimeline.documentChange',
    }
    const action = t(actionKeys[itemChange[2]!] ?? 'surface:agentExecutionTimeline.documentChange')
    return itemChange[3]
      ? t('surface:agentExecutionTimeline.itemSequenceIsActionWithCountCharactersOf', { sequence: itemChange[1]!, action, count: itemChange[3]! })
      : t('surface:agentExecutionTimeline.itemSequenceIsAction', { sequence: itemChange[1]!, action })
  }
  if (value === '工具调用失败' || value === '工具调用失败。') return t('surface:agentExecutionTimeline.failed')
  if (value === '操作已停止。' || value === '操作已停止') return t('surface:agentExecutionTimeline.stopped')
  const resultCount = /^获得 (\d+) 条结果$/.exec(value)
  if (resultCount) return t('surface:agentExecutionTimeline.countResults', { count: resultCount[1]! })
  const executed = /^已执行\s+(.+)$/u.exec(value)
  if (executed) return t('surface:agentExecutionTimeline.executedName', { name: executed[1]! })
  const executing = /^执行\s+(.+)$/u.exec(value)
  if (executing) return t('surface:agentExecutionTimeline.executingName', { name: executing[1]! })
  return value
}

export function AgentExecutionTimeline({
  activity,
  runStartedAt,
  runCompletedAt,
  continuing = false,
  continuationLabel = 'surface:agentExecutionTimeline.continuing',
}: {
  activity: AgentRunActivity
  runStartedAt?: string
  runCompletedAt?: string
  continuing?: boolean
  continuationLabel?: string
}) {
  const { t } = useLocale()
  const tools = activity.steps.map((step) => step.tool)
  const running = tools.some((tool) => tool.status === 'pending' || tool.status === 'running')
  const active = continuing || !runCompletedAt
  const summaryStarted = !continuing && Boolean(activity.pendingAnswer || activity.finalAnswer)
  const [expanded, setExpanded] = useState(active && !summaryStarted)
  const [now, setNow] = useState(Date.now())
  const wasActiveRef = useRef(active)
  const runKey = tools[0]?.runId ?? runStartedAt ?? ''
  const runKeyRef = useRef(runKey)
  const userCollapsedRef = useRef(false)
  const summaryStartedRef = useRef(summaryStarted)

  useEffect(() => {
    if (runKeyRef.current !== runKey) {
      runKeyRef.current = runKey
      userCollapsedRef.current = false
      summaryStartedRef.current = summaryStarted
      wasActiveRef.current = active
      setExpanded(active && !summaryStarted)
      return undefined
    }
    const wasActive = wasActiveRef.current
    wasActiveRef.current = active
    if (active) {
      if (!wasActive && !userCollapsedRef.current) setExpanded(true)
      return undefined
    }
    return undefined
  }, [active, runKey, summaryStarted])

  useEffect(() => {
    const wasSummaryStarted = summaryStartedRef.current
    if (!wasSummaryStarted && summaryStarted) setExpanded(false)
    if (wasSummaryStarted && !summaryStarted && active && !userCollapsedRef.current) setExpanded(true)
    summaryStartedRef.current = summaryStarted
  }, [active, summaryStarted])

  useEffect(() => {
    if (!active) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active])

  const totalDuration = useMemo(() => runStartedAt
    ? durationMs(runStartedAt, continuing ? undefined : runCompletedAt, now)
    : 0, [continuing, now, runCompletedAt, runStartedAt])

  if (!activity.hasTools) return null

  const failed = tools.some((tool) => tool.status === 'error')
  const stopped = tools.some((tool) => tool.status === 'stopped')
  const summary = continuing && !running
    ? t(continuationLabel)
    : active
      ? t('surface:agentExecutionTimeline.processing')
      : failed
        ? t('surface:agentExecutionTimeline.processingFailed')
        : stopped
          ? t('surface:agentExecutionTimeline.stopped')
          : t('surface:agentExecutionTimeline.processed')

  return (
    <section className="agent-execution" data-running={String(active)} data-expanded={String(expanded)}>
      <button
        type="button"
        className="agent-execution-summary"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((current) => {
            userCollapsedRef.current = current
            return !current
          })
        }}
      >
        {active ? <LoaderCircle className="spin" aria-hidden="true" /> : <Wrench aria-hidden="true" />}
        <strong>{summary}</strong>
        <span>{totalDuration ? formatDuration(totalDuration, t) : ''}</span>
        <ChevronRight className="agent-execution-chevron" aria-hidden="true" />
      </button>
      <div
        className="agent-execution-region"
        aria-hidden={!expanded}
        {...(!expanded ? { inert: '' } : {})}
      >
        <div>
          <div className="agent-tool-list">
            {activity.steps.map((step) => {
              const tool = step.tool
              const summaryText = localizeAgentActivityText(agentToolResultSummary(tool.result ?? tool.partialResult), t)
              const subject = agentToolSubject(tool)
              const preview = subject ?? summaryText ?? tool.error
              const duration = durationMs(tool.startedAt, tool.completedAt, now)
              const command = agentToolCommand(tool)
              const args = Object.keys(tool.args).length ? detailText(tool.args) : undefined
              const result = detailText(tool.result ?? tool.partialResult)
              const label = localizeAgentActivityText(agentToolLabel(tool), t) ?? agentToolLabel(tool)
              const beforeText = localizeAgentActivityText(step.beforeText, t)
              const stageText = localizeAgentActivityText(step.afterText || agentToolStageText(tool), t)
              return (
                <div key={step.id} className="agent-tool-step" data-status={tool.status}>
                  {beforeText ? <p className="agent-activity-commentary">{beforeText}</p> : null}
                  <details className="agent-tool-row" data-status={tool.status}>
                    <summary className="agent-tool-command" title={preview ? `${label} ${preview}` : label}>
                      <span className="agent-tool-rail" aria-hidden="true"><ToolIcon kind={toolKind(tool.name)} /></span>
                      <span className="agent-tool-command-text">
                        <strong>{label}</strong>
                        {preview ? <span>{preview}</span> : null}
                      </span>
                      <span className="agent-tool-status" title={statusLabel(tool.status, t)}>
                        <StatusIcon status={tool.status} />
                      </span>
                      <ChevronRight className="agent-tool-chevron" aria-hidden="true" />
                    </summary>
                    <div className="agent-tool-details">
                      <div>
                        <div className="agent-tool-meta">
                          <code>{tool.name}</code>
                          <span>{statusLabel(tool.status, t)} · {formatDuration(duration, t)}</span>
                        </div>
                        {tool.error ? <p className="agent-tool-error">{tool.error}</p> : null}
                        {command ? <><small>{t('surface:agentExecutionTimeline.command')}</small><pre>{command}</pre></> : null}
                        {!command && args ? <><small>{t('surface:agentExecutionTimeline.arguments')}</small><pre>{args}</pre></> : null}
                        {result ? <><small>{t('surface:agentExecutionTimeline.result')}</small><pre>{result}</pre></> : null}
                        {!command && !args && !result && !tool.error ? <p>{t('surface:agentExecutionTimeline.noAdditionalDetails')}</p> : null}
                      </div>
                    </div>
                  </details>
                  {stageText ? <p className="agent-tool-stage" data-status={tool.status}>{stageText}</p> : null}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
