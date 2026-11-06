import {
  AlertCircle,
  Bot,
  CalendarDays,
  Check,
  ChevronRight,
  Circle,
  FileJson,
  FileText,
  Image as ImageIcon,
  Lightbulb,
  ListTodo,
  LoaderCircle,
  Mail,
  Play,
  Plug,
  Presentation,
  Search,
  Square,
  Terminal,
  Wrench,
} from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale, type Translate } from '@/i18n/LocaleContext'

import { ReasoningBlock } from './ReasoningBlock'
import { noOpCommandSummary } from './noopToolCall'
import {
  agentToolCommand,
  agentToolKind,
  agentToolLabel,
  agentToolResultSummary,
  agentToolStageText,
  agentToolSubject,
  buildTimelineRows,
  dispatchedInvocationId,
  type AgentRunActivity,
  type AgentSubagentStep,
  type AgentToolKind,
  type DisplayAgentToolCall,
  type TimelineRow,
} from './agentRunActivity'
import { ContextUsageRing } from './contextUsageRing'
import { LocalAgentDispatchCard } from './LocalAgentDispatchCard'
import { useRunSubagentInvocations } from './useRunSubagentInvocations'
import { useSubagentInvocationTools } from './useSubagentInvocationTools'

type ToolKind = AgentToolKind

