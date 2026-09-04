import type { ConnectorProviderSummary } from '../../../../../shared/sources'
import { SourceIcon, type SourceIconKind } from './SourceIcon'
import { FALLBACK_CONNECTOR_PROVIDERS } from './useConnectorProviders'
import { useLocale } from '@/i18n/LocaleContext'

/**
 * 兼容导出：provider 注册名已开放（网关 SyncProvider 注册表），不再是闭集字面量。
 */
export type ConnectorProviderId = string

type ConnectItem = {
  key: string
  icon: SourceIconKind
  glyph?: boolean
  label: string
  group: 'local' | 'cloud' | 'import'
  onSelect: () => void
}

function Grid({ items, busy }: { items: ConnectItem[]; busy: boolean }) {
  return (
    <div className="src-connect-grid">
      {items.map((item) => (
        <button key={item.key} type="button" className="src-connect-tile" disabled={busy} onClick={item.onSelect}>
          <span className="src-connect-tile-icon"><SourceIcon kind={item.icon} className={item.glyph ? 'glyph' : ''} /></span>
          <span className="src-connect-tile-label">{item.label}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * 连接入口平铺（替代原右上角下拉菜单）。传 limit 时只渲染前 limit 项,
 * 超出且给了 onViewAll 则追加「查看全部」进二级页；不传 limit 按分组全量展示。
 */
export function ConnectGrid({
  busy,
  limit,
  onViewAll,
  onLocalFolder,
  onObsidian,
  onGitHub,
  onGoogleDocs,
  onNotion,
  onNotionZip,
  onOpenClaw,
  onLocalAgentHistory,
  connectorsEnabled,
  onConnectorProvider,
  providers,
  onWebcalSubscription,
}: {
  busy: boolean
  limit?: number
  onViewAll?: () => void
  onLocalFolder: () => void
  onObsidian: () => void
  onGitHub: () => void
  onGoogleDocs: () => void
  onNotion: () => void
  onNotionZip: () => void
  onOpenClaw: () => void
  onLocalAgentHistory: (provider: 'codex' | 'claude') => void
  connectorsEnabled?: boolean
  onConnectorProvider?: (provider: ConnectorProviderId) => void
  /** 网关注册表元数据（缺省回落静态清单）——mail/calendar OAuth 与 webcal 订阅由它驱动。 */
  providers?: ConnectorProviderSummary[]
  onWebcalSubscription?: () => void
}) {
  const { t } = useLocale()
  const metadata = providers ?? FALLBACK_CONNECTOR_PROVIDERS
  const oauthFeeds = metadata.filter((item) =>
    item.authChannel === 'nango-oauth' && !item.comingSoon && (item.category === 'mail' || item.category === 'calendar'))
  const webcalFeeds = metadata.filter((item) => item.authChannel === 'webcal-url' && !item.comingSoon)
  const cloud: ConnectItem[] = connectorsEnabled && onConnectorProvider
    ? [
        { key: 'google-docs', icon: 'google-docs', label: 'Google Docs', group: 'cloud', onSelect: () => onConnectorProvider('google-docs') },
        { key: 'notion', icon: 'notion', label: 'Notion', group: 'cloud', onSelect: () => onConnectorProvider('notion') },
        // 注册表驱动：mail/calendar 类 OAuth 源（新增 provider 自动出现）。
        ...oauthFeeds.map((item) => ({
          key: `oauth-${item.provider}`,
          icon: (item.iconKey as SourceIconKind) ?? 'web-page',
          label: item.label,
          group: 'cloud' as const,
          onSelect: () => onConnectorProvider(item.provider),
        })),
        // webcal-url 通道：订阅任意网站发布的日历（无 OAuth）。
        ...(onWebcalSubscription ? webcalFeeds.map((item) => ({
          key: `webcal-${item.provider}`,
          icon: 'ics-calendar' as SourceIconKind,
          glyph: true,
          label: t('surface:connectSourceMenu.webcalSubscription'),
          group: 'cloud' as const,
          onSelect: onWebcalSubscription,
        })) : []),
      ]
    : [
        { key: 'google-docs', icon: 'google-docs', label: 'Google Docs', group: 'cloud', onSelect: onGoogleDocs },
        { key: 'notion', icon: 'notion', label: 'Notion', group: 'cloud', onSelect: onNotion },
      ]
  const items: ConnectItem[] = [
    { key: 'local-folder', icon: 'local-folder', glyph: true, label: t('surface:connectSourceMenu.localFolder'), group: 'local', onSelect: onLocalFolder },
    { key: 'obsidian', icon: 'obsidian-vault', label: 'Obsidian', group: 'local', onSelect: onObsidian },
    { key: 'github', icon: 'github', label: 'GitHub', group: 'local', onSelect: onGitHub },
    ...cloud,
    { key: 'notion-zip', icon: 'notion', label: 'Notion ZIP', group: 'import', onSelect: onNotionZip },
    { key: 'claude', icon: 'claude', label: 'Claude Code', group: 'import', onSelect: () => onLocalAgentHistory('claude') },
    { key: 'codex', icon: 'codex', label: 'Codex', group: 'import', onSelect: () => onLocalAgentHistory('codex') },
    { key: 'openclaw', icon: 'openclaw', label: 'OpenClaw', group: 'import', onSelect: onOpenClaw },
  ]

  if (limit !== undefined) {
    return (
      <div>
        <Grid items={items.slice(0, limit)} busy={busy} />
        {onViewAll && items.length > limit ? (
          <button type="button" className="src-connect-more" onClick={onViewAll}>
            {t('surface:sources.viewAllCounted', { count: items.length })}
          </button>
        ) : null}
      </div>
    )
  }

  const groups: Array<{ id: ConnectItem['group']; label: string }> = [
    { id: 'local', label: t('surface:connectSourceMenu.groupLocal') },
    { id: 'cloud', label: t('surface:connectSourceMenu.groupCloud') },
    { id: 'import', label: t('surface:connectSourceMenu.groupImport') },
  ]
  return (
    <div className="src-connect-groups">
      {groups.map((group) => (
        <div key={group.id} className="src-connect-group">
          <small>{group.label}</small>
          <Grid items={items.filter((item) => item.group === group.id)} busy={busy} />
        </div>
      ))}
    </div>
  )
}
