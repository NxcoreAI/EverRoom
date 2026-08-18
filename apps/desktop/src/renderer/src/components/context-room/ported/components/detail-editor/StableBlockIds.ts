import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Fragment, Slice } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'
import { Extension, type Editor } from '@tiptap/react'
import { addressableBlockTypes } from '@nxcore/document-model'

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
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return value
  }
  if (url.protocol !== 'everroom:' || url.hostname !== 'room') return value
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 3) return value
  let documentId: string
  let blockId: string
  try {
    documentId = decodeURIComponent(parts[1]!)
    blockId = decodeURIComponent(parts[2]!)
  } catch {
    return value
  }
  const replacement = (!sourceDocumentId || sourceDocumentId === documentId) ? remap.get(blockId) : undefined
  if (!replacement) return value
  parts[2] = encodeURIComponent(replacement)
  url.pathname = `/${parts.join('/')}`
  return url.toString()
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