/** 图标分类与 agentToolLabel 共用同一张显式工具名映射表；未知工具返回 other。 */
export function toolKind(name: string): ToolKind {
  return agentToolKind(name)
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
    agent: Bot,
    analysis: Lightbulb,
    calendar: CalendarDays,
    command: Terminal,
    connector: Plug,
    document: FileText,
    email: Mail,
    file: FileText,
    image: ImageIcon,
    other: Wrench,
    schema: FileJson,
    search: Search,
    slides: Presentation,
    task: ListTodo,
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
    '获取 Room 列表': 'surface:agentExecutionTimeline.getRoomList',
    '已获取 Room 列表': 'surface:agentExecutionTimeline.roomListRetrieved',
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

/** 活跃时间线每秒随 duration 计时器、每次父级渲染帧都会整表重渲染；结果字符串
 * 可能是大 JSON（agentToolResultSummary 每次要 JSON.parse），按工具对象+语言缓存。 */
const toolSummaryCache = new WeakMap<object, { locale: string; value: string | undefined }>()

function toolSummaryText(tool: DisplayAgentToolCall, locale: string, t: Translate): string | undefined {
  const cached = toolSummaryCache.get(tool)
  if (cached && cached.locale === locale) return cached.value
  const value = localizeAgentActivityText(agentToolResultSummary(tool.result ?? tool.partialResult, t), t)
  toolSummaryCache.set(tool, { locale, value })
  return value
}

/** 单个工具行（收起态一行摘要，展开看参数/结果）。顶层与子代理嵌套列表复用。 */
function ToolRow({ tool, now, sessionId }: { tool: DisplayAgentToolCall; now: number; sessionId?: string | null }) {
  const { t, locale } = useLocale()
  const summaryText = toolSummaryText(tool, locale, t)
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
  // 子代理自己的上下文圆环：数字收在 title 里，与对话区 composer 同一套文案。
  const contextTitle = sub.contextCompacting
    ? t('surface:agentComposer.contextCompacting')
    : sub.contextUsage?.contextWindow
      ? t('surface:agentComposer.contextUsageTitle', {
        used: sub.contextUsage.tokens === null ? '—' : sub.contextUsage.tokens.toLocaleString(),
        total: sub.contextUsage.contextWindow.toLocaleString(),
        percent: sub.contextUsage.percent === null ? '—' : Math.round(sub.contextUsage.percent),
      })
      : undefined

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
            <ContextUsageRing
              usage={sub.contextUsage}
              compacting={sub.contextCompacting}
              title={contextTitle}
              inline
            />
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

/**
 * 时间线随对话区每个流式渲染帧都会被父级重渲染；memo 按属性拦截——历史 run 的
 * activity/timing 引用稳定，只有活跃 run 真正重算。props 全为值/稳定引用。
 */
export const AgentExecutionTimeline = memo(function AgentExecutionTimeline({
  activity,
  runStartedAt,
  runCompletedAt,
  continuing = false,
  continuationLabel = 'surface:agentExecutionTimeline.continuing',
  sessionId,
  failedRunIds,
}: {
  activity: AgentRunActivity
  runStartedAt?: string
  runCompletedAt?: string
  continuing?: boolean
  continuationLabel?: string
  sessionId?: string | null
  /** 网关判定为 run.failed 的 runId 集合：权威的失败口径（不传则退回"最后一步是否报错"）。 */
  failedRunIds?: ReadonlySet<string> | undefined
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

  // 失败口径以 run 的终态为准：run.failed 才算处理失败。中途的失败重试（工具参数
  // 校验、工作表名猜错后改对…）后续步骤已经补齐，不能把整轮标成失败——那会和
  // run 的 completed 状态、以及助手的最终结论自相矛盾。没有 run 终态信息时退回
  // "最后一步是否报错"的近似判断。失败明细仍留在展开后的时间线里。
  const failed = failedRunIds
    ? runId !== undefined && failedRunIds.has(runId)
    : tools.length > 0 && tools[tools.length - 1]!.status === 'error'
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
              if (row.kind === 'repeat') {
                // 同一工具连续调用多次（典型：一格一次地改 Excel）折叠成一行，
                // 展开能看到每次的对象，不用被同一行刷屏。
                const first = row.steps[0]!.tool
                const label = agentToolLabel(first, true, t)
                return (
                  <details key={row.key} className="agent-tool-step agent-noop-group" data-status="completed">
                    <summary className="agent-noop-summary">
                      {t('surface:agentExecutionTimeline.repeatCalls', { count: row.count, name: label })}
                    </summary>
                    <ul className="agent-noop-list">
                      {row.steps.map((step) => (
                        <li key={step.id}>
                          <code>{agentToolSubject(step.tool) ?? step.tool.name}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                )
              }
              if (row.kind === 'noop') {
                // 空转折叠行：默认一行摘要，展开才看每次打点的命令（原生 details，无需状态）。
                return (
                  <details key={row.key} className="agent-tool-step agent-noop-group" data-status="completed">
                    <summary className="agent-noop-summary">
                      {t('surface:agentExecutionTimeline.noopFolded', { count: row.count })}
                    </summary>
                    <ul className="agent-noop-list">
                      {row.steps.map((step) => (
                        <li key={step.id}><code>{noOpCommandSummary(step.tool.args)}</code></li>
                      ))}
                    </ul>
                  </details>
                )
              }
              const step = row.step
              const beforeText = localizeAgentActivityText(step.beforeText, t)
              const stageText = localizeAgentActivityText(step.afterText || agentToolStageText(step.tool, t), t)
              return (
                <div key={step.id} className="agent-tool-step" data-status={step.tool.status}>
                  {beforeText ? <p className="agent-activity-commentary">{beforeText}</p> : null}
                  <ReasoningBlock
                    variant="segment"
                    content={step.reasoningBefore}
                  />
                  <ToolRow tool={step.tool} now={now} sessionId={sessionId} />
                  {stageText ? <p className="agent-tool-stage" data-status={step.tool.status}>{stageText}</p> : null}
                </div>
              )
            })}
          </div>
        </div>
      </div>
      {/* 正在流动的未封段思考：放在折叠区域外——用户收起时间线也不打断阅读；
          shimmer 行实时滚动，下一个工具出现即被封段、收进上方某个 step 的静态折叠段。 */}
      {active && activity.liveReasoning ? (
        <ReasoningBlock variant="live" active content={activity.liveReasoning} />
      ) : null}
    </section>
  )
})
