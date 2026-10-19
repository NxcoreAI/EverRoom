import { join } from 'node:path'

import { app } from 'electron'
import { VersionedJsonStore } from '@nxcore/migration-kit'

export type ScreenMemoryScopeMode = 'all' | 'allowlist'

export interface ScreenMemorySettings {
  enabled: boolean
  paused: boolean
  /** all=采集全部前台应用（排除清单之外）；allowlist=仅采集 allowedApps 内应用。 */
  scopeMode: ScreenMemoryScopeMode
  /** 允许采集的前台应用 bundleId 列表；allowlist 模式下生效。 */
  allowedApps: string[]
  /** 排除应用，优先级高于任何允许。 */
  excludedApps: string[]
}

export const DEFAULT_SCREEN_MEMORY_SETTINGS: ScreenMemorySettings = {
  enabled: false,
  paused: false,
  scopeMode: 'all',
  allowedApps: [],
  excludedApps: [],
}

export function getScreenMemoryDirectory(): string {
  const configured = process.env.NXCORE_SCREEN_MEMORY_DIR?.trim()
  if (configured) return configured
  return join(app.getPath('userData'), 'screen-memory')
}

export function getScreenMemoryImagesDirectory(base: string): string {
  return join(base, 'images')
}

export function isAppInScope(settings: ScreenMemorySettings, bundleId: string | null): boolean {
  if (!bundleId) return false
  if (settings.excludedApps.includes(bundleId)) return false
  return settings.scopeMode === 'all' ? true : settings.allowedApps.includes(bundleId)
}

interface SettingsFile {
  version: 1
  settings: ScreenMemorySettings
}

export class ScreenMemorySettingsStore {
  private readonly store: VersionedJsonStore<SettingsFile>
  private cache: ScreenMemorySettings | null = null

  constructor(filePath: string = join(getScreenMemoryDirectory(), 'settings.json'), backupDir?: string) {
    this.store = new VersionedJsonStore<SettingsFile>({
      filePath,
      migrations: [],
      adoptBaseline: (raw) => {
        if (!raw || typeof raw !== 'object') return { version: 1, settings: { ...DEFAULT_SCREEN_MEMORY_SETTINGS } }
        const row = raw as Record<string, unknown>
        const settings = row.settings
        if (!settings || typeof settings !== 'object') {
          return { version: 1, settings: { ...DEFAULT_SCREEN_MEMORY_SETTINGS } }
        }
        const scopeModeRaw = (settings as Record<string, unknown>).scopeMode
        return {
          version: 1,
          settings: {
            enabled: (settings as Record<string, unknown>).enabled === true,
            paused: (settings as Record<string, unknown>).paused === true,
            scopeMode: scopeModeRaw === 'allowlist' ? 'allowlist' : 'all',
            allowedApps: readStringArray((settings as Record<string, unknown>).allowedApps),
            excludedApps: readStringArray((settings as Record<string, unknown>).excludedApps),
          },
        }
      },
      fallback: { version: 1, settings: { ...DEFAULT_SCREEN_MEMORY_SETTINGS } },
      ...(backupDir !== undefined ? { backupDir } : {}),
    })
  }

  read(): ScreenMemorySettings {
    if (this.cache) return this.cache
    this.cache = { ...this.store.read().settings }
    return this.cache
  }

  update(patch: Partial<Omit<ScreenMemorySettings, never>>): ScreenMemorySettings {
    const current = this.read()
    const next: ScreenMemorySettings = {
      enabled: patch.enabled ?? current.enabled,
      paused: patch.paused ?? current.paused,
      scopeMode: patch.scopeMode ?? current.scopeMode,
      allowedApps: patch.allowedApps ?? current.allowedApps,
      excludedApps: patch.excludedApps ?? current.excludedApps,
    }
    this.store.write({ version: 1, settings: next })
    this.cache = next
    return next
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
