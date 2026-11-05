import { describe, expect, it, vi } from 'vitest'

import {
  isOsOpenDocumentPath,
  openDocumentFromSystem,
  OsOpenQueue,
  osOpenPathsFromArgv,
} from '../src/main/office/os-open'

describe('os-open document routing', () => {
  it('accepts the formats the embedded Office preview can open', () => {
    for (const name of ['a.docx', 'a.DOC', 'b.xlsx', 'b.xls', 'b.xlsm', 'c.pptx', 'c.ppt']) {
      expect(isOsOpenDocumentPath(`/tmp/${name}`)).toBe(true)
    }
  })

  it('ignores switches, empty values and unrelated formats', () => {
    for (const value of [undefined, null, '', '-psn_0_123', '--remote-debugging-port=9222', '/tmp/a.pdf', '/tmp/a.txt', '/tmp/a.docx.txt']) {
      expect(isOsOpenDocumentPath(value)).toBe(false)
    }
  })

  it('keeps only document arguments from argv, de-duplicated', () => {
    const paths = osOpenPathsFromArgv([
      '/Applications/EverOffice.app/Contents/MacOS/EverOffice',
      '--no-sandbox',
      '/tmp/report.docx',
      './notes.pptx',
      '/tmp/report.docx',
      '/tmp/other.txt',
    ])
    expect(paths).toEqual(['/tmp/report.docx', './notes.pptx'])
  })

  it('queues requests until a handler is installed, then drains in order', async () => {
    const queue = new OsOpenQueue()
    const handled: string[] = []
    queue.push('/tmp/first.docx', '/tmp/second.xlsx')
    expect(queue.size).toBe(2)

    queue.setHandler(async (filePath) => {
      handled.push(filePath)
    })
    await vi.waitFor(() => expect(queue.size).toBe(0))
    expect(handled).toEqual(['/tmp/first.docx', '/tmp/second.xlsx'])
  })

  it('keeps draining after a handler failure', async () => {
    const queue = new OsOpenQueue()
    const handled: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    queue.setHandler(async (filePath) => {
      if (filePath.endsWith('broken.docx')) throw new Error('import failed')
      handled.push(filePath)
    })
    queue.push('/tmp/broken.docx', '/tmp/ok.pptx')
    await vi.waitFor(() => expect(queue.size).toBe(0))
    expect(handled).toEqual(['/tmp/ok.pptx'])
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})

describe('openDocumentFromSystem', () => {
  function handlers(importFile: Parameters<typeof openDocumentFromSystem>[1]['importFile']) {
    return {
      importFile,
      open: vi.fn(),
      fail: vi.fn(),
    }
  }

  it('imports the file and hands it to the renderer', async () => {
    const deps = handlers(async () => ({
      fileId: 'file-1',
      filename: '季度汇报.pptx',
      error: null,
      skippedReason: null,
    }))
    await openDocumentFromSystem('/Users/me/季度汇报.pptx', deps)
    expect(deps.open).toHaveBeenCalledWith({ fileId: 'file-1', originalName: '季度汇报.pptx' })
    expect(deps.fail).not.toHaveBeenCalled()
  })

  it('reports an unsupported format instead of opening', async () => {
    const deps = handlers(async () => ({
      fileId: null,
      filename: 'old.doc',
      error: null,
      skippedReason: 'unsupported_format',
    }))
    await openDocumentFromSystem('/Users/me/old.doc', deps)
    expect(deps.open).not.toHaveBeenCalled()
    expect(deps.fail).toHaveBeenCalledWith('old.doc', { kind: 'unsupported_format' })
  })

  it('surfaces an import error', async () => {
    const deps = handlers(async () => {
      throw new Error('gateway offline')
    })
    await openDocumentFromSystem('/Users/me/report.xlsx', deps)
    expect(deps.open).not.toHaveBeenCalled()
    expect(deps.fail).toHaveBeenCalledWith('report.xlsx', { kind: 'error', message: 'gateway offline' })
  })

  it('falls back to the file name when the import result has none', async () => {
    const deps = handlers(async () => ({
      fileId: 'file-2',
      filename: '',
      error: null,
      skippedReason: null,
    }))
    await openDocumentFromSystem('/Users/me/未命名.docx', deps)
    expect(deps.open).toHaveBeenCalledWith({ fileId: 'file-2', originalName: '未命名.docx' })
  })

  it('reports a not-ready file service', async () => {
    const deps = handlers(async () => null)
    await openDocumentFromSystem('/Users/me/report.docx', deps)
    expect(deps.open).not.toHaveBeenCalled()
    expect(deps.fail).toHaveBeenCalledWith('report.docx', { kind: 'service_unavailable' })
  })
})
