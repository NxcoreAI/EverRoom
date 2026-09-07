import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentRuntime } from '@nxcore/agent-runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase } from '../src/infrastructure/database/client.js'
import { DocumentEventBroker } from '../src/modules/documents/event-broker.js'
import { DocumentService } from '../src/modules/documents/service.js'
import { DocumentServiceError } from '../src/modules/documents/errors.js'
import {
  buildOverviewPrompt,
  canonicalOverviewText,
  MAX_PROMPT_CHARS,
  MIN_OVERVIEW_TEXT_CHARS,
  overviewEligibility,
  parseOverviewResponse,
} from '../src/modules/documents/overview.js'

let closeDatabase: (() => void) | null = null

afterEach(() => {
  closeDatabase?.()
  closeDatabase = null
})

/** invokeRuntime 兼容的最小 fake runtime（document-index-backfill-llm 同款）。 */
function fakeRuntime(respond: (prompt: string) => string): { runtime: AgentRuntime; calls: string[] } {
  const calls: string[] = []
  const runtime = {
    id: 'fake-document-overview',
    getCapabilities: async () => ({ streaming: false, reasoning: false, tools: false, steering: false, resume: false }),
    start: async (input: { prompt: string }) => {
      calls.push(input.prompt)
      return {
        runtimeSessionRef: null,
        events: (async function* generate() {
          yield { type: 'message.completed', payload: { content: respond(input.prompt) } }
          yield { type: 'run.completed', payload: {} }
        })(),
      }
    },
    cancel: async () => undefined,
    deleteSession: async () => undefined,
  } as unknown as AgentRuntime
  return { runtime, calls }
}

const VALID_OVERVIEW_RESPONSE = [
  '主题：项目架构演进方案',
  '要点：',
  '- 模块分层重构',
  '- 网关进程拆分',
  '- 数据库迁移统一',
  '结论：架构已趋于稳定，可进入功能迭代',
].join('\n')

function longTextParagraph(length: number) {
  return { type: 'paragraph', content: [{ type: 'text', text: '字'.repeat(length) }] }
}

async function createService(): Promise<{ documents: DocumentService; close: () => void }> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'nxcore-overview-'))
  const created = createDatabase(join(dataDirectory, 'gateway.sqlite'), resolve('drizzle'))
  closeDatabase = () => created.sqlite.close()
  return { documents: new DocumentService(created.db, new DocumentEventBroker()), close: () => created.sqlite.close() }
}

