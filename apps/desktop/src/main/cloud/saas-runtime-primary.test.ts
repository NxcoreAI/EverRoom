import { describe, expect, it } from 'vitest'

import type { SaasRuntimeConfig } from './saas-client'
import { saasRuntimePrimaryPresent } from './saas-client'

function configWith(primary: unknown): SaasRuntimeConfig['config'] {
  return { schemaVersion: 1, primary } as SaasRuntimeConfig['config']
}

describe('saasRuntimePrimaryPresent（#225：空 primary 不得覆盖可用本地配置）', () => {
  it('primary 缺失 / 非对象 / 空串占位 → 未下发', () => {
    expect(saasRuntimePrimaryPresent(undefined)).toBe(false)
    expect(saasRuntimePrimaryPresent(configWith(undefined))).toBe(false)
    expect(saasRuntimePrimaryPresent({ schemaVersion: 1 })).toBe(false)
    expect(saasRuntimePrimaryPresent(configWith({ model: '', baseUrl: '', apiKey: '', provider: '' }))).toBe(false)
    expect(saasRuntimePrimaryPresent(configWith(['not-an-object']))).toBe(false)
  })

  it('model 与 baseUrl 非空即视为实质下发（apiKey 可缺省，由 relay 注入）', () => {
    expect(saasRuntimePrimaryPresent(configWith({ model: 'glm-4-flash', baseUrl: 'https://relay.example/v1' }))).toBe(true)
    expect(saasRuntimePrimaryPresent(configWith({ model: ' glm-4-flash ', baseUrl: ' https://relay.example/v1 ', apiKey: '' }))).toBe(true)
  })

  it('model 或 baseUrl 任一为空/非字符串 → 未下发', () => {
    expect(saasRuntimePrimaryPresent(configWith({ model: 'glm-4-flash', baseUrl: '' }))).toBe(false)
    expect(saasRuntimePrimaryPresent(configWith({ model: '', baseUrl: 'https://relay.example/v1' }))).toBe(false)
    expect(saasRuntimePrimaryPresent(configWith({ model: 1, baseUrl: 'https://relay.example/v1' }))).toBe(false)
  })
})
