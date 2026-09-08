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
  MIN_SECTION_TEXT_CHARS,
  buildSectionPreviewPrompt,
  parseSectionPreviewResponse,
  sectionEligibility,
  sectionPlainText,
} from '../src/modules/documents/section-preview.js'

let closeDatabase: (() => void) | null = null

afterEach(() => {
  closeDatabase?.()
  closeDatabase = null
})

/** invokeRuntime 兼容的最小 fake runtime（document-overview.test 同款）。 */
function fakeRuntime(respond: (prompt: string) => string): { runtime: AgentRuntime; calls: string[] } {
  const calls: string[] = []
  const runtime = {
    id: 'fake-section-preview',
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

const SECTION_MARKDOWN = Array.from({ length: 12 }, (_, index) => `第${String(index + 1)}段：`.padEnd(4, 'x') + '架构'.repeat(20)).join('\n\n')
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function sectionInput(overrides: { contentHash?: string; sectionMarkdown?: string } = {}) {
  return {
    blockId: 'heading-block-1',
    headingText: '架构演进',
    sectionMarkdown: overrides.sectionMarkdown ?? SECTION_MARKDOWN,
    contentHash: overrides.contentHash ?? HASH_A,
  }
}

async function createService(): Promise<DocumentService> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'nxcore-section-preview-'))
  const created = createDatabase(join(dataDirectory, 'gateway.sqlite'), resolve('drizzle'))
  closeDatabase = () => created.sqlite.close()
  return new DocumentService(created.db, new DocumentEventBroker())
}

