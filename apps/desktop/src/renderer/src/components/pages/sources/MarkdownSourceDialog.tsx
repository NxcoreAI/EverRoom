import { FileText, Network, X } from 'lucide-react'
import type { FormEvent } from 'react'
import { useLocale } from '@/i18n/LocaleContext'

export function MarkdownSourceDialog({ kind, value, busy, onChange, onClose, onSubmit }: { kind: 'google-docs' | 'notion'; value: { ids: string; token: string }; busy: boolean; onChange: (value: { ids: string; token: string }) => void; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const { t } = useLocale()
  const google = kind === 'google-docs'
  return <div className="evidence-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
    <section className="source-connect-dialog" role="dialog" aria-modal="true" aria-labelledby="markdown-source-dialog-title">
      <header className="evidence-dialog-head"><div><span>{t('surface:markdownSourceDialog.connectSource')}</span><h2 id="markdown-source-dialog-title">{google ? 'Google Docs' : 'Notion'}</h2><small>{t('surface:markdownSourceDialog.readOnlyContentIsSyncedAsMarkdownAnd')}</small></div><button type="button" className="icon-button" title={t('surface:markdownSourceDialog.close')} aria-label={t('surface:markdownSourceDialog.close')} onClick={onClose}><X aria-hidden="true" strokeWidth={1.8} /></button></header>
      <form className="source-connect-form" onSubmit={onSubmit}>
        <label>{t(google ? 'surface:markdownSourceDialog.documentIdOrUrl' : 'surface:markdownSourceDialog.pageIdOrUrl')}<textarea required rows={4} value={value.ids} placeholder={google ? 'https://docs.google.com/document/d/.../edit' : 'https://www.notion.so/...'} onChange={(event) => onChange({ ...value, ids: event.target.value })} /></label>
        <label>{google ? 'OAuth access token' : 'Notion integration token'}<input required type="password" value={value.token} onChange={(event) => onChange({ ...value, token: event.target.value })} /></label>
        <footer><button type="button" className="secondary-button" onClick={onClose}>{t('surface:markdownSourceDialog.cancel')}</button><button type="submit" className="primary-button" disabled={busy}>{google ? <FileText aria-hidden="true" strokeWidth={1.8} /> : <Network aria-hidden="true" strokeWidth={1.8} />}{t('surface:markdownSourceDialog.startSync')}</button></footer>
      </form>
    </section>
  </div>
}
