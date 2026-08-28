import { useLocale } from '@/i18n/LocaleContext'
import { SourceIcon } from './SourceIcon'

export type ConnectorProviderId = 'gmail' | 'outlook' | 'google-calendar' | 'google-docs' | 'notion'

export function ConnectSourceMenu({
  busy,
  onLocalFolder,
  onObsidian,
  onGitHub,
  onGoogleDocs,
  onNotion,
  onNotionZip,
  onOpenClaw,
  connectorsEnabled,
  onConnectorProvider,
}: {
  busy: boolean
  onLocalFolder: () => void
  onObsidian: () => void
  onGitHub: () => void
  onGoogleDocs: () => void
  onNotion: () => void
  onNotionZip: () => void
  onOpenClaw: () => void
  connectorsEnabled?: boolean
  onConnectorProvider?: (provider: ConnectorProviderId) => void
}) {
  const { t } = useLocale()
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
      {connectorsEnabled && onConnectorProvider ? (
        <>
          <button type="button" role="menuitem" disabled={busy} onClick={() => onConnectorProvider('gmail')}>
            <SourceIcon kind="gmail" /><span><strong>Gmail</strong><small>{t('surface:connectSourceMenu.mailOAuthHint')}</small></span>
          </button>
          <button type="button" role="menuitem" disabled={busy} onClick={() => onConnectorProvider('outlook')}>
            <SourceIcon kind="outlook" /><span><strong>Outlook</strong><small>{t('surface:connectSourceMenu.mailOAuthHint')}</small></span>
          </button>
          <button type="button" role="menuitem" disabled={busy} onClick={() => onConnectorProvider('google-calendar')}>
            <SourceIcon kind="google-calendar" /><span><strong>Google Calendar</strong><small>{t('surface:connectSourceMenu.calendarOAuthHint')}</small></span>
          </button>
        </>
      ) : null}
      <button type="button" role="menuitem" className="connect-source-disabled" disabled>
        <SourceIcon kind="feishu" /><span><strong>{t('surface:connectSourceMenu.feishu')}</strong><small>{t('surface:connectSourceMenu.readOnlyComingSoon')}</small></span>
      </button>
      <button type="button" role="menuitem" className="connect-source-disabled" disabled>
        <SourceIcon kind="web-page" /><span><strong>{t('surface:connectSourceMenu.manualWebImport')}</strong><small>{t('surface:connectSourceMenu.urlImportComingSoon')}</small></span>
      </button>
    </div>
  )
}
