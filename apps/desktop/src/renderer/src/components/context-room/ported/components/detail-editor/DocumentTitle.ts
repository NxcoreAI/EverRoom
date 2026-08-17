import Document from '@tiptap/extension-document'
import { Node, mergeAttributes } from '@tiptap/react'

export const DOCUMENT_TITLE_NODE = 'documentTitle'

/** A schema-level title keeps the document list and editor on one transaction. */
export const DocumentTitle = Node.create({
  name: DOCUMENT_TITLE_NODE,
  content: 'inline*',
  defining: true,
  isolating: true,

  parseHTML() {
    return [{ tag: 'h1[data-document-title]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['h1', mergeAttributes(HTMLAttributes, { 'data-document-title': '' }), 0]
  },

  renderMarkdown(node) {
    const title = node.textContent.trim()
    return title ? `# ${title}\n\n` : ''
  },

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        if (editor.state.selection.$from.parent.type.name !== DOCUMENT_TITLE_NODE) return false
        const position = editor.state.selection.$from.after(editor.state.selection.$from.depth)
        return editor.chain().insertContentAt(position, { type: 'paragraph' }).setTextSelection(position + 1).run()
      },
    }
  },
})

export const DocumentWithTitle = Document.extend({
  content: `${DOCUMENT_TITLE_NODE} block*`,
})
