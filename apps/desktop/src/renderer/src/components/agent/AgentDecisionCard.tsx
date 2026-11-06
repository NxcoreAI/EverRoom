import { useState } from 'react'
import { Check, LoaderCircle, MessageCircleQuestion, ShieldAlert, X } from 'lucide-react'

import { useLocale } from '@/i18n/LocaleContext'

import type { PendingShellApproval } from './agentShellApprovals'

/** 决策卡回填：confirm → approved/denied（+反馈）；question → choice/text（作答）。 */
export type AgentCardResolve = (
  approvalId: string,
  decision: 'approved' | 'approved_session' | 'denied',
  feedback?: string,
  choice?: string,
  text?: string,
) => void

/**
 * 通用决策卡（agent_confirm 计划确认 / agent_ask_user 提问）。
 * 复用审批卡骨架样式；confirm 展示计划/色板/字体/要点并收「确认/取消+反馈」，
 * question 展示候选按钮与自由输入并收「选项/文本」。
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
  const [answer, setAnswer] = useState('')
  const [feedback, setFeedback] = useState('')
  const card = approval.card
  if (!card) return null

  const isConfirm = card.kind === 'confirm'
  const title = isConfirm ? t('surface:agentChat.cardConfirmTitle') : t('surface:agentChat.cardQuestionTitle')

  const submitAnswer = () => {
    const trimmed = answer.trim()
    if (!trimmed) return
    // question 的作答走 choice（与 gateway resolveApproval 的 choice/text 口径一致）；
    // decision 传 approved 让事件流按「已作答」收口（choice 非空即 resolveAgentCard 命中）。
    onResolve(approval.approvalId, 'approved', undefined, trimmed, trimmed)
  }

  const submitOption = (option: string) => {
    onResolve(approval.approvalId, 'approved', undefined, option, option)
  }

  return (
    <section className="agent-shell-approval" aria-label={title}>
      <header className="agent-shell-approval-header">
        <span className="agent-shell-approval-icon">
          {isConfirm ? <ShieldAlert aria-hidden="true" /> : <MessageCircleQuestion aria-hidden="true" />}
        </span>
        <span>
          <strong>{title}</strong>
          <small>{card.title}</small>
        </span>
      </header>

      {card.body ? <p className="agent-decision-card-body">{card.body}</p> : null}

      {card.plan && card.plan.length > 0 ? (
        <ol className="agent-decision-card-plan">
          {card.plan.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
      ) : null}

      {card.palette && card.palette.length > 0 ? (
        <div className="agent-decision-card-swatches">
          {card.palette.map((color) => (
            <span key={color} className="agent-decision-card-swatch">
              <span className="agent-decision-card-swatch-chip" style={{ background: color }} />
              <small>{color}</small>
            </span>
          ))}
        </div>
      ) : null}

      {card.fonts && (card.fonts.heading || card.fonts.body) ? (
        <div className="agent-decision-card-fonts">
          <span>{t('surface:agentChat.cardFonts')}</span>
          {card.fonts.heading ? <code>{card.fonts.heading}</code> : null}
          {card.fonts.body ? <code>{card.fonts.body}</code> : null}
        </div>
      ) : null}

      {card.notes && card.notes.length > 0 ? (
        <ul className="agent-decision-card-notes">
          {card.notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      ) : null}

      {isConfirm ? (
        <>
          <textarea
            className="agent-decision-card-input"
            value={feedback}
            placeholder={t('surface:agentChat.cardConfirmFeedbackPlaceholder')}
            rows={2}
            disabled={busy}
            onChange={(event) => { setFeedback(event.target.value) }}
          />
          <footer>
            <button
              type="button"
              className="agent-shell-deny"
              disabled={busy}
              onClick={() => onResolve(approval.approvalId, 'denied', feedback.trim() || undefined)}
            >
              <X aria-hidden="true" />
              {t('surface:agentChat.cardCancel')}
            </button>
            <button
              type="button"
              className="agent-shell-approve"
              disabled={busy}
              onClick={() => onResolve(approval.approvalId, 'approved')}
            >
              {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
              {t('surface:agentChat.cardConfirm')}
            </button>
          </footer>
        </>
      ) : (
        <>
          {card.options && card.options.length > 0 ? (
            <div className="agent-decision-card-options">
              {card.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  className="agent-decision-card-option"
                  disabled={busy}
                  onClick={() => { submitOption(option) }}
                >
                  {option}
                </button>
              ))}
            </div>
          ) : null}
          {(!card.options || card.options.length === 0 || card.allowText !== false) ? (
            <>
              <textarea
                className="agent-decision-card-input"
                value={answer}
                placeholder={t('surface:agentChat.cardAnswerPlaceholder')}
                rows={2}
                disabled={busy}
                onChange={(event) => { setAnswer(event.target.value) }}
              />
              <footer>
                <button
                  type="button"
                  className="agent-shell-deny"
                  disabled={busy}
                  onClick={() => onResolve(approval.approvalId, 'denied')}
                >
                  <X aria-hidden="true" />
                  {t('surface:agentChat.cardCancel')}
                </button>
                <button
                  type="button"
                  className="agent-shell-approve"
                  disabled={busy || !answer.trim()}
                  onClick={submitAnswer}
                >
                  {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
                  {t('surface:agentChat.cardSubmit')}
                </button>
              </footer>
            </>
          ) : (
            <footer>
              <button
                type="button"
                className="agent-shell-deny"
                disabled={busy}
                onClick={() => onResolve(approval.approvalId, 'denied')}
              >
                <X aria-hidden="true" />
                {t('surface:agentChat.cardCancel')}
              </button>
            </footer>
          )}
        </>
      )}
    </section>
  )
}
