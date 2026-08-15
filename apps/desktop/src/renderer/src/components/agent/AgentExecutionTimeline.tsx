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
import { useEffect, useMemo, useState } from 'react'

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

function toolCategory(tool: DisplayAgentToolCall): string {
  const category = {
    calendar: '日程',
    command: '命令',
    email: '邮件',
    file: '文件',
    image: '图片',
    memory: '记忆',
    other: '工具',
    search: '网页',
  }[toolKind(tool.name)]
  return `${tool.name.replace(/_/g, '-').slice(0, 30)} / ${category}`
}

function userText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text || text.startsWith('{') || text.startsWith('[')) return undefined
  return text.slice(0, 120)
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
      return result.trim().slice(0, 100) || undefined
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

function durationMs(startedAt: string, completedAt: string | undefined, now: number): number {
  const start = Date.parse(startedAt)
  const end = completedAt ? Date.parse(completedAt) : now
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0
}

function formatDuration(duration: number): string {
  return duration < 1000 ? `${Math.round(duration)} 毫秒` : `${(duration / 1000).toFixed(1)} 秒`
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

  useEffect(() => {
    setExpanded(running)
  }, [running])

  useEffect(() => {
    if (!running) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [running])

  const totalDuration = useMemo(() => runStartedAt
    ? durationMs(runStartedAt, runCompletedAt, now)
    : 0, [now, runCompletedAt, runStartedAt])

  if (tools.length === 0) return null

  return (
    <section className="agent-execution" data-running={String(running)}>
      <button
        type="button"
        className="agent-execution-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <ChevronDown aria-hidden="true" />
        <span className="agent-execution-pulse" aria-hidden="true" />
        <strong>执行过程</strong>
        <span>{tools.length} 个步骤{totalDuration ? ` · ${formatDuration(totalDuration)}` : ''}</span>
      </button>
      {expanded ? (
        <div className="agent-tool-list">
          {tools.map((tool) => {
            const kind = toolKind(tool.name)
            const summary = resultSummary(tool.result ?? tool.partialResult)
            const duration = durationMs(tool.startedAt, tool.completedAt, now)
            return (
              <article key={tool.id} className="agent-tool-card" data-kind={kind} data-status={tool.status}>
                <span className="agent-tool-icon"><ToolIcon kind={kind} /></span>
                <span className="agent-tool-copy">
                  <strong>{toolLabel(tool)}</strong>
                  <small>{toolCategory(tool)}</small>
                  {toolSubject(tool) ? <span>“{toolSubject(tool)}”</span> : null}
                  {summary ? <span>{summary}</span> : null}
                  {tool.error ? <span className="agent-tool-error">{tool.error}</span> : null}
                  <small>{tool.status === 'running' ? '已运行' : '工具执行'} {formatDuration(duration)}</small>
                </span>
                <span className="agent-tool-status"><StatusIcon status={tool.status} />{statusLabel(tool.status)}</span>
              </article>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}
