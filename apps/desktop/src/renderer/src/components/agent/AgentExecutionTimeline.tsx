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
  if (duration < 1_000) return t('<1 秒')
  const seconds = Math.max(1, Math.round(duration / 1_000))
  if (seconds < 60) return t('{count} 秒', { count: seconds })
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder
    ? t('{minutes} 分 {seconds} 秒', { minutes, seconds: remainder })
    : t('{count} 分', { count: minutes })
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
  if (status === 'completed') return t('已完成')
  if (status === 'error') return t('失败')
  if (status === 'stopped') return t('已停止')
  if (status === 'running') return t('执行中')
  return t('等待中')
}

function localizeAgentActivityText(value: string | undefined, t: Translate): string | undefined {
  if (!value) return value
  const trimmed = value.trim()
  const punctuation = trimmed.match(/[。.!！?？…]+$/u)?.[0] ?? ''
  const text = punctuation ? trimmed.slice(0, -punctuation.length).trimEnd() : trimmed
  let localized = t(text)

  let match = /^已执行\s+(.+)$/u.exec(text)
  if (match) localized = t('已执行 {name}', { name: match[1] })
  match = /^执行\s+(.+)$/u.exec(text)
  if (match) localized = t('执行 {name}', { name: match[1] })
  match = /^获得\s+(\d+)\s+条结果$/u.exec(text)
  if (match) localized = t('获得 {count} 条结果', { count: match[1] })
  match = /^《(.+)》当前有\s+(\d+)\s+个可编辑内容块，基于版本\s+(.+)\s+处理$/u.exec(text)
  if (match) {
    localized = t('《{title}》当前有 {count} 个可编辑内容块，基于版本 {version} 处理', {
      title: match[1],
      count: match[2],
      version: match[3],
    })
  }
  match = /^修改范围已确定：(.+)$/u.exec(text)
  if (match) localized = t('修改范围已确定：{summary}', { summary: match[1] })
  match = /^第\s+(\d+)\s+项为(新增内容|替换内容|删除内容|文档修改)，建议内容\s+(\d+)\s+字$/u.exec(text)
  if (match) {
    localized = t('第 {sequence} 项为{action}，建议内容 {count} 字', {
      sequence: match[1],
      action: t(match[2]),
      count: match[3],
    })
  }
  match = /^第\s+(\d+)\s+项为(新增内容|替换内容|删除内容|文档修改)$/u.exec(text)
  if (match) localized = t('第 {sequence} 项为{action}', { sequence: match[1], action: t(match[2]) })

  if (!punctuation) return localized
  const localizedPunctuation = localized === text
    ? punctuation
    : punctuation.replaceAll('。', '.').replaceAll('！', '!').replaceAll('？', '?')
  return `${localized}${localizedPunctuation}`
}

export function AgentExecutionTimeline({
  activity,
  runStartedAt,
  runCompletedAt,
  continuing = false,
  continuationLabel = '正在继续处理',
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
      ? t('正在处理')
      : failed
        ? t('处理失败')
        : stopped
          ? t('已停止')
          : t('已处理')

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
                        {command ? <><small>{t('命令')}</small><pre>{command}</pre></> : null}
                        {!command && args ? <><small>{t('参数')}</small><pre>{args}</pre></> : null}
                        {result ? <><small>{t('结果')}</small><pre>{result}</pre></> : null}
                        {!command && !args && !result && !tool.error ? <p>{t('暂无更多详情')}</p> : null}
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
