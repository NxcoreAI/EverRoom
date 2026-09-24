import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  localAcpAdapterCommand,
  localAcpAdapterInstallPackage,
  type LocalAcpAdapterSpawn,
  type LocalAcpProvider,
} from '@nxcore/agent-contract'
import type { LocalAgentAdapterInstallResult, LocalAgentInstallation } from '../../shared/local-agents'
import {
  findPrivateAdapterInstall,
  isSafeLocalAgentPath,
  mergedDiscoveryEnvironment,
  probeLocalAgentAcpAdapter,
  resolveCommandPath,
} from './discovery'

const NPM_INSTALL_TIMEOUT_MS = 300_000
const NPM_MIRROR_REGISTRY = 'https://registry.npmmirror.com'

/** 纯逻辑安装器的运行时输入（路径由调用方经 local-agent-paths 解析注入，便于测试）。 */
export interface AdapterInstallOptions {
  adaptersRoot: string
  /** 内置 npm-cli.js 绝对路径；null 表示打包缺失（结果带 npm_cli_missing）。 */
  npmCliPath: string | null
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
  probeTimeoutMs?: number
  /** 承载 npm 与适配器入口的运行时（默认当前进程，配 ELECTRON_RUN_AS_NODE）。 */
  execPath?: string
  /** 注入 npm 下载的系统代理环境变量。 */
  proxyEnv?: Record<string, string>
}

export interface AdapterSpawnOptions {
  adaptersRoot: string
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
  probeTimeoutMs?: number
  execPath?: string
}

interface NpmRunResult {
  code: number | null
  timedOut: boolean
  output: string
}

