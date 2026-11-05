import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  sofficeFontConfigEnv,
  type SofficeFontConfigDeps,
} from '../src/main/office/office-fontconfig'

const MAC_EXECUTABLE = '/Applications/LibreOffice.app/Contents/MacOS/soffice'
const MAC_HOME = '/Users/test'
const MAC_SYSTEM_FONT_DIRECTORIES = [
  '/System/Library/Fonts',
  '/System/Library/Fonts/Supplemental',
  '/Library/Fonts',
  `${MAC_HOME}/Library/Fonts`,
  '/System/Library/AssetsV2/com_apple_MobileAsset_Font8',
]
const MAC_BUNDLED_FONT_DIRECTORY = '/Applications/LibreOffice.app/Contents/Resources/fonts/truetype'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createCacheRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'everroom-fontconfig-test-'))
  temporaryDirectories.push(directory)
  return directory
}

/** 只让指定目录“存在”，其余探测一律为假，避免测试依赖真实系统字体。 */
function existingDirectories(directories: string[]): (path: string) => boolean {
  return (path) => directories.includes(path)
}

function darwinDeps(cacheRoot: string, existing: string[]): SofficeFontConfigDeps {
  return {
    platform: 'darwin',
    env: {},
    homeDir: MAC_HOME,
    exists: existingDirectories(existing),
    cacheRoot,
  }
}

function readConfig(environment: Record<string, string>): string {
  const configPath = environment.FONTCONFIG_FILE
  expect(configPath).toBeTruthy()
  expect(existsSync(configPath as string)).toBe(true)
  return readFileSync(configPath as string, 'utf8')
}

