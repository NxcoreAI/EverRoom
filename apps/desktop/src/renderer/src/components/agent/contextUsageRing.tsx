import type { AgentContextUsage } from '@nxcore/agent-contract'

/** token 数紧凑显示：<1000 原样，否则 K 单位（40960→"41K"，150000→"150K"）。 */
export function formatContextTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  return `${Math.round(tokens / 1000)}K`
}

/** 圆环周长（r=5.5）。 */
export const RING_CIRCUMFERENCE = 2 * Math.PI * 5.5

/** 占用构成占比：<10% 保留一位小数，否则取整。 */
export function formatContextPercent(percent: number): string {
  return percent >= 9.95 ? `${Math.round(percent)}%` : `${percent.toFixed(1)}%`
}

/**
 * 上下文用量圆环：对话区 composer 与子代理执行行共用同一套视觉——
 * 有窗口快照时画弧（≥85% 换警示色），只有压缩中信号时只留轨道并呼吸。
 * 默认渲染为静态标记（span，靠 title 悬停看数字）；传 onClick 时变成按钮，
 * 供 composer 点击展开占用构成。
 */
export function ContextUsageRing({
  usage,
  compacting = false,
  title,
  expanded,
  onClick,
  inline = false,
}: {
  /** 最近一次上下文用量快照；缺省 = 未知，不渲染。 */
  usage?: AgentContextUsage | null
  /** 上下文压缩进行中：圆环呼吸。 */
  compacting?: boolean
  /** 悬停标题（token 数 / 窗口 / 百分比）。 */
  title?: string
  /** 仅按钮态：弹层是否展开（aria-expanded）。 */
  expanded?: boolean
  /** 传了才可点击；不传按静态标记渲染。 */
  onClick?: () => void
  /** 行内态：紧跟文字（子代理名），去掉按钮的靠右/hover 样式。 */
  inline?: boolean
}) {
  if (!usage?.contextWindow && !compacting) return null
  const className = `agent-context-ring${compacting ? ' agent-context-ring--compacting' : ''}${inline ? ' agent-context-ring--inline' : ''}`
  const level = usage?.percent != null && usage.percent >= 85 ? 'high' : undefined
  const percent = usage?.percent
  const glyph = (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle className="agent-context-ring-track" cx="8" cy="8" r="5.5" fill="none" strokeWidth="2.5" />
      {percent != null ? (
        <circle
          className="agent-context-ring-arc"
          cx="8"
          cy="8"
          r="5.5"
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${(RING_CIRCUMFERENCE * Math.min(100, Math.max(3, percent))) / 100} ${RING_CIRCUMFERENCE}`}
          transform="rotate(-90 8 8)"
        />
      ) : null}
    </svg>
  )
  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        data-level={level}
        aria-expanded={expanded}
        title={title}
        onClick={onClick}
      >
        {glyph}
      </button>
    )
  }
  return (
    <span className={className} data-level={level} title={title} role={title ? 'img' : undefined} aria-label={title}>
      {glyph}
    </span>
  )
}
