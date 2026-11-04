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
    await expect(unsafe.bridge.startAuthorization('gmail')).rejects.toThrow('不安全的授权地址')
  })

  it('reports connected once the connection lands in the oo tenant, without local registration', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, data: [{ service: 'gmail', alias: 'default' }] }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { bridge } = buildBridge(async () => ({ authorizationUrl: 'https://accounts.google.com/x' }), () => ({
      baseUrl: 'http://127.0.0.1:3000',
      token: 'oct_user-token',
    }))

    const attempt = await bridge.startAuthorization('gmail')
    const status = await bridge.authorizationStatus(attempt.id)
    expect(status.status).toBe('connected')
    expect(status.connection).toMatchObject({
      id: 'gmail:default',
      provider: 'gmail',
      service: 'gmail',
      connectionName: 'default',
      status: 'active',
    })

    // 已完成的授权短路返回，不再探测。
    const second = await bridge.authorizationStatus(attempt.id)
    expect(second.status).toBe('connected')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps polling while the oo tenant has no connection yet', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { bridge } = buildBridge(async () => ({ authorizationUrl: 'https://accounts.google.com/x' }), () => ({
      baseUrl: 'http://127.0.0.1:3000',
      token: 'oct_user-token',
    }))

    const attempt = await bridge.startAuthorization('gmail')
    await expect(bridge.authorizationStatus(attempt.id)).resolves.toMatchObject({ status: 'pending' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('SaasConnectorBridge configured providers', () => {
  it('passes the whole SaaS OAuth catalog through, mapping service → provider', async () => {
    const { bridge } = buildBridge(
      async () => ({ authorizationUrl: 'https://example.com/x' }),
      () => null,
      async () => [
        { service: 'gmail', displayName: 'Gmail', iconUrl: 'https://cdn.example.com/gmail.png' },
        { service: 'googledrive', displayName: 'Drive', iconUrl: null },
        { service: 'unknown-svc', displayName: '未知应用', iconUrl: 'https://cdn.example.com/x.png' },
      ],
    )

    // 旧接口（名单）：只回网关有适配器的 provider。
    await expect(bridge.configuredProviders()).resolves.toEqual(['gmail', 'google-docs'])
    // 新接口（目录）：SaaS 配置即目录，未知 service 原样透传（不依赖网关查询档案）。
    await expect(bridge.configuredProvidersDetailed()).resolves.toEqual([
      { provider: 'gmail', displayName: 'Gmail', iconUrl: 'https://cdn.example.com/gmail.png' },
      { provider: 'google-docs', displayName: 'Drive', iconUrl: null },
      { provider: 'unknown-svc', displayName: '未知应用', iconUrl: 'https://cdn.example.com/x.png' },
    ])
  })

  it('keeps the first entry when the same provider is configured twice', async () => {
    const { bridge } = buildBridge(
      async () => ({ authorizationUrl: 'https://example.com/x' }),
      () => null,
      async () => [
        { service: 'gmail', displayName: 'Gmail', iconUrl: 'https://cdn.example.com/first.png' },
        { service: 'gmail', displayName: 'Gmail 2', iconUrl: 'https://cdn.example.com/second.png' },
      ],
    )

    await expect(bridge.configuredProvidersDetailed()).resolves.toEqual([
      { provider: 'gmail', displayName: 'Gmail', iconUrl: 'https://cdn.example.com/first.png' },
    ])
  })
})
