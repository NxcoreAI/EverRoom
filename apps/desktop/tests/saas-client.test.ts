import { describe, expect, it, vi } from 'vitest'

import { SaasClient, normalizeSaasApiUrl } from '../src/main/cloud/saas-client'

describe('normalizeSaasApiUrl', () => {
  it('adds the API prefix when only an origin is configured', () => {
    expect(normalizeSaasApiUrl('http://192.168.1.27:4100')).toBe(
      'http://192.168.1.27:4100/api/v1',
    )
  })

  it('preserves an explicitly configured API prefix', () => {
    expect(normalizeSaasApiUrl('https://saas.example.com/api/v1/')).toBe(
      'https://saas.example.com/api/v1',
    )
  })
})

describe('SaasClient summary tag contract', () => {
  it('strips read-only tag projection fields before saving', async () => {
    const client = Object.create(SaasClient.prototype) as SaasClient
    const request = vi.fn(async () => undefined)
    Object.defineProperty(client, 'request', { value: request })

    await client.replaceSummaryTags('summary-id', [{
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'entity',
      label: 'Alice',
      entityType: 'person',
      normalizedKey: 'alice',
      occurrenceCount: 4,
      confidence: 0.9,
    }])

    expect(request).toHaveBeenCalledWith('/app/summaries/summary-id/tags', {
      method: 'PUT',
      data: { tags: [{
        id: '11111111-1111-4111-8111-111111111111',
        kind: 'entity',
        label: 'Alice',
        entityType: 'person',
        confidence: 0.9,
      }] },
    })
  })
})

describe('SaasClient invitation code contract', () => {
  it('validates the code through the public auth endpoint', async () => {
    const client = Object.create(SaasClient.prototype) as SaasClient
    const publicRequest = vi.fn(async () => ({ valid: true as const }))
    Object.defineProperty(client, 'initialize', { value: vi.fn(async () => undefined) })
    Object.defineProperty(client, 'publicRequest', { value: publicRequest })

    await expect(client.validateInvitationCode('ER-2345-ABCD-JKLM')).resolves.toEqual({ valid: true })
    expect(publicRequest).toHaveBeenCalledWith('/app/auth/invitation-code/validate', {
      method: 'POST',
      data: { invitationCode: 'ER-2345-ABCD-JKLM' },
    })
  })
})

describe('SaasClient connector oo session contract', () => {
  function buildClient(request: ReturnType<typeof vi.fn>): SaasClient {
    const client = Object.create(SaasClient.prototype) as SaasClient
    Object.defineProperty(client, 'initialize', { value: vi.fn(async () => undefined) })
    Object.defineProperty(client, 'request', { value: request })
    return client
  }

  it('posts to the oo token endpoint and normalizes the returned session', async () => {
    const request = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:3000/',
      tenantId: 'u0b6f9a1e22c34d5e8f901a2b3c4d5e6f',
      token: 'oct_user-token',
    }))
    const client = buildClient(request)

    await expect(client.connectorOoSession()).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:3000',
      tenantId: 'u0b6f9a1e22c34d5e8f901a2b3c4d5e6f',
      token: 'oct_user-token',
    })
    expect(request).toHaveBeenCalledWith('/app/connectors/oo/token', { method: 'POST' })
  })

  it('rejects a session without a usable base url or token', async () => {
    const client = buildClient(vi.fn(async () => ({ baseUrl: '', token: 'oct_x' })))
    await expect(client.connectorOoSession()).rejects.toThrow('SaaS 返回了无效的 oo 连接会话。')

    const missingToken = buildClient(vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:3000' })))
    await expect(missingToken.connectorOoSession()).rejects.toThrow('SaaS 返回了无效的 oo 连接会话。')
  })
})

describe('SaasClient agent status heartbeat contract', () => {
  function buildClient(request: ReturnType<typeof vi.fn>): SaasClient {
    const client = Object.create(SaasClient.prototype) as SaasClient
    Object.defineProperty(client, 'initialize', { value: vi.fn(async () => undefined) })
    Object.defineProperty(client, 'request', { value: request })
    return client
  }

  function buildSession(overrides: Partial<Parameters<SaasClient['reportAgentStatus']>[0]['sessions'] extends (infer S)[] ? S : never> = {}) {
    return {
      id: 'session-1',
      workspaceId: 'ws-1',
      roomId: null,
      pageLabel: 'work',
      runtimeId: 'runtime-1',
      activeAgentId: 'agent-1',
      modelPreference: 'balanced',
      channelAgentId: null,
      thinkingLevel: null,
      title: '计划',
      status: 'idle',
      createdAt: '2026-11-05T06:00:00.000Z',
      updatedAt: '2026-11-05T06:00:00.000Z',
      messages: [
        {
          id: 'message-8',
          sessionId: 'session-1',
          runId: 'run-1',
          role: 'user',
          authorAgentId: null,
          content: '合并文案',
          createdAt: '2026-11-05T06:00:00.000Z',
          noteCards: [{ excerpt: '原文', note: '批注' }],
          displayContent: '',
        },
      ],
      activeRun: null,
      lastEventSeq: 3,
      ...overrides,
    }
  }

  function buildClient(request: ReturnType<typeof vi.fn>): SaasClient {
    const client = Object.create(SaasClient.prototype) as SaasClient
    Object.defineProperty(client, 'initialize', { value: vi.fn(async () => undefined) })
    Object.defineProperty(client, 'request', { value: request })
    Object.defineProperty(client, 'account', { value: {} })
    Object.defineProperty(client, 'accessToken', { value: 'token' })
    return client
  }

  it('strips noteCards and displayContent from heartbeat messages (SaaS 422)', async () => {
    const request = vi.fn(async () => undefined)
    const client = buildClient(request)

    await client.reportAgentStatus({ state: 'idle', sessions: [buildSession()] })

    const payload = request.mock.calls[0][1].data
    const message = payload.sessions[0].messages[0]
    expect(message).not.toHaveProperty('noteCards')
    expect(message).not.toHaveProperty('displayContent')
    // 保留 SaaS 认识的字段
    expect(message).toMatchObject({ id: 'message-8', role: 'user', content: '合并文案' })
  })
})

describe('SaasClient connector authorization contract', () => {
  function buildClient(request: ReturnType<typeof vi.fn>): SaasClient {
    const client = Object.create(SaasClient.prototype) as SaasClient
    Object.defineProperty(client, 'initialize', { value: vi.fn(async () => undefined) })
    Object.defineProperty(client, 'request', { value: request })
    return client
  }

  it('posts the service and returns the SaaS-provided authorization url', async () => {
    const request = vi.fn(async () => ({ service: 'gmail', authorizationUrl: 'https://accounts.google.com/o/oauth2/x' }))
    const client = buildClient(request)

    await expect(client.startConnectorAuthorization('gmail')).resolves.toEqual({
      authorizationUrl: 'https://accounts.google.com/o/oauth2/x',
    })
    expect(request).toHaveBeenCalledWith('/app/connectors/authorizations', {
      method: 'POST',
      data: { service: 'gmail' },
    })
  })

  it('rejects a response without an authorization url', async () => {
    const client = buildClient(vi.fn(async () => ({ service: 'gmail' })))
    await expect(client.startConnectorAuthorization('gmail')).rejects.toThrow('SaaS 返回了无效的授权地址。')
  })
})

