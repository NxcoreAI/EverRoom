import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

/**
 * 飞书 lark-cli 的运行时契约（内置优先 + 环境隔离）。
 *
 * 产品策略（与用户电脑自带的 lark-cli 的关系）：
 * 1. **内置优先**：发行包始终优先使用随应用安装的 `resources/lark-cli/<platform>-<arch>/lark-cli`，
 *    它随应用一起安装、一起卸载，不依赖用户终端里的任何安装。
 * 2. **系统兜底**：仅当内置二进制缺失（开发态 / 安装包损坏）时才回退到系统已安装的
 *    lark-cli，且必须通过 `--version` 探测并满足最低兼容版本；GUI 应用的 PATH 通常
 *    不含登录 shell 的全局 bin 目录，因此这里主动探测常见的全局安装位置。
 * 3. **配置隔离**：无论用内置还是系统二进制，子进程的 HOME/USERPROFILE 都重定向到应用
 *    私有目录（`<userData>/lark-cli/home`）。lark-cli 的配置、缓存、本地回退密钥都在
 *    这个私有 HOME 下，**绝不读写用户 `~/.lark-cli`**，因此用户自己在终端里配置的
 *    lark-cli 不受影响，应用也不会误用/覆盖用户的飞书应用凭据。
 * 3.1 **不使用系统钥匙串**：lark-cli 默认把加密主密钥存进 macOS 登录钥匙串，跨进程
 *    读取时 macOS 会弹「lark-cli 想使用你钥匙串中的密钥」的 ACL 授权框。应用会在首次
 *    调用 CLI 之前，先在私有 HOME 下预置主密钥文件（0600、32 字节随机值）；
 *    lark-cli 检测到该文件后固定从文件读写，**全程不访问钥匙串**，也不会弹窗、不需要
 *    用户授权。已存在的主密钥文件绝不覆盖（覆盖会让已保存的凭据无法解密）。
 * 4. **环境继承白名单**：只继承代理、证书、语言、时区、终端等运行必需变量，剥离
 *    `LARK_*` / `FEISHU_*` / `OPENCLAW_*` / `HERMES_*` / `NODE_OPTIONS` / `ELECTRON_*` 等会把子进程带到
 *    其他 Agent 工作区或注入非预期行为的变量，并统一 `NO_COLOR=1`。
 *
 * 该模块不 import electron，路径全部由调用方注入，便于单测。
 */

/** 系统兜底时要求的最低 lark-cli 版本（低于此版本缺少导出所需的设备码/JSON 契约）。 */
export const MIN_SUPPORTED_LARK_CLI_VERSION = '1.0.90'

export type LarkCliSource = 'env' | 'bundled' | 'system' | 'missing'

export interface LarkCliRuntimeOptions {
  /** Electron `process.resourcesPath`（打包后 = `<app>/Contents/Resources`）。 */
  resourcesPath: string
  /** Electron `app.getAppPath()`（开发态 = apps/desktop，打包 = app.asar）。 */
  appPath: string
  /** 应用私有的 lark-cli HOME（配置隔离落点）。 */
  homeDirectory: string
  platform?: NodeJS.Platform
  arch?: string
  /** 基础环境（默认 process.env），用于探测系统安装位置与继承白名单。 */
  baseEnvironment?: NodeJS.ProcessEnv
  /** 版本探测注入点（测试用）。返回 `--version` 原始输出，探测失败返回 null。 */
  probeVersion?: (executable: string) => string | null
}

