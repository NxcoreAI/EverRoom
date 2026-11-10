import { LoaderCircle, Sparkles } from 'lucide-react'
import QRCode from 'qrcode'
import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Modal } from '../ui/modal'

/** 充值弹窗:积分档位卡片(与升级弹窗同构)。
 *  顶部渠道分段控件:PayPal(美元,系统浏览器 approval 页)/ 微信支付(人民币价,弹窗内扫码)。
 *  选中档位即下单:mock 渠道就地自动批准;paypal 主进程打开系统浏览器支付页;
 *  wechatpay 返回 code_url(weixin://)在弹窗内渲染二维码;
 *  弹窗内 2s 轮询订单状态,completed 后回调 onSettled 刷新额度。 */

type PurchasePhase = 'idle' | 'creating' | 'pending' | 'completed' | 'failed'
type Channel = 'paypal' | 'wechatpay'

interface CreditPackLite {
  id: string
  code: string
  name: string
  amountCents: number
  amountCnyCents?: number
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
  const [channel, setChannel] = useState<Channel>('paypal')
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
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
            setQrDataUrl(null)
            setMessage(t('surface:settings.topupCompleted'))
            settledRef.current?.()
          } else if (status.status === 'failed' || status.status === 'expired') {
            setPhase('failed')
            setQrDataUrl(null)
            setMessage(t('surface:settings.topupFailed'))
          }
        })
        .catch(() => undefined)
    }, 2000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [phase, t])

  useEffect(() => {
    if (!open) { setPhase('idle'); setMessage(null); setActiveCode(null); setQrDataUrl(null); orderIdRef.current = null }
  }, [open])

  const busy = phase === 'creating' || phase === 'pending'

  /** 重置购买现场(切渠道/取消扫码时):停轮询、回档位选择。 */
  const resetPurchase = () => {
    setPhase('idle')
    setMessage(null)
    setActiveCode(null)
    setQrDataUrl(null)
    orderIdRef.current = null
  }

  const switchChannel = (next: Channel) => {
    if (next === channel) return
    setChannel(next)
    resetPurchase()
  }

  const buyPack = async (pack: CreditPackLite) => {
    if (busy || !window.nxcore?.billing) return
    setActiveCode(pack.code)
    setPhase('creating'); setMessage(null); setQrDataUrl(null)
    try {
      // PayPal 不传 channel=现状;微信显式传 wechatpay
      const order = await window.nxcore.billing.topup(pack.code, channel === 'wechatpay' ? 'wechatpay' : undefined)
      orderIdRef.current = order.orderId
      if (order.provider === 'mock') {
        // Mock 模式:模拟买家批准(联调),随后轮询自然到账
        setPhase('pending')
        setMessage(t('surface:settings.topupMockHint'))
        void window.nxcore.billing.topupMockApprove(order.orderId).catch(() => undefined)
      } else if (order.provider === 'wechatpay') {
        // 微信 Native:approvalUrl 是 weixin:// code_url,不开浏览器,弹窗内渲染二维码
        setPhase('pending')
        setMessage(t('surface:settings.topupScanNote'))
        try {
          const dataUrl = await QRCode.toDataURL(order.approvalUrl, { margin: 1, width: 360, errorCorrectionLevel: 'M' })
          setQrDataUrl(dataUrl)
        } catch {
          setPhase('failed')
          setMessage(t('surface:settings.topupFailed'))
        }
      } else {
        setPhase('pending')
        setMessage(t('surface:settings.topupBrowserOpened'))
      }
    } catch (error) {
      setPhase('failed')
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const showQr = channel === 'wechatpay' && qrDataUrl && phase === 'pending'

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('surface:settings.topupModalTitle')}
      description={t('surface:settings.topupModalDescription')}
      size="lg"
    >
      <div className="topup-channel-tabs" role="tablist" aria-label={t('surface:settings.topupModalTitle')}>
        <button
          type="button"
          role="tab"
          className="topup-channel-tab"
          data-active={channel === 'paypal'}
          aria-selected={channel === 'paypal'}
          onClick={() => switchChannel('paypal')}
        >
          {t('surface:settings.topupChannelPaypal')}
        </button>
        <button
          type="button"
          role="tab"
          className="topup-channel-tab"
          data-active={channel === 'wechatpay'}
          aria-selected={channel === 'wechatpay'}
          onClick={() => switchChannel('wechatpay')}
        >
          {t('surface:settings.topupChannelWechat')}
        </button>
      </div>
      {showQr ? (
        <div className="topup-qr">
          <img className="topup-qr-image" src={qrDataUrl} alt={t('surface:settings.topupScanTitle')} width={180} height={180} />
          <strong className="topup-qr-title">{t('surface:settings.topupScanTitle')}</strong>
          <p className="topup-qr-note">{t('surface:settings.topupScanNote')}</p>
          <button type="button" className="topup-qr-cancel" onClick={resetPurchase}>
            {t('surface:settings.topupScanCancel')}
          </button>
        </div>
      ) : packs.length ? (
        <div className="plan-cards">
          {packs.map((pack) => {
            // 1 积分 = $0.1:积分数 = amountCents / 10 取整
            const credits = Math.round(pack.amountCents / 10)
            // 微信渠道优先显示人民币价(¥);档位未配置人民币价时退回美元
            const price = channel === 'wechatpay' && pack.amountCnyCents
              ? `¥${Math.round(pack.amountCnyCents / 100)}`
              : `$${Math.round(pack.amountCents / 100)}`
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
      {!showQr && packs.length && message ? <small className="plan-purchase-message" data-phase={phase}>{message}</small> : null}
    </Modal>
  )
}
