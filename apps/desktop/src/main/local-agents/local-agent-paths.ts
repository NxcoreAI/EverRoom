import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/** app 私有适配器安装目录（按 provider 分 prefix，互不污染）。 */
export function localAgentAdaptersRoot(): string {
  return join(app.getPath('userData'), 'local-agent-adapters')
}

/**
 * 打包内置的 ACP 适配器目录（prepare-acp-adapters.mjs 产物随 extraResources
 * 落 resources/acp-adapters）；dev 从 build/ 产物解析。探测与启动链把它作为
 * 用户 PATH 与私有安装目录之后的兜底——任何机器开箱即用，无需网络安装。
 */
export function bundledAcpAdaptersRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'acp-adapters')
    : join(app.getAppPath(), 'build', 'acp-adapters')
}

/**
 * 内置 npm-cli.js（npm 包自身零运行时依赖，可直接以 ELECTRON_RUN_AS_NODE 跑）。
 * dev 从 workspace node_modules 解析；packaged 从 resources/npm（asar 外，npm 需要
 * 真实文件系统做解包与 chmod）解析。找不到返回 null（渲染端显示手动指引）。
 */
export function bundledNpmCliPath(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'npm', 'bin', 'npm-cli.js')]
    : [
      join(app.getAppPath(), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      join(app.getAppPath(), '..', '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}
