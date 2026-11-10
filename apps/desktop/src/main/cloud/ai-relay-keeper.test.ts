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

const PLAN_MODELS_A = {
  primary: 'saas-main-x',
  background: 'saas-bg-y',
  lite: 'saas-lite-z',
  cursorCompletion: 'saas-complete-w',
  vlm: 'saas-vlm-v',
  webSearch: 'saas-search-u',
  embedding: 'saas-embed-t',
  embeddingDimensions: 1024,
}

function createKeeper(options?: {
  issue?: () => Promise<unknown>
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
  const onEvent = options?.onEvent ?? vi.fn()
  const keeper = new AiRelayKeeper(
    client as never,
    supervisor as never,
    onEvent,
  )
  return { keeper, client, onEvent }
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

  it('pushes SaaS-issued plan models with the session', async () => {
    const { keeper } = createKeeper({
      issue: async () => ({
        token: 'sk-relay-51',
        expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(),
        baseUrl: 'https://relay.example.com',
        models: PLAN_MODELS_A,
      }),
    })
    try {
      await keeper.renewNow()
      const puts = sessionRequests('PUT')
      expect(puts).toHaveLength(1)
      expect((puts[0]!.data as { models?: unknown }).models).toEqual(PLAN_MODELS_A)
    } finally {
      keeper.stop()
    }
  })

  it('emits models-changed only on renewal when the plan models differ', async () => {
    const onEvent = vi.fn()
    let models: unknown = PLAN_MODELS_A
    const { keeper } = createKeeper({
      issue: async () => ({
        token: 'sk-relay-51',
        expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(),
        baseUrl: 'https://relay.example.com',
        models,
      }),
      onEvent,
    })
    try {
      // 首推：会话激活（session-activated），不比对 models。
      await keeper.renewNow()
      expect(onEvent).toHaveBeenCalledWith({ type: 'session-activated' })
      expect(onEvent).not.toHaveBeenCalledWith({ type: 'models-changed' })

      // 续签且模型不变：不触发。
      await keeper.renewNow()
      expect(onEvent).not.toHaveBeenCalledWith({ type: 'models-changed' })

      // 续签且 SaaS 侧改了套餐模型：触发一次。
      models = { ...PLAN_MODELS_A, primary: 'saas-main-2' }
      await keeper.renewNow()
      expect(onEvent).toHaveBeenCalledTimes(2)
      expect(onEvent).toHaveBeenLastCalledWith({ type: 'models-changed' })
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
    } finally {
      keeper.stop()
    }
  })

  it('treats 402 quota exhaustion as authoritative and tracks the verdict flag', async () => {
    let exhausted = true
    const { keeper, onEvent } = createKeeper({
      issue: async () => {
        if (exhausted) throw new SaasRequestError('AI credit quota for this period is exhausted', 402)
        return {
          token: 'sk-relay-52',
          expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(),
          baseUrl: 'https://relay.example.com',
        }
      },
    })
    try {
      await keeper.renewNow()
      expect(sessionRequests('DELETE')).toHaveLength(1)
      expect(onEvent).toHaveBeenCalledWith({ type: 'quota-exhausted' })
      expect(keeper.isQuotaExhausted()).toBe(true)

      // 兑换/周期重置后续签成功：判定清除。
      exhausted = false
      await keeper.renewNow()
      expect(keeper.isQuotaExhausted()).toBe(false)
    } finally {
      keeper.stop()
    }
  })

  it('keeps retrying network failures without flipping the config source', async () => {
    const onEvent = vi.fn()
    let fail = true
    const { keeper } = createKeeper({
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
      // 网络失败只重试，不翻运行时配置源（issue #283：自动翻源会让用户已
      // 保存的自定义配置在设置页看起来被重置）。
      expect(onEvent).not.toHaveBeenCalled()

      fail = false
      await keeper.renewNow()
      expect(sessionRequests('PUT')).toHaveLength(1)
      expect(onEvent).toHaveBeenCalledWith({ type: 'session-activated' })
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

  it('retries quickly with backoff while the relay session is inactive', async () => {
    vi.useFakeTimers()
    let calls = 0
    const { keeper } = createKeeper({
      issue: async () => {
        calls += 1
        throw new Error('network unreachable')
      },
    })
    try {
      keeper.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(1)
      // 会话未激活：10s 起步、逐轮翻倍、60s 封顶，不再死等 20min 周期。
      await vi.advanceTimersByTimeAsync(10_000)
      expect(calls).toBe(2)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(calls).toBe(3)
      await vi.advanceTimersByTimeAsync(40_000)
      expect(calls).toBe(4)
      await vi.advanceTimersByTimeAsync(59_000)
      expect(calls).toBe(4)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(calls).toBe(5)
    } finally {
      await keeper.stop()
      vi.useRealTimers()
    }
  })
})
