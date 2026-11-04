/** 调试台用的轻量格式化工具（无 i18n 依赖，中文为主）。 */

export function formatDuration(milliseconds: number): string {
  const value = Math.max(0, milliseconds)
  if (value < 1000) return `${Math.round(value)}ms`
  const seconds = value / 1000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  if (minutes < 60) return rest ? `${minutes}m${String(rest).padStart(2, '0')}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}

/** 绝对时间 `MM-DD HH:mm`（本地时区），历史 run 需要跨天辨认。 */
export function formatMonthDayTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return '—'
  const delta = now - time
  if (delta < 0) return '刚刚'
  if (delta < 15_000) return '刚刚'
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s 前`
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m 前`
  if (delta < 24 * 3_600_000) {
    return new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  return new Date(time).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function formatCharCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0'
  if (count < 1000) return String(Math.round(count))
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
  return `${(count / 1_000_000).toFixed(1)}m`
}

export function formatTokens(count: number | null | undefined): string {
  if (count === null || count === undefined || !Number.isFinite(count)) return '—'
  if (count < 1000) return String(Math.round(count))
  return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value < 10 ? value.toFixed(1) : String(Math.round(value))
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 从时间戳算耗时；running 时用 now。 */
export function elapsedMs(startedAt: string | null | undefined, completedAt: string | null | undefined, now = Date.now()): number {
  if (!startedAt) return 0
  const start = Date.parse(startedAt)
  if (!Number.isFinite(start)) return 0
  const end = completedAt ? Date.parse(completedAt) : now
  if (!Number.isFinite(end)) return 0
  return Math.max(0, end - start)
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
