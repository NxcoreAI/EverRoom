import { ChevronDown, ChevronUp } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WritingStyleInsightDto } from '../../../../shared/writing-style'
import { useLocale } from '@/i18n/LocaleContext'

const POLL_INTERVAL_MS = 45_000
const CONFIRMED_FLASH_MS = 3_000

/**
 * 智能区顶部的协作洞察横幅（写作风格 v2）：一轮文档协作安静收尾后，
 * gateway 蒸馏出该轮偏好陈述（pending 洞察），此处提示并等待用户确认写入
 * 画像；"稍后"可关闭横幅，稍后回记忆页写作风格 tab 找回确认。
 * 白色圆角卡片、单行高度，偏好详情默认折叠（点标题/箭头展开）。
 */
export function WritingStyleInsightBanner() {
  const { t } = useLocale()
  const [insight, setInsight] = useState<WritingStyleInsightDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [justConfirmed, setJustConfirmed] = useState(false)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const poll = useCallback(async () => {
    const api = window.nxcore?.writingStyle
    if (!api) return
    try {
      const { insights } = await api.insights()
      if (!aliveRef.current) return
      setInsight(insights.find((item) => item.status === 'pending') ?? null)
    } catch {
      // 轮询失败静默：横幅是增益提示，不进入错误态。
    }
  }, [])

  useEffect(() => {
    void poll()
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS)
    const onFocus = () => void poll()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [poll])

  const act = useCallback(async (action: 'confirm' | 'snooze') => {
    if (!insight || busy) return
    const api = window.nxcore?.writingStyle
    if (!api) return
    setBusy(true)
    try {
      if (action === 'confirm') {
        await api.confirmInsight(insight.id)
        setJustConfirmed(true)
        window.setTimeout(() => {
          if (aliveRef.current) setJustConfirmed(false)
        }, CONFIRMED_FLASH_MS)
      } else {
        await api.snoozeInsight(insight.id)
      }
      setInsight(null)
      setExpanded(false)
    } catch {
      // 失败保持横幅，下一轮轮询重试。
    } finally {
      setBusy(false)
    }
  }, [busy, insight])

  if (justConfirmed) {
    return (
      <div className="agent-insight-banner agent-insight-banner-confirmed" role="status">
        <span>{t('memory:writingStyle.insightBannerConfirmed')}</span>
      </div>
    )
  }
  if (!insight) return null

  return (
    <div className="agent-insight-banner" data-status={insight.status} data-expanded={expanded}>
      <button
        type="button"
        className="agent-insight-banner-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="agent-insight-banner-title">{t('memory:writingStyle.insightBannerTitle')}</span>
        {expanded
          ? <ChevronUp aria-hidden="true" strokeWidth={1.8} size={14} />
          : <ChevronDown aria-hidden="true" strokeWidth={1.8} size={14} />}
      </button>
      {expanded ? (
        <ul className="agent-insight-banner-list">
          {insight.preferences.map((preference) => (
            <li key={preference}>{preference}</li>
          ))}
        </ul>
      ) : null}
      <div className="agent-insight-banner-actions">
        <button
          type="button"
          className="agent-insight-banner-primary"
          disabled={busy}
          onClick={() => void act('confirm')}
        >
          {t('memory:writingStyle.insightBannerConfirm')}
        </button>
        <button
          type="button"
          className="agent-insight-banner-secondary"
          disabled={busy}
          onClick={() => void act('snooze')}
        >
          {t('memory:writingStyle.insightBannerSnooze')}
        </button>
      </div>
    </div>
  )
}
