import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OIDC_LOGIN_CANCELLED_MESSAGE } from '../../shared/sources'
import { SaasClient } from './saas-client'

const http = vi.hoisted(() => ({
  get: vi.fn(async (..._args: unknown[]) => ({ status: 200 })),
  post: vi.fn(async (..._args: unknown[]) => ({ status: 200, data: {} })),
  request: vi.fn<(...args: unknown[]) => Promise<{ status: number; data: unknown }>>(
    async (..._args: unknown[]) => ({ status: 200, data: {} }),
  ),
}))

vi.mock('../network/http-client', () => ({
  createLoggedHttpClient: () => http,
}))

const ISSUER = 'https://auth.nxcore.ai/oidc'
const APP_ID = 'typreqzzbz3anel9aq1z8'
const OIDC_TIMEOUT_MS = 3 * 60_000

function createCredentials() {
  const secure = new Map<string, string>()
  const plain = new Map<string, string>()
  return {
    secure,
    getSecureText: vi.fn(async (key: string) => secure.get(key)),
    setSecureText: vi.fn(async (key: string, value: string) => { secure.set(key, value) }),
    delete: vi.fn(async (key: string) => { secure.delete(key); plain.delete(key) }),
    getPlainText: vi.fn(async (key: string) => plain.get(key)),
    setPlainText: vi.fn(async (key: string, value: string) => { plain.set(key, value) }),
  }
}

function createClient() {
  const credentials = createCredentials()
  const openedUrls: string[] = []
  const client = new SaasClient(
    credentials as never,
    { getVersion: () => '0.0.0-test' } as never,
    '',
    async (url: string) => { openedUrls.push(url) },
  )
  return { client, credentials, openedUrls }
}

/** pending 中的 OIDC 登录：settle 拿到最终结局（成功/错误文案），cancel 模拟用户取消。 */
function startOidcLogin(client: SaasClient, provider: 'apple' | 'google') {
  const settled = client.loginWithOidc(provider)
    .then(() => 'resolved')
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
  return { settle: () => settled, cancel: () => client.cancelOidcLogin() }
}

function makeIdToken(nonce: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return [
    part({ alg: 'none', typ: 'JWT' }),
    part({ iss: ISSUER, aud: APP_ID, nonce, exp: Math.floor(Date.now() / 1000) + 600 }),
    'signature',
  ].join('.')
}

function loginOutcome(refreshToken: string) {
  return {
    data: {
      accessToken: `access-${refreshToken}`,
      refreshToken,
      user: { id: 'user-1', tenantId: 'tenant-1', email: 'zeng@example.com', name: 'Zeng' },
      device: { id: 'device-1', name: 'nxcoredeMacBook-Pro.local', platform: 'macOS' },
      registration: { accountCreated: false, invitationApplied: false },
    },
  }
}

const subscriptionBody = {
  data: {
    status: 'active',
    planCode: 'free',
    planName: 'Free',
    periodStart: '2026-09-01T00:00:00.000Z',
    periodEnd: '2026-09-30T00:00:00.000Z',
    entitlements: { asrSecondsPerPeriod: 3600 },
    usedSeconds: 60,
  },
}

/** 默认业务响应：外层 axios response 包着 { data: ... } 信封。 */
const okResponse = { status: 200, data: subscriptionBody }

/** 驱动纯微任务链（mock 的 http/credentials 都是立即 resolve 的 async）跑到静止。 */
async function flush(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}

