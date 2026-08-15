import type { JSONContent } from '@tiptap/react'

import type { ContextRoomRecord } from '../../types'

const DOCUMENT_DRAFT_PREFIX = 'everroom:context-room:document:v1:'

function textNode(text: string): JSONContent {
  return { type: 'text', text }
}

export function createRoomDocumentContent(
  room: ContextRoomRecord,
  title: string,
): JSONContent {
  const decisions = room.brief.decisions.length ? room.brief.decisions : ['暂无关键结论']

  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [textNode(title)] },
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

export function readDocumentDraft(documentId: string): JSONContent | null {
  try {
    const raw = localStorage.getItem(`${DOCUMENT_DRAFT_PREFIX}${documentId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { content?: JSONContent }
    return parsed.content?.type === 'doc' ? parsed.content : null
  } catch {
    return null
  }
}

export function writeDocumentDraft(documentId: string, content: JSONContent): boolean {
  try {
    localStorage.setItem(
      `${DOCUMENT_DRAFT_PREFIX}${documentId}`,
      JSON.stringify({ content, updatedAt: new Date().toISOString() }),
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
