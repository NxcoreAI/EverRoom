import { describe, expect, it } from 'vitest'
import { knowledgeServiceLlmEnv } from '../src/main/knowledge/llm-env'

describe('knowledgeServiceLlmEnv', () => {
  it('maps the primary section onto KS LLM_* (custom mode)', () => {
    expect(knowledgeServiceLlmEnv({
      primary: { provider: 'openai', model: 'deepseek-v4-flash', baseUrl: 'https://api.example.com/v1', apiKey: ' sk-llm ' },
    })).toEqual({
      LLM_MODE: 'custom',
      LLM_BASE_URL: 'https://api.example.com/v1',
      LLM_API_KEY: 'sk-llm',
      LLM_MODEL: 'deepseek-v4-flash',
    })
  })

  it('returns null when baseUrl/apiKey/model incomplete', () => {
    expect(knowledgeServiceLlmEnv({ primary: { baseUrl: 'u', apiKey: 'k', model: '' } })).toBeNull()
    expect(knowledgeServiceLlmEnv({ primary: { baseUrl: '', apiKey: 'k', model: 'm' } })).toBeNull()
    expect(knowledgeServiceLlmEnv({ primary: {} })).toBeNull()
    expect(knowledgeServiceLlmEnv({})).toBeNull()
    expect(knowledgeServiceLlmEnv(null)).toBeNull()
  })

  it('returns null when apiKey is a redaction mask (******** / [REDACTED])', () => {
    // 网关脱敏快照的掩码不得当成真 key 注入 KS（LLM_MODE=custom + 假 key
    // 会让 wiki ingest 每次上游调用 401）；按未配置处理，保持 .env 透传。
    expect(knowledgeServiceLlmEnv({ primary: { baseUrl: 'u', apiKey: '********', model: 'm' } })).toBeNull()
    expect(knowledgeServiceLlmEnv({ primary: { baseUrl: 'u', apiKey: '[REDACTED]', model: 'm' } })).toBeNull()
  })
})
