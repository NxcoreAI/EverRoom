import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { writeMemoryCoreGatewayConfig } from '../src/main/memory/memory-core-config'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ))
})

describe('MemoryCore 调度参数下发（状态/参考分流第 2 层）', () => {
  it('写 tdai-gateway.yaml 到 dataDir，重复下发幂等覆写', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nxcore-memory-cfg-'))
    directories.push(dir)

    const firstPath = await writeMemoryCoreGatewayConfig(dir)
    expect(firstPath).toBe(join(dir, 'tdai-gateway.yaml'))
    await writeMemoryCoreGatewayConfig(dir)

    const content = await readFile(join(dir, 'tdai-gateway.yaml'), 'utf8')
    expect(content).toContain('memory:')
    expect(content).toContain('pipeline:')
    expect(content).toContain('everyNConversations: 8')
  })

  it('只写 pipeline 调度键，不碰 env 已接管的 llm/embedding/server 配置', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nxcore-memory-cfg-'))
    directories.push(dir)
    await writeMemoryCoreGatewayConfig(dir)

    const content = await readFile(join(dir, 'tdai-gateway.yaml'), 'utf8')
    expect(content).not.toContain('llm')
    expect(content).not.toContain('embedding')
    expect(content).not.toContain('server')
    expect(content).not.toContain('apiKey')
  })
})
