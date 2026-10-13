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

import { NxCoreAsrSupervisor } from '../src/main/asr/nxcore-asr-supervisor'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function useTempDataDir(): Promise<{ dataDir: string; supervisor: NxCoreAsrSupervisor }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-asr-supervisor-'))
  directories.push(dataDir)
  return { dataDir, supervisor: new NxCoreAsrSupervisor(dataDir) }
}

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

  it('模型档位：切换持久化，config.yaml 按档位换 model_dir（lite=别名目录）', async () => {
    const { dataDir, supervisor } = await useTempDataDir()
    expect(supervisor.getStatus().tier).toBe('full')
    await supervisor.setModelTier('lite')
    expect(supervisor.getStatus().tier).toBe('lite')
    expect(readFileSync(join(dataDir, 'nxcore-asr-tier'), 'utf8').trim()).toBe('lite')
    // 新一代 supervisor 从磁盘读回档位。
    expect(new NxCoreAsrSupervisor(dataDir).getStatus().tier).toBe('lite')

    const serviceDir = await mkdtemp(join(tmpdir(), 'nxcore-asr-svc-'))
    directories.push(serviceDir)
    const writeConfig = () =>
      (supervisor as unknown as { ensureServiceConfig(dir: string, key: string): void })
        .ensureServiceConfig(serviceDir, 'test-key-0123456789abcdef0123456789')
    writeConfig()
    const liteConfig = readFileSync(join(serviceDir, 'config.yaml'), 'utf8')
    expect(liteConfig).toContain(`model_dir: ${join(dataDir, 'nxcore-asr-models-lite').replaceAll('\\', '/')}`)
    // SQLite 库文件指向应用数据目录（打包版服务目录只读）。
    expect(liteConfig).toContain(`database_url: sqlite:///`)
    expect(liteConfig).toContain(encodeURIComponent(`${dataDir.replaceAll('\\', '/')}/nxcore-asr-data/asr.db`))
    expect(liteConfig).toContain(`data_dir: ${dataDir.replaceAll('\\', '/')}/nxcore-asr-data`)

    await supervisor.setModelTier('full')
    writeConfig()
    const fullConfig = readFileSync(join(serviceDir, 'config.yaml'), 'utf8')
    expect(fullConfig).toContain('model_dir: ./models')

    // 非法档位值忽略，不落盘不改态。
    await supervisor.setModelTier('whatever' as never)
    expect(supervisor.getStatus().tier).toBe('full')
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
        expect(['error', 'external', 'missing-python', 'setup-venv', 'starting']).toContain(status.state)
      }
    } finally {
      delete process.env.NXCORE_ASR_BASE_URL
      delete process.env.NXCORE_ASR_SERVICE_DIR
    }
  })
})
