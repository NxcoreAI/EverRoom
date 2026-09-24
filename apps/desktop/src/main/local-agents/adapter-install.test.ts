import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installLocalAgentAcpAdapter, resolveLocalAcpAdapterSpawn } from './adapter-install'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'everroom-adapter-install-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const CLAUDE_INSTALLATION = {
  id: 'agent-claude',
  provider: 'claude' as const,
  executablePath: '/usr/local/bin/claude',
  callable: true,
}

/**
 * 假 npm-cli.js：node 跑起来后从 argv 取 --prefix，在对应目录落
 * node_modules/<pkg>/{package.json,bin 入口}。registryGate 控制首次
 * （默认 registry）失败、镜像重试成功——验证 failover。
 */
function fakeNpmCliScript(pkg: string, binRel: string, registryGate: boolean): string {
  return [
    'const { mkdirSync, writeFileSync } = require("node:fs")',
    'const argv = process.argv.slice(2)',
    'const prefixIndex = argv.indexOf("--prefix")',
    'const prefix = argv[prefixIndex + 1]',
    'if (!prefix) process.exit(64)',
    `if (${JSON.stringify(registryGate)} && !process.env.npm_config_registry) process.exit(1)`,
    `const pkgDir = require("node:path").join(prefix, "node_modules", ${JSON.stringify(pkg)})`,
    'mkdirSync(require("node:path").dirname(require("node:path").join(pkgDir, "package.json")), { recursive: true })',
    'writeFileSync(require("node:path").join(pkgDir, "package.json"), JSON.stringify({',
    `  name: ${JSON.stringify(pkg)},`,
    '  version: "9.9.9",',
    `  bin: { "claude-agent-acp": ${JSON.stringify(binRel)} },`,
    '}))',
    `mkdirSync(require("node:path").dirname(require("node:path").join(pkgDir, ${JSON.stringify(binRel)})), { recursive: true })`,
    `writeFileSync(require("node:path").join(pkgDir, ${JSON.stringify(binRel)}), "#!/usr/bin/env node\\n")`,
    'process.exit(0)',
  ].join('\n')
}

async function writeFakeNpmCli(pkg: string, binRel: string, registryGate: boolean): Promise<string> {
  const root = await temporaryRoot()
  const npmCli = join(root, 'npm-cli.js')
  await writeFile(npmCli, fakeNpmCliScript(pkg, binRel, registryGate), 'utf8')
  return npmCli
}

// win32：探测无系统默认目录、不跑登录 shell，PATH 即全部搜索面，隔离宿主机器。
const INSTALL_BASE = { env: { PATH: `/usr/bin:/bin` }, platform: 'win32' as const, probeTimeoutMs: 1 }

