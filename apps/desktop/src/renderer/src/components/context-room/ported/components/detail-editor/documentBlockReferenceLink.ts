import type {
  DocumentBlockReferenceInput,
  DocumentBlockResolution,
  DocumentBlockResolutionStatus,
} from '@nxcore/agent-contract'

export const DOCUMENT_BLOCK_REFERENCE_NODE = 'documentBlockReference'

export interface DocumentBlockReferenceAttrs extends DocumentBlockReferenceInput {
  /** Stable id of the reference block itself, not the target block. */
  id?: string | null
  fallbackTitle?: string | null
  fallbackPreview?: string | null
}

export interface DocumentBlockReferenceNodeAttrs {
  id?: string | null
  targetRoomId: string
  targetDocumentId: string
  targetBlockId: string
  fallbackTitle?: string | null
  fallbackPreview?: string | null
}

export function toDocumentBlockReferenceNodeAttrs(
  reference: DocumentBlockReferenceAttrs,
): DocumentBlockReferenceNodeAttrs {
  return {
    id: reference.id,
    targetRoomId: reference.roomId,
    targetDocumentId: reference.documentId,
    targetBlockId: reference.blockId,
    fallbackTitle: reference.fallbackTitle,
    fallbackPreview: reference.fallbackPreview,
  }
}

export function fromDocumentBlockReferenceNodeAttrs(
  attrs: Partial<DocumentBlockReferenceNodeAttrs>,
): DocumentBlockReferenceAttrs {
  return {
    id: attrs.id,
    roomId: attrs.targetRoomId || '',
    documentId: attrs.targetDocumentId || '',
    blockId: attrs.targetBlockId || '',
    fallbackTitle: attrs.fallbackTitle,
    fallbackPreview: attrs.fallbackPreview,
  }
}

const EVERROOM_PROTOCOL = 'everroom:'
const ROOM_HOST = 'room'

function cleanOptionalText(value: string | null | undefined): string | null {
  const text = value?.trim()
  return text ? text : null
}

export function createEverroomBlockReferenceUrl(
  reference: DocumentBlockReferenceAttrs,
): string {
  const path = [reference.roomId, reference.documentId, reference.blockId]
    .map((part) => encodeURIComponent(part))
    .join('/')
  const query = new URLSearchParams()
  const title = cleanOptionalText(reference.fallbackTitle)
  const preview = cleanOptionalText(reference.fallbackPreview)
  if (title) query.set('title', title)
  if (preview) query.set('preview', preview)
  const suffix = query.size > 0 ? `?${query.toString()}` : ''
  return `everroom://${ROOM_HOST}/${path}${suffix}`
}

export function parseEverroomBlockReferenceUrl(
  value: string,
): DocumentBlockReferenceAttrs | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== EVERROOM_PROTOCOL || url.hostname !== ROOM_HOST) return null

  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 3) return null
  let decoded: string[]
  try {
    decoded = parts.map((part) => decodeURIComponent(part))
  } catch {
    return null
  }
  const [roomId, documentId, blockId] = decoded
  if (!roomId || !documentId || !blockId) return null
  return {
    roomId,
    documentId,
    blockId,
    fallbackTitle: cleanOptionalText(url.searchParams.get('title')),
    fallbackPreview: cleanOptionalText(url.searchParams.get('preview')),
  }
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\\[\]])/g, '\\$1').replace(/[\r\n]+/g, ' ').trim()
}

function unescapeMarkdownLabel(value: string): string {
  return value.replace(/\\([\\\[\]])/g, '$1').trim()
}

export function documentBlockReferenceToMarkdown(
  reference: DocumentBlockReferenceAttrs,
): string {
  const label = escapeMarkdownLabel(reference.fallbackTitle || '文档块引用') || '文档块引用'
  return `[${label}](${createEverroomBlockReferenceUrl(reference)})`
}

export function parseDocumentBlockReferenceMarkdown(
  markdown: string,
): DocumentBlockReferenceAttrs | null {
  const match = markdown.match(
    /^\s*\[((?:\\.|[^\]])*)\]\((everroom:\/\/[^\s)]+)(?:\s+["'][^)]*["'])?\)\s*(?:\r?\n|$)/,
  )
  if (!match) return null
  const reference = parseEverroomBlockReferenceUrl(match[2])
  if (!reference) return null
  return {
    ...reference,
    fallbackTitle: reference.fallbackTitle || cleanOptionalText(unescapeMarkdownLabel(match[1])),
  }
}

export function isSameRoomBlockReference(
  sourceRoomId: string,
  reference: Pick<DocumentBlockReferenceInput, 'roomId'>,
): boolean {
  return sourceRoomId === reference.roomId
}

export function parseSameRoomBlockReferenceLink(
  value: string,
  sourceRoomId: string,
): DocumentBlockReferenceAttrs | null {
  const reference = parseEverroomBlockReferenceUrl(value)
  return reference && isSameRoomBlockReference(sourceRoomId, reference) ? reference : null
}

const STATUS_LABELS: Record<DocumentBlockResolutionStatus, string> = {
  available: '可用',
  document_trashed: '文档在回收站',
  document_deleted: '文档已删除',
  block_missing: '原内容块已不存在',
  room_unavailable: '不在当前 Room',
}

export function documentBlockResolutionLabel(
  resolution: Pick<DocumentBlockResolution, 'status'> | null,
): string {
  return resolution ? STATUS_LABELS[resolution.status] : '暂时无法更新'
}
