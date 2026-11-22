import { join } from 'node:path'

/**
 * GenOffice 原生编辑器运行时根目录解析（两个宿主共用，避免开发态/打包态再次漂移）。
 *
 * 运行时由 scripts/prepare-genoffice-runtime.mjs 构建到 apps/desktop/build/genoffice-runtime；
 * 打包时由 electron-builder 的 extraResources 落到 <app>/Contents/Resources/genoffice
 * （见 apps/desktop/package.json 的 build.extraResources）。因此：
 * - 开发态（app.isPackaged=false）：app.getAppPath()/build/genoffice-runtime
 * - 打包态（app.isPackaged=true）：process.resourcesPath/genoffice
 *   ——注意绝不能回落到 app.asar/build/...，asar 内没有 build/ 目录。
 */
export interface GenOfficeRuntimeRootOptions {
  /** GENOFFICE_RUNTIME_ROOT 显式覆盖（指向 EverOffice 的 build/genoffice-runtime）。 */
  envRoot?: string | undefined
  /** Electron app.isPackaged。 */
  isPackaged: boolean
  /** 开发态应用根目录（Electron app.getAppPath()）。 */
  appPath: string
  /** 打包态 Electron process.resourcesPath（<app>/Contents/Resources）。 */
  resourcesPath: string
}

export function resolveGenOfficeRuntimeRoot(options: GenOfficeRuntimeRootOptions): string {
  if (options.envRoot) return options.envRoot
  return options.isPackaged
    ? join(options.resourcesPath, 'genoffice')
    : join(options.appPath, 'build', 'genoffice-runtime')
}