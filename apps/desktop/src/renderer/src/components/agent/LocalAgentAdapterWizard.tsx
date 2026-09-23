import { AlertCircle, Check, Copy, Download, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { useRef, useState } from 'react'
import type { LocalAgentAdapterCheck } from '../../../../shared/sources'
import type { LocalAgentAdapterInstallResult } from '../../../../shared/local-agents'
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
  const [rechecking, setRechecking] = useState(false)
  const [installingAgentId, setInstallingAgentId] = useState<string | null>(null)
  const [installErrors, setInstallErrors] = useState<Record<string, { message: string; log?: string }>>({})
  const [copiedAgentId, setCopiedAgentId] = useState<string | null>(null)
  const requestRef = useRef(0)

  const allInstalled = checks.every((check) => check.adapter.installed)
  const busy = rechecking || installingAgentId !== null

  const recheck = async () => {
    if (busy) return
    const requestId = ++requestRef.current
    setRechecking(true)
    try {
      const next = await window.nxcore?.agent?.checkLocalAgentAdapters(initialChecks.map((check) => check.agentId))
      if (requestId === requestRef.current && next) {
        setChecks(next)
        setInstallErrors({})
      }
    } catch {
      // 检测失败保留当前结果，用户可重试或选择继续发送。
    } finally {
      if (requestId === requestRef.current) setRechecking(false)
    }
  }

  const install = async (agentId: string) => {
    if (busy) return
    const requestId = ++requestRef.current
    setInstallingAgentId(agentId)
    setInstallErrors((current) => {
      const { [agentId]: _discarded, ...rest } = current
      return rest
    })
    try {
      const outcome = await window.nxcore?.agent?.installLocalAgentAdapter(agentId)
      if (requestId !== requestRef.current || !outcome) return
      setChecks((current) => current.map((check) => (
        check.agentId === outcome.agentId
          ? { ...check, adapter: outcome.adapter }
          : check
      )))
      if (!outcome.ok) {
        const key = outcome.error ? INSTALL_ERROR_KEYS[outcome.error] : undefined
        const message = t(`surface:localAgentAdapterWizard.${key ?? 'installFailed'}`)
        setInstallErrors((current) => ({ ...current, [outcome.agentId]: { message, log: outcome.log } }))
      }
    } catch (error) {
      if (requestId !== requestRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      setInstallErrors((current) => ({ ...current, [agentId]: { message } }))
    } finally {
      if (requestId === requestRef.current) setInstallingAgentId(null)
    }
  }

  const copyInstallCommand = async (agentId: string, command: string) => {
    try {
      await navigator.clipboard.writeText(command)
      setCopiedAgentId(agentId)
      setTimeout(() => setCopiedAgentId((current) => (current === agentId ? null : current)), 2_000)
    } catch {
      // 剪贴板不可用时静默失败，用户仍可手动选择文本。
    }
  }

  return (
    <section className="agent-shell-approval agent-adapter-wizard" aria-label={t('surface:localAgentAdapterWizard.title')}>
      <header className="agent-shell-approval-header">
        <span className="agent-shell-approval-icon"><Download aria-hidden="true" /></span>
        <span>
          <strong>{t('surface:localAgentAdapterWizard.title')}</strong>
          <small>{allInstalled
            ? t('surface:localAgentAdapterWizard.installed')
            : t('surface:localAgentAdapterWizard.hint')}</small>
        </span>
      </header>

      <div className="agent-adapter-wizard-list">
        {checks.map((check) => (
          <div key={check.agentId} className="agent-shell-command" data-installed={String(check.adapter.installed)}>
            <span className="agent-adapter-wizard-command-head">
              {check.displayName}
              {check.adapter.installed ? (
                <em className="agent-adapter-wizard-ready"><Check aria-hidden="true" />{t('surface:localAgentAdapterWizard.itemInstalled')}</em>
              ) : null}
              {!check.adapter.installed && check.adapter.installCommand ? (
                <button
                  type="button"
                  className="agent-adapter-wizard-copy"
                  disabled={busy}
                  onClick={() => void copyInstallCommand(check.agentId, check.adapter.installCommand!)}
                >
                  <Copy aria-hidden="true" />
                  {copiedAgentId === check.agentId
                    ? t('surface:localAgentAdapterWizard.copied')
                    : t('surface:localAgentAdapterWizard.copy')}
                </button>
              ) : null}
            </span>
            {!check.adapter.installed ? (
              <button
                type="button"
                className="agent-adapter-wizard-install"
                disabled={busy}
                onClick={() => void install(check.agentId)}
              >
                {installingAgentId === check.agentId ? <LoaderCircle className="spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
                {installingAgentId === check.agentId
                  ? t('surface:localAgentAdapterWizard.installing')
                  : t('surface:localAgentAdapterWizard.install')}
              </button>
            ) : null}
            {installErrors[check.agentId] ? (
              <span className="agent-adapter-wizard-error">
                <AlertCircle aria-hidden="true" />
                {installErrors[check.agentId].message}
                {installErrors[check.agentId].log ? <code>{installErrors[check.agentId].log}</code> : null}
              </span>
            ) : null}
            <code>{check.adapter.installCommand ?? check.adapter.command}</code>
          </div>
        ))}
      </div>

      <footer>
        <button type="button" className="agent-shell-deny" disabled={busy} onClick={onCancel}>
          <X aria-hidden="true" />
          {t('surface:localAgentAdapterWizard.cancel')}
        </button>
        {!allInstalled ? (
          <button type="button" className="agent-shell-approve" disabled={busy} onClick={() => void recheck()}>
            {rechecking ? <LoaderCircle className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            {t('surface:localAgentAdapterWizard.recheck')}
          </button>
        ) : null}
        <button
          type="button"
          className="agent-shell-approve agent-shell-approve-session"
          disabled={busy}
          onClick={onProceed}
        >
          {allInstalled ? <Check aria-hidden="true" /> : null}
          {allInstalled
            ? t('surface:localAgentAdapterWizard.send')
            : t('surface:localAgentAdapterWizard.sendAnyway')}
        </button>
      </footer>
    </section>
  )
}
