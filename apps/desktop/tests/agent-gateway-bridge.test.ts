import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/monitoring/sentry', () => ({ captureSentryLog: vi.fn() }))

import { AgentGatewayBridge } from '../src/main/gateway/agent-gateway-bridge'
import type { GatewaySupervisor } from '../src/main/gateway/gateway-supervisor'

const servers: Array<ReturnType<typeof createServer>> = []

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return (server.address() as AddressInfo).port
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
  const index = servers.indexOf(server)
  if (index >= 0) servers.splice(index, 1)
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
})

describe('AgentGatewayBridge requests', () => {
  it('only sends a JSON content type when the request has a body', async () => {
    const requests: Array<{ method: string; path: string; contentType?: string; body: string }> = []
    const server = createServer(async (request, response) => {
      const requestBody = await body(request)
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        ...(request.headers['content-type'] ? { contentType: request.headers['content-type'] } : {}),
        body: requestBody,
      })
      if (request.headers.authorization !== 'Bearer test-token') return json(response, 401, {})
      if (request.method === 'DELETE') {
        response.writeHead(204)
        return response.end()
      }
      if (request.url?.includes('/events?')) return json(response, 200, [])
      return json(response, 200, {})
    })
    const port = await listen(server)
    const ensureConnection = vi.fn(async () => ({
        pid: 1,
        baseUrl: `http://127.0.0.1:${String(port)}`,
        token: 'test-token',
        version: 'test',
      }))
    const supervisor = { ensureConnection } as unknown as GatewaySupervisor
    const bridge = new AgentGatewayBridge(supervisor)

    await bridge.createSession({ pageLabel: 'AI 重写', roomId: 'room-1' })
    await bridge.getEvents('session-1', 'run-1', 0)
    await bridge.cancelRun('run-1')
    await bridge.deleteSession('session-1')

    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ['POST', '/v1/agent/sessions'],
      ['GET', '/v1/agent/sessions/session-1/events?runId=run-1&afterSeq=0'],
      ['POST', '/v1/agent/runs/run-1/cancel'],
      ['DELETE', '/v1/agent/sessions/session-1'],
    ])
    expect(requests[0]).toMatchObject({
      contentType: 'application/json',
      body: expect.stringContaining('AI 重写'),
    })
    for (const index of [1, 2, 3]) {
      expect(requests[index]).toMatchObject({ body: '' })
      expect(requests[index]).not.toHaveProperty('contentType')
    }
    expect(ensureConnection).toHaveBeenCalledTimes(4)
  })

  it('passes workspaceId through to the sessions query（按空间列会话）', async () => {
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(request.url ?? '')
      json(response, 200, [])
    })
    const port = await listen(server)
    const supervisor = {
      ensureConnection: async () => ({
        pid: 1,
        baseUrl: `http://127.0.0.1:${String(port)}`,
        token: 'test-token',
        version: 'test',
      }),
    } as unknown as GatewaySupervisor
    const bridge = new AgentGatewayBridge(supervisor)

    await bridge.listSessions(undefined, undefined, 'ws-9')
    await bridge.listSessions('Agent', null)

    expect(requests).toEqual([
      '/v1/agent/sessions?workspaceId=ws-9',
      '/v1/agent/sessions?pageLabel=Agent&roomId=',
    ])
  })

  it('refreshes a stale gateway connection and retries the request once', async () => {
    const staleServer = createServer((_request, response) => json(response, 200, {}))
    const stalePort = await listen(staleServer)
    const recoveredRequests: string[] = []
    const recoveredServer = createServer((request, response) => {
      recoveredRequests.push(request.url ?? '')
      json(response, 200, { id: 'recovered-session' })
    })
    const recoveredPort = await listen(recoveredServer)
    const staleConnection = {
      pid: 1,
      baseUrl: `http://127.0.0.1:${String(stalePort)}`,
      token: 'test-token',
      version: 'old',
    }
    const recoveredConnection = {
      pid: 2,
      baseUrl: `http://127.0.0.1:${String(recoveredPort)}`,
      token: 'test-token',
      version: 'new',
    }
    const recoverConnection = vi.fn(async () => recoveredConnection)
    const supervisor = {
      ensureConnection: async () => staleConnection,
      recoverConnection,
    } as unknown as GatewaySupervisor
    const bridge = new AgentGatewayBridge(supervisor)
    await close(staleServer)

    const session = await bridge.createSession({ pageLabel: '续写', roomId: 'room-1' })

    expect(session.id).toBe('recovered-session')
    expect(recoverConnection).toHaveBeenCalledOnce()
    expect(recoverConnection).toHaveBeenCalledWith(staleConnection)
    expect(recoveredRequests).toEqual(['/v1/agent/sessions'])
  })

  it('does not retry repeatedly when the recovered connection also refuses', async () => {
    const unavailableServer = createServer()
    const unavailablePort = await listen(unavailableServer)
    const connection = {
      pid: 1,
      baseUrl: `http://127.0.0.1:${String(unavailablePort)}`,
      token: 'test-token',
      version: 'test',
    }
    const recoverConnection = vi.fn(async () => connection)
    const supervisor = {
      ensureConnection: async () => connection,
      recoverConnection,
    } as unknown as GatewaySupervisor
    const bridge = new AgentGatewayBridge(supervisor)
    await close(unavailableServer)

    await expect(bridge.createSession({ pageLabel: '续写', roomId: 'room-1' })).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    })
    expect(recoverConnection).toHaveBeenCalledOnce()
  })

  it('maps the gateway quota error to a localized actionable message', async () => {
    const server = createServer((_request, response) => {
      json(response, 402, { error: 'ai_quota_exhausted', message: 'AI relay account is out of quota' })
    })
    const port = await listen(server)
    const supervisor = {
      ensureConnection: async () => ({
        pid: 1,
        baseUrl: `http://127.0.0.1:${String(port)}`,
        token: 'test-token',
        version: 'test',
      }),
    } as unknown as GatewaySupervisor
    const bridge = new AgentGatewayBridge(supervisor)

    // 额度不足不应触发连接恢复重试，直接抛出本地化文案
    await expect(bridge.suggestConversationPrompt({
      sessionId: null,
      pageLabel: 'AI 对话',
      roomTitle: null,
      messages: [{ role: 'user', text: '你是谁' }],
    })).rejects.toThrow('AI 额度不足')
  })

  it('injects the currently viewed Office tab into every run context', async () => {
    const bodies: string[] = []
    const server = createServer(async (request, response) => {
      bodies.push(await body(request))
      json(response, 202, { id: 'run-1', sessionId: 'session-1' })
    })
    const port = await listen(server)
    const supervisor = {
      ensureConnection: async () => ({
        pid: 1,
        baseUrl: `http://127.0.0.1:${String(port)}`,
        token: 'test-token',
        version: 'test',
      }),
    } as unknown as GatewaySupervisor
    const activeFile = vi.fn(() => ({
      fileId: 'file-contract',
      title: '软件开发合同.docx',
      kind: 'docx' as const,
      editable: true,
    }))
    const bridge = new AgentGatewayBridge(supervisor, undefined, { activeFile })

    await bridge.startRun('session-1', {
      prompt: '这份文档里面是什么东西',
      idempotencyKey: 'idem-1',
      context: { pageLabel: 'Office' },
    })

    expect(activeFile).toHaveBeenCalledOnce()
    expect(JSON.parse(bodies[0]!)).toMatchObject({
      prompt: '这份文档里面是什么东西',
      context: {
        pageLabel: 'Office',
        activeFile: {
          fileId: 'file-contract',
          title: '软件开发合同.docx',
          kind: 'docx',
          editable: true,
        },
      },
    })
  })

  it('leaves the run context untouched when no Office tab is focused', async () => {
    let sentBody = ''
    const server = createServer(async (request, response) => {
      sentBody = await body(request)
      json(response, 202, { id: 'run-2', sessionId: 'session-1' })
    })
    const port = await listen(server)
    const supervisor = {
      ensureConnection: async () => ({
        pid: 1,
        baseUrl: `http://127.0.0.1:${String(port)}`,
        token: 'test-token',
        version: 'test',
      }),
    } as unknown as GatewaySupervisor
    const bridge = new AgentGatewayBridge(supervisor, undefined, { activeFile: () => null })

    await bridge.startRun('session-1', {
      prompt: '你好',
      idempotencyKey: 'idem-2',
      context: { pageLabel: '首页' },
    })

    expect(JSON.parse(sentBody)).toEqual({
      prompt: '你好',
      idempotencyKey: 'idem-2',
      context: { pageLabel: '首页' },
    })
  })

  it('injects every open Office tab and derives activeFile from the list', async () => {
    let sentBody = ''
    const server = createServer(async (request, response) => {
      sentBody = await body(request)
      json(response, 202, { id: 'run-3', sessionId: 'session-1' })
    })
    const port = await listen(server)
    const supervisor = {
      ensureConnection: async () => ({
        pid: 1,
        baseUrl: `http://127.0.0.1:${String(port)}`,
        token: 'test-token',
        version: 'test',
      }),
    } as unknown as GatewaySupervisor
    const openFiles = vi.fn(() => [
      { fileId: 'file-contract', title: '软件开发合同.docx', kind: 'docx' as const, editable: true, active: true },
      { fileId: 'file-budget', title: '预算.xlsx', kind: 'spreadsheet' as const, active: false },
    ])
    const bridge = new AgentGatewayBridge(supervisor, undefined, { openFiles })

    await bridge.startRun('session-1', {
      prompt: '工作区都开着哪些文件',
      idempotencyKey: 'idem-3',
      context: { pageLabel: 'Office' },
    })

    expect(openFiles).toHaveBeenCalledOnce()
    const payload = JSON.parse(sentBody)
    expect(payload.context.openFiles).toEqual([
      { fileId: 'file-contract', title: '软件开发合同.docx', kind: 'docx', editable: true, active: true },
      { fileId: 'file-budget', title: '预算.xlsx', kind: 'spreadsheet', active: false },
    ])
    // activeFile 的 schema 不允许 active 字段：从清单推出来时必须剥掉。
    expect(payload.context.activeFile).toEqual({
      fileId: 'file-contract',
      title: '软件开发合同.docx',
      kind: 'docx',
      editable: true,
    })
  })

  it('keeps the context untouched when the workspace has no open Office tab', async () => {
    let sentBody = ''
    const server = createServer(async (request, response) => {
      sentBody = await body(request)
      json(response, 202, { id: 'run-4', sessionId: 'session-1' })
    })
    const port = await listen(server)
    const supervisor = {
      ensureConnection: async () => ({
        pid: 1,
        baseUrl: `http://127.0.0.1:${String(port)}`,
        token: 'test-token',
        version: 'test',
      }),
    } as unknown as GatewaySupervisor
    const bridge = new AgentGatewayBridge(supervisor, undefined, { openFiles: () => [] })

    await bridge.startRun('session-1', {
      prompt: '你好',
      idempotencyKey: 'idem-4',
      context: { pageLabel: '首页' },
    })

    expect(JSON.parse(sentBody)).toEqual({
      prompt: '你好',
      idempotencyKey: 'idem-4',
      context: { pageLabel: '首页' },
    })
  })
})