function runNpmInstall(
  execPath: string,
  npmCli: string,
  prefix: string,
  pkg: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<NpmRunResult> {
  return new Promise((resolveRun) => {
    // execPath 是 Electron 二进制，ELECTRON_RUN_AS_NODE 下即完整 Node；
    // npmCli 为内部常量路径，无注入面，不需要 shell。
    const child = spawn(execPath, [
      npmCli,
      'install',
      '--prefix', prefix,
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      pkg,
    ], { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let settled = false
    const finish = (code: number | null, timedOut = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun({ code, timedOut, output: output.slice(-4_000) })
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(-1, true)
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(-8_000) })
    child.stderr?.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString('utf8')}`.slice(-8_000) })
    child.on('error', (error) => { output = `${output}\n${error.message}`; finish(-1) })
    child.on('close', (code) => finish(code))
  })
}

/**
 * 一键安装缺失的 ACP 适配器：用内置 npm-cli.js（Electron 以
 * ELECTRON_RUN_AS_NODE 承载）把官方适配器包 `--prefix` 装进 app 私有目录。
 * 不依赖用户 npm/Node，三平台一致，也不碰用户全局环境。
 * 先按用户默认 registry（含 ~/.npmrc）安装，失败再切 npmmirror 兜底。
 */
export async function installLocalAgentAcpAdapter(
  installation: Pick<LocalAgentInstallation, 'id' | 'provider' | 'executablePath' | 'callable'>,
  options: AdapterInstallOptions,
): Promise<LocalAgentAdapterInstallResult> {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  const probeTimeoutMs = options.probeTimeoutMs ?? 2_000
  const adaptersRoot = options.adaptersRoot
  const probeOptions = { env, home, platform, probeTimeoutMs, adaptersRoot }
  const provider = installation.provider
  if (provider !== 'claude' && provider !== 'codex') {
    return {
      agentId: installation.id,
      ok: true,
      status: 'not_needed',
      adapter: await probeLocalAgentAcpAdapter(installation, probeOptions),
    }
  }
  const pkg = localAcpAdapterInstallPackage(provider)
  if (!pkg) {
    return {
      agentId: installation.id,
      ok: true,
      status: 'not_needed',
      adapter: await probeLocalAgentAcpAdapter(installation, probeOptions),
    }
  }
  const before = await probeLocalAgentAcpAdapter(installation, probeOptions)
  if (before.installed) {
    return { agentId: installation.id, ok: true, status: 'not_needed', adapter: before }
  }
  const npmCli = options.npmCliPath
  if (!npmCli) {
    return { agentId: installation.id, ok: false, status: 'failed', adapter: before, error: 'npm_cli_missing' }
  }
  const prefix = join(adaptersRoot, provider)
  await mkdir(prefix, { recursive: true })
  const execPath = options.execPath ?? process.execPath
  const baseEnv: NodeJS.ProcessEnv = {
    ...env,
    ELECTRON_RUN_AS_NODE: '1',
    ...(options.proxyEnv ?? {}),
  }
  let output = ''
  let code: number | null = null
  let timedOut = false
  // 第一次不设 registry（尊重用户 ~/.npmrc 与默认官方源），失败再显式切镜像。
  for (const registry of [undefined, NPM_MIRROR_REGISTRY]) {
    const run = await runNpmInstall(execPath, npmCli, prefix, pkg, {
      ...baseEnv,
      ...(registry ? { npm_config_registry: registry } : {}),
    }, NPM_INSTALL_TIMEOUT_MS)
    output = output ? `${output}\n${run.output}` : run.output
    code = run.code
    timedOut = run.timedOut
    if (run.code === 0) break
  }
  if (code !== 0) {
    return {
      agentId: installation.id,
      ok: false,
      status: 'failed',
      adapter: await probeLocalAgentAcpAdapter(installation, probeOptions),
      error: timedOut ? 'npm_install_timeout' : 'npm_install_failed',
      log: output || undefined,
    }
  }
  const installed = await findPrivateAdapterInstall(adaptersRoot, provider)
  if (!installed) {
    return {
      agentId: installation.id,
      ok: false,
      status: 'failed',
      adapter: await probeLocalAgentAcpAdapter(installation, probeOptions),
      error: 'installed_but_not_found',
      log: output || undefined,
    }
  }
  return {
    agentId: installation.id,
    ok: true,
    status: 'installed',
    adapter: await probeLocalAgentAcpAdapter(installation, probeOptions),
  }
}

/**
 * 为派发 target 解析适配器的绝对路径 spawn 覆盖，gateway 拿到后免 PATH 解析：
 * 1. 用户自己装的适配器（登录 shell 合并 PATH 命中，含旧 bin 名）→ 直接绝对路径；
 * 2. app 私有安装 → Electron 运行时承载入口（ELECTRON_RUN_AS_NODE + entry.js）。
 * 两种情况都附上合并后的 PATH，适配器内部再拉起 claude/codex CLI 时同样免瘦 PATH 问题。
 */
export async function resolveLocalAcpAdapterSpawn(
  installation: Pick<LocalAgentInstallation, 'provider' | 'executablePath' | 'callable'>,
  options: AdapterSpawnOptions,
): Promise<LocalAcpAdapterSpawn | null> {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  const probeTimeoutMs = options.probeTimeoutMs ?? 2_000
  const adaptersRoot = options.adaptersRoot
  if (installation.provider !== 'claude' && installation.provider !== 'codex') return null
  const provider = installation.provider as LocalAcpProvider
  const searchEnv = await mergedDiscoveryEnvironment(env, home, platform, probeTimeoutMs)
  const info = localAcpAdapterCommand(provider, installation.executablePath ?? '', env)
  for (const candidate of [info.command, ...(info.fallbacks ?? [])]) {
    const absolute = await resolveCommandPath(searchEnv, candidate, platform)
    if (absolute && isSafeLocalAgentPath(absolute)) {
      return { command: absolute, args: [], env: { PATH: searchEnv.PATH ?? '' } }
    }
  }
  const privateInstall = await findPrivateAdapterInstall(adaptersRoot, provider)
  if (privateInstall && isSafeLocalAgentPath(privateInstall.entry)) {
    return {
      command: options.execPath ?? process.execPath,
      args: [privateInstall.entry],
      env: { ELECTRON_RUN_AS_NODE: '1', PATH: searchEnv.PATH ?? '' },
    }
  }
  return null
}
