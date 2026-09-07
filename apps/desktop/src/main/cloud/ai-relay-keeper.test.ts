import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AiRelayKeeper } from './ai-relay-keeper'
import { SaasRequestError } from './saas-client'

const http = vi.hoisted(() => ({
  request: vi.fn(async (..._config: unknown[]) => ({ status: 200, data: { ok: true } })),
}))

vi.mock('../network/http-client', () => ({
  createLoggedHttpClient: () => http,
}))

const GATEWAY = { baseUrl: 'http://gateway.test', token: 'gw-token-51' }

function createKeeper(options?: {
  issue?: () => Promise<unknown>
  selectedSource?: string
  isRunning?: boolean
  onEvent?: (event: { type: string }) => void
}) {
  const client = {
    issueAiGatewayToken: options?.issue ?? vi.fn(async () => ({
      token: 'sk-relay-51',
      expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(),
      baseUrl: 'https://relay.example.com',
    })),
  }
  const supervisor = {
    ensureConnection: async () => GATEWAY,
    isRunning: () => options?.isRunning ?? true,
    getConnection: () => GATEWAY,
  }
  // 源选择是网关侧状态：selectSource 后 get() 返回新值。
  let selectedSource = options?.selectedSource ?? 'saas'
  const runtimeConfig = {
    get: async () => ({ selectedSource }),
    selectSource: vi.fn(async (source: string) => { selectedSource = source }),
  }
  const onEvent = options?.onEvent ?? vi.fn()
  const keeper = new AiRelayKeeper(
    client as never,
    supervisor as never,
    runtimeConfig as never,
    onEvent,
  )
  return { keeper, client, runtimeConfig, onEvent }
}

function sessionRequests(method: string): Array<Record<string, unknown>> {
  return http.request.mock.calls
    .map(([config]) => config as unknown as Record<string, unknown>)
    .filter((config) => config.url === `${GATEWAY.baseUrl}/v1/ai-relay/session` && config.method === method)
}

describe('AiRelayKeeper', () => {
  beforeEach(() => {
    http.request.mockClear()
    http.request.mockImplementation(async () => ({ status: 200, data: { ok: true } }))
  })

  it('issues a token and pushes it to the gateway session endpoint', async () => {
    const { keeper, client } = createKeeper()
    try {
      await keeper.renewNow()
      expect(client.issueAiGatewayToken).toHaveBeenCalledTimes(1)
      const puts = sessionRequests('PUT')
      expect(puts).toHaveLength(1)
      expect(puts[0]).toMatchObject({
        method: 'PUT',
        data: {
          baseUrl: 'https://relay.example.com',
          token: 'sk-relay-51',
          proxyOrigin: GATEWAY.baseUrl,
        },
        headers: { Authorization: `Bearer ${GATEWAY.token}` },
      })
      const data = puts[0]!.data as { expiresAt: string }
      expect(Number.isFinite(Date.parse(data.expiresAt))).toBe(true)
    } finally {
      keeper.stop()
    }
  })

  it('clears the gateway session and notifies on quota exhaustion (403)', async () => {
    const { keeper, onEvent } = createKeeper({
      issue: async () => { throw new SaasRequestError('LLM credit quota is exhausted', 403) },
    })
    try {
      await keeper.renewNow()
      expect(sessionRequests('DELETE')).toHaveLength(1)
      expect(onEvent).toHaveBeenCalledWith({ type: 'quota-exhausted' })
      // 403 是权威判定：不计网络失败，绝不回落 user 源。
      expect(onEvent).not.toHaveBeenCalledWith({ type: 'fallback-user' })
    } finally {
      keeper.stop()
    }
  })

  it('falls back to the user source exactly once after 3 consecutive network failures', async () => {
    let calls = 0
    const { keeper, runtimeConfig, onEvent } = createKeeper({
      issue: async () => {
        calls += 1
        throw new Error('network unreachable')
      },
    })
    try {
      await keeper.renewNow()
      await keeper.renewNow()
      expect(runtimeConfig.selectSource).not.toHaveBeenCalled()
      expect(onEvent).not.toHaveBeenCalledWith({ type: 'fallback-user' })

      await keeper.renewNow()
      expect(calls).toBe(3)
      expect(runtimeConfig.selectSource).toHaveBeenCalledTimes(1)
      expect(runtimeConfig.selectSource).toHaveBeenCalledWith('user')
      expect(onEvent).toHaveBeenCalledWith({ type: 'fallback-user' })
    } finally {
      keeper.stop()
    }
  })

  it('restores the saas source after a successful renewal while the fallback is active', async () => {
    const onEvent = vi.fn()
    let fail = true
    const { keeper, runtimeConfig } = createKeeper({
      issue: async () => {
        if (fail) throw new Error('network unreachable')
        return {
          token: 'sk-relay-53',
          expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(),
          baseUrl: 'https://relay.example.com',
        }
      },
      onEvent,
    })
    try {
      await keeper.renewNow()
      await keeper.renewNow()
      await keeper.renewNow()
      expect(runtimeConfig.selectSource).toHaveBeenCalledWith('user')
      expect(onEvent).toHaveBeenCalledWith({ type: 'fallback-user' })

      fail = false
      await keeper.renewNow()
      expect(runtimeConfig.selectSource).toHaveBeenLastCalledWith('saas')
      expect(onEvent).toHaveBeenCalledWith({ type: 'fallback-restored' })
    } finally {
      keeper.stop()
    }
  })

  it('skips the fallback when the active source is not saas', async () => {
    const { keeper, runtimeConfig } = createKeeper({ selectedSource: 'user' })
    try {
      await keeper.renewNow()
      await keeper.renewNow()
      await keeper.renewNow()
      expect(runtimeConfig.selectSource).not.toHaveBeenCalled()
    } finally {
      keeper.stop()
    }
  })

  it('stops and deletes the gateway session on stop()', async () => {
    const { keeper } = createKeeper()
    try {
      await keeper.renewNow()
      keeper.stop()
      await vi.waitFor(() => expect(sessionRequests('DELETE')).toHaveLength(1))
    } finally {
      keeper.stop()
    }
  })

  it('skips the gateway delete when the gateway is not running', () => {
    const { keeper } = createKeeper({ isRunning: false })
    keeper.stop()
    // 无 gateway 进程时无需清理（进程已死，会话随内存消失）。
    expect(sessionRequests('DELETE')).toHaveLength(0)
  })
})
