import {
  AlertCircle,
  Bot,
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
  buildTimelineRows,
  dispatchedInvocationId,
  type AgentRunActivity,
  type AgentSubagentStep,
  type DisplayAgentToolCall,
  type TimelineRow,
} from './agentRunActivity'
import { LocalAgentDispatchCard } from './LocalAgentDispatchCard'
import { useRunSubagentInvocations } from './useRunSubagentInvocations'
import { useSubagentInvocationTools } from './useSubagentInvocationTools'

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

const detailTextCache = new WeakMap<object, string | undefined>()

/** 大结果 JSON.stringify(2 空格缩进) 开销不小，时间线每秒随 duration 计时器整表
 * 重渲染，按对象身份缓存；终态工具的 args/result 不再变化，缓存长期有效。 */
function detailTextCached(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return detailText(value)
  if (detailTextCache.has(value)) return detailTextCache.get(value)
  const computed = detailText(value)
  detailTextCache.set(value, computed)
  return computed
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

export function localizeAgentActivityText(value: string | undefined, t: Translate): string | undefined {
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
    '搜索知识库': 'surface:agentExecutionTimeline.searchWiki',
    '已搜索知识库': 'surface:agentExecutionTimeline.wikiSearched',
    '读取知识库页面': 'surface:agentExecutionTimeline.readWikiPage',
    '已读取知识库页面': 'surface:agentExecutionTimeline.wikiPageRead',
    '检索历史对话': 'surface:agentExecutionTimeline.searchConversations',
    '已检索历史对话': 'surface:agentExecutionTimeline.conversationsSearched',
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
  // Tool names are not translated, but the surrounding status verb must follow the UI locale.
  const englishExecuted = /^Executed\s+(.+)$/u.exec(value)
  if (englishExecuted) return t('surface:agentExecutionTimeline.executedName', { name: englishExecuted[1]! })
  const englishExecuting = /^Executing\s+(.+)$/u.exec(value)
  if (englishExecuting) return t('surface:agentExecutionTimeline.executingName', { name: englishExecuting[1]! })
  return value
}

/** 单个工具行（收起态一行摘要，展开看参数/结果）。顶层与子代理嵌套列表复用。 */
function ToolRow({ tool, now, sessionId }: { tool: DisplayAgentToolCall; now: number; sessionId?: string | null }) {
  const { t } = useLocale()
  const summaryText = localizeAgentActivityText(agentToolResultSummary(tool.result ?? tool.partialResult, t), t)
  const subject = agentToolSubject(tool)
  const preview = subject ?? summaryText ?? tool.error
  const duration = durationMs(tool.startedAt, tool.completedAt, now)
  const command = agentToolCommand(tool)
  const args = Object.keys(tool.args).length ? detailTextCached(tool.args) : undefined
  const result = detailTextCached(tool.result ?? tool.partialResult)
  const label = agentToolLabel(tool, tool.status === 'completed', t)
  return (
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
          {tool.error ? <p className="agent-tool-error">{localizeAgentActivityText(tool.error, t)}</p> : null}
          {tool.name.toLowerCase() === 'local_agent_dispatch' ? (
            <LocalAgentDispatchCard tool={tool} sessionId={sessionId} />
          ) : (
            <>
              {command ? <><small>{t('surface:agentExecutionTimeline.command')}</small><pre>{command}</pre></> : null}
              {!command && args ? <><small>{t('surface:agentExecutionTimeline.arguments')}</small><pre>{args}</pre></> : null}
              {result ? <><small>{t('surface:agentExecutionTimeline.result')}</small><pre>{result}</pre></> : null}
              {!command && !args && !result && !tool.error ? <p>{t('surface:agentExecutionTimeline.noAdditionalDetails')}</p> : null}
            </>
          )}
        </div>
      </div>
    </details>
  )
}

/**
 * 子代理行：展开后内嵌它自己的工具流（运行中自动展开、转终态自动收起；
 * 用户手动开合后不再自动管）。它再派发的子代理不嵌在这里——调用树统一
 * 在外层时间线平铺成「A → B」链式行，面板内只把自己的调度工具行去重掉。
 */
function SubagentRow({ sub, now, sessionId }: {
  sub: AgentSubagentStep
  now: number
  sessionId?: string | null
}) {
  const { t } = useLocale()
  const taskPreview = sub.task.trim().slice(0, 120) || undefined
  const duration = sub.startedAt ? durationMs(sub.startedAt, sub.completedAt ?? undefined, now) : null
  const running = sub.status === 'running' || sub.status === 'pending'
  const [open, setOpen] = useState(running)
  const userToggledRef = useRef(false)
  const runningRef = useRef(running)

  useEffect(() => {
    if (runningRef.current === running) return
    runningRef.current = running
    if (!userToggledRef.current) setOpen(running)
  }, [running])

  const tools = useSubagentInvocationTools(sub.id, running, open)
  // 拉子调用列表只为去重：调度类工具行对应的调用已在外层平铺展示。
  const childInvocations = useRunSubagentInvocations(sub.id, running)
  const childIds = useMemo(() => new Set(childInvocations.map((child) => child.id)), [childInvocations])
  const ownTools = tools.filter((tool) => {
    const invocationId = dispatchedInvocationId(tool)
    return !invocationId || !childIds.has(invocationId)
  })

  return (
    <div className="agent-tool-step" data-status={sub.status}>
      <details
        className="agent-tool-row"
        data-status={sub.status}
        data-kind="subagent"
        open={open}
        onToggle={(event) => {
          const next = (event.currentTarget as HTMLDetailsElement).open
          setOpen(next)
          userToggledRef.current = true
        }}
      >
        <summary className="agent-tool-command" title={taskPreview ? `${sub.label} ${taskPreview}` : sub.label}>
          <span className="agent-tool-rail" aria-hidden="true"><Bot aria-hidden="true" /></span>
          <span className="agent-tool-command-text">
            <strong>{sub.label}</strong>
            {running
              ? taskPreview ? <span>{taskPreview}</span> : null
              : duration !== null ? <span>{formatDuration(duration, t)}</span> : null}
          </span>
          <span className="agent-tool-status" title={statusLabel(sub.status, t)}>
            <StatusIcon status={sub.status} />
          </span>
          <ChevronRight className="agent-tool-chevron" aria-hidden="true" />
        </summary>
        <div className="agent-tool-details">
          <div>
            <div className="agent-tool-meta">
              <span>{statusLabel(sub.status, t)}{duration !== null ? ` · ${formatDuration(duration, t)}` : ''}</span>
            </div>
            {sub.errorMessage ? <p className="agent-tool-error">{sub.errorMessage}</p> : null}
            {sub.task.trim() ? <><small>{t('surface:agentExecutionTimeline.subagentTask')}</small><pre>{sub.task}</pre></> : null}
            {open && ownTools.length ? (
              <div className="agent-subagent-tools">
                {ownTools.map((tool) => (
                  <ToolRow key={tool.id} tool={tool} now={now} sessionId={sessionId} />
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </details>
    </div>
  )
}

export function AgentExecutionTimeline({
  activity,
  runStartedAt,
  runCompletedAt,
  continuing = false,
  continuationLabel = 'surface:agentExecutionTimeline.continuing',
  sessionId,
}: {
  activity: AgentRunActivity
  runStartedAt?: string
  runCompletedAt?: string
  continuing?: boolean
  continuationLabel?: string
  sessionId?: string | null
}) {
  const { t } = useLocale()
  const tools = activity.steps.map((step) => step.tool)
  const running = tools.some((tool) => tool.status === 'pending' || tool.status === 'running')
  const active = continuing || !runCompletedAt
  const runId = tools[0]?.runId
  const subagentInvocations = useRunSubagentInvocations(runId, active)
  const rows = useMemo<TimelineRow[]>(
    () => buildTimelineRows(activity.steps, subagentInvocations, runId ?? ''),
    [activity.steps, runId, subagentInvocations],
  )
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
            {rows.map((row) => {
              if (row.kind === 'subagent') {
                return <SubagentRow key={row.key} sub={row.subagent} now={now} sessionId={sessionId} />
              }
              const step = row.step
              const beforeText = localizeAgentActivityText(step.beforeText, t)
              const stageText = localizeAgentActivityText(step.afterText || agentToolStageText(step.tool, t), t)
              return (
                <div key={step.id} className="agent-tool-step" data-status={step.tool.status}>
                  {beforeText ? <p className="agent-activity-commentary">{beforeText}</p> : null}
                  <ToolRow tool={step.tool} now={now} sessionId={sessionId} />
                  {stageText ? <p className="agent-tool-stage" data-status={step.tool.status}>{stageText}</p> : null}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
