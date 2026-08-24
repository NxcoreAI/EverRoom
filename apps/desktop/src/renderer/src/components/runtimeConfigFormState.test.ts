import { describe, expect, it } from 'vitest'

import type { RuntimeConfigSnapshot } from '../../../shared/sources'

import {
  asrFieldsError,
  asrFieldsFromSnapshot,
  aiFieldsError,
  buildUserConfig,
  embeddingFieldsFromSnapshot,
  emptyAsrFields,
  vlmFieldsFromSnapshot,
  type ManualAiConfigFields,
} from './runtimeConfigFormState'

function snapshot(config: Record<string, unknown> = {}): RuntimeConfigSnapshot {
  return {
    config,
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
      oss: { region: 'oss-cn-beijing', bucket: 'b', accessKeyId: 'ak', accessKeySecret: '', stsToken: '', prefix: 'nxcore-asr' },
    })
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
