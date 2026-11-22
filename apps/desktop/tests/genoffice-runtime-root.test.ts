import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveGenOfficeRuntimeRoot } from '../src/main/runtime/genoffice-root'

/** GenOffice 运行时四个编辑器 + 表格侧车，宿主 resolve 后必须全部存在。 */
const REQUIRED_RUNTIME_FILES = [
  'docs/main/embed.js',
  'docs/preload/index.js',
  'docs/renderer/index.html',
  'sheets/main/embed.js',
  'sheets/preload/index.js',
  'sheets/renderer/index.html',
  'slides/main/embed.js',
  'slides/preload/index.js',
  'slides/renderer/index.html',
  'pdf/main/embed.js',
  'pdf/preload/index.js',
  'pdf/renderer/index.html',
  'native/xlsx-sidecar',
]

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * 构造与安装包一致的布局：<resources>/genoffice 是 extraResources 落点，
 * <resources>/app.asar 是应用包（里面没有 build/ 目录）。
 */
function makePackagedLayout(): { resourcesPath: string; appAsar: string; runtimeRoot: string } {
  const resourcesPath = mkdtempSync(join(tmpdir(), 'everoffice-resources-'))
  tempDirs.push(resourcesPath)
  const runtimeRoot = join(resourcesPath, 'genoffice')
  for (const relative of REQUIRED_RUNTIME_FILES) {
    const file = join(runtimeRoot, relative)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '')
  }
  return { resourcesPath, appAsar: join(resourcesPath, 'app.asar'), runtimeRoot }
}

describe('resolveGenOfficeRuntimeRoot', () => {
  it('打包态解析到 process.resourcesPath/genoffice，而不是 app.asar/build/genoffice-runtime', () => {
    const { resourcesPath, appAsar, runtimeRoot } = makePackagedLayout()

    const root = resolveGenOfficeRuntimeRoot({
      isPackaged: true,
      appPath: appAsar,
      resourcesPath,
      envRoot: undefined,
    })

    expect(root).toBe(runtimeRoot)
    // 用户症状同款断言：解析出的 root 下必须找得到 docs/main/embed.js（以及其余必需文件）。
    expect(existsSync(join(root, 'docs', 'main', 'embed.js'))).toBe(true)
    for (const relative of REQUIRED_RUNTIME_FILES) {
      expect(existsSync(join(root, relative)), `缺少 ${relative}`).toBe(true)
    }
    // 回归护栏：打包态绝不能再解析进 app.asar（asar 只读且没有 build/）。
    expect(root.startsWith(appAsar)).toBe(false)
  })

  it('开发态解析到 appPath/build/genoffice-runtime（prepare:genoffice 产物）', () => {
    const appPath = join(tmpdir(), 'everoffice-desktop')
    const root = resolveGenOfficeRuntimeRoot({
      isPackaged: false,
      appPath,
      resourcesPath: join(tmpdir(), 'Electron.app', 'Contents', 'Resources'),
      envRoot: undefined,
    })
    expect(root).toBe(join(appPath, 'build', 'genoffice-runtime'))
  })

  it('GENOFFICE_RUNTIME_ROOT 显式覆盖优先（开发调试换源）', () => {
    const override = join(tmpdir(), 'custom-genoffice-runtime')
    const { resourcesPath, appAsar } = makePackagedLayout()

    expect(
      resolveGenOfficeRuntimeRoot({
        isPackaged: true,
        appPath: appAsar,
        resourcesPath,
        envRoot: override,
      }),
    ).toBe(override)
    expect(
      resolveGenOfficeRuntimeRoot({
        isPackaged: false,
        appPath: join(tmpdir(), 'everoffice-desktop'),
        resourcesPath,
        envRoot: override,
      }),
    ).toBe(override)
  })
})