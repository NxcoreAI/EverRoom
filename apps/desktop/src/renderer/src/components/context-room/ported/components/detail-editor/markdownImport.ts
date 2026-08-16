import type { TiptapJsonContent } from '@nxcore/agent-contract'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'

const markdownManager = new MarkdownManager({
  extensions: [
    StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
    TaskList,
    TaskItem.configure({ nested: true }),
  ],
})

export function markdownDocumentTitle(fileName: string): string {
  return fileName.replace(/\.(?:md|markdown)$/i, '').trim() || '无标题文档'
}

export function parseMarkdownDocument(markdown: string): TiptapJsonContent {
  const parsed = markdownManager.parse(markdown) as TiptapJsonContent
  return parsed.content?.length
    ? parsed
    : { type: 'doc', content: [{ type: 'paragraph' }] }
}
