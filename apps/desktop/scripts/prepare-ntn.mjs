import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// 预装 ntn（Notion 官方 CLI，Notion 导出通道）：npm 包自带各平台二进制
// （dist/ntn-<platform>-<arch>/ntn，无需网络下载），这里只做拷贝。
// ntn 官方安装器不支持 Windows；本产品当前仅在 macOS 暴露 Notion 导出，
// 非 darwin 平台跳过（构建产物缺失时网关按 environment_not_ready 降级）。
const require = createRequire(import.meta.url)
const executableName = process.platform === 'win32' ? 'ntn.exe' : 'ntn'
const source = join(
  dirname(require.resolve('ntn/package.json')),
  'dist',
  `ntn-${process.platform}-${process.arch}`,
  executableName,
)

const targetDirectory = join(dirname(import.meta.dirname), 'build', 'ntn', `${process.platform}-${process.arch}`)
const target = join(targetDirectory, executableName)
await mkdir(targetDirectory, { recursive: true })
await copyFile(source, target)
if (process.platform !== 'win32') await chmod(target, 0o755)
console.log(`Prepared ntn: ${target}`)
