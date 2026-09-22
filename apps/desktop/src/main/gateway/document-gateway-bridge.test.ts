import { afterEach, describe, expect, it, vi } from 'vitest'

import { DocumentGatewayBridge } from './document-gateway-bridge'
import type { GatewaySupervisor } from './gateway-supervisor'

function bridge(): DocumentGatewayBridge {
  return new DocumentGatewayBridge({
    getConnection: () => ({ baseUrl: 'http://127.0.0.1:1', token: 'test-token' }),
  } as GatewaySupervisor)
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('DocumentGatewayBridge 幂等读 5xx 静默重试（issue #259）', () => {
  it('打开房间的文档基线遇网关 500 静默重试一次后自愈，不透传错误', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(500, {
        error: 'internal_error',
        message: 'An internal gateway error occurred',
      }))
      .mockResolvedValueOnce(jsonResponse(200, []))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()

    const pending = bridge().list('room-1')
    await vi.runAllTimersAsync()

    await expect(pending).resolves.toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:1/v1/documents?roomId=room-1')
  })

  it('重试耗尽后照常透传网关错误（保持既有语义）', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(500, {
        error: 'internal_error',
        message: 'An internal gateway error occurred',
      }))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()

    const pending = bridge().listTrash('room-1')
    pending.catch(() => undefined)
    await vi.runAllTimersAsync()

    await expect(pending).rejects.toThrow('internal_error: An internal gateway error occurred')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('4xx 不重试，单次请求即透传', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(404, { error: 'not_found', message: 'Document not found' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(bridge().list('room-1')).rejects.toThrow('not_found: Document not found')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
