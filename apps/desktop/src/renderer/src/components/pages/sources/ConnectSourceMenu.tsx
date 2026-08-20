import { CalendarDays, ExternalLink, FileText, FolderOpen, Github, Globe, Mail, Network } from 'lucide-react'
import { useLocale } from '@/i18n/LocaleContext'

export type ConnectorProviderId = 'gmail' | 'outlook' | 'google-calendar' | 'google-docs' | 'notion'

export function ConnectSourceMenu({
  busy,
  onLocalFolder,
  onGitHub,
  onGoogleDocs,
  onNotion,
  connectorsEnabled,
  onConnectorProvider,
}: {
  busy: boolean
  onLocalFolder: () => void
  onGitHub: () => void
  onGoogleDocs: () => void
  onNotion: () => void
  connectorsEnabled?: boolean
  onConnectorProvider?: (provider: ConnectorProviderId) => void
}) {
  const { t } = useLocale()
  return (
    <div className="connect-source-menu" role="menu" aria-label={t('surface:connectSourceMenu.chooseSourceType')}>
      <button type="button" role="menuitem" disabled={busy} onClick={onLocalFolder}>
        <FolderOpen aria-hidden="true" strokeWidth={1.8} /><span><strong>{t('surface:connectSourceMenu.localFolder')}</strong><small>{t('surface:connectSourceMenu.localFolderHint')}</small></span>
      </button>
      <button type="button" role="menuitem" disabled={busy} onClick={onGitHub}>
        <Github aria-hidden="true" strokeWidth={1.8} /><span><strong>GitHub</strong><small>{t('surface:connectSourceMenu.githubHint')}</small></span>
      </button>
      {connectorsEnabled && onConnectorProvider ? (
        <button type="button" role="menuitem" disabled={busy} onClick={() => onConnectorProvider('google-docs')}>
          <FileText aria-hidden="true" strokeWidth={1.8} /><span><strong>Google Docs</strong><small>{t('surface:connectSourceMenu.googleDocsOAuthHint')}</small></span>
        </button>
      ) : (
        <button type="button" role="menuitem" disabled={busy} onClick={onGoogleDocs}>
          <FileText aria-hidden="true" strokeWidth={1.8} /><span><strong>Google Docs</strong><small>{t('surface:connectSourceMenu.googleDocsMarkdownHint')}</small></span>
        </button>
      )}
      {connectorsEnabled && onConnectorProvider ? (
        <button type="button" role="menuitem" disabled={busy} onClick={() => onConnectorProvider('notion')}>
          <Network aria-hidden="true" strokeWidth={1.8} /><span><strong>Notion</strong><small>{t('surface:connectSourceMenu.notionOAuthHint')}</small></span>
        </button>
      ) : (
        <button type="button" role="menuitem" disabled={busy} onClick={onNotion}>
          <Network aria-hidden="true" strokeWidth={1.8} /><span><strong>Notion</strong><small>{t('surface:connectSourceMenu.notionMarkdownHint')}</small></span>
        </button>
      )}
      {connectorsEnabled && onConnectorProvider ? (
        <>
          <button type="button" role="menuitem" disabled={busy} onClick={() => onConnectorProvider('gmail')}>
            <Mail aria-hidden="true" strokeWidth={1.8} /><span><strong>Gmail</strong><small>{t('surface:connectSourceMenu.mailOAuthHint')}</small></span>
          </button>
          <button type="button" role="menuitem" disabled={busy} onClick={() => onConnectorProvider('outlook')}>
            <ExternalLink aria-hidden="true" strokeWidth={1.8} /><span><strong>Outlook</strong><small>{t('surface:connectSourceMenu.mailOAuthHint')}</small></span>
          </button>
          <button type="button" role="menuitem" disabled={busy} onClick={() => onConnectorProvider('google-calendar')}>
            <CalendarDays aria-hidden="true" strokeWidth={1.8} /><span><strong>Google Calendar</strong><small>{t('surface:connectSourceMenu.calendarOAuthHint')}</small></span>
          </button>
        </>
      ) : null}
      <button type="button" role="menuitem" className="connect-source-disabled" disabled>
        <ExternalLink aria-hidden="true" strokeWidth={1.8} /><span><strong>{t('surface:connectSourceMenu.feishu')}</strong><small>{t('surface:connectSourceMenu.readOnlyComingSoon')}</small></span>
      </button>
      <button type="button" role="menuitem" className="connect-source-disabled" disabled>
        <Globe aria-hidden="true" strokeWidth={1.8} /><span><strong>{t('surface:connectSourceMenu.manualWebImport')}</strong><small>{t('surface:connectSourceMenu.urlImportComingSoon')}</small></span>
      </button>
    </div>
  )
}
