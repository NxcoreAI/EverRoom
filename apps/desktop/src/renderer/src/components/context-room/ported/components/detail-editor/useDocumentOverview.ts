import type { DocumentOverviewView, RoomDocument } from '@nxcore/agent-contract'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'
import { showToast } from '../../../../../state/toast'

/**
 * 文档速览（文章级 AI 摘要）状态机：挂载 GET → 无速览且 eligible 且
 * aiAvailable 时立即自动生成；正文版本超过 generatedAtVersion（已过期）
 * 时也自动重新生成（等正文稳定的去抖——连续编辑每 300ms 防抖保存都会
 * bump version，不能每版都调 LLM；锁定期挂起，解锁后补触发）。生成前先
 * flush 本地防抖保存锁定权威 version；在途生成以 documentId 记在模块级
 * Map，编辑器重挂载不中断、不重复触发（useDocumentAiReview 同款模式）。
 */

const inFlightOverviews = new Map<string, Promise<DocumentOverviewView | null>>()

/** 过期重生成的去抖：版本变化后等正文稳定再触发（毫秒）。 */
const OVERVIEW_REGEN_SETTLE_MS = 2500

export type DocumentOverviewStatus =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'generating'; view: DocumentOverviewView | null }
  | { state: 'ready'; view: DocumentOverviewView }
  | { state: 'stale'; view: DocumentOverviewView }
  | { state: 'failed'; kind: 'unavailable' | 'error' }
  | { state: 'ineligible'; reason: 'empty' | 'too_short' }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useDocumentOverview({
  documentId,
  backendDocument,
  prepareDocument,
  locked,
  refreshSignal = 0,
}: {
  documentId: string
  backendDocument: RoomDocument | null
  /** 生成前 flush 本地防抖保存，拿权威 version（防止摘到旧内容）。 */
  prepareDocument: () => Promise<number>
  /** editorLocked：锁定期间不自动生成，解锁后 effect 自动补触发。 */
  locked: boolean
  /** 外部强制重拉信号（如应用导入候选后——服务端已清速览列，重拉落回无速览态即自动重新生成）。 */
  refreshSignal?: number
}): { status: DocumentOverviewStatus; regenerate: () => void } {
  const { t } = useLocale()
  const [view, setView] = useState<DocumentOverviewView | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [generating, setGenerating] = useState(() => inFlightOverviews.has(documentId))
  const [failure, setFailure] = useState<'unavailable' | 'error' | null>(null)
  const requestSeqRef = useRef(0)
  const lastEvaluatedVersionRef = useRef<number | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const documents = window.nxcore?.documents
    if (!documents) return
    const seq = ++requestSeqRef.current
    try {
      const result = await documents.getOverview(documentId)
      if (seq !== requestSeqRef.current) return
      setView(result)
      setLoaded(true)
      setFailure(null)
    } catch {
      if (seq !== requestSeqRef.current) return
      setLoaded(true)
      setFailure('error')
    }
  }, [documentId])

  // 挂载/换文档：清态重拉。
  useEffect(() => {
    setView(null)
    setLoaded(false)
    setFailure(null)
    lastEvaluatedVersionRef.current = null
    void refresh()
  }, [refresh])

  // 外部信号（应用导入候选等正文被外部替换的场景）：强制重拉速览。
  const signalRef = useRef(refreshSignal)
  useEffect(() => {
    if (refreshSignal === signalRef.current) return
    signalRef.current = refreshSignal
    void refresh()
  }, [refreshSignal, refresh])

  // 换文档时跟随可能在途的生成（上一实例/其它挂载发起）。
  useEffect(() => {
    const pending = inFlightOverviews.get(documentId)
    if (!pending) return
    setGenerating(true)
    let cancelled = false
    pending.then((result) => {
      if (!cancelled && result) setView(result)
    }).catch(() => undefined).finally(() => {
      if (!cancelled) setGenerating(false)
    })
    return () => { cancelled = true }
  }, [documentId])

  const generate = useCallback((): Promise<DocumentOverviewView | null> => {
    const documents = window.nxcore?.documents
    const existing = inFlightOverviews.get(documentId)
    if (existing) return existing
    const task = (async (): Promise<DocumentOverviewView | null> => {
      try {
        await prepareDocument()
        const result = await documents!.generateOverview(documentId)
        setView(result)
        setLoaded(true)
        return result
      } catch (error) {
        const message = errorMessage(error)
        if (message.includes('DOCUMENT_OVERVIEW_AI_UNAVAILABLE')) {
          setFailure('unavailable')
        } else if (message.includes('DOCUMENT_OVERVIEW_TOO_SHORT')) {
          // 生成期间内容被删短：重新 GET 落回 ineligible 状态。
          await refresh()
        } else {
          setFailure('error')
        }
        return null
      }
    })()
    inFlightOverviews.set(documentId, task)
    setGenerating(true)
    setFailure(null)
    void task.finally(() => {
      inFlightOverviews.delete(documentId)
      setGenerating(false)
    })
    return task
  }, [documentId, prepareDocument, refresh])

  // 自动生成（无速览的首次进入）：无速览 + eligible + AI 可用 + 解锁 + 无在途 + 本挂载未失败过。
  useEffect(() => {
    if (!loaded || locked || !backendDocument) return
    if (!view || view.topic || !view.eligible || !view.aiAvailable) return
    if (failure || inFlightOverviews.has(documentId)) return
    void generate()
  }, [backendDocument, documentId, failure, generate, loaded, locked, view])

  // 过期自动重生成（进入已过期的文档 / 正文有修改）：版本变化后等正文
  // 稳定再触发；锁定期（Agent 写入/审阅/历史 diff）定时器被清理，解锁后
  // effect 重跑补触发。失败不自动重试（用户手动或下次版本变化）。
  const regenTimerRef = useRef<number | null>(null)
  const isStale = Boolean(
    view?.topic
    && view.generatedAtVersion != null
    && backendDocument
    && backendDocument.version > view.generatedAtVersion,
  )
  useEffect(() => {
    if (!loaded || locked || !isStale) return
    if (!view || !view.eligible || !view.aiAvailable) return
    if (failure || inFlightOverviews.has(documentId)) return
    if (regenTimerRef.current !== null) window.clearTimeout(regenTimerRef.current)
    regenTimerRef.current = window.setTimeout(() => {
      regenTimerRef.current = null
      if (inFlightOverviews.has(documentId)) return
      void generate()
    }, OVERVIEW_REGEN_SETTLE_MS)
    return () => {
      if (regenTimerRef.current !== null) {
        window.clearTimeout(regenTimerRef.current)
        regenTimerRef.current = null
      }
    }
  }, [backendDocument, documentId, failure, generate, isStale, loaded, locked, view])

  // 尚无速览时正文版本变化（如打开时是空文档，后来写长了）→ 重新评估空短。
  const contentVersion = backendDocument?.version ?? null
  useEffect(() => {
    if (!loaded || contentVersion == null) return
    const previous = lastEvaluatedVersionRef.current
    lastEvaluatedVersionRef.current = contentVersion
    if (previous == null || previous === contentVersion) return
    if (view?.topic) return
    void refresh()
  }, [contentVersion, loaded, refresh, view?.topic])

  const regenerate = useCallback(() => {
    if (inFlightOverviews.has(documentId)) {
      showToast({ title: t('contextRoom:documentQuickView.busy') })
      return
    }
    void generate()
  }, [documentId, generate, t])

  const status = useMemo<DocumentOverviewStatus>(() => {
    if (!backendDocument) return { state: 'idle' }
    if (!loaded) return { state: 'loading' }
    if (generating) return { state: 'generating', view }
    if (view?.topic) {
      const currentVersion = backendDocument?.version ?? view.generatedAtVersion ?? 0
      if (view.generatedAtVersion != null && currentVersion > view.generatedAtVersion) {
        return { state: 'stale', view }
      }
      return { state: 'ready', view }
    }
    if (view && !view.eligible) {
      return { state: 'ineligible', reason: view.reason === 'empty' ? 'empty' : 'too_short' }
    }
    if (view && !view.aiAvailable) return { state: 'failed', kind: 'unavailable' }
    if (failure) return { state: 'failed', kind: failure }
    return { state: 'loading' }
  }, [backendDocument, failure, generating, loaded, view])

  return { status, regenerate }
}
