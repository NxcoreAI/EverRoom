import type { LocalAgentInstallation } from '@nxcore/agent-contract'

export interface MentionedAgent {
  id: string
  displayName: string
}

export interface MentionTokenRange {
  start: number
  end: number
  token: string
  agent: MentionedAgent
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

function matchMentionAgent(
  token: string,
  hintTokens: Map<string, string>,
  localAgents: LocalAgentInstallation[],
): MentionedAgent | null {
  const normalized = token.toLocaleLowerCase()
  const byId = new Map(localAgents.map((agent) => [agent.id, agent]))
  const hintedId = hintTokens.get(normalized)
  if (hintedId) {
    const agent = byId.get(hintedId)
    if (agent) return { id: agent.id, displayName: agent.displayName }
  }
  const candidates = localAgents.filter((agent) => slugifyAgentToken(agent.displayName) === normalized)
  if (candidates.length === 1) return { id: candidates[0]!.id, displayName: candidates[0]!.displayName }
  return null
}

/** 全文中所有能对上真实 agent 的 @ token 及其文本区间（供输入框 overlay 高亮）。 */
export function findMentionRanges(
  value: string,
  hintTokens: Map<string, string>,
  localAgents: LocalAgentInstallation[],
): MentionTokenRange[] {
  const ranges: MentionTokenRange[] = []
  for (const match of value.matchAll(/(^|[\s])@([^\s\n@]+)/g)) {
    const token = match[2]!
    const agent = matchMentionAgent(token, hintTokens, localAgents)
    if (!agent) continue
    const start = match.index! + match[1]!.length
    ranges.push({ start, end: start + 1 + token.length, token, agent })
  }
  return ranges
}

/** 发送前对账：解析全文中 @ 到的 agent（去重保序）；token 被删改后自然失效。 */
export function resolveMentions(
  value: string,
  hintTokens: Map<string, string>,
  localAgents: LocalAgentInstallation[],
): MentionedAgent[] {
  const seen = new Set<string>()
  const mentioned: MentionedAgent[] = []
  for (const range of findMentionRanges(value, hintTokens, localAgents)) {
    if (seen.has(range.agent.id)) continue
    seen.add(range.agent.id)
    mentioned.push(range.agent)
  }
  return mentioned
}
