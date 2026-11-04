import { LoaderCircle, Sparkles } from 'lucide-react'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { formatCredits, type PlanTier } from '@/shared/sources'

import { Modal } from '../ui/modal'

/** 升级弹窗:档位卡片(权益由 entitlements 动态填值)+ Pro 月卡直购。
 *  购买与积分充值同构:下单 → 系统浏览器支付 → 弹窗内轮询 → 到账开订阅。 */

type PurchasePhase = 'idle' | 'creating' | 'pending' | 'completed' | 'failed'

interface PlanCardProps {
  tier: PlanTier
  current: boolean
  purchasable: boolean
  phase: PurchasePhase
  onBuy: () => void
}

function planFeatureLines(tier: PlanTier, t: (key: string, opts?: Record<string, unknown>) => string): string[] {
  const e = tier.entitlements ?? {}
  const lines: string[] = []
  if (typeof e.llmCreditsPerPeriod === 'number' && e.llmCreditsPerPeriod > 0) {
    lines.push(t('surface:plans.featureCredits', { credits: formatCredits(e.llmCreditsPerPeriod, 'en') }))
  }
  if (typeof e.asrSecondsPerPeriod === 'number' && e.asrSecondsPerPeriod > 0) {
    lines.push(t('surface:plans.featureAsr', { minutes: Math.round(e.asrSecondsPerPeriod / 60).toLocaleString('en') }))
  }
  if (typeof e.maxDevices === 'number') {
    lines.push(t('surface:plans.featureDevices', { count: e.maxDevices }))
  }
  if (typeof e.syncRetentionDays === 'number') {
    lines.push(t('surface:plans.featureRetention', { days: e.syncRetentionDays }))
  }
  return lines
}

function PlanCard({ tier, current, purchasable, phase, onBuy }: PlanCardProps) {
  const { t } = useTranslation()
  const busy = phase === 'creating' || phase === 'pending'
  const price = tier.priceCents === 0
    ? t('surface:plans.freeForever')
    : `${Math.round(tier.priceCents / 10)} ${t('surface:plans.creditsUnit')}`
  const features = planFeatureLines(tier, t)

  return (
    <div className="plan-card" data-current={current}>
      <div className="plan-card-head">
        <strong>{tier.name}</strong>
        <span className="plan-card-price">{price}</span>
      </div>
      <ul className="plan-card-features">
        {features.map((line) => <li key={line}>{line}</li>)}
      </ul>
      {current ? (
        <button type="button" className="plan-card-cta" disabled>{t('surface:plans.currentPlan')}</button>
      ) : purchasable ? (
        <button type="button" className="plan-card-cta is-primary" onClick={onBuy} disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}
          {busy ? t('surface:plans.purchasing') : t('surface:plans.buyPro', { price: `${Math.round(tier.priceCents / 10)}` })}
        </button>
      ) : (
        <button type="button" className="plan-card-cta" disabled>{t('surface:plans.defaultPlan')}</button>
      )}
    </div>
  )
}

export function PlanUpgradeModal({
  open, onOpenChange, currentPlanCode, onSettled,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentPlanCode: string | null
  onSettled?: () => void
}) {
  const { t } = useTranslation()
  const [tiers, setTiers] = useState<PlanTier[]>([])
  const [phase, setPhase] = useState<PurchasePhase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const orderIdRef = useRef<string | null>(null)
  const settledRef = useRef(onSettled)
  settledRef.current = onSettled

  useEffect(() => {
    if (!open || !window.nxcore?.billing) return
    void window.nxcore.billing.plans()
      .then((items) => setTiers(items))
      .catch(() => setMessage(t('surface:plans.loadFailed')))
  }, [open, t])

  // 购买轮询:与 TopupPanel 同构,到账即开 30 天 Pro 订阅
  useEffect(() => {
    if (phase !== 'pending' || !orderIdRef.current || !window.nxcore?.billing) return
    let cancelled = false
    const timer = window.setInterval(() => {
      void window.nxcore?.billing?.topupStatus(orderIdRef.current!)
        .then((status) => {
          if (cancelled) return
          if (status.status === 'completed') {
            setPhase('completed')
            setMessage(t('surface:plans.proActivated'))
            settledRef.current?.()
          } else if (status.status === 'failed' || status.status === 'expired') {
            setPhase('failed')
            setMessage(t('surface:plans.purchaseFailed'))
          }
        })
        .catch(() => undefined)
    }, 2000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [phase, t])

  useEffect(() => {
    if (!open) { setPhase('idle'); setMessage(null); orderIdRef.current = null }
  }, [open])

  const proTier = useMemo(() => tiers.find((tier) => tier.code === 'pro') ?? null, [tiers])
  const isPro = currentPlanCode === 'pro'
  const busy = phase === 'creating' || phase === 'pending'

  const buyPro = async () => {
    if (!proTier || !window.nxcore?.billing) return
    setPhase('creating'); setMessage(null)
    try {
      const order = await window.nxcore.billing.topup('pro_month')
      orderIdRef.current = order.orderId
      if (order.provider === 'mock') {
        setPhase('pending')
        setMessage(t('surface:plans.mockHint'))
        void window.nxcore.billing.topupMockApprove(order.orderId).catch(() => undefined)
      } else {
        setPhase('pending')
        setMessage(t('surface:plans.browserOpened'))
      }
    } catch (error) {
      setPhase('failed')
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('surface:plans.modalTitle')}
      description={t('surface:plans.modalDescription')}
      size="lg"
    >
      <div className="plan-cards">
        {tiers.map((tier) => (
          <PlanCard
            key={tier.code}
            tier={tier}
            current={currentPlanCode === tier.code}
            /* 只有 pro 可购(free 是默认档);已是 pro 时 CTA 显示当前方案 */
            purchasable={tier.code === 'pro' && !isPro && !busy}
            phase={tier.code === 'pro' ? phase : 'idle'}
            onBuy={() => { void buyPro() }}
          />
        ))}
      </div>
      {message ? <small className="plan-purchase-message" data-phase={phase}>{message}</small> : null}
      {phase === 'completed' ? (
        <p className="plan-purchase-done">{t('surface:plans.proActivatedNote')}</p>
      ) : null}
    </Modal>
  )
}
