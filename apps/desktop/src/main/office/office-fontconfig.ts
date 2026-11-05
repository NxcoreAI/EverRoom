import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** fontconfig 配置/缓存的根目录（放在系统临时目录下，可随时清理）。 */
const FONTCONFIG_ROOT_DIRECTORY = 'everroom-soffice-fontconfig'

/** 通用兜底字体：文档里的字体族全部未命中时弱绑定到它，保证 CJK 有字形可用。 */
const MAC_CJK_FALLBACK_FAMILY = 'PingFang SC'

interface FontAlias {
  family: string
  prefer: string
}

/**
 * macOS 上把 Office 文档常用的 Windows 中文字体名映射到系统自带中文字体。
 * 不映射的话 fontconfig 会把 SimSun/微软雅黑 等当成不存在的字体，中文渲染成空白方框。
 */
const MAC_CJK_FONT_ALIASES: FontAlias[] = [
  { family: 'SimSun', prefer: 'Songti SC' },
  { family: '宋体', prefer: 'Songti SC' },
  { family: 'SimHei', prefer: 'Heiti SC' },
  { family: '黑体', prefer: 'Heiti SC' },
  { family: 'Microsoft YaHei', prefer: 'PingFang SC' },
  { family: '微软雅黑', prefer: 'PingFang SC' },
  { family: '等线', prefer: 'PingFang SC' },
  { family: 'DengXian', prefer: 'PingFang SC' },
  { family: 'FangSong', prefer: 'STFangsong' },
  { family: '仿宋', prefer: 'STFangsong' },
  { family: 'KaiTi', prefer: 'Kaiti SC' },
  { family: '楷体', prefer: 'Kaiti SC' },
]

/**
 * 单测注入点：平台、环境变量、home 目录、字体目录存在性探测、缓存根目录。
 * 默认全部走真实进程环境，因此在生产代码里直接调用即可。
 */
export interface SofficeFontConfigDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDir?: string
  /** 仅用于判断字体目录是否存在；配置文件/缓存目录的读写始终走真实文件系统。 */
  exists?: (path: string) => boolean
  cacheRoot?: string
}

function platformFontDirectories(platform: NodeJS.Platform, homeDirectory: string): string[] {
  if (platform === 'darwin') {
    return [
      '/System/Library/Fonts',
      '/System/Library/Fonts/Supplemental',
      '/Library/Fonts',
      join(homeDirectory, 'Library/Fonts'),
      // 苹果按需下载的字体资产（部分用户机器上的中文字体只在这里）。
      '/System/Library/AssetsV2/com_apple_MobileAsset_Font8',
    ]
  }
  if (platform === 'linux') {
    return [
      '/usr/share/fonts',
      '/usr/local/share/fonts',
      join(homeDirectory, '.local/share/fonts'),
      join(homeDirectory, '.fonts'),
    ]
  }
  // Windows 的 LibreOffice 不走 fontconfig，由 sofficeFontConfigEnv 提前返回。
  return []
}

/** 由 soffice 可执行文件位置推导 LibreOffice 自带字体目录，避免拉丁字体目录被替换后丢失。 */
function libreOfficeFontDirectories(executable: string, platform: NodeJS.Platform): string[] {
  const executableDirectory = isAbsolute(executable) ? dirname(executable) : null
  if (platform === 'darwin') {
    return [
      ...(executableDirectory
        ? // .app/Contents/MacOS/soffice → .app/Contents/Resources/fonts/truetype
          [resolve(executableDirectory, '../Resources/fonts/truetype')]
        : []),
      // homebrew 装的 soffice 只是指向 /Applications 下 .app 的包装脚本，
      // 由它推导不出真实安装位置，兜底已知安装路径。
      '/Applications/LibreOffice.app/Contents/Resources/fonts/truetype',
    ]
  }
  if (platform === 'linux') {
    return [
      ...(executableDirectory ? [resolve(executableDirectory, '../share/fonts/truetype')] : []),
      '/usr/lib/libreoffice/share/fonts/truetype',
    ]
  }
  return []
}

function uniqueExistingDirectories(
  candidates: string[],
  exists: (path: string) => boolean,
): string[] {
  const directories: string[] = []
  for (const candidate of candidates) {
    if (directories.includes(candidate)) continue
    if (!exists(candidate)) continue
    directories.push(candidate)
  }
  return directories
}

