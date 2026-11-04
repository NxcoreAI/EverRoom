import { LoaderCircle, Sparkles } from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Modal } from '../ui/modal'

/** 充值弹窗:积分档位卡片(与升级弹窗同构)。
 *  选中档位即下单:mock 渠道就地自动批准,真实渠道主进程打开系统浏览器支付页;
 *  弹窗内 2s 轮询订单状态,completed 后回调 onSettled 刷新额度。 */

type PurchasePhase = 'idle' | 'creating' | 'pending' | 'completed' | 'failed'

interface CreditPackLite {
  id: string
  code: string
  name: string
  amountCents: number
  productKind?: string
}

export function TopupModal({
  open, onOpenChange, onSettled,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSettled?: () => void
}) {
  const { t } = useTranslation()
  const [packs, setPacks] = useState<CreditPackLite[]>([])
  const [phase, setPhase] = useState<PurchasePhase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [activeCode, setActiveCode] = useState<string | null>(null)
  const orderIdRef = useRef<string | null>(null)
  const settledRef = useRef(onSettled)
  settledRef.current = onSettled

  useEffect(() => {
    if (!open || !window.nxcore?.billing) return
    void window.nxcore.billing.packs()
      .then((items) => {
        // 只列积分类档位;pro_month 走升级弹窗,不混进充值选择
        const creditOnly = items.filter((item) => item.active && (item.productKind ?? 'credits') === 'credits')
        setPacks(creditOnly)
      })
      .catch(() => setMessage(t('surface:settings.topupLoadFailed')))
  }, [open, t])

  // 到账轮询:2s 间隔,completed 后经 onSettled 让外层刷新额度
  useEffect(() => {
    if (phase !== 'pending' || !orderIdRef.current || !window.nxcore?.billing) return
    let cancelled = false
    const timer = window.setInterval(() => {
      void window.nxcore?.billing?.topupStatus(orderIdRef.current!)
        .then((status) => {
          if (cancelled) return
          if (status.status === 'completed') {
            setPhase('completed')
            setMessage(t('surface:settings.topupCompleted'))
            settledRef.current?.()
          } else if (status.status === 'failed' || status.status === 'expired') {
            setPhase('failed')
            setMessage(t('surface:settings.topupFailed'))
          }
        })
        .catch(() => undefined)
    }, 2000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [phase, t])

  useEffect(() => {
    if (!open) { setPhase('idle'); setMessage(null); setActiveCode(null); orderIdRef.current = null }
  }, [open])

  const busy = phase === 'creating' || phase === 'pending'

  const buyPack = async (pack: CreditPackLite) => {
    if (busy || !window.nxcore?.billing) return
    setActiveCode(pack.code)
    setPhase('creating'); setMessage(null)
    try {
      const order = await window.nxcore.billing.topup(pack.code)
      orderIdRef.current = order.orderId
      if (order.provider === 'mock') {
        // Mock 模式:模拟买家批准(联调),随后轮询自然到账
        setPhase('pending')
        setMessage(t('surface:settings.topupMockHint'))
        void window.nxcore.billing.topupMockApprove(order.orderId).catch(() => undefined)
      } else {
        setPhase('pending')
        setMessage(t('surface:settings.topupBrowserOpened'))
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
      title={t('surface:settings.topupModalTitle')}
      description={t('surface:settings.topupModalDescription')}
      size="lg"
    >
      {packs.length ? (
        <div className="plan-cards">
          {packs.map((pack) => {
            // 1 积分 = $0.1:积分数 = amountCents / 10 取整
            const credits = Math.round(pack.amountCents / 10)
            const price = `$${Math.round(pack.amountCents / 100)}`
            const isBusyPack = busy && activeCode === pack.code
            return (
              <div key={pack.code} className="plan-card">
                <div className="plan-card-head">
                  <strong>{t('surface:settings.topupPackCredits', { credits })}</strong>
                  <span className="plan-card-price">{price}</span>
                </div>
                <p className="plan-card-note">{t('surface:settings.topupPackNote')}</p>
                <button
                  type="button"
                  className="plan-card-cta is-primary"
                  onClick={() => { void buyPack(pack) }}
                  disabled={busy}
                >
                  {isBusyPack ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}
                  {isBusyPack ? t('surface:settings.topupPending') : t('surface:settings.topupBuy')}
                </button>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="plan-purchase-message">{message ?? t('surface:settings.topupLoadFailed')}</p>
      )}
      {packs.length && message ? <small className="plan-purchase-message" data-phase={phase}>{message}</small> : null}
    </Modal>
  )
}
