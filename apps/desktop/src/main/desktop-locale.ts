import {
  isDesktopLocale,
  translateDesktopMessage,
  type DesktopLocale,
  type DesktopMessageKey,
} from '../shared/i18n/desktop'

let currentLocale: DesktopLocale = 'zh-CN'

export function setDesktopLocale(locale: unknown): void {
  if (isDesktopLocale(locale)) currentLocale = locale
}

export function getDesktopLocale(): DesktopLocale {
  return currentLocale
}

export function desktopText(
  key: DesktopMessageKey,
  values?: Record<string, string | number>,
): string {
  return translateDesktopMessage(currentLocale, key, values)
}
