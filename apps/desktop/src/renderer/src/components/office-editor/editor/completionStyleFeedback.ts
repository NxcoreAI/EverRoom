/**
 * 补全接受/拒绝反馈的批量上报（写作风格 v2 缺口补齐）：
 * 渲染端累计显式接受（Tab/按钮）与拒绝（Esc/菜单）的计数与接受样例，
 * 按窗口（60s）或事件数（≥5）批量上报 gateway（单行累加进 signals 表）。
 * 失败静默丢弃——反馈是增益信号，不重试、不打扰补全链路。
 */
const FLUSH_INTERVAL_MS = 60_000
const FLUSH_EVENT_THRESHOLD = 5
const SAMPLE_MAX_CHARS = 120
const SAMPLE_KEEP = 3

interface PendingFeedback {
  accepted: number
  rejected: number
  samples: string[]
}

let pending: PendingFeedback | null = null
let flushTimer: number | null = null

export function recordCompletionAcceptance(sample?: string): void {
  pending ??= { accepted: 0, rejected: 0, samples: [] }
  pending.accepted += 1
  if (typeof sample === 'string' && sample.trim()) pushSample(sample)
  bump()
}

export function recordCompletionRejection(): void {
  pending ??= { accepted: 0, rejected: 0, samples: [] }
  pending.rejected += 1
  bump()
}

function pushSample(sample: string): void {
  if (!pending) return
  const clipped = sample.replace(/\s+/g, " ").trim().slice(0, SAMPLE_MAX_CHARS)
  if (!clipped || pending.samples.includes(clipped)) return
  pending.samples.push(clipped)
  if (pending.samples.length > SAMPLE_KEEP) pending.samples.shift()
}

function bump(): void {
  if (pending && pending.accepted + pending.rejected >= FLUSH_EVENT_THRESHOLD) {
    flushCompletionFeedback()
    return
  }
  if (flushTimer !== null || typeof window === "undefined") return
  flushTimer = window.setTimeout(() => {
    flushTimer = null
    flushCompletionFeedback()
  }, FLUSH_INTERVAL_MS)
}

export function flushCompletionFeedback(): void {
  if (flushTimer !== null && typeof window !== "undefined") {
    window.clearTimeout(flushTimer)
    flushTimer = null
  }
  const batch = pending
  pending = null
  if (!batch || batch.accepted + batch.rejected <= 0) return
  void window.nxcore?.writingStyle?.reportCompletionFeedback({
    accepted: batch.accepted,
    rejected: batch.rejected,
    samples: batch.samples,
  }).catch(() => undefined)
}
