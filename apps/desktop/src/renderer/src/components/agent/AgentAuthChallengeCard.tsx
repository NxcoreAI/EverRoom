import type { AgentAuthEnvironmentStatus, AgentAuthEventFrame, DesktopAgentAuthChallenge } from '../../../../shared/agent-auth'
import { BadgeCheck, ExternalLink, Loader2, RefreshCw, ShieldQuestion, X } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocale } from '../../i18n/LocaleContext'

/**
 * AuthChallenge 授权卡片（feishu-notion-document-export-plan.md §7）。挂在会话流
 * 最新消息位置，像 Agent 输出的卡片；授权完成后保留显示"已授权"状态，由用户
 * 手动关闭或下一次授权开始时替换。数据来自桌面本地 agent-auth 控制器（IPC），
 * device code 等敏感值不经过本组件。
 */
export function useAgentAuthStatus(): AgentAuthEnvironmentStatus | null {
  const [status, setStatus] = useState<AgentAuthEnvironmentStatus | null>(null)
  useEffect(() => {
    const api = window.nxcore?.agentAuth
    if (!api) return
    let cancelled = false
    let pollTimer: number | null = null
    const refresh = (): void => {
      void api.status().then((next) => {
        if (!cancelled) setStatus(next)
      }).catch(() => undefined)
    }
    const applyFrame = (frame: AgentAuthEventFrame): void => {
      if (frame.type === 'environment.changed') setStatus(frame.status)
      else refresh()
    }
    const unsubscribe = api.onEvent(applyFrame)
    refresh()
    // 兜底轮询：TTL 过期等惰性状态只在 status() 读取时推进,不伴随事件。
    pollTimer = window.setInterval(refresh, 8_000)
    return () => {
      cancelled = true
      unsubscribe()
      if (pollTimer !== null) window.clearInterval(pollTimer)
    }
  }, [])
  return status
}

export function useAgentAuthChallenge(): DesktopAgentAuthChallenge | null {
  const status = useAgentAuthStatus()
  return status?.activeChallenge ?? null
}

function AgentAuthChallengeBody({ challenge, autoScroll }: { challenge: DesktopAgentAuthChallenge | null; autoScroll: boolean }) {
  const { t } = useLocale()
  const cardRef = useRef<HTMLElement | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [resuming, setResuming] = useState(false)
  const [restarting, setRestarting] = useState(false)

  // 新挑战出现（或阶段推进）时，把智能区滚动到卡片所在位置。
  useEffect(() => {
    if (!autoScroll || !challenge || challenge.status === 'cancelled') return
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [autoScroll, challenge?.id, challenge?.phase, challenge?.status])

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

  // 授权成功：极简成功态——大图标 + 一句话，不再展示步骤流程。
  if (completed) {
    return (
      <section
        ref={cardRef}
        className="agent-auth-challenge agent-auth-challenge-success"
        data-status="authorized"
        data-completed="true"
      >
        <button
          type="button"
          className="agent-auth-challenge-success-close"
          aria-label={t('surface:agentAuthCard.dismiss')}
          title={t('surface:agentAuthCard.dismiss')}
          onClick={() => void api?.cancel(challenge.id)}
        >
          <X aria-hidden="true" />
        </button>
        <span className="agent-auth-challenge-success-icon" aria-hidden="true">
          <BadgeCheck aria-hidden="true" />
        </span>
        <strong className="agent-auth-challenge-success-title">
          {t('surface:agentAuthCard.successTitle', {
            provider: challenge.provider === 'feishu'
              ? t('surface:agentAuthCard.feishu')
              : t('surface:agentAuthCard.notion'),
          })}
        </strong>
        {challenge.message && <small className="agent-auth-challenge-success-hint">{challenge.message}</small>}
      </section>
    )
  }

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
          <ShieldQuestion size={16} aria-hidden="true" />
        </span>
        <div>
          <strong>{challenge.title}</strong>
          <small>
            {challenge.provider === 'feishu' ? t('surface:agentAuthCard.feishu') : t('surface:agentAuthCard.notion')}
            {' · '}
            {phaseLabel}
          </small>
        </div>
        <button
          type="button"
          aria-label={t('surface:agentAuthCard.cancel')}
          title={t('surface:agentAuthCard.cancel')}
          onClick={() => void api?.cancel(challenge.id)}
        >
          <X aria-hidden="true" />
        </button>
      </header>
      {challenge.message && <p className="agent-auth-challenge-message">{challenge.message}</p>}
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
        <div
          className="agent-auth-challenge-footer"
          data-with-qr={String(Boolean(qrDataUrl && challenge.verificationUrl))}
        >
          {qrDataUrl && challenge.verificationUrl && (
            <div className="agent-auth-challenge-qr-wrap">
              <img className="agent-auth-challenge-qr" src={qrDataUrl} alt={t('surface:agentAuthCard.qrAlt')} />
              <small className="agent-auth-challenge-qr-hint">{t('surface:agentAuthCard.qrAlt')}</small>
            </div>
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

/** 会话流内嵌授权卡（Agent 导出场景）：像一条 Agent 消息挂在消息流末端。 */
export function AgentAuthChallengeCard() {
  const challenge = useAgentAuthChallenge()
  return <AgentAuthChallengeBody challenge={challenge} autoScroll />
}

/**
 * 授权过程弹窗（数据源页）：居中对话框 + 出入场过渡动画。授权进行中点遮罩/
 * ESC 不动作（避免误中断），终态（已授权/失败/过期）可点遮罩或 ESC 关闭。
 */
export function AgentAuthDialog({ challenge }: { challenge: DesktopAgentAuthChallenge | null }) {
  const [mounted, setMounted] = useState(false)
  const lastChallengeRef = useRef<DesktopAgentAuthChallenge | null>(null)
  if (challenge) lastChallengeRef.current = challenge

  useEffect(() => {
    if (challenge) {
      setMounted(true)
      return
    }
    // 退场动画播完再卸载（data-open 翻 false 触发 keyframes 出场）。
    const exit = window.setTimeout(() => setMounted(false), 240)
    return () => window.clearTimeout(exit)
  }, [challenge])

  const open = challenge != null
  const dismiss = () => {
    const api = window.nxcore?.agentAuth
    const shown = challenge ?? lastChallengeRef.current
    if (!api || !shown) return
    void api.cancel(shown.id)
  }

  useEffect(() => {
    if (!challenge) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const status = challenge.status
      if (status === 'authorized' || status === 'failed' || status === 'expired') dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge?.id, challenge?.status])

  if (!mounted || typeof document === 'undefined') return null
  const shown = challenge ?? lastChallengeRef.current
  const terminal = challenge != null && (challenge.status === 'authorized' || challenge.status === 'failed' || challenge.status === 'expired')
  return createPortal(
    <div
      className="agent-auth-dialog-backdrop"
      data-open={String(open)}
      onMouseDown={(event) => {
        if (event.currentTarget !== event.target || !terminal) return
        dismiss()
      }}
    >
      <div className="agent-auth-dialog" data-open={String(open)} role="dialog" aria-modal="true" aria-label={shown?.title ?? ''}>
        <AgentAuthChallengeBody challenge={shown} autoScroll={false} />
      </div>
    </div>,
    document.body,
  )
}
