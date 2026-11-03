/**
 * Office「AI 修改」的批注草稿（攒一批一起发）。
 *
 * 每条草稿都是浮层提交时宿主组好包的一条消息：`message` 是带块索引/工具提示的
 * 技术指令（只进 runtime），`displayMessage` 是给人看的一句。这里只做「多条 → 一条」
 * 的合并：合并后仍然保持这个分层，气泡里不会出现块索引和工具名。
 */

export interface PendingAskDraft {
  id: string
  workspaceId: string
  /** 所属文件标题（合并文案里点名用；缺失时退化成「几份文件」）。 */
  title?: string
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
  if (titles.length === 1) return `《${titles[0]}》里`
  if (titles.length > 1) return `《${titles.join('》《')}》里`
  return '打开的文件里'
}

/**
 * 把多条草稿合并成一轮请求；空数组返回 null（调用方据此禁用发送）。
 * 单条时不做「1)」编号，保持和技术指令原样一致。
 */
export function buildAskBatch(
  drafts: readonly PendingAskDraft[],
): { message: string; displayMessage: string } | null {
  if (drafts.length === 0) return null
  const message = drafts.length === 1
    ? drafts[0]!.message
    : [
        `我在${documentPhrase(drafts)}攒了 ${drafts.length} 条修改意见，请一次性处理：`
          + '同一份文件按顺序改，改完回一句总的说明，不要重复解释每一步。',
        ...drafts.map((draft, index) => `${index + 1}) ${draft.message}`),
      ].join('\n')
  const displayMessage = drafts.length === 1
    ? (drafts[0]!.displayMessage ?? drafts[0]!.message)
    : `一起改这几处：${drafts
        .map((draft, index) => `${circled(index)} ${(draft.displayMessage ?? draft.message).replace(/[。.]$/, '')}`)
        .join(' ')}`
  return { message, displayMessage }
}
