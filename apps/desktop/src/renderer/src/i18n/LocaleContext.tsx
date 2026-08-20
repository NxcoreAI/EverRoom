import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import { contextRoomEnglishMessages } from './contextRoomMessages'
import { contextRoomSurfaceEnglishMessages } from './contextRoomSurfaceMessages'
import { diaryRealityEnglishMessages } from './diaryRealityMessages'
import { finalSurfaceEnglishMessages } from './finalSurfaceMessages'
import { memoryEnglishMessages } from './memoryMessages'
import { englishMessages } from './messages'

export type AppLocale = 'zh-CN' | 'en-US'

const STORAGE_KEY = 'everroom:locale:v1'

export function resolveLocale(stored: string | null, browserLanguage: string): AppLocale {
  if (stored === 'zh-CN' || stored === 'en-US') return stored
  return browserLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

function detectLocale(): AppLocale {
  let stored: string | null = null
  try {
    stored = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    // Browser storage is optional.
  }
  return resolveLocale(stored, window.navigator.language)
}

export function interpolate(message: string, values?: Record<string, string | number>): string {
  if (!values) return message
  return message.replace(/\{(\w+)\}/g, (match, key: string) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  ))
}

export function translate(locale: AppLocale, message: string, values?: Record<string, string | number>): string {
  const translated = englishMessages[message]
    ?? contextRoomEnglishMessages[message]
    ?? contextRoomSurfaceEnglishMessages[message]
    ?? diaryRealityEnglishMessages[message]
    ?? finalSurfaceEnglishMessages[message]
    ?? memoryEnglishMessages[message]
    ?? message
  return interpolate(locale === 'en-US' ? translated : message, values)
}

export type Translate = (message: string, values?: Record<string, string | number>) => string

interface LocaleContextValue {
  locale: AppLocale
  setLocale: (locale: AppLocale) => void
  t: Translate
  formatNumber: (value: number) => string
  formatDate: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => string
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<AppLocale>(detectLocale)

  useEffect(() => {
    document.documentElement.lang = locale
    try {
      window.localStorage.setItem(STORAGE_KEY, locale)
    } catch {
      // Browser storage is optional.
    }
  }, [locale])

  const value = useMemo<LocaleContextValue>(() => ({
    locale,
    setLocale,
    t: (message, values) => translate(locale, message, values),
    formatNumber: (number) => number.toLocaleString(locale),
    formatDate: (input, options) => new Intl.DateTimeFormat(locale, options).format(new Date(input)),
  }), [locale])

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext)
  if (!value) throw new Error('useLocale must be used inside LocaleProvider')
  return value
}
