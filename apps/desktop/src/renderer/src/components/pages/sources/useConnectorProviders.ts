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
  { provider: 'ics-calendar', label: '日历订阅（WebCal/ICS）', category: 'calendar', iconKey: 'ics-calendar', dataTypes: ['calendar'], authChannel: 'webcal-url', connected: false, comingSoon: false },
]

export const FALLBACK_CONNECTOR_PROVIDERS = FALLBACK_PROVIDERS

/**
 * 拉取网关 SyncProvider 注册表元数据（连接菜单/图标/分类的唯一数据源）。
 * 失败回落静态清单——UI 在旧网关/冷启动下保持可用。
 */
export function useConnectorProviders(): { providers: ConnectorProviderSummary[]; loaded: boolean } {
  const [providers, setProviders] = useState<ConnectorProviderSummary[]>(FALLBACK_PROVIDERS)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let active = true
    void window.nxcore?.nangoConnector.providers?.().then((response) => {
      if (!active) return
      if (Array.isArray(response?.providers) && response.providers.length > 0) setProviders(response.providers)
    }).catch(() => undefined).finally(() => {
      if (active) setLoaded(true)
    })
    return () => { active = false }
  }, [])
  return { providers, loaded }
}
