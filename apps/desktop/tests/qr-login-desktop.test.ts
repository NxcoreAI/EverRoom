import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { SaasClient, SaasRequestError, isAdmissionRequired } from '../src/main/cloud/saas-client'
import { SessionLeaseKeeper } from '../src/main/cloud/session-lease-keeper'
import type { QrLoginPresentation } from '../src/shared/sources'


function clientWith(overrides: Record<string, unknown> = {}): SaasClient {
  const client = Object.create(SaasClient.prototype) as SaasClient
  Object.defineProperty(client, 'initialize', { value: vi.fn(async () => undefined) })
  Object.defineProperty(client, 'baseUrl', { value: 'https://api.everroom.example/api/v1' })
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(client, key, { value, writable: true, configurable: true })
  }
  return client
}

const createdResponse = {
  qrLoginSessionId: '11111111-1111-4111-8111-111111111111',
  qrScanToken: 'A'.repeat(43),
  desktopExchangeToken: 'B'.repeat(43),
  confirmationCode: '123456',
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  status: 'pending_scan' as const,
}

describe('SaasClient QR login credential isolation', () => {
  it('creates a session and keeps the desktop exchange token out of the renderer payload', async () => {
    const publicRequest = vi.fn(async () => createdResponse)
    const client = clientWith({
      publicRequest,
      deviceDetails: vi.fn(async () => ({ deviceKey: 'hw-key', deviceName: 'Mac', platform: 'macOS' as const, appVersion: '1.0' })),
      cancelQrLoginSession: vi.fn(async () => undefined),
    })
    const presentation: QrLoginPresentation = await client.createQrLoginSession()
    expect(presentation).toMatchObject({ qrLoginSessionId: createdResponse.qrLoginSessionId, qrScanToken: createdResponse.qrScanToken, confirmationCode: '123456', status: 'pending_scan' })
    expect(JSON.stringify(presentation)).not.toContain('desktopExchangeToken')
    expect(JSON.stringify(presentation)).not.toContain(createdResponse.desktopExchangeToken)
  })

  it('sends only the desktop exchange token from memory for status and exchange', async () => {
    const publicRequest = vi.fn(async (path: string) => {
      if (path.endsWith('/status')) return { status: 'pending_scan', expiresAt: createdResponse.expiresAt }
      throw new Error(`unexpected path ${path}`)
    })
    const client = clientWith({ publicRequest })
    Object.defineProperty(client, 'pendingQrLogin', { value: { sessionId: createdResponse.qrLoginSessionId, desktopExchangeToken: createdResponse.desktopExchangeToken, expiresAt: createdResponse.expiresAt, inFlight: false }, writable: true, configurable: true })
    await client.getQrLoginStatus()
    expect(publicRequest).toHaveBeenCalledWith(`/app/auth/qr-login/sessions/${createdResponse.qrLoginSessionId}/status`, {
      method: 'POST',
      data: { desktopExchangeToken: createdResponse.desktopExchangeToken },
    })
  })

  it('rejects a status call whose session id does not match the pending session', async () => {
    const client = clientWith({})
    Object.defineProperty(client, 'pendingQrLogin', { value: { sessionId: createdResponse.qrLoginSessionId, desktopExchangeToken: createdResponse.desktopExchangeToken, expiresAt: createdResponse.expiresAt, inFlight: false }, writable: true, configurable: true })
    await expect(client.getQrLoginStatus('22222222-2222-4222-8222-222222222222')).rejects.toThrow('会话不匹配')
  })

  it('rejects any QR call when no pending session exists', async () => {
    const client = clientWith({})
    Object.defineProperty(client, 'pendingQrLogin', { value: null, writable: true, configurable: true })
    await expect(client.getQrLoginStatus()).rejects.toThrow('没有进行中的扫码登录会话')
  })

  it('clears the pending session once status reaches a terminal state', async () => {
    const publicRequest = vi.fn(async () => ({ status: 'expired' }))
    const client = clientWith({ publicRequest })
    Object.defineProperty(client, 'pendingQrLogin', { value: { sessionId: createdResponse.qrLoginSessionId, desktopExchangeToken: createdResponse.desktopExchangeToken, expiresAt: createdResponse.expiresAt, inFlight: false }, writable: true, configurable: true })
    await client.getQrLoginStatus()
    expect(client.pendingQrLoginSession).toBeNull()
  })

  it('cancels the previous session best-effort before creating a new one', async () => {
    const calls: string[] = []
    const cancel = vi.fn(async () => { calls.push('cancel') })
    const client = clientWith({
      publicRequest: vi.fn(async (path: string) => { calls.push(path); return createdResponse }),
      deviceDetails: vi.fn(async () => ({ deviceKey: 'hw-key', deviceName: 'Mac', platform: 'macOS' as const, appVersion: '1.0' })),
      cancelQrLoginSession: cancel,
    })
    Object.defineProperty(client, 'pendingQrLogin', { value: { sessionId: 'old-session', desktopExchangeToken: 'C'.repeat(43), expiresAt: createdResponse.expiresAt, inFlight: false }, writable: true, configurable: true })
    await client.createQrLoginSession()
    expect(calls[0]).toBe('cancel')
  })
})

