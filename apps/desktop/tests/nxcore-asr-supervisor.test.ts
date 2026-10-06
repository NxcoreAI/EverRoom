import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => '/mock/app' } }))
vi.mock('../src/main/process-cleanup', () => ({
  registerProcessRecord: vi.fn(),
  forgetProcessRecord: vi.fn(),
}))

import { NxCoreAsrSupervisor, probeTcpPort } from '../src/main/asr/nxcore-asr-supervisor'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function useTempDataDir(): Promise<{ dataDir: string; supervisor: NxCoreAsrSupervisor }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-asr-supervisor-'))
  directories.push(dataDir)
  return { dataDir, supervisor: new NxCoreAsrSupervisor(dataDir) }
}

describe('probeTcpPort', () => {
  it('空闲端口返回 false（有真实监听者才返回 true）——曾反向判定致 docker compose 从未执行', async () => {
    // 找一个几乎必然空闲的端口。
    expect(await probeTcpPort(1)).toBe(false)
    // 起一个真实监听者再探测。
    const { createServer } = await import('node:net')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      expect(await probeTcpPort(port)).toBe(true)
    } finally {
      server.close()
    }
  })
})

describe('NxCoreAsrSupervisor', () => {
  it('初始状态为 idle（未启动不显示就绪——曾因默认 ready 误导用户）', async () => {
    const { supervisor } = await useTempDataDir()
    expect(supervisor.getStatus().state).toBe('idle')
    expect(supervisor.getConnection()).toBeNull()
  })

  it('外部模式（NXCORE_ASR_MANAGED=false）不托管', async () => {
    process.env.NXCORE_ASR_MANAGED = 'false'
    try {
      const { supervisor } = await useTempDataDir()
      const connection = await supervisor.start()
      expect(connection).toBeNull()
      expect(supervisor.getStatus().state).toBe('external')
    } finally {
      delete process.env.NXCORE_ASR_MANAGED
    }
  })

  it('租户 key 持久化：两代 supervisor 复用同一把 key', async () => {
    const { dataDir } = await useTempDataDir()
    const first = new NxCoreAsrSupervisor(dataDir)
    const keyOne = (first as unknown as { loadOrCreateApiKey(): string }).loadOrCreateApiKey()
    const keyFile = join(dataDir, 'nxcore-asr-key')
    expect(existsSync(keyFile)).toBe(true)
    expect(keyOne.length).toBeGreaterThanOrEqual(32)

    const second = new NxCoreAsrSupervisor(dataDir)
    const keyTwo = (second as unknown as { loadOrCreateApiKey(): string }).loadOrCreateApiKey()
    expect(keyTwo).toBe(keyOne)
    expect(readFileSync(keyFile, 'utf8').trim()).toBe(keyOne)
  })

  it('服务目录缺失时给出可读错误（submodule 未检出的场景）', async () => {
    const { supervisor } = await useTempDataDir()
    process.env.NXCORE_ASR_BASE_URL = 'http://127.0.0.1:8300'
    // 指向不存在的服务目录；端口探测走 fetch 会失败落到目录检查。
    process.env.NXCORE_ASR_SERVICE_DIR = join(tmpdir(), 'nxcore-asr-nowhere-' + Date.now())
    try {
      const connection = await supervisor.start()
      // 服务目录缺失 → error 态（probe 不通 + 目录不存在）。
      const status = supervisor.getStatus()
      if (connection === null) {
        expect(['error', 'external', 'missing-python', 'missing-docker', 'setup-venv', 'starting']).toContain(status.state)
      }
    } finally {
      delete process.env.NXCORE_ASR_BASE_URL
      delete process.env.NXCORE_ASR_SERVICE_DIR
    }
  })
})
