import { Check, LoaderCircle, ShieldAlert, Terminal, X } from 'lucide-react'

import { useLocale } from '@/i18n/LocaleContext'

import type { PendingShellApproval } from './agentShellApprovals'

export function AgentShellApproval({
  approvals,
  resolvingApprovalIds,
  onResolve,
}: {
  approvals: PendingShellApproval[]
  resolvingApprovalIds: ReadonlySet<string>
  onResolve: (approvalId: string, decision: 'approved' | 'approved_session' | 'denied') => void
}) {
  const { t } = useLocale()
  const approval = approvals[0]
  if (!approval) return null

  const busy = resolvingApprovalIds.has(approval.approvalId)
  const queuedCount = approvals.length - 1

  return (
    <section className="agent-shell-approval" aria-label={t('surface:agentChat.shellApprovalTitle')}>
      <header className="agent-shell-approval-header">
        <span className="agent-shell-approval-icon"><ShieldAlert aria-hidden="true" /></span>
        <span>
          <strong>{t('surface:agentChat.shellApprovalTitle')}</strong>
          <small>{t('surface:agentChat.shellApprovalDescription')}</small>
        </span>
        {queuedCount > 0 ? (
          <span className="agent-shell-approval-count">+{queuedCount}</span>
        ) : null}
      </header>

      <div className="agent-shell-command">
        <span><Terminal aria-hidden="true" />{approval.toolName}</span>
        <code>{approval.command}</code>
      </div>

      {approval.cwd ? (
        <div className="agent-shell-approval-detail">
          <span>{t('surface:agentChat.shellWorkingDirectory')}</span>
          <code title={approval.cwd}>{approval.cwd}</code>
        </div>
      ) : null}
      {approval.reason ? <p>{approval.reason}</p> : null}

      <footer>
        <button
          type="button"
          className="agent-shell-deny"
          disabled={busy}
          onClick={() => onResolve(approval.approvalId, 'denied')}
        >
          <X aria-hidden="true" />
          {t('surface:agentChat.shellDeny')}
        </button>
        <button
          type="button"
          className="agent-shell-approve"
          disabled={busy}
          onClick={() => onResolve(approval.approvalId, 'approved')}
        >
          {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
          {busy ? t('surface:agentChat.shellResolving') : t('surface:agentChat.shellApproveOnce')}
        </button>
        <button
          type="button"
          className="agent-shell-approve agent-shell-approve-session"
          disabled={busy}
          onClick={() => onResolve(approval.approvalId, 'approved_session')}
        >
          {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
          {busy ? t('surface:agentChat.shellResolving') : t('surface:agentChat.shellApproveSession')}
        </button>
      </footer>
    </section>
  )
}
