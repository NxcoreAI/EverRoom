import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Fragment, Slice } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'
import { Extension, type Editor } from '@tiptap/react'

export const stableBlockTypes = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'taskList',
  'listItem',
  'taskItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'documentBlockReference',
])

function newBlockId(): string {
  return crypto.randomUUID()
}

function freshenPastedNode(node: ProseMirrorNode): ProseMirrorNode {
  if (node.isText) return node
  const children: ProseMirrorNode[] = []
  node.content.forEach((child) => children.push(freshenPastedNode(child)))
  const attrs = stableBlockTypes.has(node.type.name)
    ? { ...node.attrs, id: null }
    : node.attrs
  return node.type.create(attrs, Fragment.fromArray(children), node.marks)
}

export function stripStableBlockIdsFromPaste(slice: Slice): Slice {
  const children: ProseMirrorNode[] = []
  slice.content.forEach((child) => children.push(freshenPastedNode(child)))
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

export const StableBlockIds = Extension.create({
  name: 'stableBlockIds',
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
        transformPasted: stripStableBlockIdsFromPaste,
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