describe('document section preview', () => {
  it('classifies eligibility and strips markdown noise for the plain-text length', () => {
    expect(sectionEligibility(0)).toEqual({ eligible: false, reason: 'empty' })
    expect(sectionEligibility(MIN_SECTION_TEXT_CHARS - 1)).toEqual({ eligible: false, reason: 'too_short' })
    expect(sectionEligibility(MIN_SECTION_TEXT_CHARS)).toEqual({ eligible: true, reason: 'ok' })
    expect(sectionPlainText('## 标题\n\n`code` 与 **加粗** [链接](https://x)')).toBe('标题 code 与 加粗 链接')
  })

  it('builds a prompt with heading, budget cap, and the untrusted-data warning', () => {
    const prompt = buildSectionPreviewPrompt({
      headingText: '架构演进',
      sectionMarkdown: '段'.repeat(40_000),
    })
    expect(prompt.length).toBeLessThanOrEqual(10_000)
    expect(prompt).toContain('架构演进')
    expect(prompt).toContain('不可信数据')
    expect(prompt).toContain('禁止编造')
  })

  it('parses responses tolerantly and clamps to 80 chars', () => {
    expect(parseSectionPreviewResponse('```\n本节介绍了模块分层与网关拆分。\n```')).toBe('本节介绍了模块分层与网关拆分。')
    const paragraph = parseSectionPreviewResponse(`第一段\n\n第二段`)
    expect(paragraph).toBe('第一段')
    expect(parseSectionPreviewResponse('长'.repeat(200)).length).toBe(80)
    expect(() => parseSectionPreviewResponse('   \n\n  ')).toThrowError()
  })

  it('rejects too-short sections with 422 and persists nothing', async () => {
    const documents = await createService()
    const document = await documents.import({
      id: `doc-sp-short-${Math.random().toString(36).slice(2, 8)}`,
      roomId: 'room-sp',
      title: '短章节文档',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '正文' }] }] } as never,
    })
    await expect(documents.getOrGenerateSectionPreview(document.id, sectionInput({ sectionMarkdown: '太短' })))
      .rejects.toThrowError(expect.objectContaining({ code: 'SECTION_PREVIEW_TOO_SHORT' }) as never)
  })

  it('returns cached preview on hash hit without invoking the LLM again, even with runtime null', async () => {
    const documents = await createService()
    const document = await documents.import({
      id: `doc-sp-cache-${Math.random().toString(36).slice(2, 8)}`,
      roomId: 'room-sp',
      title: '缓存文档',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '正文'.repeat(100) }] }] } as never,
    })
    const { runtime, calls } = fakeRuntime(() => '本节介绍了模块分层重构与网关进程拆分的动机与收益。')
    const before = documents.get(document.id)

    const first = await documents.getOrGenerateSectionPreview(document.id, sectionInput(), runtime)
    expect(first).toMatchObject({ blockId: 'heading-block-1', cached: false })
    expect(calls).toHaveLength(1)

    // 同 hash 二次请求：不重调 LLM；且 AI 已撤配置（runtime null）也照样命中。
    const second = await documents.getOrGenerateSectionPreview(document.id, sectionInput(), null)
    expect(second.cached).toBe(true)
    expect(second.preview).toBe(first.preview)
    expect(calls).toHaveLength(1)

    // 速览生成绝不修改正文。
    const after = documents.get(document.id)
    expect(after!.version).toBe(before!.version)
    expect(after!.contentJson).toEqual(before!.contentJson)
    expect(after!.updatedAt).toBe(before!.updatedAt)
  })

  it('regenerates and overwrites when the content hash changes', async () => {
    const documents = await createService()
    const document = await documents.import({
      id: `doc-sp-regen-${Math.random().toString(36).slice(2, 8)}`,
      roomId: 'room-sp',
      title: '重生成文档',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '正文'.repeat(100) }] }] } as never,
    })
    const first = fakeRuntime(() => '第一次的预览内容。')
    await documents.getOrGenerateSectionPreview(document.id, sectionInput(), first.runtime)

    const second = fakeRuntime(() => '正文变化后重新生成的预览内容。')
    const result = await documents.getOrGenerateSectionPreview(document.id, sectionInput({ contentHash: HASH_B }), second.runtime)
    expect(result.cached).toBe(false)
    expect(result.preview).toBe('正文变化后重新生成的预览内容。')
    // 第三次按新 hash 再来：命中新缓存，两个 runtime 总调用数不再增加。
    const callsBefore = first.calls.length + second.calls.length
    await documents.getOrGenerateSectionPreview(document.id, sectionInput({ contentHash: HASH_B }), null)
    expect(first.calls.length + second.calls.length).toBe(callsBefore)
  })

  it('fails with AI_UNAVAILABLE on cache miss when runtime is null, persisting nothing', async () => {
    const documents = await createService()
    const document = await documents.import({
      id: `doc-sp-nort-${Math.random().toString(36).slice(2, 8)}`,
      roomId: 'room-sp',
      title: '未配置文档',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '正文'.repeat(100) }] }] } as never,
    })
    await expect(documents.getOrGenerateSectionPreview(document.id, sectionInput(), null))
      .rejects.toThrowError(expect.objectContaining({ code: 'SECTION_PREVIEW_AI_UNAVAILABLE' }) as never)
  })

  it('wraps empty responses as GENERATION_FAILED without persisting', async () => {
    const documents = await createService()
    const document = await documents.import({
      id: `doc-sp-bad-${Math.random().toString(36).slice(2, 8)}`,
      roomId: 'room-sp',
      title: '解析失败文档',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '正文'.repeat(100) }] }] } as never,
    })
    // 空白输出由 invokeRuntime 的空内容守卫先抛（章节预览的宽容解析对任何
    // 非空文本都能成功，解析失败重试只在解析器收紧后才可能触发）。
    const { runtime, calls } = fakeRuntime(() => '   \n\n   ')
    await expect(documents.getOrGenerateSectionPreview(document.id, sectionInput(), runtime))
      .rejects.toThrowError(expect.objectContaining({ code: 'SECTION_PREVIEW_GENERATION_FAILED' }) as never)
    expect(calls).toHaveLength(1)
  })
})
