import { ArrowRight, Check, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { LocalAgentInstallation } from '../../../../shared/local-agents'
import { SourceIcon } from '@/components/pages/sources/SourceIcon'
import { useLocale } from '@/i18n/LocaleContext'
import './AgentMigrationOnboarding.css'

type AgentMigrationView = 'scanning' | 'empty' | 'select' | 'importing' | 'done' | 'error'

const MIGRATABLE_PROVIDERS = new Set(['codex', 'claude', 'openclaw'])

interface AgentMigrationOnboardingProps {
  onNavigateStage?: (stage: 'memory' | 'room' | 'folder' | 'ready') => void
  onFinished: () => void
}

function agentIconKind(provider: string): 'claude' | 'codex' | 'openclaw' {
  if (provider === 'claude' || provider === 'codex') return provider
  return 'openclaw'
}

export function AgentMigrationOnboarding({ onFinished }: AgentMigrationOnboardingProps) {
  const { t } = useLocale()
  const [view, setView] = useState<AgentMigrationView>('scanning')
  const [agents, setAgents] = useState<LocalAgentInstallation[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [importedSessions, setImportedSessions] = useState<number | null>(null)
  const finishedRef = useRef(false)
  const scanRequestRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const scan = async () => {
      const requestId = ++scanRequestRef.current
      try {
        const discovered = await window.nxcore?.agent?.discoverLocalAgents()
        if (cancelled || requestId !== scanRequestRef.current) return
        const migratable = (discovered ?? []).filter((agent) => MIGRATABLE_PROVIDERS.has(agent.provider) && agent.historyAvailable)
        setAgents(migratable)
        setSelected(new Set(migratable.map((agent) => agent.id)))
        setView(migratable.length ? 'select' : 'empty')
      } catch {
        if (cancelled || requestId !== scanRequestRef.current) return
        setView('empty')
      }
    }
    void scan()
    return () => { cancelled = true }
  }, [])

  const toggle = (agentId: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(agentId)) next.delete(agentId)
      else next.add(agentId)
      return next
    })
  }

  const finish = () => {
    if (finishedRef.current) return
    finishedRef.current = true
    onFinished()
  }

  const importSelected = async () => {
    if (!selected.size || view === 'importing') return
    setView('importing')
    setErrorMessage(null)
    let sessions = 0
    const failures: string[] = []
    for (const agent of agents) {
      if (!selected.has(agent.id)) continue
      try {
        if (agent.provider === 'openclaw') {
          const run = await window.nxcore!.migrations.importOpenClaw()
          sessions += run.threadsCompleted
        } else {
          const result = await window.nxcore!.agent.importLocalAgentHistory(agent.id)
          sessions += result.sessionsImported
        }
      } catch (agentError) {
        if (agent.provider !== 'openclaw') throw agentError
        failures.push(agent.displayName)
      }
    }
    if (failures.length && !sessions) {
      setErrorMessage(t('surface:onboarding.agentMigration.error'))
      setView('error')
      return
    }
    setImportedSessions(sessions)
    setView('done')
  }

  return (
    <section className="agent-migration" data-view={view} aria-live="polite">
      <div className="agent-migration-copy">
        <h1>{t('surface:onboarding.agentMigration.title')}</h1>
      </div>

      {view === 'scanning' ? (
        <div className="agent-migration-stage" role="status">
          <LoaderCircle className="spin" aria-hidden="true" />
          <span>{t('surface:onboarding.agentMigration.scanning')}</span>
        </div>
      ) : null}

      {view === 'empty' ? (
        <div className="agent-migration-stage">
          <span className="agent-migration-empty">{t('surface:onboarding.agentMigration.empty')}</span>
          <button type="button" className="agent-migration-continue" onClick={finish}>
            {t('surface:onboarding.agentMigration.skip')}&nbsp;<ArrowRight aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {view === 'select' ? (
        <div className="agent-migration-select">
          <ul className="agent-migration-list">
            {agents.map((agent) => {
              const checked = selected.has(agent.id)
              return (
                <li key={agent.id}>
                  <button
                    type="button"
                    className="agent-migration-item"
                    data-checked={String(checked)}
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() => toggle(agent.id)}
                  >
                    <span className="agent-migration-item-check">{checked ? <Check aria-hidden="true" /> : null}</span>
                    <SourceIcon kind={agentIconKind(agent.provider)} />
                    <span className="agent-migration-item-copy">
                      <strong>{agent.displayName}</strong>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          <div className="agent-migration-actions">
            <button type="button" className="agent-migration-continue" disabled={!selected.size} onClick={() => void importSelected()}>
              {t('surface:onboarding.agentMigration.importSelected')}
            </button>
            <button type="button" className="agent-migration-skip" onClick={finish}>
              {t('surface:onboarding.agentMigration.skip')}
            </button>
          </div>
        </div>
      ) : null}

      {view === 'importing' ? (
        <div className="agent-migration-stage" role="status">
          <LoaderCircle className="spin" aria-hidden="true" />
          <span>{t('surface:onboarding.agentMigration.importing')}</span>
        </div>
      ) : null}

      {view === 'done' ? (
        <div className="agent-migration-stage">
          <span className="agent-migration-done-icon"><Check aria-hidden="true" /></span>
          <span className="agent-migration-done">{t('surface:onboarding.agentMigration.done', { sessions: importedSessions ?? 0 })}</span>
          <button type="button" className="agent-migration-continue" onClick={finish}>
            {t('surface:onboarding.agentMigration.continue')}&nbsp;<ArrowRight aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {view === 'error' ? (
        <div className="agent-migration-stage">
          <span className="agent-migration-error" role="alert">{errorMessage}</span>
          <div className="agent-migration-actions">
            <button type="button" className="agent-migration-continue" onClick={() => setView('select')}>
              {t('surface:onboarding.agentMigration.retry')}
            </button>
            <button type="button" className="agent-migration-skip" onClick={finish}>
              {t('surface:onboarding.agentMigration.skip')}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
