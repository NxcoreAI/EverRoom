import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Editor } from '@tiptap/react'
import {
  parseBlockIndexMarkMarkdown,
  parseEverroomBlockReferenceUrl,
  parseEverroomMemoryIndexUrl,
  type EverroomBlockIndexTarget,
} from '@nxcore/document-model'

export const BLOCK_INDEX_MARK_NODE = 'blockIndexMark'

export type BlockIndexTarget = EverroomBlockIndexTarget

export interface BlockIndexMarkNodeAttrs {
  kind: 'document' | 'memory'
  targetRoomId: string
  targetDocumentId: string
  targetBlockId: string
  targetMemoryId: string
  fallbackTitle: string | null
  fallbackPreview: string | null
}

export function toBlockIndexMarkNodeAttrs(target: BlockIndexTarget): BlockIndexMarkNodeAttrs {
  return {
    kind: target.kind,
    targetRoomId: target.roomId,
    targetDocumentId: target.kind === 'document' ? target.documentId : '',
    targetBlockId: target.kind === 'document' ? target.blockId : '',
    targetMemoryId: target.kind === 'memory' ? target.memoryId : '',
    fallbackTitle: target.fallbackTitle ?? null,
    fallbackPreview: target.fallbackPreview ?? null,
  }
}

export function fromBlockIndexMarkNodeAttrs(
  attrs: Partial<BlockIndexMarkNodeAttrs>,
): BlockIndexTarget | null {
  const kind = attrs.kind === 'memory' ? 'memory' : attrs.kind === 'document' ? 'document' : null
  if (!kind) return null
  if (kind === 'document') {
    if (!attrs.targetRoomId || !attrs.targetDocumentId || !attrs.targetBlockId) return null
    return {
      kind,
      roomId: attrs.targetRoomId,
      documentId: attrs.targetDocumentId,
      blockId: attrs.targetBlockId,
      fallbackTitle: attrs.fallbackTitle ?? null,
      fallbackPreview: attrs.fallbackPreview ?? null,
    }
  }
  if (!attrs.targetRoomId || !attrs.targetMemoryId) return null
  return {
    kind,
    roomId: attrs.targetRoomId,
    memoryId: attrs.targetMemoryId,
    fallbackTitle: attrs.fallbackTitle ?? null,
    fallbackPreview: attrs.fallbackPreview ?? null,
  }
}

export function isSameRoomIndexTarget(
  sourceRoomId: string,
  target: Pick<BlockIndexTarget, 'roomId'>,
): boolean {
  return sourceRoomId === target.roomId
}

const MARKDOWN_LINK_PATTERN = /^\s*\[((?:\\.|[^\]])*)\]\((everroom:\/\/[^\s)]+)(?:\s+["'][^)]*["'])?\)\s*$/

/**
 * Parses clipboard text produced by 复制块引用 (and equivalent markdown forms)
 * into an index target. Only a payload that is exactly one block link counts —
 * text with surrounding content pastes normally.
 */
export function blockIndexTargetFromClipboardText(text: string): BlockIndexTarget | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  // 索引标记自身的 markdown 语法 ^[label](url)(例如从 agent markdown 复制)。
  const mark = parseBlockIndexMarkMarkdown(trimmed)
  if (mark && mark.raw === trimmed.trimEnd()) return mark.target
  // markdown 链接 [label](url)
  const linkMatch = trimmed.match(MARKDOWN_LINK_PATTERN)
  if (linkMatch) {
    const target = indexTargetFromUrl(linkMatch[2])
    if (target && !target.fallbackTitle) {
      return { ...target, fallbackTitle: linkMatch[1].replace(/\\([\\[\]])/g, '$1').trim() || target.fallbackTitle }
    }
    return target
  }
  // 裸 URL(复制块引用写剪贴板的就是这个形态)。
  return indexTargetFromUrl(trimmed)
}

function indexTargetFromUrl(url: string): BlockIndexTarget | null {
  const reference = parseEverroomBlockReferenceUrl(url)
  if (reference) return { kind: 'document', ...reference }
  const memory = parseEverroomMemoryIndexUrl(url)
  if (memory) return { kind: 'memory', ...memory }
  return null
}

/**
 * Finds the textblock that should host an index mark for the given top-level
 * block: the last non-code textblock inside it (headings/paragraphs directly,
 * lists/blockquotes via their last item). Returns null for blocks with no
 * eligible host (e.g. a lone code block or horizontal rule).
 */
export function findIndexMarkHost(node: ProseMirrorNode): ProseMirrorNode | null {
  const visit = (current: ProseMirrorNode): ProseMirrorNode | null => {
    if (current.isTextblock) return current.type.name === 'codeBlock' ? null : current
    let last: ProseMirrorNode | null = null
    current.content.forEach((child) => {
      const found = visit(child)
      if (found) last = found
    })
    return last
  }
  return visit(node)
}

/**
 * Inserts an index mark at the end of the host block's content. `hostPos` must
 * point at the top-level block returned by the block handle (any nested
 * textblock position works too — the mark lands at that textblock's end).
 */
export function insertBlockIndexMark(
  editor: Editor,
  hostPos: number,
  hostNode: ProseMirrorNode,
  target: BlockIndexTarget,
): boolean {
  const host = hostNode.isTextblock ? hostNode : findIndexMarkHost(hostNode)
  if (!host) return false
  let insertAt: number | null = null
  if (hostNode.isTextblock) {
    insertAt = hostPos + hostNode.nodeSize - 1
  } else {
    hostNode.descendants((node, pos) => {
      if (node === host) insertAt = hostPos + pos + node.nodeSize - 1
      return true
    })
  }
  if (insertAt == null || insertAt < 0) return false
  // focus() 单独调用：链式 focus 在无头/失焦环境返回 false，会拖垮整个链的
  // 返回值，即使插入实际已成功。
  try { editor.commands.focus() } catch { /* focus 尽力而为 */ }
  return editor.chain().insertContentAt(insertAt, {
    type: BLOCK_INDEX_MARK_NODE,
    attrs: toBlockIndexMarkNodeAttrs(target),
  }, { updateSelection: false }).run()
}
