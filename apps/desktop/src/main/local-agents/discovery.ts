import { access, constants, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import {
  localAcpAdapterCommand,
  localAcpAdapterInstallPackage,
  type LocalAgentAcpAdapterInfo,
  type LocalAgentProvider,
  type LocalAcpProvider,
} from '@nxcore/agent-contract'
import type {
  LocalAgentCard,
  LocalAgentInstallation,
  LocalAgentStatus,
} from '../../shared/local-agents'

const ACP_PROVIDERS = new Set<LocalAgentProvider>(['codex', 'claude', 'openclaw'])

const PROVIDERS: Array<{ provider: LocalAgentProvider; names: string[]; label: string; historyPaths: string[] }> = [
  { provider: 'codex', names: ['codex'], label: 'Codex', historyPaths: ['.codex'] },
  { provider: 'claude', names: ['claude'], label: 'Claude Code', historyPaths: ['.claude'] },
  { provider: 'openclaw', names: ['openclaw'], label: 'OpenClaw', historyPaths: ['.openclaw'] },
  { provider: 'opencode', names: ['opencode'], label: 'OpenCode', historyPaths: ['.config/opencode', '.opencode'] },
]

export interface LocalAgentDiscoveryOptions {
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
  now?: () => Date
  probeTimeoutMs?: number
  resolveLoginShellPath?: boolean
  /** app 私有适配器安装目录（一键安装落点）；探测时作为 PATH 之后的兜底。 */
  adaptersRoot?: string
}

function loginShellPath(env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string | null> {
  const shell = env.SHELL
  if (!shell || !shell.startsWith('/') || !['zsh', 'bash'].includes(shell.split('/').at(-1) ?? '')) {
    return Promise.resolve(null)
  }
  return new Promise((resolvePath) => {
    const child = spawn(shell, ['-ilc', 'printf "%s" "$PATH"'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    })
    let output = ''
    let settled = false
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePath(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(null)
    }, timeoutMs)
    timer.unref?.()
    child.stdout.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(0, 32_768) })
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 && output.trim() ? output.trim() : null))
  })
}

async function discoveryEnvironment(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
  resolveLoginPath: boolean,
  timeoutMs: number,
): Promise<NodeJS.ProcessEnv> {
  const loginPath = resolveLoginPath && platform !== 'win32' ? await loginShellPath(env, timeoutMs) : null
  const defaults = platform === 'darwin'
    ? ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local/bin')]
    : platform === 'win32' ? [] : ['/usr/local/bin', join(home, '.local/bin')]
  const combined = [loginPath, env.PATH, ...defaults].filter(Boolean).join(delimiter)
  return { ...env, PATH: [...new Set(combined.split(delimiter).filter(Boolean))].join(delimiter) }
}

/** 合并登录 shell PATH 后的完整搜索环境（适配器 spawn 覆盖构造用）。 */
export async function mergedDiscoveryEnvironment(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
  timeoutMs: number,
): Promise<NodeJS.ProcessEnv> {
  return discoveryEnvironment(env, home, platform, platform !== 'win32', timeoutMs)
}

/** 一键安装落到 app 私有目录的适配器（bin 入口 + 版本）。 */
export interface LocalAgentPrivateAdapterInstall {
  entry: string
  version: string | null
}

/**
 * 在 app 私有安装目录（`<adaptersRoot>/<provider>/node_modules/<pkg>`）里
 * 解析适配器的 JS 入口。npm 包的 bin 是 `#!/usr/bin/env node` 脚本——私有
 * 安装不落 PATH，由调用方用运行时承载（ELECTRON_RUN_AS_NODE）直接跑入口。
 */
