import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const SOFFICE_TIMEOUT_MS = 60_000

export type LegacyOfficeTarget = 'docx' | 'xlsx' | 'pptx'

/** 二进制旧格式 → 内嵌预览所需的 OOXML 转换目标。 */
const LEGACY_OFFICE_TARGETS: Record<string, LegacyOfficeTarget> = {
  '.doc': 'docx',
  '.xls': 'xlsx',
  '.ppt': 'pptx',
}

export function legacyOfficeTargetFor(fileName: string): LegacyOfficeTarget | null {
  return LEGACY_OFFICE_TARGETS[extname(fileName).toLowerCase()] ?? null
}

function sofficeCandidates(): string[] {
  return [
    ...(process.env.EVERROOM_SOFFICE_PATH ? [process.env.EVERROOM_SOFFICE_PATH] : []),
    'soffice',
    'soffice.exe',
    'libreoffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    ...(process.env.PROGRAMFILES
      ? [join(process.env.PROGRAMFILES, 'LibreOffice', 'program', 'soffice.exe')]
      : []),
    ...(process.env['PROGRAMFILES(X86)']
      ? [join(process.env['PROGRAMFILES(X86)'], 'LibreOffice', 'program', 'soffice.exe')]
      : []),
  ]
}

/**
 * 用 LibreOffice 把 .doc/.xls/.ppt 转成 OOXML，落盘到 targetDir 下
 * `<原文件名去扩展名>.<targetExt>`（已存在即视为同一 (fileId, hash) 版本的缓存命中）。
 * 找不到 soffice 或转换失败时抛错，由调用方决定是否回退外部应用打开。
 */
export async function convertLegacyOfficeFile(
  sourcePath: string,
  originalName: string,
  targetDir: string,
  targetExt: LegacyOfficeTarget,
): Promise<string> {
  const base = basename(originalName, extname(originalName)) || 'document'
  const target = join(targetDir, `${base}.${targetExt}`)
  mkdirSync(targetDir, { recursive: true })
  if (existsSync(target)) return target

  // soffice 按扩展名识别格式，而 CAS blob 无扩展名，先在临时目录落一份带原始扩展名的输入。
  const workDirectory = await mkdtemp(join(tmpdir(), 'everroom-office-'))
  try {
    const inputPath = join(workDirectory, `input${extname(originalName).toLowerCase()}`)
    const profilePath = join(workDirectory, 'profile')
    copyFileSync(sourcePath, inputPath)
    const args = [
      '--headless',
      '--nologo',
      '--nodefault',
      '--norestore',
      '--nolockcheck',
      `-env:UserInstallation=${pathToFileURL(profilePath).href}`,
      '--convert-to',
      targetExt,
      '--outdir',
      workDirectory,
      inputPath,
    ]

    let converted = false
    for (const executable of [...new Set(sofficeCandidates())]) {
      try {
        await execFileAsync(executable, args, { timeout: SOFFICE_TIMEOUT_MS })
        converted = true
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`LibreOffice 转换 ${originalName} 失败：${detail}`)
      }
    }
    if (!converted) {
      throw new Error(`未找到 LibreOffice（soffice），无法内嵌预览 ${originalName}`)
    }

    const generated = readdirSync(workDirectory).find((name) =>
      name.toLowerCase().endsWith(`.${targetExt}`),
    )
    if (!generated) {
      throw new Error(`LibreOffice 转换 ${originalName} 后没有生成 .${targetExt} 文件`)
    }
    copyFileSync(join(workDirectory, generated), target)
    return target
  } finally {
    await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}
