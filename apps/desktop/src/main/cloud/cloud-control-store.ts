import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { DEFAULT_CLOUD_CONTROL_SETTINGS, type CloudControlSettings } from '../../shared/sources'

const listeners = new Set<(settings: CloudControlSettings) => void>()
let settingsFile: string | null = null
let cached: CloudControlSettings | null = null

export function pickCloudControlPatch(raw: unknown): Partial<CloudControlSettings> {
  const patch: Partial<CloudControlSettings> = {}
  if (!raw || typeof raw !== 'object') return patch
  const value = raw as Record<string, unknown>
  if (typeof value.audioUpload === 'boolean') patch.audioUpload = value.audioUpload
  if (typeof value.transcriptSync === 'boolean') patch.transcriptSync = value.transcriptSync
  if (typeof value.remoteAgentChannel === 'boolean') patch.remoteAgentChannel = value.remoteAgentChannel
  if (typeof value.aiRelay === 'boolean') patch.aiRelay = value.aiRelay
  return patch
}

export function normalizeCloudControlSettings(raw: unknown): CloudControlSettings {
  return { ...DEFAULT_CLOUD_CONTROL_SETTINGS, ...pickCloudControlPatch(raw) }
}

/** 路径由 IPC 注册方注入（app.getPath 需在 electron ready 后可用），也让本模块可脱离 electron 测试。 */
export function initCloudControlStore(file: string): void {
  settingsFile = file
  cached = null
}

export function getCloudControlSettings(): CloudControlSettings {
  if (cached) return cached
  let loaded = { ...DEFAULT_CLOUD_CONTROL_SETTINGS }
  if (settingsFile && existsSync(settingsFile)) {
    try {
      loaded = normalizeCloudControlSettings(JSON.parse(readFileSync(settingsFile, 'utf8')))
    } catch {
      // 损坏文件按默认值重建
    }
  }
  cached = loaded
  return cached
}

export function updateCloudControlSettings(patch: Partial<CloudControlSettings>): CloudControlSettings {
  const next = { ...getCloudControlSettings(), ...patch }
  cached = next
  if (settingsFile) {
    try {
      writeFileSync(settingsFile, JSON.stringify(next, null, 2), 'utf8')
    } catch (error) {
      console.warn('[desktop/cloud-control] persist failed |', error)
    }
  }
  for (const listener of listeners) listener(next)
  return next
}

export function onCloudControlSettingsChanged(listener: (settings: CloudControlSettings) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
