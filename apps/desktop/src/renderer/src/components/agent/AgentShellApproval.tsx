import { Check, LoaderCircle, ShieldAlert, Terminal, X } from 'lucide-react'

import { useLocale } from '@/i18n/LocaleContext'

import type { PendingShellApproval } from './agentShellApprovals'
import { AgentDecisionCard, type AgentCardResolve } from './AgentDecisionCard'

export function AgentShellApproval({
  approvals,
  resolvingApprovalIds,
  onResolve,
}: {
  approvals: PendingShellApproval[]
  resolvingApprovalIds: ReadonlySet<string>
  onResolve: (approvalId: string, decision: 'approved' | 'approved_session' | 'denied', feedback?: string, choice?: string, text?: string) => void
}) {
  const { t } = useLocale()
  const approval = approvals[0]
  if (!approval) return null

  const busy = resolvingApprovalIds.has(approval.approvalId)
  // 通用决策卡（agent_confirm / agent_ask_user）：单独的 UI 分流。
  if (approval.kind === 'card' && approval.card) {
    return <AgentDecisionCard approval={approval} busy={busy} onResolve={onResolve as AgentCardResolve} />
  }
  const queuedCount = approvals.length - 1
  const titleKey = approval.kind === 'edit'
    ? 'surface:agentChat.editApprovalTitle'
    : approval.kind === 'tool'
      ? 'surface:agentChat.toolApprovalTitle'
      : 'surface:agentChat.shellApprovalTitle'
  const descriptionKey = approval.kind === 'edit'
    ? 'surface:agentChat.editApprovalDescription'
    : approval.kind === 'tool'
      ? 'surface:agentChat.toolApprovalDescription'
      : 'surface:agentChat.shellApprovalDescription'
  const title = t(titleKey)
  const description = t(descriptionKey)

  return (
    <section className="agent-shell-approval" aria-label={title}>
      <header className="agent-shell-approval-header">
        <span className="agent-shell-approval-icon"><ShieldAlert aria-hidden="true" /></span>
        <span>
          <strong>{title}</strong>
          <small>{description}</small>
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
