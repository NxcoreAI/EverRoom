import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { constants, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// 预装 lark-cli（飞书 Agent 导出通道）：npm 包是引导器，真实二进制由其
// install.js 从 GitHub Releases / npmmirror 下载并做 sha256 校验。这里在
// 构建/开发准备阶段完成下载并拷贝到 build/lark-cli/<platform>-<arch>/，
// 产品运行时不做任何网络安装（feishu-notion-document-export-plan.md §6.1）。
//
// 加固点（内置 CLI 与安装包生命周期绑定）：
// - 生成 manifest.json（版本/平台/架构/sha256/大小/准备时间），与二进制一起
//   进入安装包；运行时据此判断内置 CLI 是否完整。
// - 已准备且校验通过时直接复用（离线构建不重复下载/拷贝）。
// - 拷贝后校验 `--version` 与 npm 包版本一致，不一致直接失败（避免装错版本）。
// - 环境变量：
//   LARK_CLI_PREPARE_FORCE=1        强制重新拷贝（忽略缓存）
//   LARK_CLI_PREPARE_ALLOW_VERSION_MISMATCH=1  允许版本不一致（排障用）

const require = createRequire(import.meta.url)
const packageJson = require('@larksuite/cli/package.json')
const packageDirectory = dirname(require.resolve('@larksuite/cli/package.json'))
const packageVersion = String(packageJson.version ?? '').trim()
if (!packageVersion) throw new Error('@larksuite/cli package.json 缺少 version 字段')
const executableName = process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli'
const source = join(packageDirectory, 'bin', executableName)

const targetDirectory = join(dirname(import.meta.dirname), 'build', 'lark-cli', `${process.platform}-${process.arch}`)
const target = join(targetDirectory, executableName)
const manifestPath = join(targetDirectory, 'manifest.json')
const forced = process.env.LARK_CLI_PREPARE_FORCE === '1'
const allowVersionMismatch = process.env.LARK_CLI_PREPARE_ALLOW_VERSION_MISMATCH === '1'

function executableExists(path) {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

async function sha256(path) {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

function parseVersion(text) {
  const match = /(\d+\.\d+\.\d+)/.exec(String(text ?? ''))
  return match ? match[1] : null
}

function probeVersion(executable) {
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1' },
  })
  if (result.status !== 0) {
    throw new Error(
      `lark-cli --version 失败（exit ${String(result.status)}）：`
      + `${(result.stderr || result.stdout || '').trim().slice(0, 400)}`,
    )
  }
  return (result.stdout || '').trim()
}

/** 读取并校验已有 manifest；任何不一致都返回 null 触发重新准备。 */
async function readValidManifest() {
  if (!executableExists(target)) return null
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    return null
  }
  if (manifest?.tool !== 'lark-cli') return null
  if (manifest.version !== packageVersion) return null
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) return null
  const actualSha = await sha256(target)
  if (manifest.sha256 !== actualSha) {
    console.warn(`lark-cli 缓存 sha256 不匹配，重新准备（期望 ${manifest.sha256}，实际 ${actualSha}）`)
    return null
  }
  try {
    const versionText = probeVersion(target)
    if (parseVersion(versionText) !== packageVersion) {
      console.warn(`lark-cli 缓存版本不符（${versionText} ≠ ${packageVersion}），重新准备`)
      return null
    }
    return { manifest, versionText }
  } catch {
    return null
  }
}

async function ensureSourceBinary() {
  if (executableExists(source)) return
  console.log('lark-cli binary missing; running @larksuite/cli install script …')
  const result = spawnSync(process.execPath, [join(packageDirectory, 'scripts', 'install.js')], {
    stdio: 'inherit',
    env: { ...process.env, LARK_CLI_RUN: 'true' },
  })
  if (result.status !== 0 || !executableExists(source)) {
    throw new Error(
      'lark-cli 二进制下载失败（导出/导入环境将不可用）。'
      + '请检查网络/代理后重试，或设置 LARK_CLI_PREPARE_FORCE=1 重新下载。',
    )
  }
}

async function writeManifest(manifest) {
  const temporary = `${manifestPath}.tmp`
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await rename(temporary, manifestPath)
}

if (!forced) {
  const cached = await readValidManifest()
  if (cached) {
    console.log(`Reused lark-cli: ${target} (${cached.versionText}, sha256 ${cached.manifest.sha256.slice(0, 12)}…)`)
    process.exit(0)
  }
}

await ensureSourceBinary()
await mkdir(targetDirectory, { recursive: true })
await copyFile(source, target)
if (process.platform !== 'win32') await chmod(target, 0o755)

const versionText = probeVersion(target)
const builtVersion = parseVersion(versionText)
if (builtVersion !== packageVersion && !allowVersionMismatch) {
  throw new Error(
    `lark-cli 版本与 @larksuite/cli 包版本不一致：二进制 ${versionText}，包 ${packageVersion}。`
    + '请删除 node_modules/@larksuite/cli 后重新安装，或设置 LARK_CLI_PREPARE_ALLOW_VERSION_MISMATCH=1 强制通过。',
  )
}
const digest = await sha256(target)
const size = (await stat(target)).size
const manifest = {
  tool: 'lark-cli',
  version: packageVersion,
  platform: process.platform,
  arch: process.arch,
  executable: executableName,
  sha256: digest,
  size,
  preparedAt: new Date().toISOString(),
}
await writeManifest(manifest)
console.log(`Prepared lark-cli: ${target} (${versionText}, ${size} bytes, sha256 ${digest.slice(0, 12)}…)`)