export async function findPrivateAdapterInstall(
  adaptersRoot: string,
  provider: LocalAcpProvider,
): Promise<LocalAgentPrivateAdapterInstall | null> {
  const pkg = localAcpAdapterInstallPackage(provider)
  if (!pkg) return null
  const pkgDir = join(adaptersRoot, provider, 'node_modules', pkg)
  let manifest: { bin?: string | Record<string, string>; version?: string }
  try {
    manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
  const defaultBin = localAcpAdapterCommand(provider, '', {}).command
  const binField = manifest.bin
  const binRel = typeof binField === 'string'
    ? binField
    : (binField?.[defaultBin] ?? Object.values(binField ?? {})[0])
  if (!binRel) return null
  const entry = resolve(pkgDir, binRel)
  const pkgRoot = resolve(pkgDir)
  if (entry !== pkgRoot && !entry.startsWith(`${pkgRoot}${sep}`)) return null
  try {
    await access(entry, constants.R_OK)
  } catch {
    return null
  }
  return { entry, version: typeof manifest.version === 'string' ? manifest.version : null }
}

export interface LocalAgentDiscovery {
  scan(): Promise<LocalAgentInstallation[]>
}

function pathCandidates(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string[] {
  const suffixes = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  return (env.PATH ?? '').split(delimiter).filter(Boolean).flatMap((root) => suffixes.map((suffix) => join(root, `${name}${suffix}`)))
}

async function executablePath(env: NodeJS.ProcessEnv, names: string[], platform: NodeJS.Platform): Promise<string | null> {
  for (const name of names) {
    for (const candidate of pathCandidates(env, name, platform)) {
      try {
        await access(candidate, constants.X_OK)
        const info = await stat(candidate)
        if (info.isFile()) return resolve(candidate)
      } catch {
        // Keep probing the next PATH entry.
      }
    }
  }
  return null
}

async function commandAvailable(
  env: NodeJS.ProcessEnv,
  command: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (!command) return false
  if (command.includes('/') || isAbsolute(command)) {
    try {
      await access(command, constants.X_OK)
      const info = await stat(command)
      return info.isFile()
    } catch {
      return false
    }
  }
  return (await executablePath(env, [command], platform)) !== null
}

/** 解析命令名为可执行绝对路径；bare 名按 PATH（win32 含 .exe/.cmd 后缀）查找。 */
export async function resolveCommandPath(
  env: NodeJS.ProcessEnv,
  command: string,
  platform: NodeJS.Platform,
): Promise<string | null> {
  if (!command) return null
  if (command.includes('/') || isAbsolute(command)) {
    try {
      await access(command, constants.X_OK)
      const info = await stat(command)
      return info.isFile() ? resolve(command) : null
    } catch {
      return null
    }
  }
  return executablePath(env, [command], platform)
}

/**
 * 检测某个本机 Agent 的 ACP 适配器是否可用（安装向导用）。
 * 先用当前 PATH 快速探测，未命中再合并登录 shell PATH 复查——
 * 用户在终端 `npm i -g` 装完后无需重启应用即可被检出；
 * 最后看 app 私有安装目录（一键安装的落点，用户自装的优先）。
 */
export async function probeLocalAgentAcpAdapter(
  installation: Pick<LocalAgentInstallation, 'provider' | 'executablePath' | 'callable'>,
  options: Pick<LocalAgentDiscoveryOptions, 'env' | 'home' | 'platform' | 'probeTimeoutMs' | 'adaptersRoot'> = {},
): Promise<LocalAgentAcpAdapterInfo> {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  const probeTimeoutMs = options.probeTimeoutMs ?? 2_000
  if (!ACP_PROVIDERS.has(installation.provider)) {
    return { command: '', installed: true, installCommand: null }
  }
  const adapter = localAcpAdapterCommand(installation.provider as LocalAcpProvider, installation.executablePath ?? '', env)
  if (installation.provider === 'openclaw') {
    return { command: adapter.command, installed: Boolean(installation.executablePath), installCommand: null }
  }
  const candidates = [adapter.command, ...(adapter.fallbacks ?? [])]
  const anyInstalled = async (searchEnv: NodeJS.ProcessEnv): Promise<string | null> => {
    for (const candidate of candidates) {
      if (await commandAvailable(searchEnv, candidate, platform)) return candidate
    }
    return null
  }
  const hit = await anyInstalled(env)
  if (hit) return { command: hit, installed: true, installCommand: adapter.installCommand }
  const searchEnv = await discoveryEnvironment(env, home, platform, true, probeTimeoutMs)
  const recheck = await anyInstalled(searchEnv)
  if (recheck) return { command: recheck, installed: true, installCommand: adapter.installCommand }
  if (options.adaptersRoot !== undefined) {
    const privateInstall = await findPrivateAdapterInstall(options.adaptersRoot, installation.provider as LocalAcpProvider)
    if (privateInstall) {
      return { command: privateInstall.entry, installed: true, installCommand: adapter.installCommand }
    }
  }
  return { command: adapter.command, installed: false, installCommand: adapter.installCommand }
}

function runVersion(command: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<{ version: string | null; error?: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(command, ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: env.PATH ?? '' } })
    let output = ''
    let settled = false
    const finish = (result: { version: string | null; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ version: null, error: 'version_probe_timeout' })
    }, timeoutMs)
    timer.unref?.()
    child.stdout.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(0, 4_096) })
    child.stderr.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(0, 4_096) })
    child.on('error', (error) => finish({ version: null, error: error.message }))
    child.on('close', (code) => {
      const version = output.trim().split(/\r?\n/u)[0]?.slice(0, 200) || null
      finish(code === 0 ? { version } : { version, error: `version_probe_exit_${code ?? 'unknown'}` })
    })
  })
}

