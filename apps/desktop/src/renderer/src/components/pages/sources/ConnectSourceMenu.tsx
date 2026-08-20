import { CalendarDays, ExternalLink, FileText, FolderOpen, Github, Globe, Mail, Network } from 'lucide-react'

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
  return (
    <div className="connect-source-menu" role="menu" aria-label="选择数据源类型">
      <button type="button" role="menuitem" disabled={busy} onClick={onLocalFolder}>
        <FolderOpen aria-hidden="true" strokeWidth={1.8} /><span><strong>本地文件夹</strong><small>扫描本机目录中的文件</small></span>
      </button>
      <button type="button" role="menuitem" disabled={busy} onClick={onGitHub}>
        <Github aria-hidden="true" strokeWidth={1.8} /><span><strong>GitHub</strong><small>同步仓库代码与 Issue</small></span>
      </button>
      {connectorsEnabled && onConnectorProvider ? (
        <button type="button" role="menuitem" disabled={busy} onClick={() => onConnectorProvider('google-docs')}>
          <FileText aria-hidden="true" strokeWidth={1.8} /><span><strong>Google Docs</strong><small>OAuth 授权并同步文档进记忆</small></span>
        </button>
      ) : (
        <button type="button" role="menuitem" disabled={busy} onClick={onGoogleDocs}>
          <FileText aria-hidden="true" strokeWidth={1.8} /><span><strong>Google Docs</strong><small>转换为 Markdown 并同步到 LLM wiki</small></span>
        </button>
      )}
      {connectorsEnabled && onConnectorProvider ? (
        <button type="button" role="menuitem" disabled={busy} onClick={() => onConnectorProvider('notion')}>
          <Network aria-hidden="true" strokeWidth={1.8} /><span><strong>Notion</strong><small>OAuth 授权并同步页面进记忆</small></span>
        </button>
      ) : (
        <button type="button" role="menuitem" disabled={busy} onClick={onNotion}>
          <Network aria-hidden="true" strokeWidth={1.8} /><span><strong>Notion</strong><small>同步页面并转换为 Markdown</small></span>
        </button>
      )}
      {connectorsEnabled && onConnectorProvider ? (
        <>
          <button type="button" role="menuitem" disabled={busy} onClick={() => onConnectorProvider('gmail')}>
            <Mail aria-hidden="true" strokeWidth={1.8} /><span><strong>Gmail</strong><small>OAuth 授权并同步邮件进记忆</small></span>
          </button>
          <button type="button" role="menuitem" disabled={busy} onClick={() => onConnectorProvider('outlook')}>
            <ExternalLink aria-hidden="true" strokeWidth={1.8} /><span><strong>Outlook</strong><small>OAuth 授权并同步邮件进记忆</small></span>
          </button>
          <button type="button" role="menuitem" disabled={busy} onClick={() => onConnectorProvider('google-calendar')}>
            <CalendarDays aria-hidden="true" strokeWidth={1.8} /><span><strong>Google Calendar</strong><small>OAuth 授权并同步日程进记忆</small></span>
          </button>
        </>
      ) : null}
      <button type="button" role="menuitem" className="connect-source-disabled" disabled>
        <ExternalLink aria-hidden="true" strokeWidth={1.8} /><span><strong>飞书文档 / 云盘</strong><small>即将支持只读同步</small></span>
      </button>
      <button type="button" role="menuitem" className="connect-source-disabled" disabled>
        <Globe aria-hidden="true" strokeWidth={1.8} /><span><strong>手动网页导入</strong><small>即将支持 URL 导入</small></span>
      </button>
    </div>
  )
}
