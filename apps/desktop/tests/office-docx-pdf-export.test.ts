import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/logging/desktop-logger', () => ({ logDesktop: vi.fn() }))

const { convertOfficeFileToPdf } = vi.hoisted(() => ({
  convertOfficeFileToPdf: vi.fn(),
}))

vi.mock('../src/main/office/legacy-convert', () => ({ convertOfficeFileToPdf }))

import { exportDocxToPdf } from '../src/main/office/docx-pdf-export'

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'everroom-docx-export-'))
  await writeFile(join(directory, 'storage.docx'), Buffer.from('PK\u0003\u0004'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
  vi.clearAllMocks()
})

function makeRegistry(exportImpl: (fileId: string, outPath: string) => Promise<unknown>) {
  return {
    exportDocxPdf: vi.fn(exportImpl),
  } as unknown as Parameters<typeof exportDocxToPdf>[0]['registry']
}

describe('exportDocxToPdf（genoffice 优先、LibreOffice 回退）', () => {
  it('genoffice 成功：直接返回，不碰 LibreOffice', async () => {
    const registry = makeRegistry(async (_id, outPath) => ({ ok: true, path: outPath }))

    const outcome = await exportDocxToPdf({
      registry,
      fileId: 'file-1',
      storagePath: join(directory, 'storage.docx'),
      originalName: '报告.docx',
      targetDir: join(directory, 'exports'),
    })

    expect(outcome).toEqual({
      ok: true,
      pdfPath: join(directory, 'exports', '报告.pdf'),
      engine: 'genoffice',
    })
    expect(convertOfficeFileToPdf).not.toHaveBeenCalled()
  })

  it('运行时不支持（老 genoffice 构建）：回退 LibreOffice', async () => {
    const registry = makeRegistry(async () => ({ ok: false, reason: 'unsupported' }))
    const pdfPath = join(directory, 'exports', '报告.pdf')
    convertOfficeFileToPdf.mockResolvedValue({ pdfPath })

    const outcome = await exportDocxToPdf({
      registry,
      fileId: 'file-1',
      storagePath: join(directory, 'storage.docx'),
      originalName: '报告.docx',
      targetDir: join(directory, 'exports'),
    })

    expect(outcome).toEqual({ ok: true, pdfPath, engine: 'libreoffice' })
    expect(convertOfficeFileToPdf).toHaveBeenCalledTimes(1)
  })

  it('genoffice 渲染失败：回退 LibreOffice（给出 soffice 自己的文案）', async () => {
    const registry = makeRegistry(async () => ({
      ok: false,
      reason: 'error',
      message: 'renderer did not reply in time',
    }))
    const pdfPath = join(directory, 'exports', '报告.pdf')
    convertOfficeFileToPdf.mockResolvedValue({ pdfPath })

    const outcome = await exportDocxToPdf({
      registry,
      fileId: 'file-1',
      storagePath: join(directory, 'storage.docx'),
      originalName: '报告.docx',
      targetDir: join(directory, 'exports'),
    })

    expect(outcome).toEqual({ ok: true, pdfPath, engine: 'libreoffice' })
  })

  it('两条路都不可用：返回带说明的失败（不再只提 LibreOffice）', async () => {
    const registry = makeRegistry(async () => ({ ok: false, reason: 'unsupported' }))
    convertOfficeFileToPdf.mockResolvedValue({ unavailable: true })

    const outcome = await exportDocxToPdf({
      registry,
      fileId: 'file-1',
      storagePath: join(directory, 'storage.docx'),
      originalName: '报告.docx',
      targetDir: join(directory, 'exports'),
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.message).toContain('内置 PDF 引擎不可用')
      expect(outcome.message).toContain('LibreOffice')
    }
  })

  it('registry 抛异常：回退 LibreOffice 而不是整体失败', async () => {
    const registry = makeRegistry(async () => {
      throw new Error('boom')
    })
    const pdfPath = join(directory, 'exports', '报告.pdf')
    convertOfficeFileToPdf.mockResolvedValue({ pdfPath })

    const outcome = await exportDocxToPdf({
      registry,
      fileId: 'file-1',
      storagePath: join(directory, 'storage.docx'),
      originalName: '报告.docx',
      targetDir: join(directory, 'exports'),
    })

    expect(outcome).toEqual({ ok: true, pdfPath, engine: 'libreoffice' })
  })
})
