import { afterEach, describe, expect, it, vi } from 'vitest'

import { SaasConnectorBridge } from '../src/main/gateway/saas-connector-bridge'
import type { GatewaySupervisor } from '../src/main/gateway/gateway-supervisor'

function buildBridge(
  startAuthorization: (service: string) => Promise<{ authorizationUrl: string }>,
  ooSession: () => { baseUrl: string; token: string } | null,
  oauthConfigs: () => Promise<Array<{ service: string; displayName: string | null; iconUrl: string | null }>> = async () => [],
): { bridge: SaasConnectorBridge; openExternal: ReturnType<typeof vi.fn> } {
  const openExternal = vi.fn(async () => undefined)
  const bridge = new SaasConnectorBridge({} as GatewaySupervisor, openExternal, { startAuthorization, ooSession, oauthConfigs })
  return { bridge, openExternal }
}

describe('SaasConnectorBridge authorization flow', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens the SaaS-provided authorization page and returns a pending attempt', async () => {
    const { bridge, openExternal } = buildBridge(
      async () => ({ authorizationUrl: 'https://accounts.google.com/o/oauth2/x' }),
      () => null,
    )

    const attempt = await bridge.startAuthorization('gmail')
    expect(attempt.status).toBe('pending')
    expect(attempt.provider).toBe('gmail')
    expect(attempt.connection).toBeNull()
    expect(openExternal).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/x')

    // 无 oo 会话时保持 pending（渲染层持续轮询）。
    await expect(bridge.authorizationStatus(attempt.id)).resolves.toMatchObject({ status: 'pending' })
  })

  it('rejects an invalid provider or a non-http authorization url', async () => {
    const { bridge } = buildBridge(async () => ({ authorizationUrl: 'https://example.com/x' }), () => null)
    await expect(bridge.startAuthorization('Gmail!')).rejects.toThrow('不支持的连接提供方。')

    const unsafe = buildBridge(async () => ({ authorizationUrl: 'javascript:alert(1)' }), () => null)
    await expect(unsafe.bridge.startAuthorization('gmail')).rejects.toThrow('SaaS 返回了不安全的授权地址。')
  })

  it('reports connected once the connection lands in the oo tenant and registers it with the gateway', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: [{ service: 'gmail' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { bridge } = buildBridge(async () => ({ authorizationUrl: 'https://accounts.google.com/x' }), () => ({
      baseUrl: 'http://127.0.0.1:3000',
      token: 'oct_user-token',
    }))
    const connection = { id: 'conn-1', provider: 'gmail', connectionName: 'default', status: 'active' }
    const register = vi.spyOn(bridge, 'registerConnection').mockResolvedValue(connection as never)

    const attempt = await bridge.startAuthorization('gmail')
    const status = await bridge.authorizationStatus(attempt.id)
    expect(status.status).toBe('connected')
    expect(status.connection).toEqual(connection)
    expect(register).toHaveBeenCalledWith({ provider: 'gmail', service: 'gmail', connectionName: 'default' })

    // 已完成的授权短路返回，不再探测/重复注册。
    const second = await bridge.authorizationStatus(attempt.id)
    expect(second.status).toBe('connected')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledTimes(1)
  })

  it('keeps polling when gateway registration fails while the connection exists in oo', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: [{ service: 'gmail' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { bridge } = buildBridge(async () => ({ authorizationUrl: 'https://accounts.google.com/x' }), () => ({
      baseUrl: 'http://127.0.0.1:3000',
      token: 'oct_user-token',
    }))
    vi.spyOn(bridge, 'registerConnection').mockRejectedValue(new Error('gateway down'))

    const attempt = await bridge.startAuthorization('gmail')
    // 注册失败 → 仍报 pending（渲染层继续轮询），下轮重试注册。
    await expect(bridge.authorizationStatus(attempt.id)).resolves.toMatchObject({ status: 'pending' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps pending while the connection has not landed and falls back for unknown ids', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { bridge } = buildBridge(async () => ({ authorizationUrl: 'https://accounts.google.com/x' }), () => ({
      baseUrl: 'http://127.0.0.1:3000',
      token: 'oct_user-token',
    }))

    const attempt = await bridge.startAuthorization('gmail')
    await expect(bridge.authorizationStatus(attempt.id)).resolves.toMatchObject({ status: 'pending' })

    // 未知 id 走 gateway 原路径（委托父类）。
    await expect(bridge.authorizationStatus('nango-flow-id').catch((error: unknown) => error)).resolves.toBeDefined()
  })

  it('translates provider names to oo service names across the authorization chain', async () => {
    const startAuthorization = vi.fn(async () => ({ authorizationUrl: 'https://accounts.google.com/x' }))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: [{ service: 'googledrive' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { bridge } = buildBridge(startAuthorization, () => ({
      baseUrl: 'http://127.0.0.1:3000',
      token: 'oct_user-token',
    }))
    const register = vi.spyOn(bridge, 'registerConnection').mockResolvedValue({ id: 'conn-1' } as never)

    await bridge.startAuthorization('google-docs')
    // SaaS/oo 按 oo service 名索引（Google 系无连字符），attempt 仍用 provider 名。
    expect(startAuthorization).toHaveBeenCalledWith('googledrive')

    const started = await bridge.startAuthorization('google-docs')
    await bridge.authorizationStatus(started.id)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/v1/apps/services/googledrive',
      expect.objectContaining({ headers: { authorization: 'Bearer oct_user-token' } }),
    )
    expect(register).toHaveBeenCalledWith({ provider: 'google-docs', service: 'googledrive', connectionName: 'default' })
  })
})

describe('SaasConnectorBridge.configuredProviders', () => {
  it('maps oo service names to registry provider names and drops unknown services', async () => {
    const { bridge } = buildBridge(async () => ({ authorizationUrl: 'https://x.example/x' }), () => null, async () => [
      { service: 'gmail', displayName: 'Gmail', iconUrl: null },
      { service: 'googledrive', displayName: 'Google Drive', iconUrl: null },
      { service: 'googlecalendar', displayName: 'Google Calendar', iconUrl: null },
      { service: 'discord', displayName: 'Discord', iconUrl: null },
    ])

    await expect(bridge.configuredProviders()).resolves.toEqual(['gmail', 'google-docs', 'google-calendar'])
  })

  it('propagates SaaS failures so the renderer can fall back', async () => {
    const { bridge } = buildBridge(async () => ({ authorizationUrl: 'https://x.example/x' }), () => null, async () => {
      throw new Error('登录已过期，请重新登录。')
    })

    await expect(bridge.configuredProviders()).rejects.toThrow('登录已过期，请重新登录。')
  })
})
