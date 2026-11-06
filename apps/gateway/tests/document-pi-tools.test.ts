import { describe, expect, it, vi } from 'vitest'
import type { StartRuntimeRunInput } from '@nxcore/agent-runtime'
import type { DocumentMcpHost, DocumentMcpToolResult } from '../src/modules/documents/mcp-host.js'
import { createDocumentPiTools } from '../src/modules/documents/pi-tools.js'

function runtimeInput(originalPrompt: string): StartRuntimeRunInput {
  return {
    runId: 'run-notion-routing',
    sessionId: 'session-notion-routing',
    runtimeSessionRef: null,
    originalPrompt,
    prompt: `外部服务路由规则\n\n用户请求：\n${originalPrompt}`,
    pageLabel: '首页',
  }
}

function harness() {
  const callTool = vi.fn(async (): Promise<DocumentMcpToolResult> => ({
    content: [{ type: 'text', text: '{"rooms":[]}' }],
    structuredContent: { rooms: [] },
  }))
  const host = {
    listTools: () => [{
      name: 'office_create',
      title: '创建 Office 文件',
      description: '创建 Word/Excel 文件。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    }],
    callTool,
  } as unknown as DocumentMcpHost
  const tool = createDocumentPiTools(host)[0]
  if (!tool) throw new Error('office_create tool was not created')
  return { callTool, tool }
}

describe('Document Pi tool routing', () => {
  it('rejects document tools for an explicit Notion-only request', async () => {
    const { callTool, tool } = harness()
    const input = runtimeInput('使用 Notion 帮我创建一个标题为“父页面”的私有工作区页面。')

    let failure: unknown
    try {
      await tool.execute(input, {})
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain('Document tool route mismatch')
    expect(callTool).not.toHaveBeenCalled()
    expect(tool.classifyFailure?.(failure, input, {})).toMatchObject({
      category: 'route_mismatch',
      recoverable: true,
      recommendedTool: 'connector_search',
      maxAttempts: 1,
    })
  })

  it('allows document tools when EverOffice is the explicit destination', async () => {
    const { callTool, tool } = harness()
    const input = runtimeInput('把 Notion 页面内容保存到 EverOffice Context Room 文档。')

    await expect(tool.execute(input, {})).resolves.toMatchObject({
      details: { rooms: [] },
    })
    expect(callTool).toHaveBeenCalledOnce()
  })

  it('Phase 2i 去 Room：文档归属取 run 上下文（无 Room 字段），工具参数里遗留 roomId 不生效', async () => {
    const callTool = vi.fn(async (_name: string, _params: Record<string, unknown>, context: Record<string, unknown>): Promise<DocumentMcpToolResult> => ({
      content: [{ type: 'text', text: JSON.stringify({ operationId: 'operation-1' }) }],
      structuredContent: { operationId: 'operation-1' },
    }))
    const host = {
      listTools: () => [
        {
          name: 'document_write_begin', title: 'Begin', description: 'Begin',
          inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
        },
        {
          name: 'document_write_append', title: 'Append', description: 'Append',
          inputSchema: { type: 'object', properties: { operationId: { type: 'string' } } },
        },
      ],
      callTool,
    } as unknown as DocumentMcpHost
    const [begin, append] = createDocumentPiTools(host)

    // Room 归属参数已从 write_begin 的 schema 摘除：参数里即便混入 roomId 也不生效，
    // Phase 2i 后 context 只携带 sessionId/runId/workspaceId（无 Room 维度）。
    await begin!.execute(runtimeInput('创建一份 Java 并发指南文档'), {
      title: 'Java 并发指南', roomId: 'room-ignored',
    })
    await append!.execute(runtimeInput('创建一份 Java 并发指南文档'), {
      operationId: 'operation-1', sequence: 1, text: '正文',
    })

    expect(callTool).toHaveBeenNthCalledWith(1, 'document_write_begin', expect.any(Object), expect.objectContaining({
      agentSessionId: 'session-notion-routing',
      runId: 'run-notion-routing',
    }))
    expect(callTool.mock.calls[0]![2]).not.toHaveProperty('roomId')
    expect(callTool).toHaveBeenNthCalledWith(2, 'document_write_append', expect.any(Object), expect.objectContaining({
      agentSessionId: 'session-notion-routing',
      runId: 'run-notion-routing',
    }))
    expect(callTool.mock.calls[1]![2]).not.toHaveProperty('roomId')
  })

  describe('document_list selectionRequired 意图闸门', () => {
    function documentListHarness() {
      const callTool = vi.fn(async (): Promise<DocumentMcpToolResult> => ({
        content: [{ type: 'text', text: JSON.stringify({
          roomId: 'room-a',
          selectionRequired: true,
          documents: [{ id: 'doc-1', roomId: 'room-a', title: '第一篇', version: 1 }],
        }) }],
        structuredContent: {
          roomId: 'room-a',
          selectionRequired: true,
          documents: [{ id: 'doc-1', roomId: 'room-a', title: '第一篇', version: 1 }],
        },
      }))
      const host = {
        listTools: () => [{
          name: 'document_list',
          title: '列出当前 Room 的文档',
          description: '列出文档。',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }],
        callTool,
      } as unknown as DocumentMcpHost
      const tool = createDocumentPiTools(host)[0]
      if (!tool) throw new Error('document_list tool was not created')
      return { callTool, tool }
    }

    it('无文档修改诉求的运行把 selectionRequired 压为 false（content 与 details 同步）', async () => {
      const { callTool, tool } = documentListHarness()
      const input = runtimeInput('总结一下这个房间里的所有文档')

      const result = await tool.execute(input, {})

      expect(callTool).toHaveBeenCalledOnce()
      expect(result.details).toMatchObject({ selectionRequired: false })
      expect(JSON.parse(result.content)).toMatchObject({ selectionRequired: false })
    })

    it('有修改诉求的运行保持 selectionRequired = true', async () => {
      const { tool } = documentListHarness()
      const input = runtimeInput('帮我修改一下房间里的文档')

      await expect(tool.execute(input, {})).resolves.toMatchObject({
        details: { selectionRequired: true },
      })
    })
  })
})