describe('SaasClient admission handling', () => {
  const admission = {
    admissionRequired: true as const,
    reason: 'DEVICE_LIMIT_REACHED' as const,
    maxDevices: 10,
    admissionToken: 'admission-token',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    devices: [{ id: 'device-1', name: 'iPhone', platform: 'iOS', status: 'online', lastSeenAt: 'now' }],
  }

  it('detects admission required outcomes', () => {
    expect(isAdmissionRequired(admission)).toBe(true)
    expect(isAdmissionRequired({ accessToken: 'a', refreshToken: 'r', user: { id: 'u', tenantId: 't' }, device: { id: 'd' } })).toBe(false)
    expect(isAdmissionRequired(null)).toBe(false)
  })

  it('keeps the challenge instead of a session when login hits the device limit', async () => {
    const client = clientWith({
      publicRequest: vi.fn(async () => admission),
      deviceDetails: vi.fn(async () => ({ deviceKey: 'hw-key', deviceName: 'Mac', platform: 'macOS' as const, appVersion: '1.0' })),
      cancelQrLoginSession: vi.fn(async () => undefined),
      currentStatus: vi.fn(() => ({ authenticated: false, apiBaseUrl: 'https://api' })),
      acceptSession: vi.fn(async () => undefined),
    })
    Object.defineProperty(client, 'pendingQrLogin', { value: null, writable: true, configurable: true })
    const status = await client.login('user@example.com', 'password')
    expect(status.authenticated).toBe(false)
    expect(client.admissionChallenge).toMatchObject({ admissionToken: 'admission-token', maxDevices: 10 })
    expect(client.admissionChallenge?.devices).toHaveLength(1)
  })

  it('replaces a device and accepts the resulting session', async () => {
    const acceptSession = vi.fn(async () => undefined)
    const loadSubscription = vi.fn(async () => undefined)
    const client = clientWith({
      publicRequest: vi.fn(async () => ({ accessToken: 'at', refreshToken: 'rt', user: { id: 'u', tenantId: 't' }, device: { id: 'd' } })),
      currentStatus: vi.fn(() => ({ authenticated: true, apiBaseUrl: 'https://api' })),
      acceptSession,
      loadSubscription,
    })
    Object.defineProperty(client, 'pendingAdmission', { value: admission, writable: true, configurable: true })
    const status = await client.replaceDeviceAdmission('admission-token', 'device-1')
    expect(status.authenticated).toBe(true)
    expect(acceptSession).toHaveBeenCalledOnce()
    expect(client.admissionChallenge).toBeNull()
  })
})

describe('SessionLeaseKeeper', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('renews every 30 seconds without overlapping requests', async () => {
    const renewals: number[] = []
    const client = clientWith({
      renewSessionLease: vi.fn(async () => {
        renewals.push(Date.now())
        await new Promise((resolve) => setTimeout(resolve, 50))
        return true
      }),
    })
    const keeper = new SessionLeaseKeeper(client)
    keeper.start()
    await vi.advanceTimersByTimeAsync(35_000)
    // First renewal fires immediately on start; interval ticks at 30s. The slow
    // in-flight renewal must not produce a parallel second call.
    expect(client.renewSessionLease).toHaveBeenCalledTimes(2)
    keeper.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(client.renewSessionLease).toHaveBeenCalledTimes(2)
  })

  it('stops and reports admission on device limit conflict', async () => {
    const onAdmissionRequired = vi.fn()
    const client = clientWith({
      renewSessionLease: vi.fn(async () => {
        throw new SaasRequestError('设备额度已满', 409)
      }),
    })
    const keeper = new SessionLeaseKeeper(client, onAdmissionRequired)
    keeper.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onAdmissionRequired).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(client.renewSessionLease).toHaveBeenCalledTimes(1)
    keeper.stop()
  })

  it('backs off when the lease route is not deployed yet', async () => {
    const client = clientWith({
      renewSessionLease: vi.fn(async () => {
        throw new SaasRequestError('not found', 404)
      }),
    })
    const keeper = new SessionLeaseKeeper(client)
    keeper.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(client.renewSessionLease).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    // 404 enters a 60s endpoint backoff, so the 30s tick is skipped.
    expect(client.renewSessionLease).toHaveBeenCalledTimes(1)
    keeper.stop()
  })
})
