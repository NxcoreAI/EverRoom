import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_APP_PREFS,
  getAppPrefs,
  initAppPrefsStore,
  normalizeAppPrefs,
  onAppPrefsChanged,
  pickAppPrefsPatch,
  resolveSaasBaseUrl,
  updateAppPrefs,
} from './app-prefs-store'

describe('app-prefs-store', () => {
  const dirs: string[] = []

  const useTempStore = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'app-prefs-'))
    dirs.push(dir)
    const file = join(dir, 'app-prefs.json')
    initAppPrefsStore(file)
    return file
  }

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  it('normalize 非法输入回默认，crashReporting 只认布尔', () => {
    expect(normalizeAppPrefs(null)).toEqual(DEFAULT_APP_PREFS)
    expect(normalizeAppPrefs('junk')).toEqual(DEFAULT_APP_PREFS)
    expect(normalizeAppPrefs({ crashReporting: 'off', junk: 1 })).toEqual(DEFAULT_APP_PREFS)
    expect(normalizeAppPrefs({ crashReporting: false })).toEqual({ ...DEFAULT_APP_PREFS, crashReporting: false })
  })

  it('URL 规范化：http(s) 绝对地址通过并去尾斜杠，其余归 null', () => {
    expect(normalizeAppPrefs({ updateFeedUrl: 'https://my-host/app/feed/' })).toEqual({
      ...DEFAULT_APP_PREFS,
      updateFeedUrl: 'https://my-host/app/feed',
    })
    expect(normalizeAppPrefs({ saasBaseUrl: ' http://192.168.1.10:4100/api/v1 ' })).toEqual({
      ...DEFAULT_APP_PREFS,
      saasBaseUrl: 'http://192.168.1.10:4100/api/v1',
    })
    expect(normalizeAppPrefs({ updateFeedUrl: 'ftp://x/y' })).toEqual(DEFAULT_APP_PREFS)
    expect(normalizeAppPrefs({ updateFeedUrl: 'not a url' })).toEqual(DEFAULT_APP_PREFS)
    expect(normalizeAppPrefs({ updateFeedUrl: '' })).toEqual(DEFAULT_APP_PREFS)
  })

  it('pickAppPrefsPatch：字段出现即校验，缺省不动', () => {
    expect(pickAppPrefsPatch({ saasBaseUrl: null })).toEqual({ saasBaseUrl: null })
    expect(pickAppPrefsPatch({ updateFeedUrl: 'https://a.com/', crashReporting: true })).toEqual({
      updateFeedUrl: 'https://a.com',
      crashReporting: true,
    })
    expect(pickAppPrefsPatch({ crashReporting: 'yes' })).toEqual({})
    expect(pickAppPrefsPatch('junk')).toEqual({})
  })

  it('update 合并、持久化并通知监听者，重启语义从磁盘读回', () => {
    const file = useTempStore()
    const seen: boolean[] = []
    const off = onAppPrefsChanged((value) => seen.push(value.crashReporting))
    expect(getAppPrefs()).toEqual(DEFAULT_APP_PREFS)
    updateAppPrefs({ crashReporting: false, updateFeedUrl: 'https://my-host/feed' })
    expect(seen).toEqual([false])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      ...DEFAULT_APP_PREFS,
      crashReporting: false,
      updateFeedUrl: 'https://my-host/feed',
    })
    initAppPrefsStore(file)
    expect(getAppPrefs().crashReporting).toBe(false)
    expect(getAppPrefs().updateFeedUrl).toBe('https://my-host/feed')
    off()
  })

  it('损坏的持久化文件回退默认', () => {
    const file = useTempStore()
    writeFileSync(file, '{oops', 'utf8')
    expect(getAppPrefs()).toEqual(DEFAULT_APP_PREFS)
  })

  it('resolveSaasBaseUrl：覆盖优先，未设置回落环境默认', () => {
    useTempStore()
    expect(resolveSaasBaseUrl('https://api.everroom.vyitec.com/api/v1')).toBe('https://api.everroom.vyitec.com/api/v1')
    updateAppPrefs({ saasBaseUrl: 'https://my-everroom.example.com/api/v1' })
    expect(resolveSaasBaseUrl('https://api.everroom.vyitec.com/api/v1')).toBe('https://my-everroom.example.com/api/v1')
  })
})
