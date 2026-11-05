import { describe, expect, it } from 'vitest'

import type { DisplayAgentToolCall } from '../src/renderer/src/components/agent/agentRunActivity'
import {
  agentTurnFilesFromTools,
  toolTurnFiles,
} from '../src/renderer/src/components/agent/agentTurnFiles'

function tool(overrides: Partial<DisplayAgentToolCall> & Pick<DisplayAgentToolCall, 'id' | 'name'>): DisplayAgentToolCall {
  return {
    runId: 'run-1',
    args: {},
    status: 'completed',
    startedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

/** success() 形态：content 是 JSON 字符串、structuredContent 是对象（渲染层收到的 details）。 */
function successResult(payload: Record<string, unknown>): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  }
}

describe('toolTurnFiles', () => {
  it('extracts docx artifact from office_create result (details payload)', () => {
    const call = tool({
      id: 't1',
      name: 'office_create',
      result: {
        content: [{ type: 'text', text: JSON.stringify({ fileEntryId: 'fe-1', originalName: '报告.docx', format: 'docx' }) }],
        structuredContent: { fileEntryId: 'fe-1', originalName: '报告.docx', format: 'docx' },
      },
    })
    expect(toolTurnFiles(call)).toEqual([
      { fileEntryId: 'fe-1', name: '报告.docx', format: 'docx', origin: 'created' },
    ])
  })

  it('accepts legacy context_room_ tool names', () => {
    const call = tool({
      id: 't2',
      name: 'context_room_sheets_create',
      result: successResult({ fileEntryId: 'fe-2', originalName: '预算.xlsx', format: 'xlsx' }),
    })
    expect(toolTurnFiles(call)).toEqual([
      { fileEntryId: 'fe-2', name: '预算.xlsx', format: 'xlsx', origin: 'created' },
    ])
  })

  it('parses plain JSON string result without envelope', () => {
    const call = tool({
      id: 't3',
      name: 'slides_create',
      result: JSON.stringify({ fileEntryId: 'fe-3', originalName: '汇报.pptx', format: 'pptx' }),
    })
    expect(toolTurnFiles(call).map((file) => file.name)).toEqual(['汇报.pptx'])
  })

  it('marks word_export_pdf results as exported and accepts fileId field', () => {
    const call = tool({
      id: 't4',
      name: 'word_export_pdf',
      result: successResult({ fileId: 'fe-4', sourceFileId: 'fe-src', originalName: '报告.pdf' }),
    })
    expect(toolTurnFiles(call)).toEqual([
      { fileEntryId: 'fe-4', name: '报告.pdf', format: 'pdf', origin: 'exported' },
    ])
  })

  it('extracts md artifact from markdown_create result (format field)', () => {
    const call = tool({
      id: 't4b',
      name: 'markdown_create',
      result: successResult({ fileEntryId: 'fe-9', originalName: '会议纪要.md', format: 'md' }),
    })
    expect(toolTurnFiles(call)).toEqual([
      { fileEntryId: 'fe-9', name: '会议纪要.md', format: 'md', origin: 'created' },
    ])
  })

  it('infers md format from .md extension when format field is missing', () => {
    const call = tool({
      id: 't4c',
      name: 'markdown_create',
      result: successResult({ fileEntryId: 'fe-10', originalName: '速记.md' }),
    })
    expect(toolTurnFiles(call)[0]?.format).toBe('md')
  })

  it('excludes slides_draft artifacts (SlidesProgressCard owns that lane)', () => {
    const completed = tool({
      id: 't5',
      name: 'slides_draft',
      result: JSON.stringify({ status: 'completed', fileEntryId: 'fe-5', fileName: '发布会.pptx' }),
    })
    expect(toolTurnFiles(completed)).toEqual([])

    const partial = tool({
      id: 't6',
      name: 'slides_draft',
      result: JSON.stringify({ status: 'partial', fileEntryId: 'fe-6', fileName: '半成品.pptx' }),
    })
    expect(toolTurnFiles(partial)).toEqual([])
  })

  it('ignores non-completed tools and unknown tools', () => {
    expect(toolTurnFiles(tool({ id: 't8', name: 'office_create', status: 'running' }))).toEqual([])
    expect(toolTurnFiles(tool({ id: 't9', name: 'web_search', result: successResult({ fileEntryId: 'x' }) }))).toEqual([])
  })

  it('infers format from extension when format field is missing', () => {
    const call = tool({
      id: 't10',
      name: 'office_create',
      result: successResult({ fileEntryId: 'fe-8', originalName: '笔记.docx' }),
    })
    expect(toolTurnFiles(call)[0]?.format).toBe('docx')
  })
})

describe('agentTurnFilesFromTools', () => {
  it('dedupes by fileEntryId keeping the latest tool occurrence', () => {
    const first = tool({
      id: 'a',
      name: 'office_create',
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:01:00Z',
      result: successResult({ fileEntryId: 'fe-1', originalName: '初稿.docx', format: 'docx' }),
    })
    const second = tool({
      id: 'b',
      name: 'office_create',
      startedAt: '2026-01-01T00:02:00Z',
      completedAt: '2026-01-01T00:03:00Z',
      result: successResult({ fileEntryId: 'fe-1', originalName: '定稿.docx', format: 'docx' }),
    })
    expect(agentTurnFilesFromTools([first, second])).toEqual([
      { fileEntryId: 'fe-1', name: '定稿.docx', format: 'docx', origin: 'created' },
    ])
  })

  it('orders by tool completion time ascending', () => {
    const later = tool({
      id: 'c',
      name: 'office_create',
      completedAt: '2026-01-01T00:05:00Z',
      result: successResult({ fileEntryId: 'fe-2', originalName: '第二份.docx', format: 'docx' }),
    })
    const earlier = tool({
      id: 'd',
      name: 'sheets_create',
      completedAt: '2026-01-01T00:01:00Z',
      result: successResult({ fileEntryId: 'fe-3', originalName: '第一份.xlsx', format: 'xlsx' }),
    })
    const files = agentTurnFilesFromTools([later, earlier])
    expect(files.map((file) => file.name)).toEqual(['第一份.xlsx', '第二份.docx'])
  })

  it('returns empty for empty input', () => {
    expect(agentTurnFilesFromTools([])).toEqual([])
  })
})
