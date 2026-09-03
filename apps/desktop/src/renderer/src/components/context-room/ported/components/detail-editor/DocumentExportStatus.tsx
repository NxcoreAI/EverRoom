import type { AgentDocumentExportRunView } from '@nxcore/agent-contract'
import { Check, Loader2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'
import './ExternalDocumentDialogs.css'

const POLL_INTERVAL_MS = 2_500
const TERMINAL_LINGER_MS = 8_000

/**
 * 编辑器顶部的导出状态小字：文档存在非终态导出任务时显示"导出中"；任务转入
 * 终态后短暂展示结果（成功带链接 / 失败提示），随后自动消失。轮询网关导出
 * 列表，导出弹窗关闭后状态依然可见。
 */
export function DocumentExportStatus({ documentId }: { documentId: string }) {
  const { t } = useLocale()
  const [latest, setLatest] = useState<AgentDocumentExportRunView | null>(null)
  const [finished, setFinished] = useState<AgentDocumentExportRunView | null>(null)
  const finishedTimer = useRef<number | null>(null)
  const lastActiveIdRef = useRef<string | null>(null)
  const latestRef = useRef<AgentDocumentExportRunView | null>(null)
  const retriedRunIdRef = useRef<string | null>(null)

  // 授权成功事件 → 自动恢复卡在 awaiting_auth 的导出任务（弹窗关闭时也生效）。
  useEffect(() => {
    const api = window.nxcore?.agentAuth
    const external = window.nxcore?.externalDocuments
    if (!api || !external) return
    return api.onEvent((frame) => {
      if (frame.type !== 'challenge.updated') return
      if (frame.challenge.status !== 'authorized') return
      const current = latestRef.current
      if (!current || current.status !== 'awaiting_auth' || current.provider !== frame.challenge.provider) return
      if (retriedRunIdRef.current === current.id) return
      retriedRunIdRef.current = current.id
      void external.retryExport(current.id).catch(() => undefined)
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: number | null = null
    const external = window.nxcore?.externalDocuments
    if (!external) return

    const poll = async () => {
      try {
        const response = await external.listExports(documentId)
        if (cancelled) return
        const next = response.items[0] ?? null
        setLatest(next)
        latestRef.current = next
        if (next && ['preparing', 'running', 'awaiting_auth', 'awaiting_confirmation'].includes(next.status)) {
          lastActiveIdRef.current = next.id
        } else if (next && next.id === lastActiveIdRef.current) {
          // 从非终态转入终态：短暂展示结果后停止轮询。
          lastActiveIdRef.current = null
          setFinished(next)
          if (finishedTimer.current !== null) window.clearTimeout(finishedTimer.current)
          finishedTimer.current = window.setTimeout(() => setFinished(null), TERMINAL_LINGER_MS)
        }
      } catch {
        // 网关不可达时静默，下一轮再试。
      }
      if (!cancelled) {
        timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS)
      }
    }
    void poll()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      if (finishedTimer.current !== null) window.clearTimeout(finishedTimer.current)
    }
  }, [documentId])

  if (!latest) return null
  const providerLabel = latest.provider === 'feishu'
    ? t('contextRoom:externalExportDialog.feishu')
    : t('contextRoom:externalExportDialog.notion')

  if (['preparing', 'running'].includes(latest.status)) {
    return (
      <div className="context-room-export-status" role="status">
        <Loader2 className="spin" aria-hidden="true" />
        <span>{t('contextRoom:exportStatus.exporting', { provider: providerLabel })}</span>
      </div>
    )
  }
  if (latest.status === 'awaiting_auth') {
    return (
      <div className="context-room-export-status" role="status">
        <Loader2 className="spin" aria-hidden="true" />
        <span>{t('contextRoom:exportStatus.awaitingAuth', { provider: providerLabel })}</span>
      </div>
    )
  }
  if (latest.status === 'awaiting_confirmation' && finished?.id !== latest.id) {
    return (
      <div className="context-room-export-status" role="status">
        <Loader2 className="spin" aria-hidden="true" />
        <span>{t('contextRoom:exportStatus.awaitingConfirmation', { provider: providerLabel })}</span>
      </div>
    )
  }
  if (finished && finished.id === latest.id) {
    if (finished.status === 'succeeded') {
      return (
        <div className="context-room-export-status" data-completed="true" role="status">
          <Check aria-hidden="true" />
          <a href={finished.remoteUrl ?? undefined} target="_blank" rel="noreferrer">
            {t('contextRoom:exportStatus.exported', { provider: providerLabel })}
          </a>
        </div>
      )
    }
    return (
      <div className="context-room-export-status" data-error="true" role="status">
        <X aria-hidden="true" />
        <span title={finished.errorMessage ?? undefined}>
          {t('contextRoom:exportStatus.failed', { provider: providerLabel })}
        </span>
      </div>
    )
  }
  return null
}
