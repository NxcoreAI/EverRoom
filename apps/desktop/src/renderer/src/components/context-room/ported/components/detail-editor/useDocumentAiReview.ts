import type { AgentSession } from '@nxcore/agent-contract'
import { useCallback, useState } from 'react'
import { useActiveDocument } from '../../../../../state/ActiveDocumentContext'
import { useLocale } from '../../../../../i18n/LocaleContext'
import { showToast } from '../../../../../state/toast'
import type { RoomDocument } from '@nxcore/agent-contract'
import {
  isSessionBusyError,
  pollDocumentAiReviewRun,
  runDocumentAiReview,
  type DocumentAiReviewAgentApi,
  type DocumentAiReviewOutcome,
} from './aiReviewAgent'

/**
 * 文档「AI 审阅」一键触发：隐藏会话（pageLabel 以 "AI " 开头被会话切换器过滤）
 * 跑一次审阅 run，agent 逐条落评论（服务端事件推送刷新面板）。
 * 会话与在途 run 以 documentId 记在模块级 Map，编辑器重挂载不中断。
 */

const reviewSessions = new Map<string, Promise<AgentSession>>()
const inFlightReviews = new Map<string, Promise<DocumentAiReviewOutcome>>()

function aiReviewApi(): DocumentAiReviewAgentApi | null {
  const agent = window.nxcore?.agent
  if (!agent) return null
  return {
    createSession: (input) => agent.createSession(input),
    getSession: (sessionId) => agent.getSession(sessionId),
    startRun: (sessionId, input) => agent.startRun(sessionId, input),
    getEvents: (sessionId, runId, afterSeq) => agent.getEvents(sessionId, runId, afterSeq),
  }
}

export function useDocumentAiReview({
  roomId,
  documentId,
  documentTitle,
  backendDocument,
}: {
  roomId: string
  documentId: string
  documentTitle: string
  backendDocument: RoomDocument | null
}) {
  const { locale, t } = useLocale()
  const { flushActiveDocument } = useActiveDocument()
  const [running, setRunning] = useState(() => inFlightReviews.has(documentId))

  const ensureSession = useCallback((title: string): Promise<AgentSession> => {
    const existing = reviewSessions.get(documentId)
    if (existing) return existing
    const api = aiReviewApi()
    if (!api) return Promise.reject(new Error('agent api unavailable'))
    const created = api.createSession({ pageLabel: t('contextRoom:aiReviewAgent.pageLabel', { name: title }) })
    reviewSessions.set(documentId, created)
    created.catch(() => reviewSessions.delete(documentId))
    return created
  }, [documentId, t])

  const start = useCallback(() => {
    if (inFlightReviews.has(documentId)) {
      showToast({ title: t('contextRoom:aiReviewAgent.busy') })
      return
    }
    const task = (async (): Promise<DocumentAiReviewOutcome> => {
      const api = aiReviewApi()
      if (!api) throw new Error('agent api unavailable')

      // flush 拿权威版本：本地未保存的编辑先落盘，防止审阅旧内容。
      const descriptor = await flushActiveDocument()
      const current = descriptor && descriptor.documentId === documentId ? descriptor : null
      const version = current?.version ?? backendDocument?.version
      const title = current?.title ?? documentTitle
      if (!version) throw new Error('document version unavailable')

      let baseline = 0
      try {
        baseline = (await window.nxcore?.documents.listDocumentComments(documentId))?.items.length ?? 0
      } catch {
        // 基线拿不到也继续，只是 toast 不带增量。
        baseline = -1
      }

      const session = await ensureSession(title)
      let outcome: DocumentAiReviewOutcome
      try {
        outcome = await runDocumentAiReview(api, {
          sessionId: session.id,
          roomId,
          documentId,
          documentTitle: title,
          version,
          responseLanguage: locale,
        })
      } catch (error) {
        if (!isSessionBusyError(error)) throw error
        // 同文档已有审阅在跑：挂到在途 run 继续跟踪。
        const activeRun = (await api.getSession(session.id)).activeRun
        if (!activeRun) throw error
        outcome = await pollDocumentAiReviewRun(api, session.id, activeRun.id)
      }

      window.dispatchEvent(new CustomEvent('everroom:document-comments-changed', { detail: { documentId } }))
      if (outcome === 'completed') {
        try {
          const after = (await window.nxcore?.documents.listDocumentComments(documentId))?.items.length ?? baseline
          if (baseline >= 0 && after > baseline) {
            showToast({ title: t('contextRoom:aiReviewAgent.completed', { count: String(after - baseline) }) })
          } else {
            showToast({ title: t('contextRoom:aiReviewAgent.completedNone') })
          }
        } catch {
          showToast({ title: t('contextRoom:aiReviewAgent.completedNone') })
        }
      } else if (outcome !== 'cancelled') {
        showToast({ title: t('contextRoom:aiReviewAgent.failed') })
      }
      return outcome
    })()
    inFlightReviews.set(documentId, task)
    setRunning(true)
    task
      .catch(() => showToast({ title: t('contextRoom:aiReviewAgent.failed') }))
      .finally(() => {
        inFlightReviews.delete(documentId)
        setRunning(false)
      })
  }, [backendDocument, documentId, documentTitle, ensureSession, flushActiveDocument, locale, roomId, t])

  return { running, start }
}
