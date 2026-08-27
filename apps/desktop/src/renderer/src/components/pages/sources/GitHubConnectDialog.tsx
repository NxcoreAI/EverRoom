import { X } from 'lucide-react'
import type { FormEvent } from 'react'
import { useLocale } from '@/i18n/LocaleContext'
import { SourceIcon } from './SourceIcon'

export interface GitHubConnectionInput {
  repository: string
  branch: string
  token: string
  syncIssues: boolean
}

export function GitHubConnectDialog({
  values,
  busy,
  onChange,
  onClose,
  onSubmit,
}: {
  values: GitHubConnectionInput
  busy: boolean
  onChange: (values: GitHubConnectionInput) => void
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  const { t } = useLocale()
  return (
    <div className="evidence-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <section className="source-connect-dialog" role="dialog" aria-modal="true" aria-labelledby="github-dialog-title">
        <header className="evidence-dialog-head">
          <div><span>{t('surface:gitHubConnectDialog.connectSource')}</span><h2 id="github-dialog-title">{t('surface:gitHubConnectDialog.githubRepository')}</h2><small>{t('surface:gitHubConnectDialog.readOnlySyncForCodeFilesAndIssues')}</small></div>
          <button type="button" className="icon-button" title={t('surface:gitHubConnectDialog.close')} aria-label={t('surface:gitHubConnectDialog.close')} onClick={onClose}><X aria-hidden="true" strokeWidth={1.8} /></button>
        </header>
        <form className="source-connect-form" onSubmit={onSubmit}>
          <label>{t('surface:gitHubConnectDialog.repository')}<input required value={values.repository} placeholder={t('surface:gitHubConnectDialog.ownerRepositoryOrGithubUrl')} onChange={(event) => onChange({ ...values, repository: event.target.value })} /></label>
          <label>{t('surface:gitHubConnectDialog.branchOptional')}<input value={values.branch} placeholder={t('surface:gitHubConnectDialog.defaultBranch')} onChange={(event) => onChange({ ...values, branch: event.target.value })} /></label>
          <label>{t('surface:gitHubConnectDialog.accessTokenOptional')}<input type="password" value={values.token} placeholder={t('surface:gitHubConnectDialog.requiredForPrivateRepositoriesOrHigherRateLimits')} onChange={(event) => onChange({ ...values, token: event.target.value })} /></label>
          <label className="source-connect-check"><input type="checkbox" checked={values.syncIssues} onChange={(event) => onChange({ ...values, syncIssues: event.target.checked })} />{t('surface:gitHubConnectDialog.syncIssuesAndComments')}</label>
          <footer>
            <button type="button" className="secondary-button" onClick={onClose}>{t('surface:gitHubConnectDialog.cancel')}</button>
            <button type="submit" className="primary-button" disabled={busy}><SourceIcon kind="github" />{t('surface:gitHubConnectDialog.connect')}</button>
          </footer>
        </form>
      </section>
    </div>
  )
}
