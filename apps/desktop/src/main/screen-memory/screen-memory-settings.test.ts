import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isAppInScope, ScreenMemorySettingsStore } from './screen-memory-settings'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

const dirs: string[] = []
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))))

describe('isAppInScope', () => {
  const base = { enabled: true, paused: false, allowedApps: ['com.apple.Safari'], excludedApps: [] }

  it('all 模式：排除清单外的全部应用都在范围内', () => {
    expect(isAppInScope({ ...base, scopeMode: 'all' }, 'com.apple.finder')).toBe(true)
    expect(isAppInScope({ ...base, scopeMode: 'all' }, 'com.apple.Safari')).toBe(true)
    expect(isAppInScope({ ...base, scopeMode: 'all', excludedApps: ['com.apple.finder'] }, 'com.apple.finder')).toBe(false)
  })

  it('allowlist 模式：仅列表内应用在范围内', () => {
    expect(isAppInScope({ ...base, scopeMode: 'allowlist' }, 'com.apple.Safari')).toBe(true)
    expect(isAppInScope({ ...base, scopeMode: 'allowlist' }, 'com.apple.finder')).toBe(false)
  })

  it('无 bundleId 一律不在范围', () => {
    expect(isAppInScope({ ...base, scopeMode: 'all' }, null)).toBe(false)
  })
})

describe('ScreenMemorySettingsStore', () => {
  it('旧配置缺 scopeMode 时收养为 all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'screen-memory-settings-'))
    dirs.push(dir)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'settings.json'), JSON.stringify({
      version: 1,
      settings: { enabled: true, paused: false, allowedApps: ['ai.nxcore.everroom'], excludedApps: [] },
    }), 'utf8')
    const store = new ScreenMemorySettingsStore(join(dir, 'settings.json'), join(dir, 'backup'))
    const settings = store.read()
    expect(settings.scopeMode).toBe('all')
    expect(settings.allowedApps).toEqual(['ai.nxcore.everroom'])
  })

  it('更新 scopeMode 持久化生效', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'screen-memory-settings-'))
    dirs.push(dir)
    const store = new ScreenMemorySettingsStore(join(dir, 'settings.json'), join(dir, 'backup'))
    const next = store.update({ enabled: true, scopeMode: 'allowlist' })
    expect(next.scopeMode).toBe('allowlist')
    expect(store.read().scopeMode).toBe('allowlist')
  })
})
