import { describe, expect, it } from 'vitest'

import type { RuntimeConfigSnapshot } from '../../../shared/sources'

import {
  asrFieldsError,
  asrFieldsFromSnapshot,
  asrFieldsIncomplete,
  aiFieldsError,
  buildUserConfig,
  embeddingFieldsFromSnapshot,
  emptyAsrFields,
  liteFieldsIncomplete,
  primaryFieldsFromSnapshot,
  vlmFieldsFromSnapshot,
  type ManualAiConfigFields,
} from './runtimeConfigFormState'

function snapshot(config: Record<string, unknown> = {}): RuntimeConfigSnapshot {
  return {
    config,
    // 播种只认用户源：helper 里 config 与 userConfig 同源，显式构造 default-only 场景时传 userConfig: null。
    userConfig: config,
    source: 'default',
    selectedSource: 'default',
    availableSources: ['default'],
    configVersion: 1,
    updatedAt: '2026-08-22T00:00:00.000Z',
  }
}

const ai = (model: string, baseUrl = 'https://api.example.com/v1', apiKey = 'sk'): ManualAiConfigFields => ({
  provider: 'openai-compatible',
  model,
  baseUrl,
  apiKey,
})

describe('runtime config form state — vlm', () => {
  it('seeds vlm fields from the snapshot, masked apiKey stays blank', () => {
    expect(vlmFieldsFromSnapshot(snapshot({
      vlm: { provider: 'openai-compatible', model: 'qwen-vl-max', baseUrl: 'https://api.example.com/v1', apiKey: '********' },
    }))).toEqual({ provider: 'openai-compatible', model: 'qwen-vl-max', baseUrl: 'https://api.example.com/v1', apiKey: '' })
  })

  it('seeds empty vlm fields when the section is missing', () => {
    expect(vlmFieldsFromSnapshot(snapshot())).toEqual({ provider: 'openai-compatible', model: '', baseUrl: '', apiKey: '' })
  })

  it('默认/中转源的值不进表单：无 userConfig 时各段播种为空', () => {
    const defaultOnly = {
      ...snapshot({
        primary: { provider: 'openai-compatible', model: 'relay-model', baseUrl: 'http://127.0.0.1:1/ai-relay/v1', apiKey: 'sk-relay' },
        vlm: { provider: 'openai-compatible', model: 'qwen-vl-max', baseUrl: 'https://api.example.com/v1', apiKey: 'sk' },
      }),
      userConfig: null,
    }
    expect(primaryFieldsFromSnapshot(defaultOnly).model).toBe('')
    expect(vlmFieldsFromSnapshot(defaultOnly).model).toBe('')
    expect(embeddingFieldsFromSnapshot(defaultOnly).model).toBe('')
  })

  it('writes vlm into the user config without touching other sections', () => {
    const next = buildUserConfig(snapshot({ primary: { provider: 'x' } }), { vlm: ai('vlm-m') }) as {
      vlm: Record<string, string>
      primary: unknown
    }
    expect(next.vlm).toEqual({ provider: 'openai-compatible', model: 'vlm-m', baseUrl: 'https://api.example.com/v1', apiKey: 'sk' })
    expect(next.primary).toEqual({ provider: 'x' })
  })
})