describe('installLocalAgentAcpAdapter', () => {
  it('installs into the private prefix and reports the adapter as installed', async () => {
    const root = await temporaryRoot()
    const adaptersRoot = join(root, 'adapters')
    const npmCli = await writeFakeNpmCli('@zed-industries/claude-agent-acp', 'bin/claude-agent-acp.js', false)

    const result = await installLocalAgentAcpAdapter(CLAUDE_INSTALLATION, {
      adaptersRoot,
      npmCliPath: npmCli,
      ...INSTALL_BASE,
      home: join(root, 'home'),
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe('installed')
    expect(result.adapter.installed).toBe(true)
    expect(result.adapter.command).toBe(
      join(adaptersRoot, 'claude', 'node_modules', '@zed-industries', 'claude-agent-acp', 'bin', 'claude-agent-acp.js'),
    )
  })

  it('retries through the npm mirror when the default registry fails', async () => {
    const root = await temporaryRoot()
    const adaptersRoot = join(root, 'adapters')
    const npmCli = await writeFakeNpmCli('@zed-industries/claude-agent-acp', 'bin/claude-agent-acp.js', true)

    const result = await installLocalAgentAcpAdapter(CLAUDE_INSTALLATION, {
      adaptersRoot,
      npmCliPath: npmCli,
      ...INSTALL_BASE,
      home: join(root, 'home'),
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe('installed')
  })

  it('returns not_needed when the adapter is already installed', async () => {
    const root = await temporaryRoot()
    const adaptersRoot = join(root, 'adapters')
    const pkgDir = join(adaptersRoot, 'claude', 'node_modules', '@zed-industries', 'claude-agent-acp')
    await mkdir(join(pkgDir, 'bin'), { recursive: true })
    await writeFile(join(pkgDir, 'bin', 'claude-agent-acp.js'), '#!/usr/bin/env node\n', 'utf8')
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@zed-industries/claude-agent-acp',
      version: '0.23.1',
      bin: { 'claude-agent-acp': 'bin/claude-agent-acp.js' },
    }), 'utf8')

    const result = await installLocalAgentAcpAdapter(CLAUDE_INSTALLATION, {
      adaptersRoot,
      npmCliPath: '/nonexistent/npm-cli.js',
      ...INSTALL_BASE,
      home: join(root, 'home'),
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe('not_needed')
  })

  it('fails with npm_cli_missing when the bundled npm is unavailable', async () => {
    const root = await temporaryRoot()
    const result = await installLocalAgentAcpAdapter(CLAUDE_INSTALLATION, {
      adaptersRoot: join(root, 'adapters'),
      npmCliPath: null,
      ...INSTALL_BASE,
      home: join(root, 'home'),
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe('failed')
    expect(result.error).toBe('npm_cli_missing')
  })

  it('fails with install output when every registry attempt fails', async () => {
    const root = await temporaryRoot()
    const npmCli = join(root, 'npm-cli.js')
    await writeFile(npmCli, 'process.stderr.write("registry unreachable")\nprocess.exit(1)\n', 'utf8')

    const result = await installLocalAgentAcpAdapter(CLAUDE_INSTALLATION, {
      adaptersRoot: join(root, 'adapters'),
      npmCliPath: npmCli,
      ...INSTALL_BASE,
      home: join(root, 'home'),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('npm_install_failed')
    expect(result.log).toContain('registry unreachable')
  })
})

describe('resolveLocalAcpAdapterSpawn', () => {
  it('prefers an adapter resolved from the login PATH as an absolute command', async () => {
    const root = await temporaryRoot()
    const bin = join(root, 'bin')
    await mkdir(bin, { recursive: true })
    const adapter = join(bin, 'codex-acp')
    await writeFile(adapter, '#!/bin/sh\n', 'utf8')
    await chmod(adapter, 0o755)

    const spawn = await resolveLocalAcpAdapterSpawn(
      { provider: 'codex', executablePath: join(bin, 'codex'), callable: true },
      { adaptersRoot: join(root, 'adapters'), env: { PATH: bin }, home: join(root, 'home'), platform: 'win32', probeTimeoutMs: 1 },
    )
    expect(spawn?.command).toBe(await realpath(adapter))
    expect(spawn?.args).toEqual([])
    expect((spawn?.env?.PATH ?? '').split(delimiter)).toContain(bin)
  })

  it('runs a privately installed adapter through the runtime with ELECTRON_RUN_AS_NODE', async () => {
    const root = await temporaryRoot()
    const adaptersRoot = join(root, 'adapters')
    const pkgDir = join(adaptersRoot, 'claude', 'node_modules', '@zed-industries', 'claude-agent-acp')
    await mkdir(dirname(join(pkgDir, 'bin', 'x')), { recursive: true })
    const entry = join(pkgDir, 'bin', 'claude-agent-acp.js')
    await writeFile(entry, '#!/usr/bin/env node\n', 'utf8')
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@zed-industries/claude-agent-acp',
      version: '0.23.1',
      bin: { 'claude-agent-acp': 'bin/claude-agent-acp.js' },
    }), 'utf8')

    const spawn = await resolveLocalAcpAdapterSpawn(CLAUDE_INSTALLATION, {
      adaptersRoot,
      env: { PATH: '/usr/bin:/bin' },
      home: join(root, 'home'),
      platform: 'win32',
      probeTimeoutMs: 1,
    })
    expect(spawn?.command).toBe(process.execPath)
    expect(spawn?.args).toEqual([entry])
    expect(spawn?.env?.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('returns null when no adapter is available anywhere', async () => {
    const root = await temporaryRoot()
    // win32：无 darwin/linux 系统默认目录、不跑登录 shell，PATH 即全部搜索面。
    const spawn = await resolveLocalAcpAdapterSpawn(CLAUDE_INSTALLATION, {
      adaptersRoot: join(root, 'adapters'),
      env: { PATH: '/usr/bin:/bin' },
      home: join(root, 'home'),
      platform: 'win32',
      probeTimeoutMs: 1,
    })
    expect(spawn).toBeNull()
  })
})
