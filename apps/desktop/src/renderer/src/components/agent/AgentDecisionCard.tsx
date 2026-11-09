import { useState } from 'react'
import { useLocale } from '@/i18n/LocaleContext'
import { CheckCircle2, CircleHelp, ClipboardList, X } from 'lucide-react'

import type { PendingShellApproval } from './agentShellApprovals'

export type AgentCardResolve = (
  approvalId: string,
  decision: 'approved' | 'denied',
  feedback?: string,
  choice?: string,
  text?: string,
) => void

/**
 * 通用决策卡：agent_confirm（计划确认）与 agent_ask_user（提问等回答）的 UI。
 * 骑在 approval 事件通道上（kind:"card"），由 AgentShellApproval 分流到这里。
 */
export function AgentDecisionCard({
  approval,
  busy,
  onResolve,
}: {
  approval: PendingShellApproval
  busy: boolean
  onResolve: AgentCardResolve
}) {
  const { t } = useLocale()
  const [text, setText] = useState('')
  const card = approval.card
  if (!card) return null
  const isConfirm = card.kind === 'confirm'

  return (
    <section className="agent-shell-approval agent-decision-card" data-card-kind={card.kind}>
      <header className="agent-shell-approval-header">
        <span className="agent-shell-approval-icon">
          {isConfirm
            ? <ClipboardList aria-hidden="true" />
            : <CircleHelp aria-hidden="true" />}
        </span>
        <span>
          <strong>{isConfirm
            ? t('surface:agentChat.cardConfirmTitle')
            : t('surface:agentChat.cardQuestionTitle')}</strong>
          <small>{card.title}</small>
        </span>
      </header>

      {card.body ? <p className="agent-decision-card-body">{card.body}</p> : null}

      {isConfirm && card.plan?.length ? (
        <ol className="agent-decision-card-plan">
          {card.plan.map((step, index) => <li key={index}>{step}</li>)}
        </ol>
      ) : null}

      {isConfirm && card.palette?.length ? (
        <div className="agent-decision-card-swatches" aria-label="配色方案">
          {card.palette.map((hex) => (
            <span key={hex} className="agent-decision-card-swatch" title={hex}>
              <span className="agent-decision-card-swatch-chip" style={{ background: hex }} aria-hidden="true" />
              <small>{hex}</small>
            </span>
          ))}
        </div>
      ) : null}

      {isConfirm && (card.fonts?.heading || card.fonts?.body) ? (
        <div className="agent-decision-card-fonts">
          <span>{t('surface:agentChat.cardFonts')}</span>
          <code>{[card.fonts.heading, card.fonts.body].filter(Boolean).join(' / ')}</code>
        </div>
      ) : null}

      {isConfirm && card.notes?.length ? (
        <ul className="agent-decision-card-notes">
          {card.notes.map((note, index) => <li key={index}>{note}</li>)}
        </ul>
      ) : null}

      {!isConfirm && card.options?.length ? (
        <div className="agent-decision-card-options">
          {card.options.map((option) => (
            <button
              key={option}
              type="button"
              className="agent-decision-card-option"
              disabled={busy}
              onClick={() => onResolve(approval.approvalId, 'approved', undefined, option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}

      {!isConfirm || card.allowText ? (
        <textarea
          className="agent-decision-card-input"
          rows={2}
          placeholder={isConfirm
            ? t('surface:agentChat.cardConfirmFeedbackPlaceholder')
            : t('surface:agentChat.cardAnswerPlaceholder')}
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
        />
      ) : null}

      <footer>
        {isConfirm ? (
          <>
            <button
              type="button"
              className="agent-shell-deny"
              disabled={busy}
              onClick={() => onResolve(approval.approvalId, 'denied', text.trim() || undefined, 'denied')}
            >
              <X aria-hidden="true" />
              {t('surface:agentChat.cardCancel')}
            </button>
            <button
              type="button"
              className="agent-shell-approve"
              disabled={busy}
              onClick={() => onResolve(approval.approvalId, 'approved', text.trim() || undefined, 'approved')}
            >
              <CheckCircle2 aria-hidden="true" />
              {t('surface:agentChat.cardConfirm')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="agent-shell-approve"
            disabled={busy || (!text.trim() && !card.options?.length)}
            onClick={() => onResolve(approval.approvalId, 'approved', undefined, '', text.trim() || undefined)}
          >
            <CheckCircle2 aria-hidden="true" />
            {t('surface:agentChat.cardSubmit')}
          </button>
        )}
      </footer>
    </section>
  )
}
