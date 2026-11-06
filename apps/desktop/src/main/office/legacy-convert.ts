import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { sofficeFontConfigEnv } from './office-fontconfig'

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

interface SofficeConversionMessages {
  /** soffice 存在但执行出错时的错误文案（沿用原有措辞）。 */
  failure: (detail: string) => string
  /** soffice 执行成功但没有产出目标文件时的错误文案。 */
  missingOutput: string
}

/**
 * 在 workDirectory 里调用 soffice 把 inputPath 转成 targetExt，返回生成的文件名。
 * 找不到任何 soffice 可执行文件时返回 null；执行失败或没产出文件时按调用方文案抛错。
 */
async function runSofficeConversion(
  workDirectory: string,
  inputPath: string,
  targetExt: string,
  messages: SofficeConversionMessages,
): Promise<string | null> {
  const profilePath = join(workDirectory, 'profile')
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
      await execFileAsync(executable, args, {
        timeout: SOFFICE_TIMEOUT_MS,
        // 注入 fontconfig 配置，让 LibreOffice 看见系统字体；
        // 否则 macOS 上 Word 文档的中文会因缺字形导出成空白方框。
        env: { ...process.env, ...sofficeFontConfigEnv(executable) },
      })
      converted = true
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(messages.failure(detail))
    }
  }
  if (!converted) return null

  const generated = readdirSync(workDirectory).find((name) =>
    name.toLowerCase().endsWith(`.${targetExt}`),
  )
  if (!generated) throw new Error(messages.missingOutput)
  return generated
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
    copyFileSync(sourcePath, inputPath)
    const generated = await runSofficeConversion(workDirectory, inputPath, targetExt, {
      failure: (detail) => `LibreOffice 转换 ${originalName} 失败：${detail}`,
      missingOutput: `LibreOffice 转换 ${originalName} 后没有生成 .${targetExt} 文件`,
    })
    if (!generated) {
      throw new Error(`未找到 LibreOffice（soffice），无法内嵌预览 ${originalName}`)
    }
    copyFileSync(join(workDirectory, generated), target)
    return target
  } finally {
    await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * 把 Office 文件转成 PDF，落到 targetDir/<原文件名>.pdf 并返回路径。
 *
 * 找不到 LibreOffice 时返回 { unavailable: true }（而不是抛错）——
 * 「本机没装转换器」是可预期的环境状态，UI 需要给出可执行的说明。
 */
export async function convertOfficeFileToPdf(
  sourcePath: string,
  originalName: string,
  targetDir: string,
): Promise<{ pdfPath: string } | { unavailable: true }> {
  const base = basename(originalName, extname(originalName)) || 'document'
  mkdirSync(targetDir, { recursive: true })
  const target = join(targetDir, `${base}.pdf`)
  const workDirectory = await mkdtemp(join(tmpdir(), 'everroom-pdf-'))
  try {
    const inputPath = join(workDirectory, `input${extname(originalName).toLowerCase()}`)
    copyFileSync(sourcePath, inputPath)
    const generated = await runSofficeConversion(workDirectory, inputPath, 'pdf', {
      failure: (detail) => `LibreOffice 导出 PDF 失败：${detail}`,
      missingOutput: 'LibreOffice 转换后没有生成 PDF 文件',
    })
    if (!generated) return { unavailable: true }
    copyFileSync(join(workDirectory, generated), target)
    return { pdfPath: target }
  } finally {
    await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}
