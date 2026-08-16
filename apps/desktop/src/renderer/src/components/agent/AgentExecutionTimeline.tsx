import {
  AlertCircle,
  Brain,
  CalendarDays,
  Check,
  ChevronDown,
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

import type { DisplayAgentToolCall } from './useAgentSession'

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

function toolLabel(tool: DisplayAgentToolCall): string {
  const name = tool.name.toLowerCase()
  if (name === 'tool_search') return tool.status === 'completed' ? '已选择所需工具' : '选择所需工具'
  if (/photo|image/.test(name)) return '搜索图片'
  if (/calendar/.test(name)) return /create|add/.test(name) ? '创建日程' : '查询日历'
  if (/scheduler/.test(name)) return '管理定时任务'
  if (/memory/.test(name)) return '查询个人记忆'
  if (/email|mail/.test(name)) return /sync/.test(name) ? '同步邮件' : '查询邮件'
  if (/meeting/.test(name)) return '查询会议'
  if (/diary/.test(name)) return '查询日记'
  if (/search|web/.test(name)) return '搜索网页'
  if (/read/.test(name)) return '读取文件'
  if (/write|edit|patch/.test(name)) return '修改文件'
  if (/bash|command|terminal|shell/.test(name)) return '执行命令'
  return tool.name.replace(/[_-]+/g, ' ').trim() || '调用工具'
}

function userText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text || text.startsWith('{') || text.startsWith('[')) return undefined
  return text.slice(0, 160)
}

function toolSubject(tool: DisplayAgentToolCall): string | undefined {
  for (const key of ['query', 'search_query', 'keyword', 'prompt', 'path', 'filePath', 'title', 'url']) {
    const value = userText(tool.args[key])
    if (value) return value
  }
  return undefined
}

function resultSummary(result: unknown): string | undefined {
  if (!result) return undefined
  if (typeof result === 'string') {
    try {
      return resultSummary(JSON.parse(result))
    } catch {
      return result.trim().slice(0, 160) || undefined
    }
  }
  if (typeof result !== 'object' || Array.isArray(result)) return undefined
  const record = result as Record<string, unknown>
  for (const key of ['results', 'items', 'messages', 'events', 'photos']) {
    if (Array.isArray(record[key])) return `获得 ${record[key].length} 条结果`
  }
  for (const key of ['summary', 'message', 'title']) {
    const value = userText(record[key])
    if (value) return value
  }
  return undefined
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
  return `${Math.max(1, Math.round(duration / 1_000))} 秒`
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
  tools,
  runStartedAt,
  runCompletedAt,
}: {
  tools: DisplayAgentToolCall[]
  runStartedAt?: string
  runCompletedAt?: string
}) {
  const running = tools.some((tool) => tool.status === 'pending' || tool.status === 'running')
  const [expanded, setExpanded] = useState(running)
  const [now, setNow] = useState(Date.now())
  const wasRunningRef = useRef(running)

  useEffect(() => {
    const wasRunning = wasRunningRef.current
    wasRunningRef.current = running
    if (running) {
      setExpanded(true)
      return undefined
    }
    if (!wasRunning) return undefined
    const timer = window.setTimeout(() => setExpanded(false), 600)
    return () => window.clearTimeout(timer)
  }, [running])

  useEffect(() => {
    if (!running) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [running])

  const totalDuration = useMemo(() => runStartedAt
    ? durationMs(runStartedAt, runCompletedAt, now)
    : 0, [now, runCompletedAt, runStartedAt])

  if (tools.length === 0) return null

  return (
    <section className="agent-execution" data-running={String(running)} data-expanded={String(expanded)}>
      <button
        type="button"
        className="agent-execution-summary"
        aria-expanded={expanded}
        onClick={() => {
          if (!running) setExpanded((current) => !current)
        }}
      >
        <ChevronDown aria-hidden="true" />
        <span className="agent-execution-pulse" aria-hidden="true" />
        <strong>{running ? '正在执行' : `已执行 ${tools.length} 个操作`}</strong>
        <span>{totalDuration ? formatDuration(totalDuration) : ''}</span>
      </button>
      <div
        className="agent-execution-region"
        aria-hidden={!expanded}
        {...(!expanded ? { inert: '' } : {})}
      >
        <div>
          <div className="agent-tool-list">
            {tools.map((tool) => {
              const summary = resultSummary(tool.result ?? tool.partialResult)
              const subject = toolSubject(tool)
              const duration = durationMs(tool.startedAt, tool.completedAt, now)
              const args = Object.keys(tool.args).length ? detailText(tool.args) : undefined
              const result = detailText(tool.result ?? tool.partialResult)
              return (
                <article key={tool.id} className="agent-tool-row" data-status={tool.status}>
                  <span className="agent-tool-rail" aria-hidden="true"><ToolIcon kind={toolKind(tool.name)} /></span>
                  <div className="agent-tool-content">
                    <div className="agent-tool-heading">
                      <strong>{toolLabel(tool)}</strong>
                      <span className="agent-tool-status"><StatusIcon status={tool.status} />{statusLabel(tool.status)}</span>
                    </div>
                    {subject ? <span className="agent-tool-subject">“{subject}”</span> : null}
                    {summary ? <span className="agent-tool-result">{summary}</span> : null}
                    {tool.error ? <span className="agent-tool-error">{tool.error}</span> : null}
                    <span className="agent-tool-duration">{formatDuration(duration)}</span>
                    {args || result ? (
                      <details className="agent-tool-details">
                        <summary>查看详情</summary>
                        {args ? <><small>参数</small><pre>{args}</pre></> : null}
                        {result ? <><small>结果</small><pre>{result}</pre></> : null}
                      </details>
                    ) : null}
                  </div>
                </article>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
