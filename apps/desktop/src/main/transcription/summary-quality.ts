export interface SummaryDetailMinimum {
  overview: number
  keyPoints: number
}

export function summaryDetailMinimum(transcriptLength: number): SummaryDetailMinimum | null {
  if (transcriptLength > 5_000) return { overview: 600, keyPoints: 10 }
  if (transcriptLength > 1_500) return { overview: 500, keyPoints: 7 }
  if (transcriptLength > 300) return { overview: 180, keyPoints: 4 }
  return null
}

/** 转写行首的时间戳+说话人标记（`[03:12] 发言人：`），回显比对前从两侧剥掉。 */
const TRANSCRIPT_LINE_MARKER = /\[\d{1,2}:\d{2}\]\s*[^\n：:]{0,16}[：:]/g
const ECHO_PROBE_LENGTH = 64
const ECHO_PROBE_COUNT = 8
const ECHO_MIN_PROBES = 4
const ECHO_HIT_RATIO = 0.5

/**
 * 判定总结是否为逐字稿的整段照抄（#260 的模型回显）。正常摘要会重新组织
 * 原文，几乎不会出现连续 64 字的逐字片段；回显则处处命中。比对前把两侧的
 * 时间戳说话人标记与空白剥掉，使「原样复制（含格式）」与「仅复制正文」按
 * 同一基准比对。探针互不重叠，避免局部引用被重复计数。
 */
export function looksLikeTranscriptEcho(summary: string, transcript: string): boolean {
  const summaryText = normalizeForEchoProbe(summary)
  const transcriptText = normalizeForEchoProbe(transcript)
  if (summaryText.length < ECHO_PROBE_LENGTH * 2 || transcriptText.length < ECHO_PROBE_LENGTH * 2) return false
  const span = summaryText.length - ECHO_PROBE_LENGTH
  const stride = Math.max(ECHO_PROBE_LENGTH, Math.ceil(span / (ECHO_PROBE_COUNT - 1)))
  let probes = 0
  let hits = 0
  for (let offset = 0; offset <= span; offset += stride) {
    probes += 1
    if (transcriptText.includes(summaryText.slice(offset, offset + ECHO_PROBE_LENGTH))) hits += 1
  }
  return probes >= ECHO_MIN_PROBES && hits >= Math.ceil(probes * ECHO_HIT_RATIO)
}

function normalizeForEchoProbe(value: string): string {
  return value.replace(TRANSCRIPT_LINE_MARKER, '').replace(/\s+/g, '')
}
