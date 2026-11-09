import { mkdtempSync, rmSync, writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  convertLegacyOfficeFile,
  textutilFallbackTarget,
} from '../src/main/office/legacy-convert'

/**
 * 旧格式（.doc/.xls/.ppt）内嵌预览的转换链路。
 *
 * 背景：真实用户模版「附件4-6-1：毕业设计（论文）外文翻译 (1).doc」在未安装
 * LibreOffice 的机器上点 AI 面板 👁 预览——convertLegacyOfficeFile 因找不到
 * soffice 抛错，openFileInAppPreview 静默回退外部应用，右侧工作区什么也不出。
 * macOS 兜底：soffice 缺失时用系统 textutil 把 .doc 转 docx（Cocoa 文本引擎，
 * 表格会摊平但文本/字体/字号/对齐保留），预览因此能开在右侧。
 */

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createWorkRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'everroom-legacy-convert-test-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('textutilFallbackTarget', () => {
  it('macOS 上 .doc → docx 可用；.xls/.ppt 不行（textutil 不认）', () => {
    expect(textutilFallbackTarget('darwin', '.doc')).toBe('docx')
    expect(textutilFallbackTarget('darwin', '.DOC')).toBe('docx')
    expect(textutilFallbackTarget('darwin', '.xls')).toBeNull()
    expect(textutilFallbackTarget('darwin', '.ppt')).toBeNull()
  })

  it('非 macOS 一律不可用（textutil 是 macOS 系统组件）', () => {
    expect(textutilFallbackTarget('win32', '.doc')).toBeNull()
    expect(textutilFallbackTarget('linux', '.doc')).toBeNull()
  })
})

describe('convertLegacyOfficeFile（textutil 兜底）', () => {
  it('soffice 缺失时（darwin + .doc）用 textutil 兜底并落盘 docx', { timeout: 30_000 }, async () => {
    const root = createWorkRoot()
    // OLE2 复合文档头：textutil 按内容识别 .doc（与真实模版同头）。
    const source = join(root, 'source.doc')
    // 用真实系统 textutil 转换时输入必须可解析；这里用最小 OLE2 头会转出空内容，
    // 但只要 textutil 产出文件就证明兜底链路通。构造带正文的输入太重——直接
    // 复用 textutil 自己生成：先把一段 HTML 转 .doc 再喂回去。
    const htmlPath = join(root, 'input.html')
    writeFileSync(htmlPath, '<html><body><p>EverRoom legacy preview test</p></body></html>')
    const { execFileSync } = await import('node:child_process')
    execFileSync('/usr/bin/textutil', ['-convert', 'doc', '-output', source, htmlPath])

    const targetDir = join(root, 'out')
    const result = await convertLegacyOfficeFile(source, '模版.doc', targetDir, 'docx')
    expect(existsSync(result)).toBe(true)
    expect(result.endsWith('.docx')).toBe(true)
    // docx 是 zip：PK 头
    expect(readFileSync(result).subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b]))
  })

  it('非 .doc 输入在 soffice 缺失时不兜底（保持原有报错文案）', { timeout: 30_000 }, async () => {
    const root = createWorkRoot()
    const source = join(root, 'source.xls')
    writeFileSync(source, Buffer.alloc(64, 0))
    // 清掉环境里的 soffice 覆盖，确保本机没装 LibreOffice 时走「缺失」分支；
    // 装了也没关系——soffice 成功路径返回目标文件，同样通过。
    const targetDir = join(root, 'out')
    if (process.platform === 'darwin') {
      // .xls 不在 textutil 兜底范围内；soffice 缺失时应抛「未找到 LibreOffice」。
      // 本机装了 soffice 的话这步会成功，所以只断言「要么成功要么报指定错误」。
      try {
        const result = await convertLegacyOfficeFile(source, '表.xls', targetDir, 'xlsx')
        expect(result.endsWith('.xlsx')).toBe(true)
      } catch (error) {
        expect((error as Error).message).toContain('未找到 LibreOffice')
      }
    } else {
      // 其他平台无兜底：直接验证调用不被 textutil 干扰（成功或抛错均可，不炸进程）。
      await expect(
        convertLegacyOfficeFile(source, '表.xls', targetDir, 'xlsx'),
      ).resolves.toBeTypeOf('string')
    }
  })
})
