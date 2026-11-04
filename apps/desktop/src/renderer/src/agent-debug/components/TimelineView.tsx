import type { AgentDebugRunStatus } from '@nxcore/agent-contract'
import { ChevronRight } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'

import {
  formatCharCount,
  formatClock,
  formatPercent,
  formatTokens,
  truncate,
} from '../format'
import type {
  DebugApprovalInfo,
  DebugFilters,
  DebugMessageBlock,
  DebugReasoningBlock,
  DebugSystemBlock,
  DebugTimelineBlock,
  DebugToolBlock,
  DebugToolStatus,
} from '../reducer'
import { JsonView } from './JsonView'
import { LiveDuration } from './Indicators'

const TOOL_STATUS_LABEL: Record<DebugToolStatus, string> = {
  pending: '等待',
  running: '运行中',
  completed: '完成',
  error: '失败',
}

function toolPreview(tool: DebugToolBlock): string | null {
  const args = tool.args
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const record = args as Record<string, unknown>
    for (const key of ['command', 'query', 'path', 'file_path', 'filePath', 'task', 'prompt', 'url', 'name', 'description']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    const keys = Object.keys(record)
    if (keys.length > 0) return `{ ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? '…' : ''} }`
  }
  return tool.error
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  return true
}

/** 工具调用：单行 head 展开纯 mono JSON。 */
const ToolCard = memo(function ToolCard({ tool }: { tool: DebugToolBlock }) {
  const [open, setOpen] = useState(tool.status === 'error')
  const preview = toolPreview(tool)
  const running = tool.status === 'running' || tool.status === 'pending'
  const hasArgs = hasValue(tool.args) && !(typeof tool.args === 'object' && tool.args !== null && !Array.isArray(tool.args) && Object.keys(tool.args as object).length === 0)
  return (
    <div className="tl-tool" data-status={tool.status}>
      <button
        type="button"
        className="tl-tool-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={preview ?? tool.name}
      >
        <span className="tl-tool-name">{tool.name}</span>
        <span className="tl-tool-status">{TOOL_STATUS_LABEL[tool.status]}</span>
        {preview ? <span className="tl-tool-preview">{truncate(preview, 180)}</span> : <span className="tl-tool-preview" />}
        <span className="tl-tool-duration">
          <LiveDuration startedAt={tool.startedAt} completedAt={tool.completedAt} running={running} />
        </span>
        <ChevronRight className="chevron" data-open={open} aria-hidden="true" />
      </button>
      {open ? (
        <div className="tl-tool-detail">
          {tool.error ? <pre className="tl-tool-error">{tool.error}</pre> : null}
          {hasArgs ? (
            <div>
              <span className="tl-field-label">参数</span>
              <JsonView value={tool.args} />
            </div>
          ) : null}
          {hasValue(tool.partialResult) ? (
            <div>
              <span className="tl-field-label">部分结果</span>
              <JsonView value={tool.partialResult} />
            </div>
          ) : null}
          {hasValue(tool.result) ? (
            <div>
              <span className="tl-field-label">结果</span>
              <JsonView value={tool.result} />
            </div>
          ) : null}
          {!hasArgs && !hasValue(tool.partialResult) && !hasValue(tool.result) && !tool.error ? (
            <span className="tl-empty">暂无参数/结果</span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})

/** 思考块：1px 左线 + 灰色正文，默认折叠 3 行。 */
const ReasoningBlock = memo(function ReasoningBlock({ block, streaming }: {
  block: DebugReasoningBlock
  streaming: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="tl-reason">
      <div className="tl-reason-head">
        <span>思考</span>
        <span>{formatCharCount(block.text.length)} 字</span>
      </div>
      <div className="tl-reason-body" data-expanded={expanded}>
        {block.text}
        {streaming ? <span className="tl-cursor">▍</span> : null}
      </div>
      <button
        type="button"
        className="text-btn tl-reason-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? '收起' : '展开'}
      </button>
    </div>
  )
})

/** assistant 消息：纯文本段落。 */
const MessageBlock = memo(function MessageBlock({ block, streaming }: {
  block: DebugMessageBlock
  streaming: boolean
}) {
  return (
    <p className="tl-message">
      {block.text}
      {streaming ? <span className="tl-cursor">▍</span> : null}
    </p>
  )
})

function approvalLabel(approval: DebugApprovalInfo): string {
  if (approval.status === 'pending') return '等待审批'
  return approval.status === 'approved' ? '审批通过' : '审批拒绝'
}

function ApprovalLine({ approval, at }: { approval: DebugApprovalInfo; at: string }) {
  return (
    <div className="tl-approval" data-status={approval.status}>
      <span>{approvalLabel(approval)}</span>
      <span>{approval.toolName ?? approval.kind ?? 'tool'}</span>
      {approval.command ? <code title={approval.command}>{truncate(approval.command, 120)}</code> : null}
      <time>{formatClock(at)}</time>
    </div>
  )
}

function UsageLine({ block }: { block: DebugSystemBlock }) {
  const usage = block.usage!
  return (
    <div className="tl-usage">
      <span>
        上下文 {formatTokens(usage.tokens)} / {formatTokens(usage.contextWindow)}
        {usage.percent === null ? '' : ` · ${formatPercent(usage.percent)}%`}
      </span>
      <time>{formatClock(block.at)}</time>
    </div>
  )
}

function SystemLine({ block }: { block: DebugSystemBlock }) {
  if (block.approval) return <ApprovalLine approval={block.approval} at={block.at} />
  if (block.usage) return <UsageLine block={block} />
  return (
    <div className="tl-system" data-severity={block.severity} data-type={block.type}>
      <span>{block.label}</span>
      {block.detail ? <span>{block.detail}</span> : null}
      <time>{formatClock(block.at)}</time>
    </div>
  )
}

function isStreamingBlock(block: DebugTimelineBlock): boolean {
  return (block.kind === 'reasoning' || block.kind === 'message') && block.open
}

interface TimelineViewProps {
  runId: string
  blocks: DebugTimelineBlock[]
  filters: DebugFilters
  runStatus: AgentDebugRunStatus
  emptyHint?: string
}

export function TimelineView({ runId, blocks, filters, runStatus, emptyHint }: TimelineViewProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  const [stuck, setStuck] = useState(true)

  const visible = useMemo(() => blocks.filter((block) => filters[block.kind]), [blocks, filters])
  const lastBlock = visible[visible.length - 1]
  const scrollKey = lastBlock ? `${lastBlock.kind}:${lastBlock.key}:${visible.length}` : `empty:${visible.length}`
  const runRunning = runStatus === 'running'

  useEffect(() => {
    const element = scrollerRef.current
    if (element && stickRef.current) element.scrollTop = element.scrollHeight
  }, [scrollKey])

  useEffect(() => {
    stickRef.current = true
    setStuck(true)
    const element = scrollerRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [runId])

  const handleScroll = () => {
    const element = scrollerRef.current
    if (!element) return
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 96
    stickRef.current = nearBottom
    setStuck(nearBottom)
  }

  const jumpToBottom = () => {
    const element = scrollerRef.current
    if (!element) return
    stickRef.current = true
    setStuck(true)
    element.scrollTop = element.scrollHeight
  }

  return (
    <div className="timeline-wrap">
      <div className="scroll timeline" ref={scrollerRef} onScroll={handleScroll}>
        <div className="timeline-inner">
          {visible.map((block) => {
            if (block.kind === 'tool') return <ToolCard key={block.key} tool={block} />
            if (block.kind === 'reasoning') {
              return <ReasoningBlock key={block.key} block={block} streaming={runRunning && isStreamingBlock(block)} />
            }
            if (block.kind === 'message') {
              return <MessageBlock key={block.key} block={block} streaming={runRunning && isStreamingBlock(block)} />
            }
            return <SystemLine key={block.key} block={block} />
          })}
          {visible.length === 0 ? (
            <div className="tl-empty">
              {blocks.length > 0 ? '当前过滤条件下没有事件' : emptyHint ?? '等待该 run 的事件'}
            </div>
          ) : null}
        </div>
      </div>
      {!stuck ? (
        <button type="button" className="tl-jump" onClick={jumpToBottom}>回到底部</button>
      ) : null}
    </div>
  )
}
