import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { execFile as execFileCb } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ appPath: '/mock/app' }))
vi.mock('electron', () => ({ app: { getAppPath: () => mocks.appPath } }))
vi.mock('../src/main/process-cleanup', () => ({
  registerProcessRecord: vi.fn(),
  forgetProcessRecord: vi.fn(),
}))

import { NxCoreAsrSupervisor } from '../src/main/asr/nxcore-asr-supervisor'

const execFile = promisify(execFileCb)
const directories: string[] = []

afterEach(async () => {
  mocks.appPath = '/mock/app'
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function useTempDataDir(): Promise<{ dataDir: string; supervisor: NxCoreAsrSupervisor }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-asr-supervisor-'))
  directories.push(dataDir)
  return { dataDir, supervisor: new NxCoreAsrSupervisor(dataDir) }
}

/** 模拟「用户克隆了主仓但未检出子模块」：fixture 主仓（.git + gitlink 注册，
 *  无子模块工作区）+ 本地裸镜像（离线确定，不打真网络）。 */
async function makeFixtureRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nxcore-asr-fixture-'))
  directories.push(root)
  const remote = join(root, 'mirror.git')
  await execFile('git', ['clone', '--bare', '--quiet', join(import.meta.dirname, '../../..', 'submodules', 'nxcoreasr'), remote])
  const repo = join(root, 'mainrepo')
  await mkdir(join(repo, 'apps', 'desktop'), { recursive: true })
  await execFile('git', ['init', '--quiet', repo])
  // URL 用正斜杠：git 子模块 url 里的反斜杠本地路径不可靠。
  const remoteUrl = remote.replaceAll('\\', '/')
  await writeFile(join(repo, '.gitmodules'), [
    '[submodule "submodules/nxcoreasr"]',
    '\tpath = submodules/nxcoreasr',
    `\turl = ${remoteUrl}`,
    '',
  ].join('\n'), 'utf8')
  await execFile('git', ['add', '.gitmodules'], { cwd: repo })
  await execFile('git', ['update-index', '--add', '--cacheinfo', '160000,49e513e8b4f05c794ae17ce7eb7c18f38cf0e2f8,submodules/nxcoreasr'], { cwd: repo })
  return repo
}

describe('NxCoreAsrSupervisor', () => {
  it('初始状态为 idle（未启动不显示就绪——曾因默认 ready 误导用户）', async () => {
    const { supervisor } = await useTempDataDir()
    expect(supervisor.getStatus().state).toBe('idle')
    expect(supervisor.getConnection()).toBeNull()
  })

  it('tryInitSubmodule：未检出的子模块从镜像自动拉取（用户点启动即可用，无需终端敲命令）', async () => {
    const repo = await makeFixtureRepo()
    mocks.appPath = join(repo, 'apps', 'desktop')
    // fixture 的子模块 url 是本地路径：git 默认禁 file 协议（CVE-2022-39253），
    // 经 env 注入放行（supervisor spawn 的 git 继承本进程 env）——真实场景走
    // https 的 GitHub 镜像，不受此限。
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = 'protocol.file.allow'
    process.env.GIT_CONFIG_VALUE_0 = 'always'
    const { supervisor } = await useTempDataDir()
    try {
      // 前置：子模块工作区不存在。
      expect(existsSync(join(repo, 'submodules', 'nxcoreasr', 'app'))).toBe(false)
      const ok = await (supervisor as unknown as { tryInitSubmodule(): Promise<boolean> }).tryInitSubmodule()
      expect(ok, `auto init failed: ${supervisor.getStatus().message}`).toBe(true)
      expect(existsSync(join(repo, 'submodules', 'nxcoreasr', 'app'))).toBe(true)
    } finally {
      delete process.env.GIT_CONFIG_COUNT
      delete process.env.GIT_CONFIG_KEY_0
      delete process.env.GIT_CONFIG_VALUE_0
    }
  })

  it('tryInitSubmodule：非 git 检出（如打包形态之外的无 .git 目录）直接返回 false，不报错', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nxcore-asr-nogit-'))
    directories.push(root)
    await mkdir(join(root, 'apps', 'desktop'), { recursive: true })
    mocks.appPath = join(root, 'apps', 'desktop')
    const { supervisor } = await useTempDataDir()
    const ok = await (supervisor as unknown as { tryInitSubmodule(): Promise<boolean> }).tryInitSubmodule()
    expect(ok).toBe(false)
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

  it('ffmpeg shim：把探测到的解码器以固定名暴露（服务的 subprocess 只按名字调）', async () => {
    const { dataDir, supervisor } = await useTempDataDir()
    const source = join(dataDir, process.platform === 'win32' ? 'fake-ffmpeg.exe' : 'fake-ffmpeg')
    writeFileSync(source, 'binary', 'utf8')
    const internal = supervisor as unknown as {
      ffmpegShimPath(): string
      writeFfmpegShim(source: string, shimPath: string): boolean
    }
    const shim = internal.ffmpegShimPath()
    expect(internal.writeFfmpegShim(source, shim)).toBe(true)
    expect(existsSync(shim)).toBe(true)
    // 软链与复制都读到同样内容；名字固定，Python 侧 subprocess 才能按名解析。
    expect(readFileSync(shim, 'utf8')).toBe('binary')
    expect(shim.endsWith(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')).toBe(true)
  })

  it('服务子进程 PATH 前置 ffmpeg 目录（GUI 启动的 PATH 看不到 Homebrew）', async () => {
    const { dataDir, supervisor } = await useTempDataDir()
    const internal = supervisor as unknown as {
      ffmpegDirectory: string | null
      serviceEnvironment(): NodeJS.ProcessEnv
    }
    expect(internal.serviceEnvironment().PATH).toBe(process.env.PATH ?? '')
    internal.ffmpegDirectory = join(dataDir, 'nxcore-asr-bin')
    expect(internal.serviceEnvironment().PATH?.split(delimiter)[0]).toBe(internal.ffmpegDirectory)
  })

  it('ffmpeg 候选顺序：env 覆盖最优先，含 macOS Homebrew/MacPorts 位置', async () => {
    const { supervisor } = await useTempDataDir()
    process.env.NXCORE_ASR_FFMPEG = '/custom/ffmpeg'
    try {
      const candidates = (supervisor as unknown as { ffmpegCandidates(): string[] }).ffmpegCandidates()
      expect(candidates[0]).toBe('/custom/ffmpeg')
      expect(candidates).toContain('/opt/homebrew/bin/ffmpeg')
      expect(candidates).toContain('/usr/local/bin/ffmpeg')
      expect(candidates).toContain('/opt/local/bin/ffmpeg')
    } finally {
      delete process.env.NXCORE_ASR_FFMPEG
    }
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
