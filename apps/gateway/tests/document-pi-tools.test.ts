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
    roomId: null,
    availableRooms: [{ id: 'room-a', title: '产品规划' }],
  }
}

function harness() {
  const callTool = vi.fn(async (): Promise<DocumentMcpToolResult> => ({
    content: [{ type: 'text', text: '{"rooms":[]}' }],
    structuredContent: { rooms: [] },
  }))
  const host = {
    listTools: () => [{
      name: 'context_room_list',
      title: '列出 Context Rooms',
      description: '列出可选的 Context Room。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    }],
    callTool,
  } as unknown as DocumentMcpHost
  const tool = createDocumentPiTools(host)[0]
  if (!tool) throw new Error('context_room_list tool was not created')
  return { callTool, tool }
}

describe('Document Pi tool routing', () => {
  it('rejects Context Room tools for an explicit Notion-only request', async () => {
    const { callTool, tool } = harness()
    const input = runtimeInput('使用 Notion 帮我创建一个标题为“父页面”的私有工作区页面。')

    let failure: unknown
    try {
      await tool.execute(input, {})
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain('Context Room tool route mismatch')
    expect(callTool).not.toHaveBeenCalled()
    expect(tool.classifyFailure?.(failure, input, {})).toMatchObject({
      category: 'route_mismatch',
      recoverable: true,
      recommendedTool: 'connector_search',
      maxAttempts: 1,
    })
  })

  it('allows Context Room tools when EverRoom is the explicit destination', async () => {
    const { callTool, tool } = harness()
    const input = runtimeInput('把 Notion 页面内容保存到 EverRoom Context Room 文档。')

    await expect(tool.execute(input, {})).resolves.toMatchObject({
      details: { rooms: [] },
    })
    expect(callTool).toHaveBeenCalledOnce()
  })
})
