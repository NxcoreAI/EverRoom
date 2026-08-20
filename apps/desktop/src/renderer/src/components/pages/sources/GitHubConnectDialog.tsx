import { Github, X } from 'lucide-react'
import type { FormEvent } from 'react'
import { useLocale } from '@/i18n/LocaleContext'

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
          <div><span>{t('连接数据源')}</span><h2 id="github-dialog-title">{t('GitHub 仓库')}</h2><small>{t('只读同步代码文件与 Issue')}</small></div>
          <button type="button" className="icon-button" title={t('关闭')} aria-label={t('关闭')} onClick={onClose}><X aria-hidden="true" strokeWidth={1.8} /></button>
        </header>
        <form className="source-connect-form" onSubmit={onSubmit}>
          <label>{t('仓库地址')}<input required value={values.repository} placeholder={t('owner/repository 或 GitHub URL')} onChange={(event) => onChange({ ...values, repository: event.target.value })} /></label>
          <label>{t('分支（可选）')}<input value={values.branch} placeholder={t('默认分支')} onChange={(event) => onChange({ ...values, branch: event.target.value })} /></label>
          <label>{t('访问令牌（可选）')}<input type="password" value={values.token} placeholder={t('私有仓库或更高速率限制需要')} onChange={(event) => onChange({ ...values, token: event.target.value })} /></label>
          <label className="source-connect-check"><input type="checkbox" checked={values.syncIssues} onChange={(event) => onChange({ ...values, syncIssues: event.target.checked })} />{t('同步 Issue 与评论')}</label>
          <footer>
            <button type="button" className="secondary-button" onClick={onClose}>{t('取消')}</button>
            <button type="submit" className="primary-button" disabled={busy}><Github aria-hidden="true" strokeWidth={1.8} />{t('开始连接')}</button>
          </footer>
        </form>
      </section>
    </div>
  )
}
