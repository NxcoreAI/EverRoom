import type { LocalAgentInstallation } from '@nxcore/agent-contract'

export type MentionKind = 'agent' | 'room' | 'file' | 'conversation'

export interface MentionedAgent {
  id: string
  displayName: string
}

/** @ 提及解析出的条目：Agent 走派发，其余三类作为运行上下文引用。 */
export interface MentionedItem {
  kind: MentionKind
  id: string
  displayName: string
}

export interface MentionTokenRange {
  start: number
  end: number
  token: string
  item: MentionedItem
}

/** displayName → @ 后插入的 token：小写、保留字母/数字/中文/连字符，其余折叠为连字符。 */
export function slugifyAgentToken(displayName: string): string {
  const slug = displayName
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return slug || displayName.trim()
}

/** 光标前是否正处在一个 @ 触发词上；返回查询串与插入替换起点（@ 的下标）。 */
export function matchMentionTrigger(value: string, caret: number): { query: string; replaceStart: number } | null {
  const match = /(^|[\s])@([^\s\n@]*)$/.exec(value.slice(0, caret))
  if (!match) return null
  return { query: match[2]!, replaceStart: match.index! + match[1]!.length }
}

function matchMentionItem(
  token: string,
  hintItems: Map<string, MentionedItem>,
  localAgents: LocalAgentInstallation[],
): MentionedItem | null {
  const normalized = token.toLocaleLowerCase()
  const hinted = hintItems.get(normalized)
  if (hinted) return hinted
  // Agent 支持 slug 免 hint 解析（从历史消息/手打场景恢复）；其余类型只能靠 hint。
  const candidates = localAgents.filter((agent) => slugifyAgentToken(agent.displayName) === normalized)
  if (candidates.length === 1) {
    return { kind: 'agent', id: candidates[0]!.id, displayName: candidates[0]!.displayName }
  }
  return null
}

/** 全文中所有能解析的 @ token 及其文本区间（供输入框 overlay 高亮）。 */
export function findMentionRanges(
  value: string,
  hintItems: Map<string, MentionedItem>,
  localAgents: LocalAgentInstallation[],
): MentionTokenRange[] {
  const ranges: MentionTokenRange[] = []
  for (const match of value.matchAll(/(^|[\s])@([^\s\n@]+)/g)) {
    const token = match[2]!
    const item = matchMentionItem(token, hintItems, localAgents)
    if (!item) continue
    const start = match.index! + match[1]!.length
    ranges.push({ start, end: start + 1 + token.length, token, item })
  }
  return ranges
}

/** 发送前对账：解析全文中 @ 到的条目（去重保序，按 kind+id）；token 被删改后自然失效。 */
export function resolveMentions(
  value: string,
  hintItems: Map<string, MentionedItem>,
  localAgents: LocalAgentInstallation[],
): MentionedItem[] {
  const seen = new Set<string>()
  const mentioned: MentionedItem[] = []
  for (const range of findMentionRanges(value, hintItems, localAgents)) {
    const key = `${range.item.kind}:${range.item.id}`
    if (seen.has(key)) continue
    seen.add(key)
    mentioned.push(range.item)
  }
  return mentioned
}

/** 生成不与现有 hint 冲突的插入 token（同名不同条目时追加短后缀）。 */
export function allocateMentionToken(displayName: string, id: string, hintItems: Map<string, MentionedItem>): string {
  let token = slugifyAgentToken(displayName)
  while (hintItems.has(token) && hintItems.get(token)!.id !== id) {
    token = `${token}-2`
  }
  return token
}
