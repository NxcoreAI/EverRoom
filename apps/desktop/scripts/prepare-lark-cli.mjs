import { chmod, copyFile, mkdir, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// 预装 lark-cli（飞书 Agent 导出通道）：npm 包是引导器，真实二进制由其
// install.js 从 GitHub Releases / npmmirror 下载并做 sha256 校验。这里在
// 构建/开发准备阶段完成下载并拷贝到 build/lark-cli/<platform>-<arch>/，
// 产品运行时不做任何网络安装（feishu-notion-document-export-plan.md §6.1）。

const require = createRequire(import.meta.url)
const packageDirectory = dirname(require.resolve('@larksuite/cli/package.json'))
const executableName = process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli'
const source = join(packageDirectory, 'bin', executableName)

async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

if (!(await exists(source))) {
  console.log('lark-cli binary missing; running @larksuite/cli install script …')
  const result = spawnSync(process.execPath, [join(packageDirectory, 'scripts', 'install.js')], {
    stdio: 'inherit',
    env: { ...process.env, LARK_CLI_RUN: 'true' },
  })
  if (result.status !== 0 || !(await exists(source))) {
    throw new Error('lark-cli binary download failed; export environment will be unavailable until fixed')
  }
}

const targetDirectory = join(dirname(import.meta.dirname), 'build', 'lark-cli', `${process.platform}-${process.arch}`)
const target = join(targetDirectory, executableName)
await mkdir(targetDirectory, { recursive: true })
await copyFile(source, target)
if (process.platform !== 'win32') await chmod(target, 0o755)

const version = spawnSync(target, ['--version'], { encoding: 'utf8', timeout: 15_000 })
const versionText = version.status === 0 ? (version.stdout || '').trim() : `exit ${String(version.status)}`
console.log(`Prepared lark-cli: ${target} (${versionText})`)