describe('AgentGatewayBridge plan stream（SSE → plan:changed）', () => {
  /** 回归（2026-11-05）：ready 帧（无 item）曾被原样转发成 plan:changed，
   *  渲染层 upsert undefined 进看板数组，点「计划」即崩（reading 'status'）。 */
  it('forwards only plan frames and drops ready/ping frames without an item', async () => {
    const change: unknown = { workspaceId: 'ws-1', event: 'updated', item: { id: 'item-1', status: 'todo' } }
    const server = createServer((request, response) => {
      if (!request.url?.startsWith('/v1/plan/stream')) return json(response, 404, {})
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      // 与 gateway routes.ts 的真实帧序一致：ready → plan → ping →（拆两块发的 plan）。
      response.write(`event: ready\ndata: {"workspaceId":"ws-1"}\n\n`)
      response.write(`event: plan\ndata: ${JSON.stringify(change)}\n\n`)
      response.write(`: ping\n\n`)
      // 半包：data 行被 TCP 分段切断也要能拼回完整 JSON。
      const split = `event: plan\ndata: ${JSON.stringify({ ...change, item: { id: 'item-2', status: 'doing' } })}\n\n`
      response.write(split.slice(0, Math.floor(split.length / 2)))
      response.write(split.slice(Math.floor(split.length / 2)))
      setTimeout(() => response.end(), 50)
    })
    const port = await listen(server)
    const supervisor = {
      ensureConnection: async () => ({
        pid: 1,
        baseUrl: `http://127.0.0.1:${String(port)}`,
        token: 'test-token',
        version: 'test',
      }),
    } as unknown as GatewaySupervisor
    const bridge = new AgentGatewayBridge(supervisor)
    const forwarded: unknown[] = []
    const contents = {
      id: 101,
      isDestroyed: () => false,
      once: () => undefined,
      send: (_channel: string, payload: unknown) => forwarded.push(payload),
    }
    bridge.subscribePlanEvents(contents as unknown as import('electron').WebContents, 'ws-1')
    try {
      await new Promise((resolve) => setTimeout(resolve, 300))
    } finally {
      bridge.unsubscribePlanEvents(contents as unknown as import('electron').WebContents)
    }

    expect(forwarded).toEqual([
      change,
      { workspaceId: 'ws-1', event: 'updated', item: { id: 'item-2', status: 'doing' } },
    ])
  })
})