export interface LarkCliRuntime {
  /** 实际执行路径（可能是命令名，见 source=missing 时的兜底）。 */
  executable: string
  source: LarkCliSource
  /** 探测到的语义版本（`1.0.93`），不可用/未探测时为 null。 */
  version: string | null
  /** 人类可读来源说明（日志与设置页使用）。 */
  detail: string
  /** 隔离后的私有 HOME。 */
  homeDirectory: string
  /** 所有 lark-cli 子进程必须使用的环境（继承白名单 + 私有 HOME + NO_COLOR）。 */
  spawnEnvironment(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  /** 注入 gateway 的变量：网关侧执行导出命令时复用同一二进制与同一私有 HOME。 */
  gatewayEnvironment(): Record<string, string>
}

/** 子进程允许继承的环境变量（其余一律剥离，避免把外部 Agent/Node 上下文带进 CLI）。 */
const INHERITED_ENVIRONMENT_KEYS = [
  // 身份与语言（KEYCHAIN/输出文案依赖）
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TERM',
  'TZ',
  // 临时目录
  'TMPDIR',
  'TMP',
  'TEMP',
  // 代理（企业网络必需，大小写两种写法都会被 Go/Node 生态读取）
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  // 自定义 CA（企业内网抓包/自签证书场景）
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const

/** Windows 运行必需的系统变量（缺失会导致加密/网络 API 初始化失败）。 */
const WINDOWS_INHERITED_ENVIRONMENT_KEYS = [
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
] as const

/** 解析 `--version` 输出里的语义版本；非语义版本返回 null。 */
export function parseLarkCliVersion(output: string | null | undefined): string | null {
  if (!output) return null
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output)
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null
}

/** 语义版本比较：a>b 返回 1，a<b 返回 -1，相等 0（仅支持三位数字版本）。 */
export function compareLarkCliVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}

/**
 * 构造 lark-cli 子进程环境：只保留白名单变量，把 HOME 族重定向到应用私有目录。
 * 这是「内置 CLI 与用户自带 CLI 互不干扰」的实现点——用户在终端里的
 * `~/.lark-cli/config.json`、钥匙串条目和应用私有配置是两套完全独立的命名空间。
 */
export function larkCliSpawnEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  homeDirectory: string,
): NodeJS.ProcessEnv {
  const platform = process.platform
  const keys: readonly string[] = platform === 'win32'
    ? [...INHERITED_ENVIRONMENT_KEYS, ...WINDOWS_INHERITED_ENVIRONMENT_KEYS]
    : INHERITED_ENVIRONMENT_KEYS
  const environment: NodeJS.ProcessEnv = {}
  for (const key of keys) {
    const value = baseEnvironment[key]
    if (typeof value === 'string' && value.length > 0) environment[key] = value
  }
  // PATH 清理：去空项与重复项，避免空项被解析成当前工作目录。
  const pathValue = baseEnvironment.PATH ?? baseEnvironment.Path
  if (typeof pathValue === 'string' && pathValue.length > 0) {
    const entries = pathValue.split(delimiter).map((entry) => entry.trim()).filter(Boolean)
    if (entries.length > 0) environment.PATH = [...new Set(entries)].join(delimiter)
  }
  // HOME 族全部指向私有目录：macOS/Linux 看 HOME，Windows 看 USERPROFILE/APPDATA。
  environment.HOME = homeDirectory
  environment.USERPROFILE = homeDirectory
  environment.APPDATA = join(homeDirectory, 'AppData', 'Roaming')
  environment.LOCALAPPDATA = join(homeDirectory, 'AppData', 'Local')
  // 不继承 XDG_*：lark-cli 支持 XDG_CONFIG_HOME，若用户环境设置了它，会把配置写到
  // 隔离目录之外；这里不传递，让配置稳定落在私有 HOME 下。
  environment.NO_COLOR = '1'
  if (baseEnvironment.LARK_CLI_NO_PROXY === '1') environment.LARK_CLI_NO_PROXY = '1'
  return environment
}

/** 创建应用私有 HOME（CLI 自己会创建 `~/.lark-cli` 等子目录）。 */
export function ensureLarkCliHome(homeDirectory: string): void {
  try {
    mkdirSync(homeDirectory, { recursive: true, mode: 0o700 })
    // Windows 上 lark-cli 可能把缓存写到 APPDATA/LOCALAPPDATA；预先建目录，
    // 避免个别 CLI 版本假定目录已存在。
    if (process.platform === 'win32') {
      mkdirSync(join(homeDirectory, 'AppData', 'Roaming'), { recursive: true })
      mkdirSync(join(homeDirectory, 'AppData', 'Local'), { recursive: true })
    }
  } catch (error) {
    console.warn('[lark-cli] failed to prepare private home:', error)
  }
}

