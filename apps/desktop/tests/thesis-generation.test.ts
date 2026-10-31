import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 论文排版两条「一改就全灭」的接线回归：
 *
 * 1) 模板骨架装订必须以**对象**调引擎（`{templateBytes, sourceBytes, card, spec}`）。
 *    曾经写成 4 个位置参数 + 运行期类型断言拦不住，引擎拿到的袋子是空的、
 *    第一行就抛错 → 每次排版静默回落 v2 重建，「表格跑位」查不出原因。
 * 2) 开头未匹配区间（题目/说明，start===0）不算「未归类内容」：
 *    两个渲染器都把它落在首个章节之前且不打标记，自检若按「有未匹配块」判硬伤，
 *    正常出稿会被整份拦下（真实模版实测必中）。
 */

const { calls, tempDir, runtimeShape } = vi.hoisted(() => {
  const calls = {
    skeletonArgs: [] as unknown[],
    v2Args: [] as unknown[],
    selfCheckInputs: [] as Array<{ expectUnmatchedSection?: boolean }>,
  }
  const tempDir = { current: '' }
  /** true = 运行时带 buildThesisDocxOnTemplate（新引擎）；false = 旧运行时（回落 v2）。 */
  const runtimeShape = { hasSkeletonExport: true }
  return { calls, tempDir, runtimeShape }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (name: string) => name === 'temp' ? tempDir.current : tempDir.current,
  },
}))

vi.mock('../src/main/office/office-runtime', () => ({
  loadPreparedGenOfficeRuntime: () => {
    const docs: Record<string, unknown> = {
      registerDocsIpc: () => undefined,
      setDocsFileSavedHook: () => undefined,
      // 装订引擎只认对象：用「读到的字段」证明调用方式正确
      buildThesisDocxOnTemplate: async (input: unknown) => {
        calls.skeletonArgs.push(input)
        return {
          bytes: new TextEncoder().encode('skeleton-docx-bytes'),
          diagnostics: { slots: 9, blocks: 100, anchors: 9, bodyStart: 20, chapters: 6, appendedOnly: false },
        }
      },
      buildThesisDocx: async (...args: unknown[]) => {
        calls.v2Args.push(args)
        return new TextEncoder().encode('v2-docx-bytes')
      },
    }
    if (!runtimeShape.hasSkeletonExport) delete docs.buildThesisDocxOnTemplate
    return {
      docs,
      sheets: { setSheetsFileSavedHook: () => undefined },
      slides: { setSlidesFileSavedHook: () => undefined },
    } as never
  },
}))

vi.mock('../src/main/office/thesis-selfcheck', () => ({
  selfCheckThesisDocx: async (bytes: Uint8Array, input: { expectUnmatchedSection?: boolean }) => {
    calls.selfCheckInputs.push({ expectUnmatchedSection: input.expectUnmatchedSection })
    return { ok: true, failures: [], warnings: [] }
  },
}))

import { generateThesisDocx, unmatchedRangesBeyondFront } from '../src/main/office/office-generation'

const card = {
  page: {}, base: {}, header: {}, footer: {}, headings: [],
  abstract: {}, toc: { enabled: false }, references: {}, cover: {}, fixedTexts: {},
} as never

const spec = {
  title: '论文', coverFields: {}, abstractZh: '', keywordsZh: [], abstractEn: '', keywordsEn: [],
  chapters: [{ level: 1, headingText: '一、项目任务', blockStart: 0, blockEnd: 2 }],
  references: [], appendixBlocks: null, acknowledgementParagraphs: [], achievements: [],
} as never

const sourceBytes = Buffer.from('source-docx-bytes')

beforeEach(async () => {
  calls.skeletonArgs.length = 0
  calls.v2Args.length = 0
  calls.selfCheckInputs.length = 0
  tempDir.current = await mkdtemp(join(tmpdir(), 'everroom-thesis-gen-'))
})

describe('generateThesisDocx：模板骨架装订的调用契约', () => {
  it('有模版字节 → 以对象式签名调引擎（四个字段齐全），不走 v2', async () => {
    const templateBytes = Buffer.from('template-docx-bytes')
    const result = await generateThesisDocx({ sourceBytes, templateBytes, formatCard: card, bindingSpec: spec })
    expect(result.bytes.toString()).toBe('skeleton-docx-bytes')

    expect(calls.skeletonArgs).toHaveLength(1)
    const input = calls.skeletonArgs[0] as Record<string, unknown>
    expect(Object.keys(input).sort()).toEqual(['card', 'sourceBytes', 'spec', 'templateBytes'])
    expect(Buffer.from(input.templateBytes as Uint8Array).toString()).toBe('template-docx-bytes')
    expect(Buffer.from(input.sourceBytes as Uint8Array).toString()).toBe('source-docx-bytes')
    expect(input.card).toBe(card)
    expect(input.spec).toBe(spec)
    // 引擎没被调用过 v2：一旦回落说明签名又错了
    expect(calls.v2Args).toHaveLength(0)
  })

  it('引擎没有新导出（旧运行时）→ 回落 v2 且不崩', async () => {
    runtimeShape.hasSkeletonExport = false
    // runtime 是模块级缓存：必须重置模块注册表，才会重新走一次能力探测
    vi.resetModules()
    try {
      const fresh = await import('../src/main/office/office-generation')
      const result = await fresh.generateThesisDocx({
        sourceBytes,
        templateBytes: Buffer.from('template-docx-bytes'),
        formatCard: card,
        bindingSpec: spec,
      })
      expect(result.bytes.toString()).toBe('v2-docx-bytes')
      expect(calls.skeletonArgs).toHaveLength(0)
      expect(calls.v2Args).toHaveLength(1)
    } finally {
      runtimeShape.hasSkeletonExport = true
      vi.resetModules()
    }
  })
})

describe('自检口径：开头未匹配区间不算未归类小节', () => {
  it('unmatchedRangesBeyondFront 只数非开头区间', () => {
    expect(unmatchedRangesBeyondFront({ unmatchedBlocks: [{ start: 0, end: 3 }, { start: 5, end: 8 }] })).toEqual([
      { start: 5, end: 8 },
    ])
    expect(unmatchedRangesBeyondFront({ unmatchedBlocks: [{ start: 0, end: 3 }] })).toEqual([])
    expect(unmatchedRangesBeyondFront({})).toEqual([])
    expect(unmatchedRangesBeyondFront(null)).toEqual([])
  })

  it('论文只有开头未匹配块时，自检不预期「未归类内容」小节（不再拦正常出稿）', async () => {
    const frontOnlySpec = {
      ...spec,
      unmatchedBlocks: [{ start: 0, end: 3, label: '位于首个章节之前的内容（封面/说明类）' }],
    } as never
    await generateThesisDocx({
      sourceBytes,
      templateBytes: Buffer.from('template-docx-bytes'),
      formatCard: card,
      bindingSpec: frontOnlySpec,
    })
    expect(calls.selfCheckInputs[0]?.expectUnmatchedSection).toBe(false)
  })

  it('正文里有真正没处放的区间时，仍要求「未归类内容」小节存在', async () => {
    const tailSpec = { ...spec, unmatchedBlocks: [{ start: 5, end: 8 }] } as never
    await generateThesisDocx({
      sourceBytes,
      templateBytes: Buffer.from('template-docx-bytes'),
      formatCard: card,
      bindingSpec: tailSpec,
    })
    expect(calls.selfCheckInputs[0]?.expectUnmatchedSection).toBe(true)
  })
})
