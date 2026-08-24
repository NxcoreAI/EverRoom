import { Agent, get } from 'node:http'

import { describe, expect, it, vi } from 'vitest'

import {
  OIDC_CALLBACK_URL,
  SaasClient,
} from '../src/main/cloud/saas-client'
import type { CredentialStore } from '../src/main/security/credential-store'

const LOOPBACK_PORT = Number.parseInt(process.env.NXCORE_LOGTO_LOOPBACK_PORT ?? '53837', 10) || 53837
const LOOPBACK_REDIRECT_URI = `http://127.0.0.1:${LOOPBACK_PORT}/auth/callback`

// 禁用连接复用,避免 keep-alive 连接让 close 后的端口在测试间保持占用。
const noKeepAliveAgent = new Agent({ keepAlive: false })

function createClient(loopbackSupported: boolean): SaasClient {
  const credentials = {
    getPlainText: vi.fn(async () => null),
    setPlainText: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    set: vi.fn(async () => 'credential-key'),
  } satisfies Partial<CredentialStore> as unknown as CredentialStore
  const electronApp = { getVersion: () => '0.0.0-test' } as unknown as import('electron').App
  const client = new SaasClient(credentials, electronApp, '/tmp', vi.fn(async () => undefined))
  // 直接指定探测缓存,避免单测依赖线上 Logto 配置。
  Object.defineProperty(client, 'loopbackRedirectSupported', { value: loopbackSupported })
  return client
}

function requestLoopback(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    get(`http://127.0.0.1:${LOOPBACK_PORT}${path}`, { agent: noKeepAliveAgent }, (response) => {
      let body = ''
      response.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
      response.on('end', () => resolveRequest({ status: response.statusCode ?? 0, body }))
    }).once('error', rejectRequest)
  })
}

function authorizationUrl(call: unknown[]): string {
  return call[0] as string
}

function authorizationParam(url: string, key: string): string {
  return new URL(url).searchParams.get(key) ?? ''
}

describe('SaasClient OIDC loopback callback', () => {
  it('uses the loopback redirect URI when supported and serves a success page for the callback', async () => {
    const client = createClient(true)
    const openExternal = vi.fn(async () => undefined)
    Object.defineProperty(client, 'openExternal', { value: openExternal })

    const loginPromise = client.loginWithOidc('google')
    loginPromise.catch(() => undefined) // 避免 token 请求失败产生 unhandled rejection
    await vi.waitFor(() => {
      expect(openExternal).toHaveBeenCalledTimes(1)
    })
    expect(authorizationUrl(openExternal.mock.calls[0])).toContain(`redirect_uri=${encodeURIComponent(LOOPBACK_REDIRECT_URI)}`)
    const state = authorizationParam(authorizationUrl(openExternal.mock.calls[0]), 'state')

    const response = await requestLoopback(`/auth/callback?state=${encodeURIComponent(state)}&code=stub-authorization-code`)
    expect(response.status).toBe(200)
    expect(response.body).toContain('You are signed in')

    // code 交付后监听即关闭,浏览器可以安全关闭回调页。
    await expect(requestLoopback(`/auth/callback?code=another`)).rejects.toThrow()
  })

  it('falls back to the everroom:// redirect URI when the loopback URI is not supported', async () => {
    const client = createClient(false)
    const openExternal = vi.fn(async () => undefined)
    Object.defineProperty(client, 'openExternal', { value: openExternal })

    const loginPromise = client.loginWithOidc('google')
    await vi.waitFor(() => {
      expect(openExternal).toHaveBeenCalledTimes(1)
    })
    expect(authorizationUrl(openExternal.mock.calls[0])).toContain(`redirect_uri=${encodeURIComponent(OIDC_CALLBACK_URL)}`)
    client.cancelOidcLogin('test-complete')
    await expect(loginPromise).rejects.toThrow('test-complete')

    // 回退模式不应占用回环端口。
    await expect(requestLoopback('/auth/callback?code=x')).rejects.toThrow()
  })

  it('reports the failure page and rejects the pending login when the callback carries an error', async () => {
    const client = createClient(true)
    const openExternal = vi.fn(async () => undefined)
    Object.defineProperty(client, 'openExternal', { value: openExternal })

    const loginPromise = client.loginWithOidc('google')
    loginPromise.catch(() => undefined) // 避免 token 请求失败产生 unhandled rejection
    await vi.waitFor(() => {
      expect(openExternal).toHaveBeenCalledTimes(1)
    })
    const state = authorizationParam(authorizationUrl(openExternal.mock.calls[0]), 'state')

    const response = await requestLoopback(`/auth/callback?state=${encodeURIComponent(state)}&error=access_denied&error_description=User+cancelled`)
    expect(response.status).toBe(400)
    expect(response.body).toContain('Sign-in incomplete')

    await expect(loginPromise).rejects.toThrow('User cancelled')
  })
})
