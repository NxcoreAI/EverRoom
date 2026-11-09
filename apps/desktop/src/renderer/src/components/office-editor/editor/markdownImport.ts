import type { TiptapJsonContent } from '@nxcore/agent-contract'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { DocumentBlockReference } from './DocumentBlockReference'
import { DOCUMENT_HEADING_LEVELS } from './documentHeadingLevels'

const markdownManager = new MarkdownManager({
  extensions: [
    StarterKit.configure({ heading: { levels: [...DOCUMENT_HEADING_LEVELS] } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Image.configure({ allowBase64: false }),
    DocumentBlockReference.configure({ sourceRoomId: '' }),
  ],
})

export function markdownDocumentTitle(fileName: string, untitled = '无标题文档'): string {
  return fileName.replace(/\.(?:md|markdown)$/i, '').trim() || untitled
}

export function parseMarkdownDocument(markdown: string): TiptapJsonContent {
  const parsed = markdownManager.parse(markdown) as TiptapJsonContent
  return parsed.content?.length
    ? parsed
    : { type: 'doc', content: [{ type: 'paragraph' }] }
}