/** macOS 上 lark-cli 主密钥文件路径（该文件存在即表示已脱离系统钥匙串）。 */
export function larkCliMasterKeyPath(
  homeDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== 'darwin') return null
  return join(homeDirectory, 'Library', 'Application Support', 'lark-cli', 'master.key.file')
}

/**
 * 预置 lark-cli 加密主密钥文件（仅 macOS 需要；Windows 凭据管理器无交互弹窗）。
 *
 * lark-cli 的规则（1.0.93 实测）：主密钥文件存在时，App Secret / token 的加解密全部
 * 使用该文件，不再读写 macOS 登录钥匙串。因此应用在第一次调用 CLI 前写入一个随机
 * 32 字节密钥（0600），即可保证连接/授权/导出全程不出现系统钥匙串授权弹窗。
 *
 * - 已存在：返回 'existing'，绝不覆盖（覆盖会导致已有凭据无法解密）。
 * - 非 macOS：返回 'unsupported'，由平台自身的凭据存储处理。
 */
export function ensureLarkCliMasterKey(
  homeDirectory: string,
  platform: NodeJS.Platform = process.platform,
): 'created' | 'existing' | 'unsupported' | 'failed' {
  const path = larkCliMasterKeyPath(homeDirectory, platform)
  if (!path) return 'unsupported'
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' })
    console.info(`[lark-cli] seeded private master key (keychain disabled): ${path}`)
    return 'created'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'existing'
    console.warn('[lark-cli] failed to seed private master key:', error)
    return 'failed'
  }
}

/** 探测可执行文件的 `--version`（同步、短超时；探测失败返回 null）。 */
export function probeLarkCliVersion(
  executable: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs = 8_000,
): string | null {
  try {
    const result = spawnSync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: environment,
      shell: false,
    })
    if (result.status !== 0) return null
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
    return output.length > 0 ? output : null
  } catch {
    return null
  }
}

