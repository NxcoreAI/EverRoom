import { describe, expect, it } from 'vitest'
import { cursorCompletionEnvFromConfig } from '../src/main/gateway/cursor-completion-env'

const primary = {
  provider: 'openai',
  model: 'deepseek-v4-flash',
  baseUrl: 'https://dashscope.example.com/v1',
  apiKey: 'sk-main',
}

const cursorCompletion = {
  provider: 'qwen',
  model: 'qwen-flash',
  baseUrl: 'https://dashscope.example.com/v1',
  apiKey: 'sk-cursor',
  api: 'openai-responses',
  maxTokens: 512,
  contextWindow: 128000,
  temperature: 0.1,
  reasoning: 'off',
}

describe('cursorCompletionEnvFromConfig', () => {
  it('maps cursorCompletion section (with optional fields) over primary fallback', () => {
    const env = cursorCompletionEnvFromConfig({ primary, cursorCompletion })
    expect(env).toEqual({
      NXCORE_AI_PROVIDER: 'openai',
      NXCORE_AI_MODEL: 'deepseek-v4-flash',
      NXCORE_AI_BASE_URL: 'https://dashscope.example.com/v1',
      NXCORE_AI_API_KEY: 'sk-main',
      NXCORE_CURSOR_COMPLETION_AI_PROVIDER: 'qwen',
      NXCORE_CURSOR_COMPLETION_AI_MODEL: 'qwen-flash',
      NXCORE_CURSOR_COMPLETION_AI_BASE_URL: 'https://dashscope.example.com/v1',
      NXCORE_CURSOR_COMPLETION_AI_API_KEY: 'sk-cursor',
      NXCORE_CURSOR_COMPLETION_AI_API: 'openai-responses',
      NXCORE_CURSOR_COMPLETION_AI_MAX_TOKENS: '512',
      NXCORE_CURSOR_COMPLETION_AI_CONTEXT_WINDOW: '128000',
      NXCORE_CURSOR_COMPLETION_AI_TEMPERATURE: '0.1',
      NXCORE_CURSOR_COMPLETION_AI_REASONING: 'off',
    })
  })

  it('falls back to primary-only env when cursorCompletion section absent', () => {
    const env = cursorCompletionEnvFromConfig({ primary })
    expect(env).toEqual({
      NXCORE_AI_PROVIDER: 'openai',
      NXCORE_AI_MODEL: 'deepseek-v4-flash',
      NXCORE_AI_BASE_URL: 'https://dashscope.example.com/v1',
      NXCORE_AI_API_KEY: 'sk-main',
    })
  })

  it('returns empty object when neither section is fully configured', () => {
    expect(cursorCompletionEnvFromConfig({})).toEqual({})
    expect(cursorCompletionEnvFromConfig(null)).toEqual({})
    // 半套 primary 不注入（子进程 boot 校验会因部分填写拒启）
    expect(cursorCompletionEnvFromConfig({
      primary: { provider: 'openai', model: '', baseUrl: 'u', apiKey: 'k' },
    })).toEqual({})
  })

  it('never emits empty-string values', () => {
    const env = cursorCompletionEnvFromConfig({
      primary,
      cursorCompletion: { provider: 'qwen', model: 'm', baseUrl: 'u', apiKey: 'k', api: '' },
    })
    expect(Object.values(env).every((value) => value !== '')).toBe(true)
    expect(env.NXCORE_CURSOR_COMPLETION_AI_API).toBeUndefined()
  })
})
