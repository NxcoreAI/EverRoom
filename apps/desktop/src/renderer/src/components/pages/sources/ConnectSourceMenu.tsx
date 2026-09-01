import { useLocale } from '@/i18n/LocaleContext'
import type { ConnectorProviderSummary } from '../../../../../shared/sources'
import { SourceIcon, type SourceIconKind } from './SourceIcon'
import { FALLBACK_CONNECTOR_PROVIDERS } from './useConnectorProviders'

/**
 * 兼容导出：provider 注册名已开放（网关 SyncProvider 注册表），不再是闭集字面量。
 */
export type ConnectorProviderId = string

export function ConnectSourceMenu({
  busy,
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
  return (
    <div className="connect-source-menu" role="menu" aria-label={t('surface:connectSourceMenu.chooseSourceType')}>
      <button type="button" role="menuitem" disabled={busy} onClick={onLocalFolder}>
        <SourceIcon kind="local-folder" /><span><strong>{t('surface:connectSourceMenu.localFolder')}</strong><small>{t('surface:connectSourceMenu.localFolderHint')}</small></span>
      </button>
      <button type="button" role="menuitem" disabled={busy} onClick={onObsidian}>
        <SourceIcon kind="obsidian-vault" /><span><strong>Obsidian Vault</strong><small>{t('surface:connectSourceMenu.obsidianHint')}</small></span>
      </button>
      <button type="button" role="menuitem" disabled={busy} onClick={onGitHub}>
        <SourceIcon kind="github" /><span><strong>GitHub</strong><small>{t('surface:connectSourceMenu.githubHint')}</small></span>
      </button>
      <button type="button" role="menuitem" disabled={busy} onClick={() => onLocalAgentHistory('claude')}>
        <SourceIcon kind="claude" /><span><strong>Claude Code</strong><small>{t('surface:connectSourceMenu.localAgentHistoryHint')}</small></span>
      </button>
      <button type="button" role="menuitem" disabled={busy} onClick={() => onLocalAgentHistory('codex')}>
        <SourceIcon kind="codex" /><span><strong>Codex</strong><small>{t('surface:connectSourceMenu.localAgentHistoryHint')}</small></span>
      </button>
      {connectorsEnabled && onConnectorProvider ? (
        <button type="button" role="menuitem" disabled={busy} onClick={() => onConnectorProvider('google-docs')}>
          <SourceIcon kind="google-docs" /><span><strong>Google Docs</strong><small>{t('surface:connectSourceMenu.googleDocsOAuthHint')}</small></span>
        </button>
      ) : (
        <button type="button" role="menuitem" disabled={busy} onClick={onGoogleDocs}>
          <SourceIcon kind="google-docs" /><span><strong>Google Docs</strong><small>{t('surface:connectSourceMenu.googleDocsMarkdownHint')}</small></span>
        </button>
      )}
      <button type="button" role="menuitem" disabled={busy} onClick={onNotionZip}>
        <SourceIcon kind="notion" /><span><strong>Notion ZIP</strong><small>{t('surface:connectSourceMenu.notionZipHint')}</small></span>
      </button>
      <button type="button" role="menuitem" disabled={busy} onClick={onOpenClaw}>
        <SourceIcon kind="openclaw" /><span><strong>OpenClaw</strong><small>{t('surface:connectSourceMenu.openClawHint')}</small></span>
      </button>
      {connectorsEnabled && onConnectorProvider ? (
        <button type="button" role="menuitem" disabled={busy} onClick={() => onConnectorProvider('notion')}>
          <SourceIcon kind="notion" /><span><strong>Notion</strong><small>{t('surface:connectSourceMenu.notionOAuthHint')}</small></span>
        </button>
      ) : (
        <button type="button" role="menuitem" disabled={busy} onClick={onNotion}>
          <SourceIcon kind="notion" /><span><strong>Notion</strong><small>{t('surface:connectSourceMenu.notionMarkdownHint')}</small></span>
        </button>
      )}
      {connectorsEnabled && onConnectorProvider
        // 注册表驱动：mail/calendar 类 OAuth 源（新增 provider 自动出现）。
        ? oauthFeeds.map((item) => (
          <button key={item.provider} type="button" role="menuitem" disabled={busy} onClick={() => onConnectorProvider(item.provider)}>
            <SourceIcon kind={(item.iconKey as SourceIconKind) ?? 'web-page'} /><span><strong>{item.label}</strong><small>{t(item.category === 'mail' ? 'surface:connectSourceMenu.mailOAuthHint' : 'surface:connectSourceMenu.calendarOAuthHint')}</small></span>
          </button>
        ))
        : null}
      {connectorsEnabled && onWebcalSubscription
        // webcal-url 通道：订阅任意网站发布的日历（无 OAuth）。
        ? webcalFeeds.map((item) => (
          <button key={item.provider} type="button" role="menuitem" disabled={busy} onClick={onWebcalSubscription}>
            <SourceIcon kind="ics-calendar" /><span><strong>{t('surface:connectSourceMenu.webcalSubscription')}</strong><small>{t('surface:connectSourceMenu.webcalHint')}</small></span>
          </button>
        ))
        : null}
      <button type="button" role="menuitem" className="connect-source-disabled" disabled>
        <SourceIcon kind="feishu" /><span><strong>{t('surface:connectSourceMenu.feishu')}</strong><small>{t('surface:connectSourceMenu.readOnlyComingSoon')}</small></span>
      </button>
      <button type="button" role="menuitem" className="connect-source-disabled" disabled>
        <SourceIcon kind="web-page" /><span><strong>{t('surface:connectSourceMenu.manualWebImport')}</strong><small>{t('surface:connectSourceMenu.urlImportComingSoon')}</small></span>
      </button>
    </div>
  )
}
