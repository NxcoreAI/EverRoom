import { X } from 'lucide-react'
import type { ConnectorRemoteAccount } from '@nxcore/connector-contract'
import { useLocale } from '@/i18n/LocaleContext'
import { SourceIcon, type SourceIconKind } from './SourceIcon'

/**
 * 重连账号选择：本地已删、远端 oo 租户旧授权仍活跃时弹出——
 * 「使用旧账号」免授权复活（registerConnection）；
 * 「切换其他账号」重新走授权（oo select_account 保证弹账号选择器）。
 */
export function ReconnectAccountDialog({
  account,
  label,
  iconKey,
  busy,
  onClose,
  onReuse,
  onSwitch,
}: {
  account: ConnectorRemoteAccount
  label: string
  iconKey: SourceIconKind
  busy: boolean
  onClose: () => void
  onReuse: (account: ConnectorRemoteAccount) => void
  onSwitch: (account: ConnectorRemoteAccount) => void
}) {
  const { t } = useLocale()
  return (
    <div className="evidence-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <section className="source-connect-dialog" role="dialog" aria-modal="true" aria-labelledby="reconnect-dialog-title">
        <header className="evidence-dialog-head">
          <div><span>{label}</span><h2 id="reconnect-dialog-title">{t('surface:connector.reuseAccountTitle')}</h2></div>
          <button type="button" className="icon-button" title={t('surface:webcalDialog.close')} aria-label={t('surface:webcalDialog.close')} onClick={onClose}><X aria-hidden="true" strokeWidth={1.8} /></button>
        </header>
        <div className="source-connect-form">
          <p>{t('surface:connector.reuseAccountBody', { account: account.displayName ?? label })}</p>
          <footer>
            <button type="button" className="secondary-button" onClick={() => onSwitch(account)}>{t('surface:connector.switchAccount')}</button>
            <button type="button" className="primary-button" disabled={busy} onClick={() => onReuse(account)}><SourceIcon kind={iconKey} />{t('surface:connector.reuseAccount')}</button>
          </footer>
        </div>
      </section>
    </div>
  )
}
