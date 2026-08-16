import {
  AlertCircle,
  Brain,
  CalendarDays,
  Check,
  ChevronDown,
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
  const done = tool.status === 'completed'
  if (name === 'tool_search') return tool.status === 'completed' ? '已选择所需工具' : '选择所需工具'
  if (/photo|image/.test(name)) return done ? '已查看图像' : '查看图像'
  if (/calendar/.test(name)) {
    if (/create|add/.test(name)) return done ? '已创建日程' : '创建日程'
    return done ? '已查询日历' : '查询日历'
  }
  if (/scheduler/.test(name)) return '管理定时任务'
  if (/memory/.test(name)) return done ? '已查询个人记忆' : '查询个人记忆'
  if (/email|mail/.test(name)) {
    if (/sync/.test(name)) return done ? '已同步邮件' : '同步邮件'
    return done ? '已查询邮件' : '查询邮件'
  }
  if (/meeting/.test(name)) return done ? '已查询会议' : '查询会议'
  if (/diary/.test(name)) return done ? '已查询日记' : '查询日记'
  if (/search|web/.test(name)) return done ? '已搜索网页' : '搜索网页'
  if (/read/.test(name)) return done ? '已读取文件' : '读取文件'
  if (/write|edit|patch/.test(name)) return done ? '已修改文件' : '修改文件'
  if (/bash|command|terminal|shell/.test(name)) return done ? '已运行命令' : '运行命令'
  return tool.name.replace(/[_-]+/g, ' ').trim() || '调用工具'
}

function userText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text || text.startsWith('{') || text.startsWith('[')) return undefined
  return text.slice(0, 600)
}

function toolSubject(tool: DisplayAgentToolCall): string | undefined {
  for (const key of [
    'command', 'cmd', 'script', 'code', 'input',
    'query', 'search_query', 'keyword', 'prompt', 'path', 'filePath', 'title', 'url',
  ]) {
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
  continuing = false,
  continuationLabel = '正在继续处理',
}: {
  tools: DisplayAgentToolCall[]
  runStartedAt?: string
  runCompletedAt?: string
  continuing?: boolean
  continuationLabel?: string
}) {
  const running = tools.some((tool) => tool.status === 'pending' || tool.status === 'running')
  const active = running || continuing
  const [expanded, setExpanded] = useState(active)
  const [now, setNow] = useState(Date.now())
  const wasActiveRef = useRef(active)

  useEffect(() => {
    const wasActive = wasActiveRef.current
    wasActiveRef.current = active
    if (active) {
      setExpanded(true)
      return undefined
    }
    if (!wasActive) return undefined
    const timer = window.setTimeout(() => setExpanded(false), 600)
    return () => window.clearTimeout(timer)
  }, [active])

  useEffect(() => {
    if (!active) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active])

  const totalDuration = useMemo(() => runStartedAt
    ? durationMs(runStartedAt, continuing ? undefined : runCompletedAt, now)
    : 0, [continuing, now, runCompletedAt, runStartedAt])

  if (tools.length === 0) return null

  return (
    <section className="agent-execution" data-running={String(active)} data-expanded={String(expanded)}>
      <button
        type="button"
        className="agent-execution-summary"
        aria-expanded={expanded}
        onClick={() => {
          if (!active) setExpanded((current) => !current)
        }}
      >
        {active ? <LoaderCircle className="spin" aria-hidden="true" /> : <Wrench aria-hidden="true" />}
        <strong>{continuing && !running ? continuationLabel : running ? '正在执行' : `已执行 ${tools.length} 个操作`}</strong>
        <ChevronDown className="agent-execution-chevron" aria-hidden="true" />
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
              const preview = subject ?? summary ?? tool.error
              const duration = durationMs(tool.startedAt, tool.completedAt, now)
              const args = Object.keys(tool.args).length ? detailText(tool.args) : undefined
              const result = detailText(tool.result ?? tool.partialResult)
              const label = toolLabel(tool)
              return (
                <details key={tool.id} className="agent-tool-row" data-status={tool.status}>
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
                      {args ? <><small>参数</small><pre>{args}</pre></> : null}
                      {result ? <><small>结果</small><pre>{result}</pre></> : null}
                      {!args && !result && !tool.error ? <p>暂无更多详情</p> : null}
                    </div>
                  </div>
                </details>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
