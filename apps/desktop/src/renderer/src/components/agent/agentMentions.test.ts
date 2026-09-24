import { describe, expect, it } from 'vitest'
import type { LocalAgentInstallation } from '@nxcore/agent-contract'

import {
  allocateMentionToken,
  findMentionRanges,
  matchMentionTrigger,
  resolveMentions,
  slugifyAgentToken,
  type MentionedItem,
} from './agentMentions'

const codexAgent: LocalAgentInstallation = {
  id: 'codex:/usr/local/bin/codex',
  provider: 'codex',
  displayName: 'Codex',
  executablePath: '/usr/local/bin/codex',
  version: '0.2.0',
  status: 'verified',
  callable: true,
  invocationSupported: true,
  historyAvailable: true,
  historyPaths: [],
  card: {
    name: 'Codex',
    description: 'OpenAI Codex CLI',
    version: '1.0.0',
    supportedInterfaces: [],
    capabilities: {},
    defaultInputModes: [],
    defaultOutputModes: [],
    skills: [],
  },
  lastSeenAt: '2026-09-09T00:00:00.000Z',
}

const chineseAgent: LocalAgentInstallation = {
  ...codexAgent,
  id: 'openclaw:/opt/homebrew/bin/openclaw',
  provider: 'openclaw',
  displayName: '抓取助手',
}

const localAgents = [codexAgent, chineseAgent]
const hintItems = new Map<string, MentionedItem>([['codex', {
  kind: 'agent',
  id: 'codex:/usr/local/bin/codex',
  displayName: 'Codex',
}]])

describe('slugifyAgentToken', () => {
  it('keeps letters, numbers, CJK and hyphens and drops the rest', () => {
    expect(slugifyAgentToken('Claude Code')).toBe('claude-code')
    expect(slugifyAgentToken('OpenClaw (beta)')).toBe('openclaw-beta')
    expect(slugifyAgentToken('抓取助手')).toBe('抓取助手')
  })
})

describe('matchMentionTrigger', () => {
  it('fires mid-text only when the caret sits on an @ word', () => {
    expect(matchMentionTrigger('先处理，然后 @cod', 11)).toEqual({ query: 'cod', replaceStart: 7 })
    expect(matchMentionTrigger('@', 1)).toEqual({ query: '', replaceStart: 0 })
    expect(matchMentionTrigger('email foo@bar', 13)).toBeNull()
    expect(matchMentionTrigger('已选 @codex ', 11)).toBeNull()
    expect(matchMentionTrigger('a@b', 3)).toBeNull()
  })
})

describe('findMentionRanges', () => {
  it('covers resolved tokens only, hint first then unique slug fallback', () => {
    const ranges = findMentionRanges('让 @codex 和 @抓取助手 一起', hintItems, localAgents)
    expect(ranges.map((range) => [range.start, range.end, range.item.id, range.item.kind])).toEqual([
      [2, 8, 'codex:/usr/local/bin/codex', 'agent'],
      [11, 16, 'openclaw:/opt/homebrew/bin/openclaw', 'agent'],
    ])
  })

  it('ignores unresolved tokens and mid-word @', () => {
    expect(findMentionRanges('联系 foo@codex 或 @unknown', hintItems, localAgents)).toHaveLength(0)
  })

  it('resolves non-agent kinds through hints and dedupes by kind+id', () => {
    const hints = new Map<string, MentionedItem>([
      ['room-x', { kind: 'room', id: 'room-1', displayName: 'X' }],
      ['room-x2', { kind: 'room', id: 'room-1', displayName: 'X' }],
    ])
    const mentioned = resolveMentions('看下 @room-x 和 @room-x2', hints, localAgents)
    expect(mentioned).toEqual([{ kind: 'room', id: 'room-1', displayName: 'X' }])
  })
})

describe('allocateMentionToken', () => {
  it('reuses a token held by the same item and suffixes on collision', () => {
    const hints = new Map<string, MentionedItem>([
      ['codex', { kind: 'conversation', id: 'thread-1', displayName: 'Codex' }],
    ])
    expect(allocateMentionToken('Codex', 'thread-1', hints)).toBe('codex')
    expect(allocateMentionToken('Codex', 'agent-2', hints)).toBe('codex-2')
  })
})
