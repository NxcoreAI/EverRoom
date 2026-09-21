import { describe, expect, it, vi } from 'vitest'

import { assertBrowserOpenableAuthorizationUrl, SaasConnectorBridge } from './saas-connector-bridge'
import type { GatewaySupervisor } from './gateway-supervisor'

const resolvable = () => Promise.resolve([{ address: '1.2.3.4', family: 4 }])
const nxDomain = () => Promise.reject(new Error('getaddrinfo ENOTFOUND'))

describe('assertBrowserOpenableAuthorizationUrl', () => {
  it('rejects *.localhost hosts (internal-only names browsers map to loopback)', async () => {
    // #240 线上实测的坏地址形态：内部容器主机名当公开授权页返回。
    await expect(assertBrowserOpenableAuthorizationUrl(
      'https://feishu.open-connector.localhost:9999/authorize?state=abc',
      nxDomain,
    )).rejects.toThrow('内部地址')
  })

  it('rejects bare single-label hostnames', async () => {
    await expect(assertBrowserOpenableAuthorizationUrl(
      'http://open-connector:9999/authorize',
      resolvable,
    )).rejects.toThrow('内部地址')
  })

  it('rejects domains that do not resolve', async () => {
    await expect(assertBrowserOpenableAuthorizationUrl(
      'https://js.everroom.cn/feishu/authorize?state=abc',
      nxDomain,
    )).rejects.toThrow('无法解析')
  })

  it('passes through when the DNS probe times out (slow DNS is not a broken URL)', async () => {
    const url = await assertBrowserOpenableAuthorizationUrl(
      'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
      () => Promise.reject(new Error('dns_probe_timeout')),
    )
    expect(url.hostname).toBe('accounts.feishu.cn')
  })

  it('accepts loopback and IP-literal hosts without a DNS probe', async () => {
    const probe = vi.fn(resolvable)
    expect((await assertBrowserOpenableAuthorizationUrl('http://127.0.0.1:4590/x', probe)).hostname).toBe('127.0.0.1')
    expect((await assertBrowserOpenableAuthorizationUrl('http://localhost:4100/api/v1/x', probe)).hostname).toBe('localhost')
    expect((await assertBrowserOpenableAuthorizationUrl('http://192.168.1.99:4100/x', probe)).hostname).toBe('192.168.1.99')
    expect(probe).not.toHaveBeenCalled()
  })

  it('accepts resolvable public domains', async () => {
    expect((await assertBrowserOpenableAuthorizationUrl(
      'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
      resolvable,
    )).protocol).toBe('https:')
  })

  it('rejects invalid URLs and unsupported protocols', async () => {
    await expect(assertBrowserOpenableAuthorizationUrl('not a url', resolvable)).rejects.toThrow('授权地址无效')
    await expect(assertBrowserOpenableAuthorizationUrl('ftp://example.com/authorize', resolvable)).rejects.toThrow('协议不受支持')
  })
})

describe('SaasConnectorBridge.startAuthorization URL guard', () => {
  function bridge(startAuthorization: (service: string) => Promise<{ authorizationUrl: string }>) {
    const openExternal = vi.fn(() => Promise.resolve())
    const saasBridge = new SaasConnectorBridge(
      {} as GatewaySupervisor,
      openExternal,
      {
        startAuthorization,
        ooSession: () => null,
        oauthConfigs: () => Promise.resolve([]),
      },
    )
    return { saasBridge, openExternal }
  }

  it('does not open the browser when the SaaS returns an internal authorization URL', async () => {
    const { saasBridge, openExternal } = bridge(() =>
      Promise.resolve({ authorizationUrl: 'https://feishu.open-connector.localhost:9999/authorize?state=x' }))
    await expect(saasBridge.startAuthorization('feishu')).rejects.toThrow('内部地址')
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('opens the browser for a usable authorization URL', async () => {
    const { saasBridge, openExternal } = bridge(() =>
      Promise.resolve({ authorizationUrl: 'http://localhost:39901/oauth/authorize?state=x' }))
    const attempt = await saasBridge.startAuthorization('feishu')
    expect(attempt.status).toBe('pending')
    expect(openExternal).toHaveBeenCalledWith('http://localhost:39901/oauth/authorize?state=x')
  })
})