describe('document overview', () => {
  it('rejects empty and too-short documents with explicit states, leaving columns null', async () => {
    const { documents } = await createService()
    const empty = await documents.import({
      id: `doc-ov-empty-${Math.random().toString(36).slice(2, 8)}`,
      roomId: 'room-ov',
      title: '空文档',
      contentJson: { type: 'doc', content: [] } as never,
    })
    expect(documents.getDocumentOverview(empty.id)).toMatchObject({ eligible: false, reason: 'empty', topic: null })
    await expect(documents.generateDocumentOverview(empty.id)).rejects
      .toThrowError(expect.objectContaining({ code: 'DOCUMENT_OVERVIEW_TOO_SHORT', details: { reason: 'empty' } }) as never)

    const short = await documents.import({
      id: `doc-ov-short-${Math.random().toString(36).slice(2, 8)}`,
      roomId: 'room-ov',
      title: '短文档',
      contentJson: { type: 'doc', content: [longTextParagraph(MIN_OVERVIEW_TEXT_CHARS - 1)] } as never,
    })
    expect(documents.getDocumentOverview(short.id)).toMatchObject({ eligible: false, reason: 'too_short', topic: null })
    await expect(documents.generateDocumentOverview(short.id)).rejects
      .toThrowError(expect.objectContaining({ code: 'DOCUMENT_OVERVIEW_TOO_SHORT', details: { reason: 'too_short' } }) as never)
  })

  it('fails with AI_UNAVAILABLE and persists nothing when runtime is null', async () => {
    const { documents } = await createService()
    const document = await documents.import({
      id: `doc-ov-nort-${Math.random().toString(36).slice(2, 8)}`,
      roomId: 'room-ov',
      title: '正常长度文档',
      contentJson: { type: 'doc', content: [longTextParagraph(MIN_OVERVIEW_TEXT_CHARS + 50)] } as never,
    })
    await expect(documents.generateDocumentOverview(document.id, null)).rejects
      .toThrowError(expect.objectContaining({ code: 'DOCUMENT_OVERVIEW_AI_UNAVAILABLE' }) as never)
    expect(documents.getDocumentOverview(document.id).topic).toBeNull()
  })

  it('generates, persists canonical overview, and never touches content or version', async () => {
    const { documents } = await createService()
    const document = await documents.import({
      id: `doc-ov-ok-${Math.random().toString(36).slice(2, 8)}`,
      roomId: 'room-ov',
      title: '架构演进记录',
      contentJson: { type: 'doc', content: [longTextParagraph(MIN_OVERVIEW_TEXT_CHARS + 100)] } as never,
    })
    const { runtime } = fakeRuntime(() => VALID_OVERVIEW_RESPONSE)
    const before = documents.get(document.id)

    const view = await documents.generateDocumentOverview(document.id, runtime)

    expect(view).toMatchObject({
      documentId: document.id,
      topic: '项目架构演进方案',
      points: ['模块分层重构', '网关进程拆分', '数据库迁移统一'],
      conclusion: '架构已趋于稳定，可进入功能迭代',
      generatedAtVersion: before!.version,
      eligible: true,
      reason: 'ok',
    })
    // 落库的是 canonical 三段式文本
    expect(documents.getDocumentOverview(document.id).topic).toBe('项目架构演进方案')

    // 速览绝不修改正文：version / contentJson / updatedAt 全部不变
    const after = documents.get(document.id)
    expect(after!.version).toBe(before!.version)
    expect(after!.contentJson).toEqual(before!.contentJson)
    expect(after!.updatedAt).toBe(before!.updatedAt)
  })

  it('regenerating after a save replaces the old overview and records the new version', async () => {
    const { documents } = await createService()
    const document = await documents.import({
      id: `doc-ov-regen-${Math.random().toString(36).slice(2, 8)}`,
      roomId: 'room-ov',
      title: '会更新的文档',
      contentJson: { type: 'doc', content: [longTextParagraph(MIN_OVERVIEW_TEXT_CHARS + 10)] } as never,
    })
    const { runtime } = fakeRuntime(() => VALID_OVERVIEW_RESPONSE)
    const first = await documents.generateDocumentOverview(document.id, runtime)
    expect(first.generatedAtVersion).toBe(document.version)

    const saved = await documents.save(document.id, {
      baseVersion: document.version,
      title: document.title,
      contentJson: { type: 'doc', content: [longTextParagraph(MIN_OVERVIEW_TEXT_CHARS + 20)] } as never,
    })

    const { runtime: runtime2 } = fakeRuntime(() => [
      '主题：更新后的主题',
      '要点：',
      '- 新要点',
      '结论：新结论',
    ].join('\n'))
    const second = await documents.generateDocumentOverview(document.id, runtime2)

    expect(second.topic).toBe('更新后的主题')
    expect(second.generatedAtVersion).toBe(saved.version)
    expect(second.generatedAtVersion).toBeGreaterThan(first.generatedAtVersion!)
    expect(documents.getDocumentOverview(document.id).topic).toBe('更新后的主题')
  })

  it('wraps unparsable responses as GENERATION_FAILED after a feedback retry, persisting nothing', async () => {
    const { documents } = await createService()
    const document = await documents.import({
      id: `doc-ov-bad-${Math.random().toString(36).slice(2, 8)}`,
      roomId: 'room-ov',
      title: '解析失败文档',
      contentJson: { type: 'doc', content: [longTextParagraph(MIN_OVERVIEW_TEXT_CHARS + 10)] } as never,
    })
    const { runtime, calls } = fakeRuntime(() => '这不是速览，只是一句闲聊。')
    await expect(documents.generateDocumentOverview(document.id, runtime)).rejects
      .toThrowError(expect.objectContaining({ code: 'DOCUMENT_OVERVIEW_GENERATION_FAILED' }) as never)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('上一次输出无法解析')
    expect(documents.getDocumentOverview(document.id).topic).toBeNull()
  })
})

describe('overview pure functions', () => {
  it('overviewEligibility classifies empty / too_short / ok', () => {
    expect(overviewEligibility(0)).toEqual({ eligible: false, reason: 'empty' })
    expect(overviewEligibility(1)).toEqual({ eligible: false, reason: 'too_short' })
    expect(overviewEligibility(MIN_OVERVIEW_TEXT_CHARS)).toEqual({ eligible: true, reason: 'ok' })
  })

  it('buildOverviewPrompt caps the prompt and carries the untrusted-data warning', () => {
    const prompt = buildOverviewPrompt({
      title: '超长文档',
      contentMarkdown: '段'.repeat(60_000),
    })
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS)
    expect(prompt).toContain('不可信数据')
    expect(prompt).toContain('禁止编造')
  })

  it('parseOverviewResponse tolerates fences and clamps lengths, and rejects missing fields', () => {
    const parsed = parseOverviewResponse([
      '```',
      '主题：主题句',
      '要点：',
      '- 第一点',
      '- 第二点',
      '结论：结论句',
      '```',
    ].join('\n'))
    expect(parsed).toEqual({ topic: '主题句', points: ['第一点', '第二点'], conclusion: '结论句' })

    const clamped = parseOverviewResponse([
      `主题：${'长'.repeat(120)}`,
      '要点：',
      ...Array.from({ length: 8 }, (_, index) => `- 要点${String(index)}`),
      `结论：${'长'.repeat(150)}`,
    ].join('\n'))
    expect(clamped.topic.length).toBe(60)
    expect(clamped.points).toHaveLength(5)
    expect(clamped.conclusion.length).toBe(80)

    expect(() => parseOverviewResponse('主题：只有主题')).toThrowError(/结论/)
    expect(() => parseOverviewResponse('主题：只有主题\n结论：但缺要点')).toThrowError(/要点/)
  })

  it('canonical overview text round-trips through the parser', () => {
    const parsed = parseOverviewResponse(VALID_OVERVIEW_RESPONSE)
    expect(parseOverviewResponse(canonicalOverviewText(parsed))).toEqual(parsed)
  })
})
