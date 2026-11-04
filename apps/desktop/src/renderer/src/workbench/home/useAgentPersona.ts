import { useCallback, useEffect, useState } from 'react'

import { relativeTimeLabel } from '../types'

/**
 * 「智能体」页的真实数据层：
 * - 人格 ← 网关 `agent.getDefinition('main')`（内置 Agent bundle 的名称/简介/SYSTEM.md/技能）；
 * - 用户画像 ← 网关 `memory.getProfile`（聚合优先、标签兜底，分组口径在网关侧）；
 * - 经验 ← 长期记忆库 `memory.listEntries`（category=lesson 的条目）。
 *
 * 三路各自独立成败：人格失败不影响记忆展示，反之亦然。
 * 归一函数全部接受 `unknown`（桥可能缺失或形状不同），异常形状降级为空而不是崩溃。
 */

export type PersonaLoadable<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error' }

export interface PersonaView {
  name: string
  tagline: string
  /** 技能名（bundle skills；正文与启停在「技能」页）。 */
  skills: string[]
  /** 系统提示词摘要。 */
  promptSummary: string
}

export interface ProfileItemView {
  id: string
  content: string
}

export interface ProfileGroupView {
  title: string
  items: ProfileItemView[]
}

export interface ExperienceView {
  id: string
  text: string
  whenLabel: string
}

export interface AgentPersonaData {
  persona: PersonaView
  profile: ProfileGroupView[]
  /** aggregate=模型聚合的画像；fallback=按标签分组的原始事实；empty=记忆库为空。 */
  profileSource: 'aggregate' | 'fallback' | 'empty'
  experiences: ExperienceView[]
  /**
   * 读取是否失败。必须和「真的没有」区分开：400/网络异常时若显示
   * 「还没有沉淀用户画像」，用户会以为自己的信息没被记住。
   */
  failed: { profile: boolean; experiences: boolean }
}

const PROMPT_SUMMARY_LIMIT = 220
/** 经验条目取多少条：网关上限 200，取 50 够「经验」栏展示，也不至于拖慢首屏。 */
const ENTRY_LIMIT = 50
const EXPERIENCE_LIMIT = 20
/** 画像聚合产物的标记标签（见 gateway modules/memory/tags.ts），不进「经验」栏。 */
const PROFILE_AGGREGATE_TAG = '画像'

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

/** 多行 SYSTEM.md 压成一行摘要。 */
function summarize(text: string): string {
  const flattened = text.replace(/\s+/g, ' ').trim()
  if (flattened.length <= PROMPT_SUMMARY_LIMIT) return flattened
  return `${flattened.slice(0, PROMPT_SUMMARY_LIMIT)}…`
}

function toPersona(raw: unknown): PersonaView | null {
  const record = asRecord(raw)
  if (!record) return null
  const name = asString(record.name).trim()
  if (!name) return null
  const skills = asStringArray(record.skills)
  return {
    name,
    tagline: asString(record.description).trim(),
    // 技能清单是 bundle 里真实存在的字段：这里只列名字，细节交给「技能」页。
    skills: skills.slice(0, 6),
    promptSummary: summarize(asString(record.systemPrompt)),
  }
}

interface MemoryEntryView {
  id: string
  content: string
  tags: string[]
  createdAt: string
  /** episodic/semantic（hippo 原始层，只作参考）。 */
  layer: string
  /** 对外类别：fact | lesson（经验被整理合并成 semantic 后仍然是 lesson）。 */
  category: 'fact' | 'lesson'
}

function toEntries(raw: unknown): MemoryEntryView[] {
  const record = asRecord(raw)
  const items = Array.isArray(record?.items) ? record.items : []
  return items.flatMap((item): MemoryEntryView[] => {
    const entry = asRecord(item)
    if (!entry) return []
    const id = asString(entry.id)
    const content = asString(entry.content).trim()
    if (!id || !content) return []
    const layer = asString(entry.layer) || 'episodic'
    const category = entry.category === 'lesson' || entry.category === 'fact'
      ? entry.category
      : layer === 'episodic' ? 'lesson' : 'fact'
    return [{
      id,
      content,
      tags: asStringArray(entry.tags),
      createdAt: asString(entry.createdAt),
      layer,
      category,
    }]
  })
}

/** 网关已经分好组的画像：这里只做形状校验，不做任何标签判断。 */
function toProfile(raw: unknown): { source: AgentPersonaData['profileSource']; groups: ProfileGroupView[] } {
  const record = asRecord(raw)
  const source = record?.source === 'aggregate' || record?.source === 'fallback' || record?.source === 'empty'
    ? record.source
    : 'empty'
  const rawGroups = Array.isArray(record?.groups) ? record.groups : []
  const groups = rawGroups.flatMap((group): ProfileGroupView[] => {
    const item = asRecord(group)
    if (!item) return []
    const title = asString(item.title).trim()
    const rawItems = Array.isArray(item.items) ? item.items : []
    const items = rawItems.flatMap((entry): ProfileItemView[] => {
      const view = asRecord(entry)
      if (!view) return []
      const content = asString(view.content).trim()
      if (!content) return []
      return [{ id: asString(view.id) || content, content }]
    })
    if (!title || items.length === 0) return []
    return [{ title, items }]
  })
  return { source, groups }
}

function toExperiences(entries: MemoryEntryView[]): ExperienceView[] {
  return entries
    .filter((entry) => entry.category === 'lesson')
    .filter((entry) => !entry.tags.includes(PROFILE_AGGREGATE_TAG))
    .slice(0, EXPERIENCE_LIMIT)
    .map((entry) => ({
      id: entry.id,
      text: entry.content,
      whenLabel: entry.createdAt ? relativeTimeLabel(entry.createdAt) : '',
    }))
}

export function useAgentPersona(agentId = 'main'): {
  state: PersonaLoadable<AgentPersonaData>
  reload: () => void
} {
  const [state, setState] = useState<PersonaLoadable<AgentPersonaData>>({ status: 'loading' })
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => {
    setState({ status: 'loading' })
    setNonce((value) => value + 1)
  }, [])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      const api = window.nxcore
      const [definition, rawProfile, entries] = await Promise.all([
        Promise.resolve(api?.agent?.getDefinition?.(agentId)).catch(() => null),
        Promise.resolve(api?.memory?.getProfile?.()).catch(() => null),
        Promise.resolve(api?.memory?.listEntries?.({ limit: ENTRY_LIMIT })).catch(() => null),
      ])
      if (cancelled) return

      const persona = toPersona(definition)
      // 人格读不到就没有可展示的主体，视为整页失败；记忆为空是正常状态。
      if (!persona) {
        setState({ status: 'error' })
        return
      }
      const profile = toProfile(rawProfile)
      setState({
        status: 'ready',
        value: {
          persona,
          profile: profile.groups,
          profileSource: profile.source,
          experiences: toExperiences(toEntries(entries)),
          failed: {
            profile: rawProfile === null || rawProfile === undefined,
            experiences: entries === null || entries === undefined,
          },
        },
      })
    }

    void load()
    return () => { cancelled = true }
  }, [agentId, nonce])

  return { state, reload }
}
