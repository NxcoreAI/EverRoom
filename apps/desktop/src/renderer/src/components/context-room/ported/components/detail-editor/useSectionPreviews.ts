import type { DocumentSectionPreviewResult } from '@nxcore/agent-contract'
import type { Editor } from '@tiptap/react'
import { useCallback, useEffect, useState } from 'react'
import {
  SECTION_MIN_TEXT_CHARS,
  documentSectionBlocks,
  hashSectionContent,
  sectionPlainTextLength,
  serializeSectionMarkdown,
} from './documentSectionPreview'

/**
 * 章节刻度线 hover 预览的数据层：hover 意图触发 ensurePreview——编辑器
 * 现算章节块 → 序列化 → hash → 会话缓存命中即时返回（零 IO）→ 未命中
 * flush 防抖保存后 POST（网关持久缓存 contentHash 命中也不重调 LLM）。
 * 缓存与在途以 documentId::blockId 记在模块级 Map，编辑器重挂载不中断
 * 不重复（useDocumentOverview 同款模式）。
 */

const previewCache = new Map<string, { contentHash: string; result: DocumentSectionPreviewResult }>()
const inFlightPreviews = new Map<string, Promise<SectionPreviewOutcome>>()

export type SectionPreviewStatus =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; preview: string; generatedAt: string }
  | { state: 'failed' }
  | { state: 'unavailable' }
  | { state: 'too-short' }
  | { state: 'locked' }

type SectionPreviewOutcome =
  | { ok: true; result: DocumentSectionPreviewResult }
  | { ok: false; kind: 'unavailable' | 'too-short' | 'error' }

function classifySectionPreviewError(error: unknown): 'unavailable' | 'too-short' | 'error' {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('SECTION_PREVIEW_AI_UNAVAILABLE')) return 'unavailable'
  if (message.includes('SECTION_PREVIEW_TOO_SHORT')) return 'too-short'
  return 'error'
}

export function useSectionPreviews({ documentId, editor, prepareDocument, locked }: {
  documentId: string
  editor: Editor | null
  /** 生成前 flush 本地防抖保存（仅缓存未命中的生成路径）。 */
  prepareDocument: () => Promise<number>
  /** 锁定期（Agent 写入/审阅/历史 diff）不生成，只回放缓存。 */
  locked: boolean
}): {
  getStatus(blockId: string): SectionPreviewStatus
  ensurePreview(item: { id: string; textContent: string }): void
} {
  const [statuses, setStatuses] = useState<Record<string, SectionPreviewStatus>>({})

  useEffect(() => {
    setStatuses({})
  }, [documentId])

  const setStatus = useCallback((blockId: string, status: SectionPreviewStatus) => {
    setStatuses((current) => (current[blockId] === status ? current : { ...current, [blockId]: status }))
  }, [])

  const ensurePreview = useCallback(({ id, textContent }: { id: string; textContent: string }) => {
    if (!editor || editor.isDestroyed) return
    void (async () => {
      const key = `${documentId}::${id}`
      const blocks = documentSectionBlocks(editor.getJSON().content, id)
      if (!blocks) {
        setStatus(id, { state: 'idle' })
        return
      }
      const markdown = serializeSectionMarkdown(blocks)
      if (sectionPlainTextLength(markdown) < SECTION_MIN_TEXT_CHARS) {
        setStatus(id, { state: 'too-short' })
        return
      }
      const contentHash = await hashSectionContent(markdown)
      const cached = previewCache.get(key)
      if (cached && cached.contentHash === contentHash) {
        setStatus(id, { state: 'ready', preview: cached.result.preview, generatedAt: cached.result.generatedAt })
        return
      }
      if (locked) {
        setStatus(id, { state: 'locked' })
        return
      }
      setStatus(id, { state: 'loading' })
      const task = inFlightPreviews.get(key) ?? (async (): Promise<SectionPreviewOutcome> => {
        try {
          await prepareDocument()
          const result = await window.nxcore!.documents.getSectionPreview(documentId, {
            blockId: id,
            headingText: textContent,
            sectionMarkdown: markdown,
            contentHash,
          })
          return { ok: true, result }
        } catch (error) {
          return { ok: false, kind: classifySectionPreviewError(error) }
        }
      })()
      if (!inFlightPreviews.has(key)) {
        inFlightPreviews.set(key, task)
        void task.finally(() => inFlightPreviews.delete(key))
      }
      const outcome = await task
      if (outcome.ok) {
        previewCache.set(key, { contentHash, result: outcome.result })
        setStatus(id, { state: 'ready', preview: outcome.result.preview, generatedAt: outcome.result.generatedAt })
        return
      }
      if (outcome.kind === 'too-short') setStatus(id, { state: 'too-short' })
      else if (outcome.kind === 'unavailable') setStatus(id, { state: 'unavailable' })
      else setStatus(id, { state: 'failed' })
    })()
  }, [documentId, editor, locked, prepareDocument, setStatus])

  const getStatus = useCallback((blockId: string): SectionPreviewStatus => (
    statuses[blockId] ?? { state: 'idle' }
  ), [statuses])

  return { getStatus, ensurePreview }
}
