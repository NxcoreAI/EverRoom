import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/** app 私有适配器安装目录（按 provider 分 prefix，互不污染）。 */
export function localAgentAdaptersRoot(): string {
  return join(app.getPath('userData'), 'local-agent-adapters')
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