describe('SaasClient 会话恢复（OIDC 响应竞态 / refresh 失效清理）', () => {
  let nonce = ''

  beforeEach(() => {
    vi.useFakeTimers()
    http.get.mockReset().mockImplementation(async () => ({ status: 400 }))
    http.post.mockReset().mockImplementation(async (url: unknown) => {
      if (String(url).includes('/token')) return { status: 200, data: { id_token: makeIdToken(nonce) } }
      return { status: 200, data: {} }
    })
    http.request.mockReset().mockImplementation(async () => okResponse)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('等待超时后返回的登录响应仍被采纳，不再抱着被吊销的旧会话（2026-09-23 线上事故）', async () => {
    const { client, credentials, openedUrls } = createClient()
    const login = startOidcLogin(client, 'apple')
    await flush()
    expect(openedUrls).toHaveLength(1)
    const authorization = new URL(openedUrls[0]!)
    nonce = authorization.searchParams.get('nonce') ?? ''
    const state = authorization.searchParams.get('state') ?? ''

    let resolveLogtoPost!: (value: { status: number; data: unknown }) => void
    http.request.mockImplementation(async (config: unknown) => {
      const url = String((config as { url?: string })?.url ?? '')
      if (url.includes('/app/auth/oidc/logto')) {
        // SaaS 登录 POST 挂起：模拟用户在浏览器耗满 3 分钟后服务端响应才回来。
        return new Promise<{ status: number; data: unknown }>((resolve) => { resolveLogtoPost = resolve })
      }
      // status() 会重跑会话恢复（initialize 记忆清空后拿存量 token 再 refresh）：
      // refresh 必须回登录形状，否则恢复失败进入 2 秒重试睡眠，假时钟下无人推进。
      if (url.includes('/app/auth/refresh')) return { status: 200, data: loginOutcome('refresh-new') }
      return okResponse
    })
    expect(client.handleOidcCallback(`everroom://auth/callback?code=auth-code&state=${state}`)).toBe('accepted')
    await flush()

    // 3 分钟等待超时：登录 Promise 被拒绝（UI 提示超时重试），pending 被清空。
    await vi.advanceTimersByTimeAsync(OIDC_TIMEOUT_MS + 1)
    await expect(login.settle()).resolves.toBe('浏览器登录等待超时，请重试。')

    // 服务端这时才返回 201：会话必须被采纳——旧会话在服务端已按本次登录吊销，
    // 丢弃新会话等于让客户端抱着死 token 死循环 401。
    resolveLogtoPost({ status: 201, data: loginOutcome('refresh-new') })
    await flush()

    expect(credentials.setSecureText).toHaveBeenCalledWith('everroom:saas:refresh-token', 'refresh-new')
    const status = await client.status()
    expect(status.authenticated).toBe(true)
    expect(status.user?.id).toBe('user-1')
  })

  it('登录响应回来时已被更新的登录接管（epoch 变化）则不采纳，由新登录收尾', async () => {
    const { client, credentials, openedUrls } = createClient()
    const first = startOidcLogin(client, 'apple')
    await flush()
    const authorization = new URL(openedUrls[0]!)
    nonce = authorization.searchParams.get('nonce') ?? ''
    const state = authorization.searchParams.get('state') ?? ''

    let resolveLogtoPost!: (value: { status: number; data: unknown }) => void
    http.request.mockImplementation(async (config: unknown) => {
      const url = String((config as { url?: string })?.url ?? '')
      if (url.includes('/app/auth/oidc/logto')) {
        return new Promise<{ status: number; data: unknown }>((resolve) => { resolveLogtoPost = resolve })
      }
      return okResponse
    })
    expect(client.handleOidcCallback(`everroom://auth/callback?code=auth-code&state=${state}`)).toBe('accepted')
    await flush()

    // 用户放弃第一轮，发起新登录：第一轮 Promise 被取消，epoch 递增。
    const second = startOidcLogin(client, 'google')
    await flush()
    await expect(first.settle()).resolves.toBe('新的登录请求已开始。')

    // 第一轮的旧响应这时回来：不能覆盖给新流程收尾的状态。
    resolveLogtoPost({ status: 201, data: loginOutcome('refresh-stale') })
    await flush()
    expect(credentials.setSecureText).not.toHaveBeenCalledWith('everroom:saas:refresh-token', 'refresh-stale')
    expect((await client.status()).authenticated).toBe(false)

    second.cancel()
    await second.settle()
  })

  it('登录 POST 在途时用户登出：迟到的登录响应不得把会话复活', async () => {
    const { client, credentials, openedUrls } = createClient()
    const login = startOidcLogin(client, 'apple')
    await flush()
    const authorization = new URL(openedUrls[0]!)
    nonce = authorization.searchParams.get('nonce') ?? ''
    const state = authorization.searchParams.get('state') ?? ''

    let resolveLogtoPost!: (value: { status: number; data: unknown }) => void
    http.request.mockImplementation(async (config: unknown) => {
      const url = String((config as { url?: string })?.url ?? '')
      if (url.includes('/app/auth/oidc/logto')) {
        return new Promise<{ status: number; data: unknown }>((resolve) => { resolveLogtoPost = resolve })
      }
      if (url.includes('/app/auth/logout')) return { status: 200, data: {} }
      return okResponse
    })
    expect(client.handleOidcCallback(`everroom://auth/callback?code=auth-code&state=${state}`)).toBe('accepted')
    await flush()

    await client.logout()
    await expect(login.settle()).resolves.toBe(OIDC_LOGIN_CANCELLED_MESSAGE)

    resolveLogtoPost({ status: 201, data: loginOutcome('refresh-after-logout') })
    await flush()
    expect(credentials.setSecureText).not.toHaveBeenCalledWith('everroom:saas:refresh-token', 'refresh-after-logout')
    expect((await client.status()).authenticated).toBe(false)
  })

  it('refresh 被 401 拒绝时清空本地会话：后台循环不再拿死 token 反复空转', async () => {
    const { client, credentials, openedUrls } = createClient()
    const login = startOidcLogin(client, 'apple')
    await flush()
    const authorization = new URL(openedUrls[0]!)
    nonce = authorization.searchParams.get('nonce') ?? ''
    const state = authorization.searchParams.get('state') ?? ''

    // 先正常登录成功。
    http.request.mockImplementation(async (config: unknown) => {
      const url = String((config as { url?: string })?.url ?? '')
      if (url.includes('/app/auth/oidc/logto')) return { status: 201, data: loginOutcome('refresh-1') }
      // status() 重跑会话恢复时 refresh 回登录形状（与登录同一会话族）。
      if (url.includes('/app/auth/refresh')) return { status: 200, data: loginOutcome('refresh-1') }
      return okResponse
    })
    expect(client.handleOidcCallback(`everroom://auth/callback?code=auth-code&state=${state}`)).toBe('accepted')
    await flush()
    await expect(login.settle()).resolves.toBe('resolved')
    expect((await client.status()).authenticated).toBe(true)

    // 会话被服务端吊销（如在别处重新登录）：业务请求 401 → refresh 也 401。
    http.request.mockImplementation(async (config: unknown) => {
      const url = String((config as { url?: string })?.url ?? '')
      if (url.includes('/app/auth/refresh')) {
        return { status: 401, data: { detail: 'Refresh session is invalid' } }
      }
      return { status: 401, data: { detail: 'Session invalid' } }
    })

    await expect(client.status(true)).rejects.toThrow('Refresh session is invalid')

    // 本地会话被清空：refresh token 删除、状态回到未登录。
    expect(credentials.delete).toHaveBeenCalledWith('everroom:saas:refresh-token')
    expect((await client.status()).authenticated).toBe(false)

    // 之后的请求在 requireLogin 处直接失败，不再发网络。
    const callsBefore = http.request.mock.calls.length
    await expect(client.listDevices()).rejects.toThrow('请先登录')
    expect(http.request.mock.calls.length).toBe(callsBefore)
  })
})