describe('sofficeFontConfigEnv', () => {
  it('macOS 配置包含系统字体目录、LibreOffice 自带字体、CJK 别名与兜底字体', () => {
    const cacheRoot = createCacheRoot()
    const environment = sofficeFontConfigEnv(
      MAC_EXECUTABLE,
      darwinDeps(cacheRoot, [
        '/System/Library/Fonts',
        '/System/Library/Fonts/Supplemental',
        MAC_BUNDLED_FONT_DIRECTORY,
      ]),
    )

    const content = readConfig(environment)
    expect(content).toContain('<!DOCTYPE fontconfig')
    expect(content).toContain('<dir>/System/Library/Fonts</dir>')
    expect(content).toContain('<dir>/System/Library/Fonts/Supplemental</dir>')
    // LibreOffice 自带字体目录必须保留，否则换掉默认 fontconfig 会丢掉拉丁字体。
    expect(content).toContain(`<dir>${MAC_BUNDLED_FONT_DIRECTORY}</dir>`)
    // 不存在的目录被过滤。
    expect(content).not.toContain('<dir>/Library/Fonts</dir>')
    expect(content).not.toContain(`<dir>${MAC_HOME}/Library/Fonts</dir>`)
    expect(content).not.toContain('<dir>/System/Library/AssetsV2/com_apple_MobileAsset_Font8</dir>')

    // 常用 Windows 中文字体名映射到 macOS 系统字体。
    expect(content).toContain('<family>SimSun</family>')
    expect(content).toContain('<family>宋体</family>')
    expect(content).toContain('<family>Songti SC</family>')
    expect(content).toContain('<family>微软雅黑</family>')
    expect(content).toContain('<family>DengXian</family>')
    expect(content).toContain('<family>PingFang SC</family>')
    expect(content).toContain('<family>FangSong</family>')
    expect(content).toContain('<family>STFangsong</family>')
    expect(content).toContain('<family>KaiTi</family>')
    expect(content).toContain('<family>Kaiti SC</family>')

    // 通用兜底 match：任意字体族都弱追加 PingFang SC。
    expect(content).toMatch(/<match target="pattern">[\s\S]*mode="append"[\s\S]*PingFang SC/)

    // cachedir 与 XDG_CACHE_HOME 必须位于可写的缓存根目录下。
    expect(content).toMatch(/<cachedir>[^<]*fontconfig-cache<\/cachedir>/)
    const xdgCacheDirectory = environment.XDG_CACHE_HOME
    expect(xdgCacheDirectory?.startsWith(cacheRoot)).toBe(true)
    expect(existsSync(xdgCacheDirectory as string)).toBe(true)
    expect(existsSync(join(xdgCacheDirectory as string, '..', 'fontconfig-cache'))).toBe(true)
  })

  it('已有 FONTCONFIG_FILE 时尊重用户配置并返回空对象', () => {
    const cacheRoot = createCacheRoot()
    const environment = sofficeFontConfigEnv(MAC_EXECUTABLE, {
      ...darwinDeps(cacheRoot, ['/System/Library/Fonts']),
      env: { FONTCONFIG_FILE: '/custom/fonts.conf' },
    })

    expect(environment).toEqual({})
    expect(readdirSync(cacheRoot)).toEqual([])
  })

  it('Windows 不启用 fontconfig，返回空对象', () => {
    const cacheRoot = createCacheRoot()
    const environment = sofficeFontConfigEnv(
      'C:/Program Files/LibreOffice/program/soffice.exe',
      {
        platform: 'win32',
        env: {},
        homeDir: 'C:/Users/test',
        exists: () => true,
        cacheRoot,
      },
    )

    expect(environment).toEqual({})
    expect(readdirSync(cacheRoot)).toEqual([])
  })

  it('macOS 系统字体目录全部不存在时返回空对象', () => {
    const cacheRoot = createCacheRoot()
    const environment = sofficeFontConfigEnv(MAC_EXECUTABLE, {
      ...darwinDeps(cacheRoot, []),
      exists: () => false,
    })

    expect(environment).toEqual({})
    expect(readdirSync(cacheRoot)).toEqual([])
  })

  it('只把存在的目录写进配置', () => {
    const cacheRoot = createCacheRoot()
    const environment = sofficeFontConfigEnv(
      MAC_EXECUTABLE,
      darwinDeps(cacheRoot, ['/System/Library/Fonts']),
    )

    const content = readConfig(environment)
    expect(content).toContain('<dir>/System/Library/Fonts</dir>')
    expect(content).not.toContain('<dir>/System/Library/Fonts/Supplemental</dir>')
    expect(content).not.toContain('<dir>/Library/Fonts</dir>')
  })

  it('从 soffice 可执行文件的真实位置推导 LibreOffice 自带字体目录', () => {
    const cacheRoot = createCacheRoot()
    const customExecutable = '/opt/custom/LibreOffice.app/Contents/MacOS/soffice'
    const derivedBundledDirectory = '/opt/custom/LibreOffice.app/Contents/Resources/fonts/truetype'
    const environment = sofficeFontConfigEnv(customExecutable, {
      platform: 'darwin',
      env: {},
      homeDir: MAC_HOME,
      // 只让系统字体目录和“推导出来的”自带字体目录存在，不用 /Applications 回退兜底。
      exists: existingDirectories(['/System/Library/Fonts', derivedBundledDirectory]),
      cacheRoot,
    })

    const content = readConfig(environment)
    expect(content).toContain(`<dir>${derivedBundledDirectory}</dir>`)
    expect(content).not.toContain('/Applications/LibreOffice.app')
  })

  it('同一 (平台, 可执行文件, 目录列表) 重复调用复用同一份配置', () => {
    const cacheRoot = createCacheRoot()
    const first = sofficeFontConfigEnv(
      MAC_EXECUTABLE,
      darwinDeps(cacheRoot, ['/System/Library/Fonts']),
    )
    const firstContent = readConfig(first)

    const second = sofficeFontConfigEnv(
      MAC_EXECUTABLE,
      darwinDeps(cacheRoot, ['/System/Library/Fonts']),
    )
    expect(second).toEqual(first)
    expect(readFileSync(first.FONTCONFIG_FILE as string, 'utf8')).toBe(firstContent)

    // 配置被外部改坏时按内容比对重新写入。
    writeFileSync(first.FONTCONFIG_FILE as string, 'corrupted', 'utf8')
    const third = sofficeFontConfigEnv(
      MAC_EXECUTABLE,
      darwinDeps(cacheRoot, ['/System/Library/Fonts']),
    )
    expect(third).toEqual(first)
    expect(readFileSync(first.FONTCONFIG_FILE as string, 'utf8')).toBe(firstContent)
  })

  it('Linux 配置 include 发行版自带配置并由可执行文件推导 LibreOffice 字体目录', () => {
    const cacheRoot = createCacheRoot()
    const bundled = '/usr/lib/libreoffice/share/fonts/truetype'
    const environment = sofficeFontConfigEnv('/usr/lib/libreoffice/program/soffice', {
      platform: 'linux',
      env: {},
      homeDir: '/home/test',
      exists: existingDirectories(['/usr/share/fonts', bundled]),
      cacheRoot,
    })

    const content = readConfig(environment)
    expect(content).toContain('<include ignore_missing="yes">/etc/fonts/fonts.conf</include>')
    expect(content).toContain('<dir>/usr/share/fonts</dir>')
    // 可执行文件推导与固定候选去重后只出现一次。
    expect(content.split(`<dir>${bundled}</dir>`)).toHaveLength(2)
    // 平台专属的 macOS 别名不应出现在 Linux 配置里。
    expect(content).not.toContain('<family>宋体</family>')
  })
})
