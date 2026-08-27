import type { AppLocale } from '../../../i18n/LocaleContext'

/** ISO 8601 日期时间（含 "2026-08-21 10:30" 空格变体，时区标记可选）。 */
const ISO_LIKE_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?/u

function isoLikeDate(text: string): Date | null {
  const match = ISO_LIKE_PATTERN.exec(text)
  if (!match) return null
  const [, year, month, day, hour, minute, second, zone] = match
  if (zone) {
    const parsed = new Date(text.trim().replace(' ', 'T'))
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  // 无时区标记的时间按本地时间解释，与“今天 11:20”式展示文案一致
  const date = new Date(
    Number(year), Number(month) - 1, Number(day),
    Number(hour ?? 0), Number(minute ?? 0), Number(second ?? 0),
  )
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * 时间轴时间解析：ISO 优先（文档时间戳都是 ISO，走旧 MM-DD 启发式会跨年错位），
 * 其后保留演示文案的 今天/昨天/MM-DD 规则；不可解析返回 null。
 * （事件派生已在网关侧投影完成，前端只负责解析与展示。）
 */
export function parseTimelineDate(value: string, now = new Date()): Date | null {
  const text = value.trim()
  if (!text) return null
  const iso = isoLikeDate(text)
  if (iso) return iso
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (/^(今天|today)(?:\s|$)/iu.test(text)) return today
  if (/^(昨天|yesterday)(?:\s|$)/iu.test(text)) {
    today.setDate(today.getDate() - 1)
    return today
  }
  const match = text.match(/(\d{1,2})-(\d{1,2})/)
  if (!match) return null
  return new Date(now.getFullYear(), Number(match[1]) - 1, Number(match[2]))
}

/** ISO 时间戳转为本地展示文案；自由文本（今天 11:20 等）原样返回。 */
export function formatTimelineTime(value: string, locale: AppLocale, now = new Date()): string {
  const match = ISO_LIKE_PATTERN.exec(value.trim())
  if (!match) return value
  const date = parseTimelineDate(value, now)
  if (!date) return value
  return new Intl.DateTimeFormat(locale, {
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    month: 'numeric',
    day: 'numeric',
    ...(match[4] ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date)
}
