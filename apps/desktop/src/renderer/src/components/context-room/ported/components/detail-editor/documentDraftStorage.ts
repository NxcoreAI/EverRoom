import type { JSONContent } from '@tiptap/react'
import { createVersionedLocalStorageStore } from '@nxcore/migration-kit/local'

import type { Translate } from '../../../../../i18n/LocaleContext'
import type { ContextRoomRecord } from '../../types'

// 旧布局把版本号嵌在 key 中段（everroom:context-room:document:v1:<id>），
// 作为 legacyKeys 兜底认领；新规范 key 为 document-draft:<id>:v<N>。
const DRAFT_KEY_VERSION = 1

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
  t?: Translate,
): JSONContent {
  const decisions = room.brief.decisions.length
    ? room.brief.decisions
    : [t?.('contextRoom:documentDraft.noKeyConclusions') ?? '暂无关键结论']

  return {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [textNode(room.brief.background)] },
      { type: 'heading', attrs: { level: 2 }, content: [textNode(t?.('contextRoom:documentDraft.goal') ?? '目标')] },
      { type: 'paragraph', content: [textNode(room.brief.goal)] },
      { type: 'heading', attrs: { level: 2 }, content: [textNode(t?.('contextRoom:documentDraft.keyConclusions') ?? '关键结论')] },
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

function adoptDraft(raw: unknown): DocumentDraft | null {
  const parsed = raw as Partial<DocumentDraft>
  if (!parsed || parsed.content?.type !== 'doc') return null
  return {
    content: parsed.content,
    ...(typeof parsed.title === 'string' ? { title: parsed.title } : {}),
    baseVersion: Number.isSafeInteger(parsed.baseVersion) && Number(parsed.baseVersion) >= 0
      ? Number(parsed.baseVersion)
      : null,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
  }
}

function createDraftStore(documentId: string) {
  return createVersionedLocalStorageStore<DocumentDraft | null>({
    keyBase: `everroom:context-room:document-draft:${documentId}`,
    version: DRAFT_KEY_VERSION,
    adoptBaseline: adoptDraft,
    fallback: null,
    migrations: [],
    legacyKeys: [`everroom:context-room:document:v1:${documentId}`],
  })
}

export function readDocumentDraftRecord(documentId: string): DocumentDraft | null {
  try {
    return createDraftStore(documentId).get()
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
    createDraftStore(documentId).set({
      content,
      baseVersion,
      ...(title ? { title } : {}),
      updatedAt: new Date().toISOString(),
    })
    return true
  } catch {
    return false
  }
}

export function removeDocumentDraft(documentId: string): void {
  try {
    createDraftStore(documentId).clear()
  } catch {
    // The Gateway remains authoritative when browser storage is unavailable.
  }
}
