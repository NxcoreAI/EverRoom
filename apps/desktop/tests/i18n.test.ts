import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { interpolate, resolveLocale, translate } from '../src/renderer/src/i18n/LocaleContext'
import i18n from '../src/renderer/src/i18n/i18next'
import { i18nResources } from '../src/renderer/src/i18n/resources'
import { desktopMessageResources, translateDesktopMessage } from '../src/shared/i18n/desktop'
import { localizedUiText } from '../src/renderer/src/components/context-room/ported/adapters'

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

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

  it('translates semantic namespace keys and interpolates dynamic values', () => {
    expect(translate('en-US', 'diaryReality:recording.desktopPerceptionTitle', { time: '09:30' })).toBe('Desktop perception · 09:30')
    expect(translate('zh-CN', 'diaryReality:recording.desktopPerceptionTitle', { time: '09:30' })).toBe('桌面感知 · 09:30')
    expect(translate('en-US', 'memory:memoryOverview.generated')).toBe('Generated')
    expect(translate('en-US', 'diaryReality:perception.screenActivity')).toBe('Screen activity')
    expect(i18n.getFixedT('en-US')('contextRoom:documentOperationReview.documentChange', { sequence: 2 })).toBe('Document change 2')
  })

  it('keeps unknown messages and unresolved placeholders intact', () => {
    expect(translate('en-US', '用户创建的标题')).toBe('用户创建的标题')
    expect(interpolate('{known} / {unknown}', { known: 'yes' })).toBe('yes / {unknown}')
  })

  it('localizes persisted Room defaults without translating user content', () => {
    const t = (message: string) => translate('en-US', message)
    expect(localizedUiText('待补充 Room 的背景和资料范围。', t)).toBe('Add the Room background and resource scope.')
    expect(localizedUiText('用户填写的 Room 背景', t)).toBe('用户填写的 Room 背景')
  })

  it('keeps locale namespace keys in parity without a legacy runtime dictionary', () => {
    expect(i18nResources['zh-CN'].common).toEqual({})
    expect(i18nResources['en-US'].common).toEqual({})
    for (const namespace of ['contextRoom', 'diaryReality', 'memory', 'surface'] as const) {
      expect(Object.keys(i18nResources['en-US'][namespace]).sort()).toEqual(
        Object.keys(i18nResources['zh-CN'][namespace]).sort(),
      )
      expect(Object.values(i18nResources['en-US'][namespace]).filter((value) => /[\u3400-\u9fff]/u.test(value))).toEqual([])
    }
  })

  it('does not define duplicate locale keys', () => {
    const localeRoot = fileURLToPath(new URL('../src/renderer/src/i18n/locales', import.meta.url))
    const duplicates: string[] = []
    for (const locale of ['zh-CN', 'en-US']) {
      for (const namespace of ['contextRoom', 'diaryReality', 'memory', 'surface']) {
        const source = readFileSync(`${localeRoot}/${locale}/${namespace}.json`, 'utf8')
        const keys = [...source.matchAll(/^\s*"([^"]+)":/gm)].map((match) => match[1])
        for (const key of new Set(keys)) {
          if (keys.filter((candidate) => candidate === key).length > 1) duplicates.push(`${locale}:${namespace}:${key}`)
        }
      }
    }
    expect(duplicates).toEqual([])
  })

  it('keeps Electron native UI messages in locale parity', () => {
    expect(Object.keys(desktopMessageResources['en-US']).sort()).toEqual(Object.keys(desktopMessageResources['zh-CN']).sort())
    expect(Object.values(desktopMessageResources['en-US']).filter((value) => /[\u3400-\u9fff]/u.test(value))).toEqual([])
    expect(translateDesktopMessage('en-US', 'dialog.exportTranscript.title')).toBe('Export transcript')
    expect(translateDesktopMessage('zh-CN', 'error.memory.fileTooLarge', { size: '2.5' })).toBe('文件超过 2MB 导入上限（2.5MB）')
  })

  it('defines every statically referenced semantic key in both locales', () => {
    const sourceRoot = fileURLToPath(new URL('../src/renderer/src', import.meta.url))
    const keyPattern = /(['"`])((contextRoom|diaryReality|memory|surface):([A-Za-z0-9_.-]+))\1/g
    const references = sourceFiles(sourceRoot).flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return [...source.matchAll(keyPattern)].map((match) => ({ path, namespace: match[3], key: match[4] }))
    })
    const missing = references.flatMap(({ path, namespace, key }) => {
      const localizedNamespace = namespace as 'contextRoom' | 'diaryReality' | 'memory' | 'surface'
      return (['zh-CN', 'en-US'] as const).flatMap((locale) => (
        Object.prototype.hasOwnProperty.call(i18nResources[locale][localizedNamespace], key)
          ? []
          : [`${locale}:${namespace}:${key} (${path})`]
      ))
    })
    expect(missing).toEqual([])
  })

  it('does not use literal Chinese source copy as translation keys', () => {
    const sourceRoot = fileURLToPath(new URL('../src/renderer/src', import.meta.url))
    const literalChineseTranslation = /\bt\(\s*(['"`])[^'"`]*[\u3400-\u9fff][^'"`]*\1/g
    const violations = sourceFiles(sourceRoot).flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return [...source.matchAll(literalChineseTranslation)].map((match) => `${path}:${match[0]}`)
    })
    expect(violations).toEqual([])
  })
})
