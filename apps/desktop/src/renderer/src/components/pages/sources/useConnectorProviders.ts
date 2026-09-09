import { useEffect, useState } from 'react'
import type { ConnectorProviderSummary } from '../../../../../shared/sources'

/**
 * 注册表元数据静态兜底清单（旧网关无 /providers 端点、或网关暂不可达时）。
 * 与 gateway sync-providers 注册表保持同值——运行时优先端点数据（新 provider
 * 自动出现），此处仅为兼容底座，不承载新 provider 的首发。
 */
const FALLBACK_PROVIDERS: ConnectorProviderSummary[] = [
  { provider: 'gmail', label: 'Gmail', category: 'mail', iconKey: 'gmail', dataTypes: ['mail'], authChannel: 'nango-oauth', connected: false, comingSoon: false },
  { provider: 'outlook', label: 'Outlook', category: 'mail', iconKey: 'outlook', dataTypes: ['mail'], authChannel: 'nango-oauth', connected: false, comingSoon: false },
  { provider: 'google-calendar', label: 'Google Calendar', category: 'calendar', iconKey: 'google-calendar', dataTypes: ['calendar'], authChannel: 'nango-oauth', connected: false, comingSoon: false },
  { provider: 'google-docs', label: 'Google Docs', category: 'docs', iconKey: 'google-docs', dataTypes: ['document'], authChannel: 'nango-oauth', connected: false, comingSoon: false },
  { provider: 'notion', label: 'Notion', category: 'docs', iconKey: 'notion', dataTypes: ['document'], authChannel: 'nango-oauth', connected: false, comingSoon: false },
  { provider: 'feishu', label: '飞书', category: 'docs', iconKey: 'feishu', dataTypes: ['document'], authChannel: 'nango-oauth', connected: false, comingSoon: false },
  { provider: 'ics-calendar', label: '日历订阅（WebCal/ICS）', category: 'calendar', iconKey: 'ics-calendar', dataTypes: ['calendar'], authChannel: 'webcal-url', connected: false, comingSoon: false },
]

export const FALLBACK_CONNECTOR_PROVIDERS = FALLBACK_PROVIDERS

/**
 * 拉取网关 SyncProvider 注册表元数据（连接菜单/图标/分类的唯一数据源）。
 * 并行拉取 SaaS 已配置 OAuth 的 provider 名单：非 null 时「待连接」云端组只
 * 显示这些（见 ConnectGrid）；null（未登录/local 模式/拉取失败）回落静态清单。
 * 失败回落静态清单——UI 在旧网关/冷启动下保持可用。
 */
export function useConnectorProviders(): { providers: ConnectorProviderSummary[]; loaded: boolean; configuredProviders: ReadonlySet<string> | null } {
  const [providers, setProviders] = useState<ConnectorProviderSummary[]>(FALLBACK_PROVIDERS)
  const [configuredProviders, setConfiguredProviders] = useState<ReadonlySet<string> | null>(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let active = true
    const oauthConfigs = window.nxcore?.nangoConnector.oauthConfigs?.().catch(() => null) ?? Promise.resolve(null)
    void Promise.all([
      window.nxcore?.nangoConnector.providers?.().catch(() => null) ?? Promise.resolve(null),
      oauthConfigs,
    ]).then(([response, configs]) => {
      if (!active) return
      if (Array.isArray(response?.providers) && response.providers.length > 0) setProviders(response.providers)
      if (configs) setConfiguredProviders(new Set(configs))
    }).finally(() => {
      if (active) setLoaded(true)
    })
    return () => { active = false }
  }, [])
  return { providers, loaded, configuredProviders }
}
