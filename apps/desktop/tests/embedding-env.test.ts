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

  it('keeps a masked apiKey (********) as-is for comparison purposes', () => {
    // 主进程拿到的是未脱敏 save 响应;此用例固化掩码不会被视为有效 key 之外的分支:
    // 掩码串非空,按普通 key 处理(调用方从 save 响应读取,不应出现掩码)。
    expect(embeddingFieldsFromConfig({
      knowledge: { embedding: { provider: 'p', model: 'm', baseUrl: 'u', apiKey: '********' } },
    })?.apiKey).toBe('********')
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
