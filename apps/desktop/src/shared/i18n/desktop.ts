import englishMessages from './locales/en-US.json'
import chineseMessages from './locales/zh-CN.json'

export const DESKTOP_LOCALES = ['zh-CN', 'en-US'] as const
export type DesktopLocale = typeof DESKTOP_LOCALES[number]
export type DesktopMessageKey = keyof typeof englishMessages

const messages: Record<DesktopLocale, Record<DesktopMessageKey, string>> = {
  'zh-CN': chineseMessages,
  'en-US': englishMessages,
}

export const desktopMessageResources = messages

export function isDesktopLocale(value: unknown): value is DesktopLocale {
  return typeof value === 'string' && DESKTOP_LOCALES.includes(value as DesktopLocale)
}

export function translateDesktopMessage(
  locale: DesktopLocale,
  key: DesktopMessageKey,
  values?: Record<string, string | number>,
): string {
  const message = messages[locale][key]
  if (!values) return message
  return message.replace(/\{(\w+)\}/g, (match, name: string) => (
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
  ))
}
