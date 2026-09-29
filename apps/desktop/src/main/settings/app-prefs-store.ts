import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { AppPrefs } from '../../shared/sources'

export type { AppPrefs }

export const DEFAULT_APP_PREFS: AppPrefs = {
  saasBaseUrl: null,
  updateFeedUrl: null,
  crashReporting: true,
}

/** 仅接受 http(s) 绝对地址并去尾斜杠；空串/非字符串/协议不对一律归 null。 */
function normalizeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  } catch {
    return null
  }
  return trimmed.replace(/\/+$/, '')
}

/** patch 语义：字段出现即校验赋值（显式清空传 null/空串），缺省不动。 */
export function pickAppPrefsPatch(raw: unknown): Partial<AppPrefs> {
  const patch: Partial<AppPrefs> = {}
  if (!raw || typeof raw !== 'object') return patch
  const value = raw as Record<string, unknown>
  if ('saasBaseUrl' in value) patch.saasBaseUrl = normalizeUrl(value.saasBaseUrl)
  if ('updateFeedUrl' in value) patch.updateFeedUrl = normalizeUrl(value.updateFeedUrl)
  if (typeof value.crashReporting === 'boolean') patch.crashReporting = value.crashReporting
  return patch
}

export function normalizeAppPrefs(raw: unknown): AppPrefs {
  const picked = pickAppPrefsPatch(raw)
  return {
    saasBaseUrl: picked.saasBaseUrl ?? null,
    updateFeedUrl: picked.updateFeedUrl ?? null,
    crashReporting: picked.crashReporting ?? true,
  }
}

const listeners = new Set<(prefs: AppPrefs) => void>()
let prefsFile: string | null = null
let cached: AppPrefs | null = null

/** 路径由 IPC 注册方注入（app.getPath 需在 electron ready 后可用），也让本模块可脱离 electron 测试。 */
export function initAppPrefsStore(file: string): void {
  prefsFile = file
  cached = null
}

export function getAppPrefs(): AppPrefs {
  if (cached) return cached
  let loaded = { ...DEFAULT_APP_PREFS }
  if (prefsFile && existsSync(prefsFile)) {
    try {
      loaded = normalizeAppPrefs(JSON.parse(readFileSync(prefsFile, 'utf8')))
    } catch {
      // 损坏文件按默认值重建
    }
  }
  cached = loaded
  return cached
}

export function updateAppPrefs(patch: Partial<AppPrefs>): AppPrefs {
  const next = { ...getAppPrefs(), ...patch }
  cached = next
  if (prefsFile) {
    try {
      writeFileSync(prefsFile, JSON.stringify(next, null, 2), 'utf8')
    } catch (error) {
      console.warn('[desktop/app-prefs] persist failed |', error)
    }
  }
  for (const listener of listeners) listener(next)
  return next
}

export function onAppPrefsChanged(listener: (prefs: AppPrefs) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** SaaS 基地址解析：用户覆盖优先，未设置回落环境默认（默认值的 /api/v1 补齐等归调用方 normalizeSaasApiUrl）。 */
export function resolveSaasBaseUrl(defaultFromEnv: string): string {
  return getAppPrefs().saasBaseUrl ?? defaultFromEnv
}
