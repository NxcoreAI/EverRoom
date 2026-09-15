import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OIDC_LOGIN_CANCELLED_MESSAGE } from '../../shared/sources'
import { SaasClient } from './saas-client'

const http = vi.hoisted(() => ({
  get: vi.fn(async (..._args: unknown[]) => ({ status: 200 })),
  post: vi.fn(async (..._args: unknown[]) => ({ status: 200, data: {} })),
}))

vi.mock('../network/http-client', () => ({
  createLoggedHttpClient: () => http,
}))

const ISSUER = 'https://auth.nxcore.ai/oidc'
const LOOPBACK_URI = 'http://127.0.0.1:53837/auth/callback'

function createClient(openExternal: (url: string) => Promise<void>) {
  const credentials = {
    getSecureText: vi.fn(async () => undefined),
    setSecureText: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  }
  const client = new SaasClient(
    credentials as never,
    { getVersion: () => '0.0.0-test' } as never,
    '',
    openExternal,
  )
  return client
}

/** pending 中的 OIDC 登录：settle 拿到最终结局（成功/错误文案），cancel 模拟用户取消。 */
function startOidcLogin(client: SaasClient, provider: 'apple' | 'google') {
  const settled = client.loginWithOidc(provider)
    .then(() => 'resolved')
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
  return { settle: () => settled, cancel: () => client.cancelOidcLogin() }
}

describe('SaasClient OIDC 登录（direct_sign_in / 回环探测 / 取消）', () => {
  let openedUrls: string[]

  beforeEach(() => {
    http.get.mockClear()
    http.post.mockClear()
    http.get.mockImplementation(async () => ({ status: 200 }))
    openedUrls = []
  })

  afterEach(() => {
    // 兜底清掉 3 分钟等待定时器，避免悬挂 timer 拖住测试进程。
    vi.clearAllTimers()
  })

  it('direct_sign_in 传 provider target（social:apple），不再传 connector ID', async () => {
    // 400 = IdP 明确表示未注册回环 redirect_uri → 本轮即回落 everroom://
    http.get.mockImplementation(async () => ({ status: 400 }))
    const client = createClient(async (url) => { openedUrls.push(url) })
    const login = startOidcLogin(client, 'apple')

    await vi.waitFor(() => expect(openedUrls).toHaveLength(1))
    const url = new URL(openedUrls[0])
    expect(url.origin + url.pathname).toBe(`${ISSUER}/auth`)
    expect(url.searchParams.get('direct_sign_in')).toBe('social:apple')
    expect(url.searchParams.get('redirect_uri')).toBe('everroom://auth/callback')

    client.cancelOidcLogin()
    await expect(login.settle()).resolves.toBe(OIDC_LOGIN_CANCELLED_MESSAGE)
  })

  it('回环探测带 5s 超时，且 IdP 明确应答后缓存结论', async () => {
    const client = createClient(async (url) => { openedUrls.push(url) })

    const first = startOidcLogin(client, 'google')
    await vi.waitFor(() => expect(openedUrls).toHaveLength(1))
    expect(new URL(openedUrls[0]).searchParams.get('redirect_uri')).toBe(LOOPBACK_URI)

    client.cancelOidcLogin()
    await first.settle()

    // 探测请求带独立短超时（代理环境下不能让点登录到跳浏览器等 15s）
    const probeConfig = http.get.mock.calls[0]?.[1] as { timeout?: number } | undefined
    expect(probeConfig?.timeout).toBe(5_000)

    // 第二次登录：结论已缓存，不再探测
    openedUrls.length = 0
    const second = startOidcLogin(client, 'google')
    await vi.waitFor(() => expect(openedUrls).toHaveLength(1))
    expect(new URL(openedUrls[0]).searchParams.get('redirect_uri')).toBe(LOOPBACK_URI)
    client.cancelOidcLogin()
    await second.settle()
    expect(http.get).toHaveBeenCalledTimes(1)
  })

  it('探测网络失败（代理/VPN 断连）只影响当次：本轮回落 everroom://，下次重新探测', async () => {
    let failProbe = true
    http.get.mockImplementation(async () => {
      if (failProbe) throw new Error('fetch failed')
      return { status: 400 }
    })

    const client = createClient(async (url) => { openedUrls.push(url) })

    // 第一次：网络故障 → everroom://（不缓存）
    const first = startOidcLogin(client, 'apple')
    await vi.waitFor(() => expect(openedUrls).toHaveLength(1))
    expect(new URL(openedUrls[0]).searchParams.get('redirect_uri')).toBe('everroom://auth/callback')
    client.cancelOidcLogin()
    await first.settle()

    // 第二次：网络恢复，探测给出明确结论（400 → 不支持回环）并被缓存
    failProbe = false
    openedUrls.length = 0
    const second = startOidcLogin(client, 'apple')
    await vi.waitFor(() => expect(openedUrls).toHaveLength(1))
    expect(new URL(openedUrls[0]).searchParams.get('redirect_uri')).toBe('everroom://auth/callback')
    client.cancelOidcLogin()
    await second.settle()
    expect(http.get).toHaveBeenCalledTimes(2)

    // 第三次：使用缓存，不再探测
    openedUrls.length = 0
    const third = startOidcLogin(client, 'apple')
    await vi.waitFor(() => expect(openedUrls).toHaveLength(1))
    client.cancelOidcLogin()
    await third.settle()
    expect(http.get).toHaveBeenCalledTimes(2)
  })
})
