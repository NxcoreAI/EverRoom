import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'

import i18n from './i18next'
import { SUPPORTED_LOCALES, type AppLocale } from './resources'

export type { AppLocale } from './resources'
export type LocalePreference = AppLocale | 'system'

const STORAGE_KEY = 'everroom:locale:v1'

function localeFromBrowser(browserLanguage: string): AppLocale {
  const normalized = browserLanguage.toLowerCase()
  const exact = SUPPORTED_LOCALES.find((locale) => locale.toLowerCase() === normalized)
  if (exact) return exact
  const language = normalized.split('-')[0]
  const match = SUPPORTED_LOCALES.find((locale) => locale.toLowerCase().split('-')[0] === language)
  return match ?? 'en-US'
}

export function resolveLocale(stored: string | null, browserLanguage: string): AppLocale {
  if (stored && SUPPORTED_LOCALES.includes(stored as AppLocale)) return stored as AppLocale
  return localeFromBrowser(browserLanguage)
}

function storedLocalePreference(): LocalePreference | null {
  let stored: string | null = null
  try {
    stored = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    // Browser storage is optional.
  }
  if (stored === 'system') return 'system'
  return stored && SUPPORTED_LOCALES.includes(stored as AppLocale) ? stored as AppLocale : null
}

function detectLocale(): AppLocale {
  const preference = storedLocalePreference()
  const systemLocale = window.nxcore?.locale.system ?? window.navigator.language
  return resolveLocale(preference === 'system' ? null : preference, systemLocale)
}

export function interpolate(message: string, values?: Record<string, string | number>): string {
  if (!values) return message
  return message.replace(/\{(\w+)\}/g, (match, key: string) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  ))
}

export function translate(locale: AppLocale, message: string, values?: Record<string, string | number>): string {
  const fixedT = i18n.getFixedT(locale, 'common')
  const translated = fixedT(message) as unknown as string
  return interpolate(translated, values)
}

export type Translate = (message: string, values?: Record<string, string | number>) => string

interface LocaleContextValue {
  locale: AppLocale
  preference: LocalePreference
  setLocale: (locale: LocalePreference) => void
  t: Translate
  formatNumber: (value: number) => string
  formatDate: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => string
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(() => {
    const detected = detectLocale()
    void i18n.changeLanguage(detected)
    return detected
  })
  const [preference, setPreferenceState] = useState<LocalePreference>(() => storedLocalePreference() ?? 'system')

  useEffect(() => {
    void i18n.changeLanguage(locale)
    document.documentElement.lang = locale
    window.nxcore?.locale.set(locale)
  }, [locale])

  useEffect(() => {
    if (preference !== 'system') {
      setLocaleState(preference)
      return
    }
    let cancelled = false
    setLocaleState(resolveLocale(null, window.nxcore?.locale.system ?? window.navigator.language))
    void window.nxcore?.locale.getSystem().then((systemLocale) => {
      if (cancelled || storedLocalePreference() !== 'system') return
      const detected = resolveLocale(null, systemLocale)
      setLocaleState(detected)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [preference])

  const value = useMemo<LocaleContextValue>(() => ({
    locale,
    preference,
    setLocale: (nextLocale) => {
      setPreferenceState(nextLocale)
      try {
        window.localStorage.setItem(STORAGE_KEY, nextLocale)
      } catch {
        // Browser storage is optional.
      }
    },
    t: (message, values) => translate(locale, message, values),
    formatNumber: (number) => number.toLocaleString(locale),
    formatDate: (input, options) => new Intl.DateTimeFormat(locale, options).format(new Date(input)),
  }), [locale, preference])

  return (
    <I18nextProvider i18n={i18n}>
      <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
    </I18nextProvider>
  )
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext)
  if (!value) throw new Error('useLocale must be used inside LocaleProvider')
  return value
}
