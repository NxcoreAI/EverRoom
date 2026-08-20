import { useEffect, useState } from 'react'

import { useLocale, type AppLocale, type Translate } from '../../../i18n/LocaleContext'
import type { ContextRoomRecord } from './types'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export function formatRoomUpdatedTime(
  updatedAt: string | undefined,
  fallback: string,
  locale: AppLocale,
  t: Translate,
  now = Date.now(),
): string {
  if (!updatedAt) return fallback
  const time = new Date(updatedAt).getTime()
  if (!Number.isFinite(time)) return fallback

  const elapsed = Math.max(0, now - time)
  if (elapsed < MINUTE_MS) return t('contextRoom:roomTime.justNow')
  if (elapsed < HOUR_MS) {
    return t('contextRoom:roomTime.countMinutesAgo', { count: Math.floor(elapsed / MINUTE_MS) })
  }
  if (elapsed < DAY_MS) {
    return t('contextRoom:roomTime.countHoursAgo', { count: Math.floor(elapsed / HOUR_MS) })
  }
  if (elapsed < 2 * DAY_MS) return t('contextRoom:roomTime.yesterday')
  return new Intl.DateTimeFormat(locale, {
    year: elapsed >= 365 * DAY_MS ? 'numeric' : undefined,
    month: 'numeric',
    day: 'numeric',
  }).format(time)
}

export function useRoomUpdatedTime(room: Pick<ContextRoomRecord, 'updatedAt' | 'lastViewed'>): string {
  const { locale, t } = useLocale()
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(interval)
  }, [])

  return formatRoomUpdatedTime(room.updatedAt, room.lastViewed, locale, t, now)
}
