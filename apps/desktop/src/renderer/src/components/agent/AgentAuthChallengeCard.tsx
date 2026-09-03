import type { AgentAuthEventFrame, DesktopAgentAuthChallenge } from '../../../../shared/agent-auth'
import { BadgeCheck, ExternalLink, Loader2, RefreshCw, ShieldQuestion, X } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useRef, useState } from 'react'
import { useLocale } from '../../i18n/LocaleContext'

/**
 * AuthChallenge 授权卡片（feishu-notion-document-export-plan.md §7）。挂在会话流
 * 最新消息位置，像 Agent 输出的卡片；授权完成后保留显示"已授权"状态，由用户
 * 手动关闭或下一次授权开始时替换。数据来自桌面本地 agent-auth 控制器（IPC），
 * device code 等敏感值不经过本组件。
 */
function useAgentAuthChallenge(): DesktopAgentAuthChallenge | null {
  const [challenge, setChallenge] = useState<DesktopAgentAuthChallenge | null>(null)
  useEffect(() => {
    const api = window.nxcore?.agentAuth
    if (!api) return
    let cancelled = false
    let pollTimer: number | null = null
    const applyFrame = (frame: AgentAuthEventFrame): void => {
      if (frame.type === 'challenge.updated') setChallenge(frame.challenge)
      else if (frame.type === 'challenge.removed') setChallenge(null)
    }
    const unsubscribe = api.onEvent(applyFrame)
    void api.status().then((status) => {
      if (!cancelled) setChallenge(status.activeChallenge)
    }).catch(() => undefined)
    pollTimer = window.setInterval(() => {
      void api.status().then((status) => {
        if (!cancelled) setChallenge(status.activeChallenge)
      }).catch(() => undefined)
    }, 8_000)
    return () => {
      cancelled = true
      unsubscribe()
      if (pollTimer !== null) window.clearInterval(pollTimer)
    }
  }, [])
  return challenge
}

export function AgentAuthChallengeCard() {
  const { t } = useLocale()
  const challenge = useAgentAuthChallenge()
  const cardRef = useRef<HTMLElement | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [resuming, setResuming] = useState(false)
  const [restarting, setRestarting] = useState(false)

  // 新挑战出现（或阶段推进）时，把智能区滚动到卡片所在位置。
  useEffect(() => {
    if (!challenge || challenge.status === 'cancelled') return
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [challenge?.id, challenge?.phase, challenge?.status])

  useEffect(() => {
    if (!challenge?.verificationUrl) {
      setQrDataUrl(null)
      return
    }
    let cancelled = false
    void QRCode.toDataURL(challenge.verificationUrl, { margin: 1, width: 200, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url)
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [challenge?.verificationUrl])

  if (!challenge || challenge.status === 'cancelled') return null
  const api = window.nxcore?.agentAuth
  const completed = challenge.status === 'authorized'
  const terminal = completed || challenge.status === 'failed' || challenge.status === 'expired'

  const resume = async () => {
    if (!api) return
    setResuming(true)
    try {
      await api.resume(challenge.id)
    } catch {
      // 状态检查失败时下一轮轮询会刷新。
    } finally {
      setResuming(false)
    }
  }

  const restart = async () => {
    if (!api) return
    setRestarting(true)
    try {
      await api.start({
        provider: challenge.provider,
        phase: challenge.phase,
        exportRunId: challenge.exportRunId ?? undefined,
      })
    } catch {
      // 已有进行中的流程等错误由卡片状态自行反映。
    } finally {
      setRestarting(false)
    }
  }

  const phaseLabel = challenge.phase === 'app_setup'
    ? t('surface:agentAuthCard.phaseAppSetup')
    : t('surface:agentAuthCard.phaseUserAuth')

  return (
    <section
      ref={cardRef}
      className="agent-auth-challenge"
      data-status={challenge.status}
      data-phase={challenge.phase}
      data-completed={String(completed)}
    >
      <header>
        <span className="agent-auth-challenge-icon" aria-hidden="true">
          {completed ? <BadgeCheck aria-hidden="true" /> : <ShieldQuestion aria-hidden="true" />}
        </span>
        <div>
          <strong>{completed ? t('surface:agentAuthCard.completedTitle') : challenge.title}</strong>
          <small>
            {challenge.provider === 'feishu' ? t('surface:agentAuthCard.feishu') : t('surface:agentAuthCard.notion')}
            {' · '}
            {phaseLabel}
            {completed ? ` · ${t('surface:agentAuthCard.completedBadge')}` : ''}
          </small>
        </div>
        <button
          type="button"
          aria-label={terminal ? t('surface:agentAuthCard.dismiss') : t('surface:agentAuthCard.cancel')}
          title={terminal ? t('surface:agentAuthCard.dismiss') : t('surface:agentAuthCard.cancel')}
          onClick={() => void api?.cancel(challenge.id)}
        >
          <X aria-hidden="true" />
        </button>
      </header>
      {challenge.message && <p className="agent-auth-challenge-message" data-completed={String(completed)}>{challenge.message}</p>}
      <ol className="agent-auth-challenge-steps">
        {challenge.steps.map((step) => (
          <li key={step.id} data-completed={String(step.completed)}>
            <span className="agent-auth-challenge-step-state" aria-hidden="true">
              {step.completed ? <BadgeCheck aria-hidden="true" /> : <span className="agent-auth-challenge-step-dot" />}
            </span>
            <span>
              <b>{step.title}</b>
              {step.description ? <small>{step.description}</small> : null}
              {step.action === 'open_url' && step.url && !completed ? (
                <a href={step.url} target="_blank" rel="noreferrer">
                  {t('surface:agentAuthCard.openLink')} <ExternalLink size={12} aria-hidden="true" />
                </a>
              ) : null}
              {step.action === 'open_connector_console' && !completed ? (
                <button
                  type="button"
                  className="agent-auth-challenge-console"
                  onClick={() => void window.nxcore?.cliConnector.openConsole()}
                >
                  {t('surface:agentAuthCard.openConsole')}
                </button>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
      {!completed && (
        <div className="agent-auth-challenge-footer">
          {qrDataUrl && challenge.verificationUrl && (
            <img className="agent-auth-challenge-qr" src={qrDataUrl} alt={t('surface:agentAuthCard.qrAlt')} />
          )}
          <div className="agent-auth-challenge-actions">
            {challenge.status === 'pending' && (
              <button
                type="button"
                className="primary"
                disabled={resuming}
                onClick={() => void resume()}
              >
                {resuming && <Loader2 className="spin" aria-hidden="true" />}
                {t('surface:agentAuthCard.resumeCheck')}
              </button>
            )}
            {(challenge.status === 'failed' || challenge.status === 'expired') && (
              <button
                type="button"
                className="primary"
                disabled={restarting}
                onClick={() => void restart()}
              >
                {restarting ? <Loader2 className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                {t('surface:agentAuthCard.restart')}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
