import { access, constants, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import type {
  LocalAgentCard,
  LocalAgentInstallation,
  LocalAgentProvider,
  LocalAgentStatus,
} from '../../shared/local-agents'

const PROVIDERS: Array<{ provider: LocalAgentProvider; names: string[]; label: string; historyPaths: string[] }> = [
  { provider: 'codex', names: ['codex'], label: 'Codex', historyPaths: ['.codex'] },
  { provider: 'claude', names: ['claude'], label: 'Claude Code', historyPaths: ['.claude'] },
  { provider: 'opencode', names: ['opencode'], label: 'OpenCode', historyPaths: ['.config/opencode', '.opencode'] },
]

export interface LocalAgentDiscoveryOptions {
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
  now?: () => Date
  probeTimeoutMs?: number
  resolveLoginShellPath?: boolean
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
    capabilities: { streaming: true, pushNotifications: false },
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
        return {
          id: installationId(provider, executable),
          provider,
          displayName: label,
          executablePath: executable,
          version: probe.version,
          status,
          callable,
          invocationSupported: callable && (provider === 'codex' || provider === 'claude'),
          historyAvailable: histories.length > 0,
          historyPaths: histories,
          card: card(provider, label, probe.version),
          lastSeenAt: now().toISOString(),
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
