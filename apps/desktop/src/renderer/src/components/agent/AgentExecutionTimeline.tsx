import {
  AlertCircle,
  Brain,
  CalendarDays,
  Check,
  ChevronRight,
  Circle,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  Mail,
  Search,
  Square,
  Terminal,
  Wrench,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  agentToolCommand,
  agentToolLabel,
  agentToolResultSummary,
  agentToolStageText,
  agentToolSubject,
  type AgentRunActivity,
  type DisplayAgentToolCall,
} from './agentRunActivity'

type ToolKind = 'search' | 'memory' | 'file' | 'email' | 'calendar' | 'image' | 'command' | 'other'

function toolKind(name: string): ToolKind {
  const normalized = name.toLowerCase()
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

function formatDuration(duration: number): string {
  if (duration < 1_000) return '<1 秒'
  const seconds = Math.max(1, Math.round(duration / 1_000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分`
}

function ToolIcon({ kind }: { kind: ToolKind }) {
  const Icon = {
    calendar: CalendarDays,
    command: Terminal,
    email: Mail,
    file: FileText,
    image: ImageIcon,
    memory: Brain,
    other: Wrench,
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

function statusLabel(status: DisplayAgentToolCall['status']): string {
  if (status === 'completed') return '已完成'
  if (status === 'error') return '失败'
  if (status === 'stopped') return '已停止'
  if (status === 'running') return '执行中'
  return '等待中'
}

export function AgentExecutionTimeline({
  activity,
  reasoning,
  runStartedAt,
  runCompletedAt,
  continuing = false,
  continuationLabel = '正在继续处理',
}: {
  activity: AgentRunActivity
  reasoning?: string
  runStartedAt?: string
  runCompletedAt?: string
  continuing?: boolean
  continuationLabel?: string
}) {
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
    ? continuationLabel
    : active
      ? '正在处理'
      : failed
        ? '处理失败'
        : stopped
          ? '已停止'
          : '已处理'

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
        <span>{totalDuration ? formatDuration(totalDuration) : ''}</span>
        <ChevronRight className="agent-execution-chevron" aria-hidden="true" />
      </button>
      <div
        className="agent-execution-region"
        aria-hidden={!expanded}
        {...(!expanded ? { inert: '' } : {})}
      >
        <div>
          <div className="agent-tool-list">
            {reasoning ? (
              <details className="agent-execution-reasoning">
                <summary><Brain aria-hidden="true" />思考过程</summary>
                <p>{reasoning}</p>
              </details>
            ) : null}
            {activity.steps.map((step) => {
              const tool = step.tool
              const summaryText = agentToolResultSummary(tool.result ?? tool.partialResult)
              const subject = agentToolSubject(tool)
              const preview = subject ?? summaryText ?? tool.error
              const duration = durationMs(tool.startedAt, tool.completedAt, now)
              const command = agentToolCommand(tool)
              const args = Object.keys(tool.args).length ? detailText(tool.args) : undefined
              const result = detailText(tool.result ?? tool.partialResult)
              const label = agentToolLabel(tool)
              const stageText = step.afterText || agentToolStageText(tool)
              return (
                <div key={step.id} className="agent-tool-step" data-status={tool.status}>
                  {step.beforeText ? <p className="agent-activity-commentary">{step.beforeText}</p> : null}
                  <details className="agent-tool-row" data-status={tool.status}>
                    <summary className="agent-tool-command" title={preview ? `${label} ${preview}` : label}>
                      <span className="agent-tool-rail" aria-hidden="true"><ToolIcon kind={toolKind(tool.name)} /></span>
                      <span className="agent-tool-command-text">
                        <strong>{label}</strong>
                        {preview ? <span>{preview}</span> : null}
                      </span>
                      <span className="agent-tool-status" title={statusLabel(tool.status)}>
                        <StatusIcon status={tool.status} />
                      </span>
                      <ChevronRight className="agent-tool-chevron" aria-hidden="true" />
                    </summary>
                    <div className="agent-tool-details">
                      <div>
                        <div className="agent-tool-meta">
                          <code>{tool.name}</code>
                          <span>{statusLabel(tool.status)} · {formatDuration(duration)}</span>
                        </div>
                        {tool.error ? <p className="agent-tool-error">{tool.error}</p> : null}
                        {command ? <><small>命令</small><pre>{command}</pre></> : null}
                        {!command && args ? <><small>参数</small><pre>{args}</pre></> : null}
                        {result ? <><small>结果</small><pre>{result}</pre></> : null}
                        {!command && !args && !result && !tool.error ? <p>暂无更多详情</p> : null}
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
