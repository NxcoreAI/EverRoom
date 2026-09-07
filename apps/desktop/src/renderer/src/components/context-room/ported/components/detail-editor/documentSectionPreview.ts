import type { TiptapJsonContent } from '@nxcore/agent-contract'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { BlockIndexMark } from './BlockIndexMark'
import { DocumentBlockReference } from './DocumentBlockReference'
import { DOCUMENT_HEADING_LEVELS } from './documentHeadingLevels'

/**
 * 章节刻度线 hover 预览的纯函数层：从文档顶层数组切出章节块、序列化
 * markdown、算 SHA-256。章节正文在 hover 时刻由编辑器 getJSON() 现算
 * （不缓存编辑器内容，避免与防抖保存竞态）。
 */

/** 章节纯文本 <50 字视为过短（与网关 MIN_SECTION_TEXT_CHARS 对齐的本地预判）。 */
export const SECTION_MIN_TEXT_CHARS = 50

function headingTocId(node: TiptapJsonContent): string | null {
  if (node.type !== 'heading') return null
  const id = node.attrs?.['data-toc-id']
  return typeof id === 'string' && id ? id : null
}

function headingLevel(node: TiptapJsonContent): number | null {
  if (node.type !== 'heading') return null
  const level = node.attrs?.level
  return typeof level === 'number' ? level : null
}

/**
 * 切出章节：从 blockId 对应的 heading 起，到下一个 level <= 起始 level
 * 的 heading（不含）为止的顶层节点数组；找不到 heading / 空结果 → null。
 */
export function documentSectionBlocks(
  content: TiptapJsonContent[] | undefined,
  blockId: string,
): TiptapJsonContent[] | null {
  if (!content?.length) return null
  const startIndex = content.findIndex((node) => headingTocId(node) === blockId)
  if (startIndex < 0) return null
  const startLevel = headingLevel(content[startIndex]!) ?? 2
  const blocks: TiptapJsonContent[] = []
  for (let index = startIndex; index < content.length; index += 1) {
    const node = content[index]!
    if (index > startIndex) {
      const level = headingLevel(node)
      if (level != null && level <= startLevel) break
    }
    blocks.push(node)
  }
  return blocks.length > 0 ? blocks : null
}

const sectionMarkdownManager = new MarkdownManager({
  extensions: [
    StarterKit.configure({ heading: { levels: [...DOCUMENT_HEADING_LEVELS] } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Image.configure({ allowBase64: false }),
    DocumentBlockReference.configure({ sourceRoomId: '' }),
    BlockIndexMark.configure({ sourceRoomId: '' }),
  ],
})

/** 序列化章节块为 markdown；序列化失败回退纯文本拼接（预览可用即可）。 */
export function serializeSectionMarkdown(blocks: TiptapJsonContent[]): string {
  try {
    return sectionMarkdownManager.serialize({ type: 'doc', content: blocks })
  } catch {
    return blocks.map((block) => JSON.stringify(block)).join('\n')
  }
}

/** SHA-256 hex；hover 路径本就 async，不做同步弱哈希（防碰撞误判缓存命中）。 */
export async function hashSectionContent(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** 章节纯文本长度（剥 markdown 记号的近似值），本地空短预判用。 */
export function sectionPlainTextLength(markdown: string): number {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length
}
