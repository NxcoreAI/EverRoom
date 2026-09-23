import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalAgentDiscovery, isSafeLocalAgentPath, probeLocalAgentAcpAdapter } from './discovery'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'everroom-local-agents-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('local agent discovery', () => {
  it('verifies executables from PATH without a shell and reports history separately', async () => {
    const root = await temporaryRoot()
    const bin = join(root, 'bin')
    const home = join(root, 'home')
    await mkdir(bin, { recursive: true })
    await mkdir(join(home, '.claude'), { recursive: true })
    const codex = join(bin, 'codex')
    const openclaw = join(bin, 'openclaw')
    await writeFile(codex, '#!/bin/sh\nprintf "codex-cli 9.9.9\\n"\n', 'utf8')
    await writeFile(openclaw, '#!/bin/sh\nprintf "OpenClaw 2026.7.1\\n"\n', 'utf8')
    await chmod(codex, 0o755)
    await chmod(openclaw, 0o755)

    const discovery = createLocalAgentDiscovery({
      env: { PATH: [bin, '/usr/bin', '/bin'].join(delimiter) },
      home,
      platform: 'darwin',
      now: () => new Date('2026-08-26T00:00:00.000Z'),
      resolveLoginShellPath: false,
    })
    const agents = await discovery.scan()

    expect(agents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'codex',
        executablePath: codex,
        version: 'codex-cli 9.9.9',
        callable: true,
        invocationSupported: true,
        status: 'verified',
      }),
      expect.objectContaining({
        provider: 'claude',
        executablePath: null,
        callable: false,
        historyAvailable: true,
        status: 'history_available',
      }),
      expect.objectContaining({
        provider: 'openclaw',
        executablePath: openclaw,
        version: 'OpenClaw 2026.7.1',
        callable: true,
        invocationSupported: true,
        status: 'verified',
      }),
    ]))
    expect(agents.some((agent) => agent.provider === 'opencode')).toBe(false)
  })

  it('does not mark a failing version probe as callable', async () => {
    const root = await temporaryRoot()
    const bin = join(root, 'bin')
    await mkdir(bin, { recursive: true })
    const opencode = join(bin, 'opencode')
    await writeFile(opencode, '#!/bin/sh\nexit 7\n', 'utf8')
    await chmod(opencode, 0o755)

    const agents = await createLocalAgentDiscovery({ env: { PATH: bin }, home: join(root, 'home'), resolveLoginShellPath: false }).scan()
    expect(agents).toEqual([])
  })
})

describe('probeLocalAgentAcpAdapter', () => {
  // platform 用 win32 隔离：不追加 darwin/linux 的系统默认目录，也不跑登录 shell 探测。
  it('reports the adapter as installed when the adapter binary is on PATH', async () => {
    const root = await temporaryRoot()
    const bin = join(root, 'bin')
    await mkdir(bin, { recursive: true })
    const adapter = join(bin, 'codex-acp')
    await writeFile(adapter, '#!/bin/sh\n', 'utf8')
    await chmod(adapter, 0o755)

    const result = await probeLocalAgentAcpAdapter(
      { provider: 'codex', executablePath: join(bin, 'codex'), callable: true },
      { env: { PATH: bin }, home: join(root, 'home'), platform: 'win32' },
    )
    expect(result).toEqual({
      command: 'codex-acp',
      installed: true,
      installCommand: 'npm install -g @agentclientprotocol/codex-acp',
    })
  })

  it('reports a missing adapter with the claude install command', async () => {
    const root = await temporaryRoot()
    const result = await probeLocalAgentAcpAdapter(
      { provider: 'claude', executablePath: '/usr/local/bin/claude', callable: true },
      { env: { PATH: '/usr/bin:/bin' }, home: join(root, 'home'), platform: 'win32' },
    )
    expect(result.command).toBe('claude-agent-acp')
    expect(result.installed).toBe(false)
    expect(result.installCommand).toBe('npm install -g @zed-industries/claude-agent-acp')
  })

  it('falls back to the legacy claude bin name', async () => {
    const root = await temporaryRoot()
    const bin = join(root, 'bin')
    await mkdir(bin, { recursive: true })
    const legacy = join(bin, 'claude-code-acp')
    await writeFile(legacy, '#!/bin/sh\n', 'utf8')
    await chmod(legacy, 0o755)

    const result = await probeLocalAgentAcpAdapter(
      { provider: 'claude', executablePath: join(bin, 'claude'), callable: true },
      { env: { PATH: bin }, home: join(root, 'home'), platform: 'win32' },
    )
    expect(result).toEqual({
      command: 'claude-code-acp',
      installed: true,
      installCommand: 'npm install -g @zed-industries/claude-agent-acp',
    })
  })

  it('reports privately installed adapters after PATH misses', async () => {
    const root = await temporaryRoot()
    const adaptersRoot = join(root, 'adapters')
    const pkgDir = join(adaptersRoot, 'claude', 'node_modules', '@zed-industries', 'claude-agent-acp')
    await mkdir(pkgDir, { recursive: true })
    const entry = join(pkgDir, 'bin', 'claude-agent-acp.js')
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(entry, '#!/usr/bin/env node\n', 'utf8')
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@zed-industries/claude-agent-acp',
      version: '0.23.1',
      bin: { 'claude-agent-acp': 'bin/claude-agent-acp.js' },
    }), 'utf8')

    const result = await probeLocalAgentAcpAdapter(
      { provider: 'claude', executablePath: '/usr/local/bin/claude', callable: true },
      { env: { PATH: '/usr/bin:/bin' }, home: join(root, 'home'), platform: 'win32', adaptersRoot },
    )
    expect(result.installed).toBe(true)
    expect(result.command).toBe(entry)

    const withoutRoot = await probeLocalAgentAcpAdapter(
      { provider: 'claude', executablePath: '/usr/local/bin/claude', callable: true },
      { env: { PATH: '/usr/bin:/bin' }, home: join(root, 'home'), platform: 'win32' },
    )
    expect(withoutRoot.installed).toBe(false)
  })

  it('treats openclaw as always installed and honors adapter command overrides', async () => {
    const root = await temporaryRoot()
    const openclaw = await probeLocalAgentAcpAdapter(
      { provider: 'openclaw', executablePath: '/opt/openclaw/bin/openclaw', callable: true },
      { env: { PATH: '/usr/bin:/bin' }, home: join(root, 'home'), platform: 'win32' },
    )
    expect(openclaw).toEqual({ command: '/opt/openclaw/bin/openclaw', installed: true, installCommand: null })

    const overridden = await probeLocalAgentAcpAdapter(
      { provider: 'claude', executablePath: '/usr/bin/claude', callable: true },
      {
        env: { PATH: '/usr/bin:/bin', EVERROOM_ACP_COMMAND_CLAUDE: '/opt/adapters/claude-acp --verbose' },
        home: join(root, 'home'),
        platform: 'win32',
      },
    )
    expect(overridden.command).toBe('/opt/adapters/claude-acp')
    expect(overridden.installed).toBe(false)
    expect(overridden.installCommand).toBeNull()
  })
})

describe('isSafeLocalAgentPath', () => {
  it('rejects empty, root, and null-containing paths', () => {
    expect(isSafeLocalAgentPath('/usr/local/bin/codex')).toBe(true)
    expect(isSafeLocalAgentPath('')).toBe(false)
    expect(isSafeLocalAgentPath('/')).toBe(false)
    expect(isSafeLocalAgentPath('/tmp/codex\0bad')).toBe(false)
  })
})