describe('runtime config form state — asr', () => {
  it('seeds asr scalar and oss fields from the snapshot, masked secrets blank', () => {
    expect(asrFieldsFromSnapshot(snapshot({
      asr: {
        provider: 'aliyun',
        model: 'asr-m',
        baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
        apiKey: '********',
        oss: {
          region: 'oss-cn-beijing',
          bucket: 'b',
          accessKeyId: 'ak',
          accessKeySecret: '********',
          prefix: 'nxcore-asr',
        },
      },
    }))).toEqual({
      provider: 'aliyun',
      model: 'asr-m',
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      apiKey: '',
      language: '',
      oss: { region: 'oss-cn-beijing', bucket: 'b', accessKeyId: 'ak', accessKeySecret: '', stsToken: '', prefix: 'nxcore-asr' },
    })
  })

  it('seeds the openai-compatible engine with language', () => {
    expect(asrFieldsFromSnapshot(snapshot({
      asr: { provider: 'openai-compatible', model: 'whisper-1', baseUrl: 'http://127.0.0.1:9000', language: 'zh' },
    }))).toMatchObject({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9000', language: 'zh' })
  })

  it('builds an asr section with oss (empty strings when untouched)', () => {
    const next = buildUserConfig(snapshot(), { asr: emptyAsrFields() }) as {
      asr: Record<string, unknown> & { oss: Record<string, string> }
    }
    expect(next.asr.provider).toBe('aliyun')
    expect(next.asr.oss).toEqual({
      region: '', bucket: '', accessKeyId: '', accessKeySecret: '', stsToken: '', prefix: '',
    })
  })

  it('validation: empty asr passes; scalars filled require oss required fields', () => {
    const t = (key: string) => key
    expect(asrFieldsError(emptyAsrFields(), t)).toBeNull()
    const scalarsOnly: typeof emptyAsrFields extends () => infer F ? F : never = {
      ...emptyAsrFields(),
      model: 'asr-m',
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      apiKey: 'k',
    }
    expect(asrFieldsError(scalarsOnly, t)).toBe('surface:settings.rcAsrOssRequired')
    expect(asrFieldsError({ ...scalarsOnly, oss: { ...scalarsOnly.oss, region: 'r', bucket: 'b', accessKeyId: 'ak', accessKeySecret: 'sk' } }, t)).toBeNull()
    // 标量填一半 → 通用 incomplete 文案
    expect(asrFieldsError({ ...emptyAsrFields(), model: 'm' }, t)).toBe('surface:configGate.embeddingIncomplete')
  })

  it('validation: openai-compatible engine requires only a http(s) baseUrl', () => {
    const t = (key: string) => key
    const selfHosted = { ...emptyAsrFields(), provider: 'openai-compatible' }
    expect(asrFieldsError(selfHosted, t)).toBeNull()
    // 想配自建引擎但没填地址 → incomplete
    expect(asrFieldsError({ ...selfHosted, model: 'whisper-1' }, t)).toBe('surface:configGate.embeddingIncomplete')
    expect(asrFieldsError({ ...selfHosted, language: 'zh' }, t)).toBe('surface:configGate.embeddingIncomplete')
    expect(asrFieldsError({ ...selfHosted, baseUrl: 'http://127.0.0.1:9000' }, t)).toBeNull()
    expect(asrFieldsError({ ...selfHosted, baseUrl: '127.0.0.1:9000' }, t)).toBe('surface:settings.rcAsrUrlInvalid')
  })

  it('历史污染数据自愈：未填全的 asr/lite/embedding 落库时清空', () => {
    const t = (key: string) => key
    const polluted = buildUserConfig(snapshot(), {
      // 阿里云半填：model 有、baseUrl/apiKey 空（旧表单默认值预填时代的遗留）
      asr: { ...emptyAsrFields(), model: 'qwen-audio-3.0-asr-flash-filetrans' },
      // lite 只填了连接没填 model
      lite: { provider: 'openai-compatible', model: '', baseUrl: 'https://api.example.com/v1', apiKey: 'sk' },
      // embedding 半填
      embedding: { provider: 'openai-compatible', model: 'text-embedding-v4', baseUrl: '', apiKey: '' },
    }) as { asr: Record<string, unknown>; lite: Record<string, string>; knowledge: { embedding: Record<string, string> } }
    expect(polluted.asr.model).toBe('')
    expect(polluted.asr.baseUrl).toBe('')
    expect(polluted.lite.baseUrl).toBe('')
    expect(polluted.knowledge.embedding.model).toBe('')
    expect(asrFieldsIncomplete({ ...emptyAsrFields(), model: 'x' })).toBe(true)
    expect(liteFieldsIncomplete({ provider: 'openai-compatible', model: '', baseUrl: 'https://x', apiKey: 'sk' })).toBe(true)
  })
})

describe('runtime config form state — shared ai fields', () => {
  it('aiFieldsError: all-or-nothing per section', () => {
    const t = (key: string) => key
    expect(aiFieldsError({ provider: 'p', model: '', baseUrl: '', apiKey: '' }, t)).toBeNull()
    expect(aiFieldsError({ provider: 'p', model: 'm', baseUrl: '', apiKey: '' }, t)).toBe('surface:configGate.embeddingIncomplete')
    expect(aiFieldsError(ai('m'), t)).toBeNull()
  })

  it('embedding seeding unchanged after the move to the shared module', () => {
    expect(embeddingFieldsFromSnapshot(snapshot({
      knowledge: { embedding: { provider: 'qwen', model: 'v4', baseUrl: 'u', apiKey: 'k' } },
    }))).toEqual({ provider: 'qwen', model: 'v4', baseUrl: 'u', apiKey: 'k' })
  })
})
