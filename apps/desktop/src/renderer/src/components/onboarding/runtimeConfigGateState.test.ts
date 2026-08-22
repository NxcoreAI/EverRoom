import { beforeEach, describe, expect, it } from 'vitest'

import type { RuntimeConfigSnapshot } from '../../../../shared/sources'

import {
  buildUserConfig,
  configTestErrorMessage,
  embeddingFieldsFromSnapshot,
  isRuntimeConfigReady,
  manualConfigFieldError,
  primaryFieldsFromSnapshot,
  readConfigGateSkipped,
  writeConfigGateSkipped,
  type ManualAiConfigFields,
} from './runtimeConfigGateState'

function snapshot(config: Record<string, unknown> = {}, extra: Partial<RuntimeConfigSnapshot> = {}): RuntimeConfigSnapshot {
  return {
    config,
    source: 'default',
    selectedSource: 'default',
    availableSources: ['default'],
    configVersion: 1,
    updatedAt: '2026-08-22T00:00:00.000Z',
    ...extra,
  }
}

const memory = { getItem: (_key: string) => null as string | null }
const memoryStore = () => {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
  }
}

const primary = (model: string, baseUrl: string, apiKey: string): ManualAiConfigFields => ({
  provider: 'openai-compatible',
  model,
  baseUrl,
  apiKey,
})

const emptyEmbedding = (): ManualAiConfigFields => ({
  provider: 'openai-compatible',
  model: '',
  baseUrl: '',
  apiKey: '',
})

describe('runtime config gate state', () => {
  beforeEach(() => {
    if (typeof window !== 'undefined') window.localStorage.removeItem('everroom:runtime-config-gate-skipped')
  })

  it('treats only an explicit server-side flag as ready', () => {
    expect(isRuntimeConfigReady(null)).toBe(false)
    expect(isRuntimeConfigReady(snapshot())).toBe(false)
    expect(isRuntimeConfigReady(snapshot({}, { primaryConfigured: true }))).toBe(true)
  })

  it('persists and clears the skip marker', () => {
    const store = memoryStore()
    expect(readConfigGateSkipped(store)).toBe(false)
    writeConfigGateSkipped(true, store)
    expect(readConfigGateSkipped(store)).toBe(true)
    writeConfigGateSkipped(false, store)
    expect(readConfigGateSkipped(store)).toBe(false)
  })

  it('seeds manual fields from an existing primary section, keeping masked secrets blank', () => {
    const current = snapshot({
      primary: { provider: 'glm', model: 'glm-4', baseUrl: 'https://api.example.com/v1', apiKey: '********' },
    })
    expect(primaryFieldsFromSnapshot(current)).toEqual({
      provider: 'glm',
      model: 'glm-4',
      baseUrl: 'https://api.example.com/v1',
      apiKey: '',
    })
  })

  it('falls back to the default provider when primary is missing', () => {
    expect(primaryFieldsFromSnapshot(snapshot())).toEqual({
      provider: 'openai-compatible',
      model: '',
      baseUrl: '',
      apiKey: '',
    })
  })

  it('builds a user config that preserves unrelated sections', () => {
    const current = snapshot({ asr: { provider: 'aliyun' }, primary: { provider: 'old' } })
    const next = buildUserConfig(current, {
      primary: {
        provider: 'openai-compatible',
        model: 'm',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-new',
      },
      embedding: emptyEmbedding(),
    }) as {
      schemaVersion: number
      asr: unknown
      primary: Record<string, string>
      knowledge: Record<string, unknown>
    }
    expect(next.schemaVersion).toBe(1)
    expect(next.asr).toEqual({ provider: 'aliyun' })
    expect(next.primary).toEqual({
      provider: 'openai-compatible',
      model: 'm',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-new',
    })
    expect(next.knowledge).toEqual({
      embedding: { provider: 'openai-compatible', model: '', baseUrl: '', apiKey: '' },
    })
  })

  it('seeds embedding fields from knowledge.embedding, keeping masked secrets blank', () => {
    const current = snapshot({
      knowledge: {
        enabled: 'true',
        embedding: { provider: 'qwen', model: 'text-embedding-v4', baseUrl: 'https://api.example.com/v1', apiKey: '********' },
      },
    })
    expect(embeddingFieldsFromSnapshot(current)).toEqual({
      provider: 'qwen',
      model: 'text-embedding-v4',
      baseUrl: 'https://api.example.com/v1',
      apiKey: '',
    })
  })

  it('builds a user config with embedding merged into an existing knowledge section', () => {
    const current = snapshot({
      knowledge: { enabled: 'true', serviceId: 'everroom', embedding: { provider: 'old', model: 'old-vec', baseUrl: 'old', apiKey: 'old-key' } },
    })
    const next = buildUserConfig(current, {
      primary: primary('new', 'https://api.example.com/v1', 'sk-new'),
      embedding: {
        provider: 'qwen',
        model: 'text-embedding-v4',
        baseUrl: 'https://dashscope.example.com/v1',
        apiKey: 'sk-embed',
      },
    }) as { knowledge: Record<string, unknown> }
    // knowledge 其余键保留,embedding 整体替换。
    expect(next.knowledge).toEqual({
      enabled: 'true',
      serviceId: 'everroom',
      embedding: {
        provider: 'qwen',
        model: 'text-embedding-v4',
        baseUrl: 'https://dashscope.example.com/v1',
        apiKey: 'sk-embed',
      },
    })
  })

  it('clearing embedding overwrites a previously stored value with empty strings', () => {
    const current = snapshot({
      knowledge: { embedding: { provider: 'qwen', model: 'v4', baseUrl: 'https://old', apiKey: 'old-key' } },
    })
    const next = buildUserConfig(current, {
      primary: primary('m', 'https://api.example.com/v1', 'sk'),
      embedding: emptyEmbedding(),
    }) as {
      knowledge: { embedding: Record<string, string> }
    }
    expect(next.knowledge.embedding.model).toBe('')
  })

  it('maps connection test failures to readable messages', () => {
    const t = (key: string) => key
    expect(configTestErrorMessage('runtime_config_test_incomplete', t)).toBe('surface:configGate.testIncomplete')
    expect(configTestErrorMessage('runtime_config_test_http_401: bad key', t)).toBe('surface:configGate.testAuthFailed')
    expect(configTestErrorMessage('runtime_config_test_http_404: no route', t)).toBe('surface:configGate.testNotFound')
    expect(configTestErrorMessage('runtime_config_test_unreachable: refused', t)).toBe('surface:configGate.testUnreachable')
    expect(configTestErrorMessage(undefined, t)).toBe('surface:configGate.testFailedGeneric')
  })

  it('validates primary fields as before and allows an entirely empty embedding', () => {
    const t = (key: string) => key
    expect(manualConfigFieldError(primary('', 'https://api.example.com/v1', 'sk'), emptyEmbedding(), t))
      .toBe('surface:configGate.fieldRequired')
    expect(manualConfigFieldError(primary('m', 'https://api.example.com/v1', 'sk'), emptyEmbedding(), t)).toBeNull()
  })

  it('rejects a partially filled embedding', () => {
    const t = (key: string) => key
    expect(manualConfigFieldError(
      primary('m', 'https://api.example.com/v1', 'sk'),
      { ...emptyEmbedding(), model: 'text-embedding-v4' },
      t,
    )).toBe('surface:configGate.embeddingIncomplete')
    expect(manualConfigFieldError(
      primary('m', 'https://api.example.com/v1', 'sk'),
      { provider: 'qwen', model: 'text-embedding-v4', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-embed' },
      t,
    )).toBeNull()
  })
})
