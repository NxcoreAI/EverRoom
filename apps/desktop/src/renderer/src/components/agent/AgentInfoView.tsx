import { Activity, Circle, FileText, LayoutPanelTop } from 'lucide-react'

import type { AgentView } from './AgentToolbar'
import { useLocale } from '@/i18n/LocaleContext'

export function AgentInfoView({
  activeRunId,
  connected,
  messageCount,
  pageLabel,
  view,
}: {
  activeRunId: string | null
  connected: boolean
  messageCount: number
  pageLabel: string
  view: Exclude<AgentView, 'chat'>
}) {
  const { t } = useLocale()
  if (view === 'context') {
    return (
      <section className="agent-detail-view" aria-label={t('surface:agentInfo.currentContext')}>
        <div className="agent-detail-heading">{t('surface:agentInfo.contextForThisTurn')}</div>
        <div className="agent-detail-row">
          <span className="agent-detail-icon"><LayoutPanelTop aria-hidden="true" /></span>
          <span><strong>{pageLabel}</strong><small>{t('surface:agentInfo.currentWorkspace')}</small></span>
        </div>
        <div className="agent-detail-row is-muted">
          <span className="agent-detail-icon"><FileText aria-hidden="true" /></span>
          <span><strong>{t('surface:agentInfo.noSourceSelected')}</strong><small>{t('surface:agentInfo.agentWillNotReadOtherContent')}</small></span>
        </div>
      </section>
    )
  }

  return (
    <section className="agent-detail-view" aria-label={t('surface:agentInfo.recentActivity')}>
      <div className="agent-detail-heading">{t('surface:agentInfo.recentActivity')}</div>
      <div className="agent-detail-row">
        <span className="agent-detail-icon"><Activity aria-hidden="true" /></span>
        <span><strong>{t(activeRunId ? 'surface:agentInfo.agentIsRunning' : 'surface:agentInfo.workspaceReady')}</strong><small>{t('surface:agentInfo.countMessages', { count: messageCount })}</small></span>
      </div>
      <div className="agent-detail-row is-muted">
        <span className="agent-detail-icon"><Circle aria-hidden="true" /></span>
        <span><strong>{t(connected ? 'surface:agentInfo.gatewayConnected' : 'surface:agentInfo.localRuntime')}</strong><small>{t(activeRunId ? 'surface:agentInfo.receivingRunEvents' : 'surface:agentInfo.waitingForTheNextTask')}</small></span>
      </div>
    </section>
  )
}
