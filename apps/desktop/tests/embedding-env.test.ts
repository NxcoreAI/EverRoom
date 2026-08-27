import { describe, expect, it } from 'vitest'
import {
  embeddingFieldsFromConfig,
  memoryCoreEmbeddingEnv,
  memoryCoreEnvironment,
  memoryCoreLlmEnv,
} from '../src/main/memory/embedding-env'

describe('memoryCoreEmbeddingEnv', () => {
  it('maps four fields onto TDAI_EMBEDDING_* with dimensions', () => {
    expect(memoryCoreEmbeddingEnv(
      { provider: 'openai-compatible', model: 'text-embedding-v4', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-embed' },
      1536,
    )).toEqual({
      TDAI_EMBEDDING_PROVIDER: 'openai-compatible',
      TDAI_EMBEDDING_BASE_URL: 'https://api.example.com/v1',
      TDAI_EMBEDDING_API_KEY: 'sk-embed',
      TDAI_EMBEDDING_MODEL: 'text-embedding-v4',
      TDAI_EMBEDDING_DIMENSIONS: '1536',
    })
  })

  it('defaults the provider to openai when blank', () => {
    const env = memoryCoreEmbeddingEnv(
      { provider: '', model: 'm', baseUrl: 'https://api.example.com/v1', apiKey: 'k' },
      8,
    )
    expect(env.TDAI_EMBEDDING_PROVIDER).toBe('openai')
  })
})

describe('embeddingFieldsFromConfig', () => {
  it('extracts trimmed fields from knowledge.embedding', () => {
    expect(embeddingFieldsFromConfig({
      knowledge: { embedding: { provider: 'openai-compatible', model: '  vec  ', baseUrl: ' https://api.example.com/v1 ', apiKey: ' k ' } },
    })).toEqual({ provider: 'openai-compatible', model: 'vec', baseUrl: 'https://api.example.com/v1', apiKey: 'k' })
  })

  it('returns null when a required field is missing or empty', () => {
    expect(embeddingFieldsFromConfig({ knowledge: { embedding: { provider: 'p', model: 'm', baseUrl: '', apiKey: 'k' } } })).toBeNull()
    expect(embeddingFieldsFromConfig({ knowledge: { embedding: { provider: 'p', model: '', baseUrl: 'u', apiKey: 'k' } } })).toBeNull()
    expect(embeddingFieldsFromConfig({ knowledge: {} })).toBeNull()
    expect(embeddingFieldsFromConfig({})).toBeNull()
    expect(embeddingFieldsFromConfig(null)).toBeNull()
  })

  it('treats a masked apiKey (********) as missing', () => {
    // 网关脱敏快照的掩码不得当成真 key 注入 MemoryCore（会当真 key 用，
    // 每个上游请求静默 401）；掩码按未配置处理，MemoryCore 走降级路径。
    expect(embeddingFieldsFromConfig({
      knowledge: { embedding: { provider: 'p', model: 'm', baseUrl: 'u', apiKey: '********' } },
    })).toBeNull()
    // 响应序列化器的 "[REDACTED]" 占位同理。
    expect(embeddingFieldsFromConfig({
      knowledge: { embedding: { provider: 'p', model: 'm', baseUrl: 'u', apiKey: '[REDACTED]' } },
    })).toBeNull()
  })
})

describe('memoryCoreLlmEnv', () => {
  it('maps primary section onto TDAI_LLM_*', () => {
    expect(memoryCoreLlmEnv({
      primary: { provider: 'openai', model: 'deepseek-v4-flash', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-llm' },
    })).toEqual({
      TDAI_LLM_BASE_URL: 'https://api.example.com/v1',
      TDAI_LLM_API_KEY: 'sk-llm',
      TDAI_LLM_MODEL: 'deepseek-v4-flash',
    })
  })

  it('returns null when model/baseUrl/apiKey incomplete', () => {
    expect(memoryCoreLlmEnv({ primary: { baseUrl: 'u', apiKey: 'k', model: '' } })).toBeNull()
    expect(memoryCoreLlmEnv({ primary: {} })).toBeNull()
    expect(memoryCoreLlmEnv({})).toBeNull()
    expect(memoryCoreLlmEnv(null)).toBeNull()
  })

  it('returns null when apiKey is a redaction mask (******** / [REDACTED])', () => {
    expect(memoryCoreLlmEnv({ primary: { baseUrl: 'u', apiKey: '********', model: 'm' } })).toBeNull()
    expect(memoryCoreLlmEnv({ primary: { baseUrl: 'u', apiKey: '[REDACTED]', model: 'm' } })).toBeNull()
  })
})

describe('memoryCoreEnvironment', () => {
  it('merges llm + embedding env', () => {
    const merged = memoryCoreEnvironment(
      { primary: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-llm', model: 'm' } },
      { TDAI_EMBEDDING_MODEL: 'vec' },
    )
    expect(merged).toMatchObject({
      TDAI_LLM_MODEL: 'm',
      TDAI_EMBEDDING_MODEL: 'vec',
    })
  })

  it('passes through whichever side is configured; null when neither', () => {
    expect(memoryCoreEnvironment({}, { TDAI_EMBEDDING_MODEL: 'vec' }))
      .toEqual({ TDAI_EMBEDDING_MODEL: 'vec' })
    expect(memoryCoreEnvironment(
      { primary: { baseUrl: 'u', apiKey: 'k', model: 'm' } },
      null,
    )).toMatchObject({ TDAI_LLM_MODEL: 'm' })
    expect(memoryCoreEnvironment({}, null)).toBeNull()
  })
})
