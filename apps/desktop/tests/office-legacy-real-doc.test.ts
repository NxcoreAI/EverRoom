import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { convertLegacyOfficeFile } from '../src/main/office/legacy-convert'

/**
 * 真实用户模版回归：广州城市理工学院《本科毕业设计（论文）外文翻译》.doc
 * （OLE2 复合文档，含封面字段表）。未装 LibreOffice 的机器上点 AI 面板 👁 预览
 * 无反应——修复后 textutil 兜底转 docx，预览开在右侧工作区。
 *
 * 该模版二进制不入库（用户文件）；测试在 EVERROOM_DOC_FIXTURE 指向本机 CAS
 * blob 时运行，否则跳过（CI 无该文件）。
 */

const FIXTURE = process.env.EVERROOM_DOC_FIXTURE ?? ''
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe.skipIf(!FIXTURE)('真实 .doc 模版（外文翻译封面）', () => {
  it('soffice 缺失时 textutil 兜底可转出含封面文字的 docx', { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'everroom-real-doc-'))
    temporaryDirectories.push(root)
    const source = join(root, 'input.doc')
    execFileSync('/bin/cp', [FIXTURE, source])

    const target = await convertLegacyOfficeFile(source, '附件4-6-1：毕业设计（论文）外文翻译 (1).doc', join(root, 'out'), 'docx')
    expect(existsSync(target)).toBe(true)
    const bytes = readFileSync(target)
    // zip 容器
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b]))
    // 正文在 zip 里是压缩的：解开 document.xml 验证封面文字保留。
    const { execFileSync: exec } = await import('node:child_process')
    const xml = exec('/usr/bin/unzip', ['-p', target, 'word/document.xml']).toString('utf8')
    expect(xml).toContain('本科毕业设计')
    expect(xml).toContain('广州城市理工学院')
  })
})
