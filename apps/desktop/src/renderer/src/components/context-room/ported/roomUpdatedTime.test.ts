import { describe, expect, it } from 'vitest'

import type { Translate } from '../../../i18n/LocaleContext'
import { formatRoomUpdatedTime } from './roomUpdatedTime'

const translations: Record<string, string> = {
  'contextRoom:roomTime.justNow': '刚刚',
  'contextRoom:roomTime.countMinutesAgo': '{count} 分钟前',
  'contextRoom:roomTime.countHoursAgo': '{count} 小时前',
  'contextRoom:roomTime.yesterday': '昨天',
}

const t: Translate = (key, values) => (
  translations[key]?.replace('{count}', String(values?.count)) ?? key
)

describe('formatRoomUpdatedTime', () => {
  const updatedAt = '2026-08-20T04:00:00.000Z'
  const updatedTime = new Date(updatedAt).getTime()

  it('moves a newly updated Room beyond just now as time passes', () => {
    expect(formatRoomUpdatedTime(updatedAt, '旧文案', 'zh-CN', t, updatedTime + 30_000)).toBe('刚刚')
    expect(formatRoomUpdatedTime(updatedAt, '旧文案', 'zh-CN', t, updatedTime + 2 * 60_000)).toBe('2 分钟前')
  })

  it('keeps the legacy label when no valid timestamp exists', () => {
    expect(formatRoomUpdatedTime(undefined, '12 分钟前', 'zh-CN', t, updatedTime)).toBe('12 分钟前')
    expect(formatRoomUpdatedTime('invalid', '昨天', 'zh-CN', t, updatedTime)).toBe('昨天')
  })
})
