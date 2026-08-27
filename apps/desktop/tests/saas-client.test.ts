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
