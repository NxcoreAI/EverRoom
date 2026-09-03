import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Fragment, Slice } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'
import { Extension, type Editor } from '@tiptap/react'
import {
  addressableBlockTypes,
  createEverroomBlockReferenceUrl,
  parseEverroomBlockReferenceUrl,
} from '@nxcore/document-model'

export const stableBlockTypes = addressableBlockTypes

function newBlockId(): string {
  return crypto.randomUUID()
}

function collectPastedBlockIds(node: ProseMirrorNode, remap: Map<string, string>): void {
  if (!node.isText && stableBlockTypes.has(node.type.name)) {
    const id = typeof node.attrs.id === 'string' ? node.attrs.id.trim() : ''
    if (id && !remap.has(id)) remap.set(id, newBlockId())
  }
  node.content.forEach((child) => collectPastedBlockIds(child, remap))
}

function remapEverroomUrl(
  value: unknown,
  remap: Map<string, string>,
  sourceDocumentId?: string,
): unknown {
  if (typeof value !== 'string') return value
  const reference = parseEverroomBlockReferenceUrl(value)
  if (!reference) return value
  const replacement = (!sourceDocumentId || sourceDocumentId === reference.documentId)
    ? remap.get(reference.blockId)
    : undefined
  if (!replacement) return value
  return createEverroomBlockReferenceUrl({ ...reference, blockId: replacement })
}

function freshenPastedNode(
  node: ProseMirrorNode,
  remap: Map<string, string>,
  sourceDocumentId?: string,
): ProseMirrorNode {
  if (node.isText) {
    const marks = node.marks.map((mark) => mark.type.name === 'link'
      ? mark.type.create({ ...mark.attrs, href: remapEverroomUrl(mark.attrs.href, remap, sourceDocumentId) })
      : mark)
    return node.mark(marks)
  }
  const children: ProseMirrorNode[] = []
  node.content.forEach((child) => children.push(freshenPastedNode(child, remap, sourceDocumentId)))
  const originalId = typeof node.attrs.id === 'string' ? node.attrs.id.trim() : ''
  const attrs = {
    ...node.attrs,
    ...(stableBlockTypes.has(node.type.name) ? { id: remap.get(originalId) ?? newBlockId() } : {}),
    ...(node.type.name === 'documentBlockReference'
      && (!sourceDocumentId || node.attrs.targetDocumentId === sourceDocumentId)
      && typeof node.attrs.targetBlockId === 'string'
      && remap.has(node.attrs.targetBlockId)
      ? { targetBlockId: remap.get(node.attrs.targetBlockId) }
      : {}),
    // 同文档粘贴时,块索引标记的文档目标跟随块 id 重定向;记忆目标保持不变。
    ...(node.type.name === 'blockIndexMark'
      && node.attrs.kind === 'document'
      && (!sourceDocumentId || node.attrs.targetDocumentId === sourceDocumentId)
      && typeof node.attrs.targetBlockId === 'string'
      && remap.has(node.attrs.targetBlockId)
      ? { targetBlockId: remap.get(node.attrs.targetBlockId) }
      : {}),
  }
  const marks = node.marks.map((mark) => mark.type.name === 'link'
    ? mark.type.create({ ...mark.attrs, href: remapEverroomUrl(mark.attrs.href, remap) })
    : mark)
  return node.type.create(attrs, Fragment.fromArray(children), marks)
}

export function stripStableBlockIdsFromPaste(slice: Slice, sourceDocumentId?: string): Slice {
  const remap = new Map<string, string>()
  slice.content.forEach((child) => collectPastedBlockIds(child, remap))
  const children: ProseMirrorNode[] = []
  slice.content.forEach((child) => children.push(freshenPastedNode(child, remap, sourceDocumentId)))
  return new Slice(Fragment.fromArray(children), slice.openStart, slice.openEnd)
}

export function ensureStableBlockIds(editor: Editor): boolean {
  const seen = new Set<string>()
  const changes: Array<{ pos: number; id: string }> = []
  editor.state.doc.descendants((node, pos) => {
    if (!stableBlockTypes.has(node.type.name)) return
    const id = typeof node.attrs.id === 'string' ? node.attrs.id.trim() : ''
    if (id && !seen.has(id)) {
      seen.add(id)
      return
    }
    const next = newBlockId()
    seen.add(next)
    changes.push({ pos, id: next })
  })
  if (!changes.length) return false
  const transaction = editor.state.tr
  for (const change of changes) {
    const node = transaction.doc.nodeAt(change.pos)
    if (node) transaction.setNodeMarkup(change.pos, undefined, { ...node.attrs, id: change.id })
  }
  editor.view.dispatch(transaction)
  return true
}

export const StableBlockIds = Extension.create<{ documentId?: string }>({
  name: 'stableBlockIds',
  addOptions() {
    return {}
  },
  onTransaction({ editor, transaction }) {
    if (transaction.docChanged) ensureStableBlockIds(editor)
  },
  addGlobalAttributes() {
    return [{
      types: [...stableBlockTypes],
      attributes: {
        id: {
          default: null,
          parseHTML: (element) => element.getAttribute('data-block-id'),
          renderHTML: (attributes) => attributes.id ? { 'data-block-id': String(attributes.id) } : {},
        },
      },
    }]
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        transformPasted: (slice) => stripStableBlockIdsFromPaste(slice, this.options.documentId),
      },
      appendTransaction: (transactions, _oldState, newState) => {
        if (!transactions.some((transaction) => transaction.docChanged)) return null
        const seen = new Set<string>()
        const changes: Array<{ pos: number; id: string }> = []
        newState.doc.descendants((node, pos) => {
          if (!stableBlockTypes.has(node.type.name)) return
          const id = typeof node.attrs.id === 'string' ? node.attrs.id.trim() : ''
          if (id && !seen.has(id)) {
            seen.add(id)
            return
          }
          const next = newBlockId()
          seen.add(next)
          changes.push({ pos, id: next })
        })
        if (!changes.length) return null
        const transaction = newState.tr
        for (const change of changes) {
          const node = transaction.doc.nodeAt(change.pos)
          if (node) transaction.setNodeMarkup(change.pos, undefined, { ...node.attrs, id: change.id })
        }
        return transaction
      },
    })]
  },
})
