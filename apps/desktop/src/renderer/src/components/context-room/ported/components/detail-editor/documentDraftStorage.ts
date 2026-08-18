import type { JSONContent } from '@tiptap/react'

import type { ContextRoomRecord } from '../../types'

const DOCUMENT_DRAFT_PREFIX = 'everroom:context-room:document:v1:'

export interface DocumentDraft {
  content: JSONContent
  title?: string
  baseVersion: number | null
  updatedAt: string
}

export function shouldRecoverDocumentDraft(
  draft: DocumentDraft | null,
  backend: { version: number; updatedAt: string; contentJson: JSONContent } | null,
): boolean {
  if (!draft || !backend || draft.baseVersion === null || draft.content.type !== 'doc') return false
  if (JSON.stringify(draft.content) === JSON.stringify(backend.contentJson)) return false
  if (draft.baseVersion === backend.version) return true
  return draft.baseVersion < backend.version && draft.updatedAt > backend.updatedAt
}

function textNode(text: string): JSONContent {
  return { type: 'text', text }
}

export function createRoomDocumentContent(
  room: ContextRoomRecord,
  _title: string,
): JSONContent {
  const decisions = room.brief.decisions.length ? room.brief.decisions : ['暂无关键结论']

  return {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [textNode(room.brief.background)] },
      { type: 'heading', attrs: { level: 2 }, content: [textNode('目标')] },
      { type: 'paragraph', content: [textNode(room.brief.goal)] },
      { type: 'heading', attrs: { level: 2 }, content: [textNode('关键结论')] },
      {
        type: 'bulletList',
        content: decisions.map((decision) => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: [textNode(decision)] }],
        })),
      },
    ],
  }
}

export function readDocumentDraftRecord(documentId: string): DocumentDraft | null {
  try {
    const raw = localStorage.getItem(`${DOCUMENT_DRAFT_PREFIX}${documentId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<DocumentDraft>
    if (parsed.content?.type !== 'doc') return null
    return {
      content: parsed.content,
      ...(typeof parsed.title === 'string' ? { title: parsed.title } : {}),
      baseVersion: Number.isSafeInteger(parsed.baseVersion) && Number(parsed.baseVersion) >= 0
        ? Number(parsed.baseVersion)
        : null,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
    }
  } catch {
    return null
  }
}

export function readDocumentDraft(documentId: string): JSONContent | null {
  return readDocumentDraftRecord(documentId)?.content ?? null
}

export function writeDocumentDraft(
  documentId: string,
  content: JSONContent,
  baseVersion: number | null = null,
  title?: string,
): boolean {
  try {
    localStorage.setItem(
      `${DOCUMENT_DRAFT_PREFIX}${documentId}`,
      JSON.stringify({ content, baseVersion, ...(title ? { title } : {}), updatedAt: new Date().toISOString() }),
    )
    return true
  } catch {
    return false
  }
}

export function removeDocumentDraft(documentId: string): void {
  try {
    localStorage.removeItem(`${DOCUMENT_DRAFT_PREFIX}${documentId}`)
  } catch {
    // The Gateway remains authoritative when browser storage is unavailable.
  }
}