/** 同一 (平台, 可执行文件, 字体目录列表) 复用同一份配置，避免每次转换都重写。 */
function fontConfigCacheKey(
  platform: NodeJS.Platform,
  executable: string,
  fontDirectories: string[],
): string {
  const digest = createHash('sha256')
    .update([platform, executable, ...fontDirectories].join('\n'))
    .digest('hex')
  return `${platform}-${digest.slice(0, 16)}`
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderMacCjkRules(): string[] {
  const lines: string[] = []
  for (const alias of MAC_CJK_FONT_ALIASES) {
    lines.push(
      '  <alias>',
      `    <family>${escapeXml(alias.family)}</family>`,
      '    <prefer>',
      `      <family>${escapeXml(alias.prefer)}</family>`,
      '    </prefer>',
      '  </alias>',
    )
  }
  // 兜底：任何字体族都弱追加 PingFang SC。fontconfig 会为缺失的 CJK 字形继续找它。
  lines.push(
    '  <match target="pattern">',
    '    <edit name="family" mode="append" binding="weak">',
    `      <string>${escapeXml(MAC_CJK_FALLBACK_FAMILY)}</string>`,
    '    </edit>',
    '  </match>',
  )
  return lines
}

function renderFontConfig(options: {
  platform: NodeJS.Platform
  fontDirectories: string[]
  cacheDirectory: string
}): string {
  const { platform, fontDirectories, cacheDirectory } = options
  const lines = [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
    '<!-- 由 EverOffice 自动生成：让 LibreOffice 看见系统字体，请勿手动修改。 -->',
    '<fontconfig>',
  ]
  if (platform === 'linux') {
    // 保留发行版自带的 fontconfig 规则（默认目录、别名、渲染参数）。
    lines.push('  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>')
  }
  for (const directory of fontDirectories) {
    lines.push(`  <dir>${escapeXml(directory)}</dir>`)
  }
  lines.push(`  <cachedir>${escapeXml(cacheDirectory)}</cachedir>`)
  if (platform === 'darwin') lines.push(...renderMacCjkRules())
  lines.push('</fontconfig>', '')
  return lines.join('\n')
}

/** 临时文件 + rename 写入：并发转换同时配置同一 key 时也不会读到半截文件。 */
function writeFileAtomically(path: string, content: string): void {
  const temporaryPath = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    writeFileSync(temporaryPath, content, 'utf8')
    renameSync(temporaryPath, path)
  } catch (error) {
    rmSync(temporaryPath, { force: true })
    throw error
  }
}

/**
 * 生成让 LibreOffice 看见系统字体的 fontconfig 配置，返回需要注入 soffice 子进程的环境变量。
 *
 * 背景：macOS / Linux 版 LibreOffice 走 fontconfig，默认只看得到自己 bundle 内的字体，
 * 于是 Word 里的中文（SimSun/微软雅黑…）找不到字形，导出 PDF 全篇变成空白方框。
 * 这里生成一份最小 fontconfig 配置，把系统字体目录和 LibreOffice 自带字体目录都纳入，
 * 并把常见 Windows 中文字体名映射到系统字体。
 *
 * 以下情况返回空对象（尊重用户配置、绝不降级原有行为）：
 * - Windows（LibreOffice 不用 fontconfig）；
 * - 进程环境里已有 FONTCONFIG_FILE；
 * - macOS 上系统字体目录全部不存在（异常环境）；
 * - 任何异常（字体配置永远不能影响导出本身）。
 */
export function sofficeFontConfigEnv(
  executable: string,
  deps: SofficeFontConfigDeps = {},
): Record<string, string> {
  try {
    const platform = deps.platform ?? process.platform
    if (platform === 'win32') return {}

    const env = deps.env ?? process.env
    if (env.FONTCONFIG_FILE) return {}

    const exists = deps.exists ?? existsSync
    const homeDirectory = deps.homeDir ?? homedir()
    const systemDirectories = platformFontDirectories(platform, homeDirectory)
    if (platform === 'darwin' && !systemDirectories.some((directory) => exists(directory))) {
      return {}
    }

    const fontDirectories = uniqueExistingDirectories(
      [...systemDirectories, ...libreOfficeFontDirectories(executable, platform)],
      exists,
    )
    if (fontDirectories.length === 0) return {}

    const cacheRoot = deps.cacheRoot ?? join(tmpdir(), FONTCONFIG_ROOT_DIRECTORY)
    const directory = join(cacheRoot, fontConfigCacheKey(platform, executable, fontDirectories))
    const configPath = join(directory, 'fonts.conf')
    const cacheDirectory = join(directory, 'fontconfig-cache')
    const xdgCacheDirectory = join(directory, 'xdg-cache')

    // 0o700：临时目录下避免其他本机用户预置同名目录/配置。
    mkdirSync(cacheRoot, { recursive: true, mode: 0o700 })
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 })
    mkdirSync(xdgCacheDirectory, { recursive: true, mode: 0o700 })

    const content = renderFontConfig({ platform, fontDirectories, cacheDirectory })
    if (!existsSync(configPath) || readFileSync(configPath, 'utf8') !== content) {
      writeFileAtomically(configPath, content)
    }

    return { FONTCONFIG_FILE: configPath, XDG_CACHE_HOME: xdgCacheDirectory }
  } catch {
    return {}
  }
}
