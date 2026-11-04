/** 看板专用格式化：耗时、token、百分比、相对时间。所有函数对 null/NaN 都返回「—」。 */

export const EMPTY = '—'

export function formatMs(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) return EMPTY
  const value = Math.max(0, milliseconds)
  if (value < 1) return '<1ms'
  if (value < 1000) return `${Math.round(value)}ms`
  const seconds = value / 1000
  if (seconds < 10) return `${seconds.toFixed(2)}s`
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  if (minutes < 60) return rest ? `${minutes}m${String(rest).padStart(2, '0')}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
}

/** 秒级绝对时间（时间轴刻度用）：`mm:ss`，超过 1 小时给 `h:mm:ss`。 */
export function formatOffset(offsetMs: number | null | undefined): string {
  if (offsetMs === null || offsetMs === undefined || !Number.isFinite(offsetMs)) return EMPTY
  const total = Math.max(0, Math.round(offsetMs / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

export function formatTokens(count: number | null | undefined): string {
  if (count === null || count === undefined || !Number.isFinite(count)) return EMPTY
  const value = Math.round(count)
  if (Math.abs(value) < 1000) return String(value)
  if (Math.abs(value) < 1_000_000) {
    const scaled = value / 1000
    return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)}k`
  }
  return `${(value / 1_000_000).toFixed(2)}m`
}

/** 带符号 token 变化（记忆收支：+1.2k / -840）。 */
export function formatTokenDelta(count: number | null | undefined): string {
  if (count === null || count === undefined || !Number.isFinite(count)) return EMPTY
  if (count === 0) return '0'
  const sign = count > 0 ? '+' : '−'
  return `${sign}${formatTokens(Math.abs(count))}`
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY
  return value < 10 ? `${value.toFixed(digits)}%` : `${Math.round(value)}%`
}

/** 0–1 的比例 → 百分比文案。 */
export function formatRatio(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY
  return formatPercent(value * 100, 0)
}

/** 占比文案：非零但不足 1% 时写「<1%」，避免把小耗时显示成「0%」。 */
export function formatShare(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY
  if (value <= 0) return '0%'
  if (value < 0.01) return '<1%'
  return formatPercent(value * 100, value < 0.1 ? 1 : 0)
}

export function formatChars(count: number | null | undefined): string {
  if (count === null || count === undefined || !Number.isFinite(count)) return EMPTY
  if (count < 1000) return String(Math.round(count))
  return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return EMPTY
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return EMPTY
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}

export function formatMonthDayTime(iso: string | null | undefined): string {
  if (!iso) return EMPTY
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return EMPTY
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return EMPTY
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return EMPTY
  const delta = now - time
  if (delta < 15_000) return '刚刚'
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s 前`
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m 前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h 前`
  return `${Math.floor(delta / 86_400_000)}d 前`
}

export function truncateText(text: string, max: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > max ? `${compact.slice(0, max)}…` : compact
}
