import { vi } from 'vitest'

vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  const locale = {
    locale: 'zh-CN',
    setLocale: vi.fn(),
    t: (message: string, values?: Record<string, string | number>) =>
      actual.translate('zh-CN', message, values),
    formatNumber: (value: number) => value.toLocaleString('zh-CN'),
    formatDate: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat('zh-CN', options).format(new Date(value)),
  }
  return {
    ...actual,
    useLocale: () => locale,
  }
})
