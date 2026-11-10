/**
 * Office「AI 修改」的批注草稿（攒一批一起发）。
 *
 * 每条草稿都是浮层提交时宿主组好包的一条消息：`message` 是带块索引/工具提示的
 * 技术指令（只进 runtime），`displayMessage` 是给人看的一句。这里只做「多条 → 一条」
 * 的合并：合并后仍然保持这个分层，气泡里不会出现块索引和工具名。
 */

import type { OfficeAskAnchor } from '@/shared/office'
import type { AgentNoteCard } from '@nxcore/agent-contract'

export interface PendingAskDraft {
  id: string
  workspaceId: string
  /** 所属文件（文档视图按 fileId 接收队列快照，用来渲染锚点与面板）。 */
  fileId?: string
  /** 所属文件标题（合并文案里点名用；缺失时退化成「几份文件」）。 */
  title?: string
  /** 用户敲的原始批注（文档内面板显示这句，而不是包装后的指令）。 */
  instruction?: string
  /** 原文摘录（选中时的文本快照）。 */
  excerpt?: string
  /** 选区锚点（Word 块索引 / Excel 区域 / PPT 元素 / PDF 页面 quads）。 */
  anchor?: OfficeAskAnchor
  /** 技术指令：块索引/区域/工具提示，只进 runtime。 */
  message: string
  /** 用户可见的一句（气泡与会话标题用它）。 */
  displayMessage?: string
  createdAt: string
}

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫']

function circled(index: number): string {
  return CIRCLED[index] ?? `(${index + 1})`
}

function documentPhrase(drafts: readonly PendingAskDraft[]): string {
  const titles = [...new Set(drafts.map((draft) => draft.title?.trim() || '').filter(Boolean))]
  if (titles.length === 1) return `《${titles[0]}》`
  if (titles.length > 1) return `《${titles.join('》《')}》`
  return '打开的文件'
}

/**
 * 把多条草稿合并成一轮请求；空数组返回 null（调用方据此禁用发送）。
 * 单条时不做「1)」编号，保持和技术指令原样一致。
 * 开场白不预设「修改」——草稿可能是提问，具体做什么由 Agent 按每条原话理解。
 */
export function buildAskBatch(
  drafts: readonly PendingAskDraft[],
): { message: string; displayMessage: string } | null {
  if (drafts.length === 0) return null
  const message = drafts.length === 1
    ? drafts[0]!.message
    : [
        `我在${documentPhrase(drafts)}的 ${drafts.length} 处内容上做了批注，请逐条看原话处理：`
          + '同一份文件按顺序来，处理完回一句总的说明，不要重复解释每一步。',
        ...drafts.map((draft, index) => `${index + 1}) ${draft.message}`),
      ].join('\n')
  const displayMessage = drafts.length === 1
    ? (drafts[0]!.displayMessage ?? drafts[0]!.message)
    : `我对这几处做了批注：${drafts
        .map((draft, index) => `${circled(index)} ${(draft.displayMessage ?? draft.message).replace(/[。.]$/, '')}`)
        .join(' ')}`
  return { message, displayMessage }
}

/** 批注锚点没有文字内容（图片/形状等非文本选区）时的占位摘录。 */
export const EMPTY_EXCERPT_PLACEHOLDER = '（该批注未选中文字内容）'

/**
 * 批注草稿 → 气泡卡片结构（原文摘录 + 注释原话；来源文件可辨时带标题）。
 *
 * excerpt 空串必须给占位：网关对 noteCards[].excerpt 有 minLength:1 校验，
 * 直接传 '' 会被 422 拒掉整条消息（2026-11-05 实测「对图片写批注并发送」踩中）。
 */
export function buildNoteCards(drafts: readonly PendingAskDraft[]): AgentNoteCard[] {
  return drafts.map((draft) => ({
    excerpt: (draft.excerpt ?? '').replace(/\s+/g, ' ').trim() || EMPTY_EXCERPT_PLACEHOLDER,
    note: (draft.instruction ?? draft.displayMessage ?? draft.message).trim(),
    ...(draft.title?.trim() ? { title: draft.title.trim() } : {}),
  }))
}
