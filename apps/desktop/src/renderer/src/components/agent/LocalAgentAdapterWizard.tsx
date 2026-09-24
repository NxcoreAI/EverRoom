import { AlertCircle, Check, Download, LoaderCircle, X } from 'lucide-react'
import { useRef, useState } from 'react'
import type { LocalAgentAdapterCheck } from '../../../../shared/sources'
import { useLocale } from '@/i18n/LocaleContext'
import './LocalAgentAdapterWizard.css'

interface LocalAgentAdapterWizardProps {
  initialChecks: LocalAgentAdapterCheck[]
  onProceed: () => void
  onCancel: () => void
}

const INSTALL_ERROR_KEYS: Record<string, string> = {
  npm_cli_missing: 'builtinNpmMissing',
  npm_install_failed: 'installFailed',
  npm_install_timeout: 'installTimeout',
  installed_but_not_found: 'installedButNotFound',
}

export function LocalAgentAdapterWizard({ initialChecks, onProceed, onCancel }: LocalAgentAdapterWizardProps) {
  const { t } = useLocale()
  const [checks, setChecks] = useState(initialChecks)
  const [installing, setInstalling] = useState(false)
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null)
  const [installErrors, setInstallErrors] = useState<Record<string, { message: string; log?: string }>>({})
  const requestRef = useRef(0)

  const confirmInstall = async () => {
    if (installing) return
    const requestId = ++requestRef.current
    setInstalling(true)
    let allOk = true
    try {
      for (const check of checks) {
        if (check.adapter.installed) continue
        setActiveAgentId(check.agentId)
        setInstallErrors((current) => {
          const { [check.agentId]: _discarded, ...rest } = current
          return rest
        })
        try {
          const outcome = await window.nxcore?.agent?.installLocalAgentAdapter(check.agentId)
          if (requestId !== requestRef.current || !outcome) return
          setChecks((current) => current.map((item) => (
            item.agentId === outcome.agentId
              ? { ...item, adapter: outcome.adapter }
              : item
          )))
          if (!outcome.ok) {
            allOk = false
            const key = outcome.error ? INSTALL_ERROR_KEYS[outcome.error] : undefined
            const message = t(`surface:localAgentAdapterWizard.${key ?? 'installFailed'}`)
            setInstallErrors((current) => ({ ...current, [outcome.agentId]: { message, log: outcome.log } }))
          }
        } catch (error) {
          if (requestId !== requestRef.current) return
          allOk = false
          const message = error instanceof Error ? error.message : String(error)
          setInstallErrors((current) => ({ ...current, [check.agentId]: { message } }))
        }
      }
      if (requestId === requestRef.current && allOk) onProceed()
    } finally {
      if (requestId === requestRef.current) {
        setInstalling(false)
        setActiveAgentId(null)
      }
    }
  }

  return (
    <section className="agent-shell-approval agent-adapter-wizard" aria-label={t('surface:localAgentAdapterWizard.title')}>
      <header className="agent-shell-approval-header">
        <span className="agent-shell-approval-icon"><Download aria-hidden="true" /></span>
        <strong>{t('surface:localAgentAdapterWizard.title')}</strong>
      </header>

      <div className="agent-adapter-wizard-list">
        {checks.map((check) => (
          <div key={check.agentId} className="agent-adapter-wizard-item" data-installed={String(check.adapter.installed)}>
            <span className="agent-adapter-wizard-item-name">{check.displayName}</span>
            {check.adapter.installed ? (
              <em className="agent-adapter-wizard-ready"><Check aria-hidden="true" />{t('surface:localAgentAdapterWizard.itemInstalled')}</em>
            ) : installing && activeAgentId === check.agentId ? (
              <em className="agent-adapter-wizard-busy"><LoaderCircle className="spin" aria-hidden="true" />{t('surface:localAgentAdapterWizard.installingItem')}</em>
            ) : (
              <em className="agent-adapter-wizard-missing">{t('surface:localAgentAdapterWizard.itemMissing')}</em>
            )}
            {installErrors[check.agentId] ? (
              <span className="agent-adapter-wizard-error">
                <AlertCircle aria-hidden="true" />
                {installErrors[check.agentId].message}
                {installErrors[check.agentId].log ? <code>{installErrors[check.agentId].log}</code> : null}
              </span>
            ) : null}
          </div>
        ))}
      </div>

      <footer>
        <button type="button" className="agent-shell-deny" onClick={onCancel}>
          <X aria-hidden="true" />
          {t('surface:localAgentAdapterWizard.cancel')}
        </button>
        {checks.some((check) => !check.adapter.installed) ? (
          <button
            type="button"
            className="agent-shell-approve agent-shell-approve-session"
            disabled={installing}
            onClick={() => void confirmInstall()}
          >
            {installing ? <LoaderCircle className="spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
            {installing
              ? t('surface:localAgentAdapterWizard.installing')
              : t('surface:localAgentAdapterWizard.confirmInstall')}
          </button>
        ) : null}
      </footer>
    </section>
  )
}