function isExecutableFile(path: string): boolean {
  try {
    if (!existsSync(path)) return false
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** 系统已安装 lark-cli 的常见位置（GUI 应用 PATH 不含登录 shell 的全局 bin 目录）。 */
function systemCandidatePaths(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): string[] {
  const executableName = platform === 'win32' ? 'lark-cli.exe' : 'lark-cli'
  const home = environment.HOME?.trim() || environment.USERPROFILE?.trim() || homedir()
  const candidates: string[] = []
  if (platform === 'win32') {
    const appData = environment.APPDATA?.trim()
    const localAppData = environment.LOCALAPPDATA?.trim()
    if (appData) {
      // npm 全局安装的真实二进制（npm 的 .cmd 垫片无法被 shell:false 直接执行）。
      candidates.push(join(appData, 'npm', 'node_modules', '@larksuite', 'cli', 'bin', executableName))
    }
    if (localAppData) candidates.push(join(localAppData, 'Programs', 'lark-cli', executableName))
    const programFiles = environment.PROGRAMFILES?.trim()
    if (programFiles) candidates.push(join(programFiles, 'lark-cli', executableName))
  } else {
    candidates.push(
      join('/usr/local/bin', executableName),
      join('/opt/homebrew/bin', executableName),
      join('/usr/bin', executableName),
      join(home, '.local', 'bin', executableName),
      join(home, '.npm-global', 'bin', executableName),
      join(home, '.volta', 'bin', executableName),
      join(home, 'bin', executableName),
    )
  }
  const pathValue = environment.PATH ?? environment.Path ?? ''
  for (const entry of pathValue.split(delimiter)) {
    const directory = entry.trim()
    if (directory) candidates.push(join(directory, executableName))
  }
  return candidates
}

/**
 * 解析本次运行使用的 lark-cli：环境变量覆盖 → 内置 → 系统兜底 → 缺失。
 * 内置/环境变量来源不做版本闸门（安装包与调试覆盖由构建方负责），系统兜底必须
 * 探测成功且 ≥ MIN_SUPPORTED_LARK_CLI_VERSION，否则视为不可用（宁可报缺失也不
 * 用版本不兼容的 CLI 去引导用户授权）。
 */
export function createLarkCliRuntime(options: LarkCliRuntimeOptions): LarkCliRuntime {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const baseEnvironment = options.baseEnvironment ?? process.env
  const executableName = platform === 'win32' ? 'lark-cli.exe' : 'lark-cli'
  const configuredHome = baseEnvironment.NXCORE_LARK_CLI_HOME?.trim()
  const homeDirectory = configuredHome || options.homeDirectory
  ensureLarkCliHome(homeDirectory)
  // 在任何 lark-cli 调用之前把主密钥固定到私有目录，确保不使用系统钥匙串。
  ensureLarkCliMasterKey(homeDirectory, platform)
  const spawnBase = (): NodeJS.ProcessEnv => larkCliSpawnEnvironment(baseEnvironment, homeDirectory)
  const probe = options.probeVersion ?? ((executable: string) => probeLarkCliVersion(executable, spawnBase()))

  const explicit = baseEnvironment.NXCORE_LARK_CLI_PATH?.trim()
  if (explicit) {
    const version = parseLarkCliVersion(probe(explicit))
    return buildRuntime({
      executable: explicit,
      source: 'env',
      version,
      detail: `由 NXCORE_LARK_CLI_PATH 指定：${explicit}`,
      homeDirectory,
      spawnBase,
    })
  }

  const bundledCandidates = [
    join(options.resourcesPath, 'lark-cli', `${platform}-${arch}`, executableName),
    join(options.resourcesPath, 'lark-cli', executableName),
    join(options.appPath, 'build', 'lark-cli', `${platform}-${arch}`, executableName),
  ]
  const bundled = bundledCandidates.find(isExecutableFile)
  if (bundled) {
    const version = parseLarkCliVersion(probe(bundled))
    return buildRuntime({
      executable: bundled,
      source: 'bundled',
      version,
      detail: `随应用内置（${platform}-${arch}）`,
      homeDirectory,
      spawnBase,
    })
  }

  // 系统兜底：只有探测成功且版本达标才接受。
  for (const candidate of systemCandidatePaths(platform, baseEnvironment)) {
    if (!isExecutableFile(candidate)) continue
    const version = parseLarkCliVersion(probe(candidate))
    if (!version) continue
    if (compareLarkCliVersions(version, MIN_SUPPORTED_LARK_CLI_VERSION) < 0) {
      console.warn(
        `[lark-cli] 忽略系统安装的旧版本 ${candidate}（${version} < ${MIN_SUPPORTED_LARK_CLI_VERSION}）`,
      )
      continue
    }
    return buildRuntime({
      executable: candidate,
      source: 'system',
      version,
      detail: `回退使用系统安装的 lark-cli（${candidate}，v${version}）`,
      homeDirectory,
      spawnBase,
    })
  }

  // 最后兜底：交给 PATH 查找（行为与历史版本一致），但明确标记为 missing，
  // 由控制器把 cliState 报成 missing，而不是静默假装可用。
  return buildRuntime({
    executable: executableName,
    source: 'missing',
    version: null,
    detail: '未找到随应用内置或系统安装的 lark-cli',
    homeDirectory,
    spawnBase,
  })
}

function buildRuntime(input: {
  executable: string
  source: LarkCliSource
  version: string | null
  detail: string
  homeDirectory: string
  spawnBase: () => NodeJS.ProcessEnv
}): LarkCliRuntime {
  return {
    executable: input.executable,
    source: input.source,
    version: input.version,
    detail: input.detail,
    homeDirectory: input.homeDirectory,
    spawnEnvironment: (base?: NodeJS.ProcessEnv) => (
      base
        ? larkCliSpawnEnvironment(base, input.homeDirectory)
        : input.spawnBase()
    ),
    gatewayEnvironment: () => ({
      NXCORE_LARK_CLI_PATH: input.executable,
      NXCORE_LARK_CLI_HOME: input.homeDirectory,
    }),
  }
}