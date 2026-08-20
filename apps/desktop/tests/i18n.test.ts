import { describe, expect, it } from 'vitest'

import { interpolate, resolveLocale, translate } from '../src/renderer/src/i18n/LocaleContext'

describe('renderer i18n', () => {
  it('restores a supported stored locale before using the system locale', () => {
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN')
    expect(resolveLocale('en-US', 'zh-CN')).toBe('en-US')
  })

  it('falls back to Chinese only for Chinese system locales', () => {
    expect(resolveLocale(null, 'zh-Hans-CN')).toBe('zh-CN')
    expect(resolveLocale(null, 'en-GB')).toBe('en-US')
    expect(resolveLocale('unsupported', 'ja-JP')).toBe('en-US')
  })

  it('translates known messages and preserves dynamic values', () => {
    expect(translate('en-US', '剩余 {minutes} 分钟', { minutes: 12 })).toBe('12 minutes remaining')
    expect(translate('zh-CN', '剩余 {minutes} 分钟', { minutes: 12 })).toBe('剩余 12 分钟')
  })

  it('keeps unknown messages and unresolved placeholders intact', () => {
    expect(translate('en-US', '用户创建的标题')).toBe('用户创建的标题')
    expect(interpolate('{known} / {unknown}', { known: 'yes' })).toBe('yes / {unknown}')
  })
})
