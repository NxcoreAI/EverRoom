import { describe, expect, it } from 'vitest'

import { normalizeSaasApiUrl } from '../src/main/cloud/saas-client'

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
