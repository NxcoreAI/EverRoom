import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CLOUD_CONTROL_SETTINGS } from '../../shared/sources'
import {
  getCloudControlSettings,
  initCloudControlStore,
  normalizeCloudControlSettings,
  onCloudControlSettingsChanged,
  pickCloudControlPatch,
  updateCloudControlSettings,
} from './cloud-control-store'

describe('cloud-control-store', () => {
  const dirs: string[] = []

  const useTempStore = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'cloud-control-'))
    dirs.push(dir)
    const file = join(dir, 'cloud-control.json')
    initCloudControlStore(file)
    return file
  }

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  it('normalize 只认布尔开关键，其余忽略并回默认（aiRelay 默认开）', () => {
    expect(normalizeCloudControlSettings(null)).toEqual(DEFAULT_CLOUD_CONTROL_SETTINGS)
    expect(DEFAULT_CLOUD_CONTROL_SETTINGS.aiRelay).toBe(true)
    expect(normalizeCloudControlSettings({ audioUpload: true, junk: 'x' })).toEqual({
      ...DEFAULT_CLOUD_CONTROL_SETTINGS,
      audioUpload: true,
    })
    expect(normalizeCloudControlSettings({ audioUpload: 'yes' })).toEqual(DEFAULT_CLOUD_CONTROL_SETTINGS)
    expect(normalizeCloudControlSettings({ aiRelay: false }).aiRelay).toBe(false)
  })

  it('pickCloudControlPatch 过滤非法 patch', () => {
    expect(pickCloudControlPatch({ transcriptSync: false, remoteAgentChannel: 'on' })).toEqual({ transcriptSync: false })
    expect(pickCloudControlPatch({ aiRelay: false, junk: 1 })).toEqual({ aiRelay: false })
    expect(pickCloudControlPatch('junk')).toEqual({})
  })

  it('update 合并、持久化并通知监听者', () => {
    const file = useTempStore()
    const seen: boolean[] = []
    const off = onCloudControlSettingsChanged((value) => seen.push(value.remoteAgentChannel))
    expect(getCloudControlSettings()).toEqual(DEFAULT_CLOUD_CONTROL_SETTINGS)
    updateCloudControlSettings({ remoteAgentChannel: true })
    expect(seen).toEqual([true])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      ...DEFAULT_CLOUD_CONTROL_SETTINGS,
      remoteAgentChannel: true,
    })
    // 重启语义：重新 init 后从磁盘读回
    initCloudControlStore(file)
    expect(getCloudControlSettings().remoteAgentChannel).toBe(true)
    off()
  })

  it('损坏的持久化文件回退默认', () => {
    const file = useTempStore()
    writeFileSync(file, '{oops', 'utf8')
    expect(getCloudControlSettings()).toEqual(DEFAULT_CLOUD_CONTROL_SETTINGS)
  })
})