function card(provider: LocalAgentProvider, label: string, version: string | null): LocalAgentCard {
  return {
    name: `${label} Local`,
    description: `本机 ${label} Agent（由 EverRoom Adapter 接入）`,
    version: version ?? 'unknown',
    supportedInterfaces: [],
    capabilities: { streaming: provider !== 'openclaw', pushNotifications: false },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [{
      id: `${provider}-workspace`,
      name: 'Workspace task',
      description: '在用户确认的工作区中执行 Agent 任务',
      tags: ['local', 'workspace'],
    }],
  }
}

function historyRoots(home: string, paths: string[]): string[] {
  return paths.map((path) => join(home, path))
}

async function availableHistory(paths: string[]): Promise<string[]> {
  const found: string[] = []
  for (const path of paths) {
    try {
      const info = await stat(path)
      if (info.isDirectory()) found.push(path)
    } catch {
      // A missing history directory is expected for new installations.
    }
  }
  return found
}

function installationId(provider: LocalAgentProvider, executable: string | null): string {
  return `${provider}:${executable ?? 'history-only'}`
}

export function createLocalAgentDiscovery(options: LocalAgentDiscoveryOptions = {}): LocalAgentDiscovery {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  const now = options.now ?? (() => new Date())
  const probeTimeoutMs = options.probeTimeoutMs ?? 2_000
  const resolveLoginPath = options.resolveLoginShellPath ?? true
  return {
    async scan() {
      const searchEnv = await discoveryEnvironment(env, home, platform, resolveLoginPath, probeTimeoutMs)
      const results = await Promise.all(PROVIDERS.map(async ({ provider, names, label, historyPaths }) => {
        const executable = await executablePath(searchEnv, names, platform)
        const roots = historyRoots(home, historyPaths)
        const histories = await availableHistory(roots)
        const probe = executable ? await runVersion(executable, probeTimeoutMs, searchEnv) : { version: null, error: 'executable_not_found' }
        const callable = Boolean(executable && !probe.error)
        const status: LocalAgentStatus = callable ? 'verified' : histories.length ? 'history_available' : 'unavailable'
        const invocationSupported = callable && ACP_PROVIDERS.has(provider)
        const acpAdapter = invocationSupported
          ? await probeLocalAgentAcpAdapter(
            { provider, executablePath: executable, callable },
            { env: searchEnv, home, platform, probeTimeoutMs, ...(options.adaptersRoot !== undefined ? { adaptersRoot: options.adaptersRoot } : {}) },
          )
          : undefined
        return {
          id: installationId(provider, executable),
          provider,
          displayName: label,
          executablePath: executable,
          version: probe.version,
          status,
          callable,
          invocationSupported,
          historyAvailable: histories.length > 0,
          historyPaths: histories,
          card: card(provider, label, probe.version),
          lastSeenAt: now().toISOString(),
          ...(acpAdapter ? { acpAdapter } : {}),
          ...(probe.error && executable ? { error: probe.error } : {}),
        } satisfies LocalAgentInstallation
      }))
      return results.filter((item) => item.callable || item.historyAvailable)
    },
  }
}

export function isSafeLocalAgentPath(value: string): boolean {
  return value.length > 0 && !value.includes('\0') && dirname(value) !== value
}
