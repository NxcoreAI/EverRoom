import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FileCatalogDto } from '../src/shared/ingest'

vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      locale: 'zh-CN',
      t: (message: string, values?: Record<string, string | number>) =>
        actual.translate('zh-CN', message, values),
    }),
  }
})

import { FilesPage } from '../src/renderer/src/components/pages/FilesPage'

function catalogFile(index: number): FileCatalogDto {
  return {
    id: `file-${index}`,
    originalName: `document-${index}.md`,
    displayName: null,
    sharedTitle: `文档 ${index}`,
    sourceKind: 'manual-upload',
    sourceLabel: '手动上传',
    relativePath: null,
    provider: null,
    bytes: 100,
    dataType: 'document',
    agentCategory: 'document',
    summary: null,
    tags: [],
    processingState: 'ready',
    clusterId: null,
    contentHash: `hash-${index}`,
    parsed: true,
    updatedAt: new Date(Date.UTC(2026, 7, 21, 0, 0, 201 - index)).toISOString(),
  }
}

describe('FilesPage catalog refresh', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  afterEach(() => {
    if (renderer) act(() => renderer?.unmount())
    renderer = null
    vi.unstubAllGlobals()
  })

  it('hydrates every catalog page and merges later status updates', async () => {
    const catalog = Array.from({ length: 201 }, (_, index) => catalogFile(index))
    const list = vi.fn(async (_limit = 200, offset = 0) => ({
      items: catalog.slice(offset, offset + 200),
      total: catalog.length,
    }))
    let tick: (() => void) | null = null
    vi.stubGlobal('window', {
      nxcore: {
        files: { list },
        ingest: { listEvents: vi.fn().mockResolvedValue({ items: [], total: 0 }) },
      },
      setInterval: vi.fn((callback: () => void) => { tick = callback; return 1 }),
      clearInterval: vi.fn(),
    })
    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })

    await act(async () => {
      renderer = TestRenderer.create(<FilesPage />)
    })

    expect(list).toHaveBeenCalledWith(200, 0)
    expect(list).toHaveBeenCalledWith(200, 200)
    expect(renderer!.root.findAllByType('small')
      .some((node) => node.children.join('') === '201 份文件')).toBe(true)
    expect(renderer!.root.findAllByProps({ className: 'files-outcomes' })).toHaveLength(0)

    catalog[0] = { ...catalog[0]!, sharedTitle: '自动更新后的标题', processingState: 'ready' }
    await act(async () => { tick?.() })

    expect(JSON.stringify(renderer!.toJSON())).toContain('自动更新后的标题')
    expect(list).toHaveBeenCalledTimes(3)

    act(() => renderer?.unmount())
    renderer = null
    await act(async () => {
      renderer = TestRenderer.create(<FilesPage />)
    })

    expect(renderer!.root.findAllByType('small')
      .some((node) => node.children.join('') === '201 份文件')).toBe(true)
    expect(list).toHaveBeenCalledTimes(4)
    expect(list.mock.calls.filter(([, offset]) => offset === 200)).toHaveLength(1)
  })

  it('shows a single card title and reveals the original file from the card action', async () => {
    const file = { ...catalogFile(301), originalName: '访达测试.md', sharedTitle: '访达测试.md' }
    const reveal = vi.fn().mockResolvedValue(undefined)
    const list = vi.fn().mockResolvedValue({ items: [file], total: 1 })
    vi.stubGlobal('window', {
      nxcore: {
        files: { list, reveal },
        ingest: { listEvents: vi.fn().mockResolvedValue({ items: [], total: 0 }) },
      },
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
    })
    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })

    await act(async () => {
      renderer = TestRenderer.create(<FilesPage />)
    })

    const categoryCard = renderer!.root.findByProps({ className: 'file-category-card file-category-slate' })
    act(() => categoryCard.props.onClick())

    expect(renderer!.root.findAllByProps({ className: 'file-document-preview' })).toHaveLength(0)
    const title = renderer!.root.findByProps({ className: 'file-document-copy' })
    expect(title.findAllByType('strong')).toHaveLength(1)
    expect(title.findAllByType('small')).toHaveLength(0)

    const toolbar = renderer!.root.findByProps({ className: 'file-recognition-toolbar' })
    expect(toolbar.findByType('h2').children.join('')).toBe('文档')
    expect(toolbar.findAll((node) => node.children.join('') === '1 份文件')).toHaveLength(1)

    const revealButton = renderer!.root.findByProps({ 'aria-label': '在文件资源管理器中显示 访达测试.md' })
    await act(async () => {
      revealButton.props.onClick()
    })
    expect(reveal).toHaveBeenCalledWith(file.id)
  })

  it('restores drag import when a desktop directory is exposed through dataTransfer.items', async () => {
    const importedFile = { name: 'notes.md' } as File
    const importDropped = vi.fn().mockResolvedValue([{
      filename: 'notes.md',
      fileId: 'file-1',
      fileVersionId: 'version-1',
      eventId: null,
      dataType: null,
      deduped: false,
      pipelines: null,
      memoryResult: null,
      routeJobId: 'job-1',
      error: null,
    }])
    const list = vi.fn().mockResolvedValue({ items: [], total: 0 })
    const listEvents = vi.fn().mockResolvedValue({ items: [], total: 0 })
    vi.stubGlobal('window', {
      nxcore: {
        files: { list, importDropped },
        ingest: { listEvents },
      },
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
    })
    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })

    await act(async () => {
      renderer = TestRenderer.create(<FilesPage />)
    })

    const dropTarget = renderer!.root.findByProps({ className: 'page files-page-drop-target' })
    await act(async () => {
      await dropTarget.props.onDrop({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        dataTransfer: {
          types: ['Files'],
          files: [],
          items: [{ kind: 'file', getAsFile: () => importedFile }],
        },
      })
    })

    expect(importDropped).toHaveBeenCalledWith([importedFile])
  })

  it('walks a directory entry when the drag payload has no FileList entries', async () => {
    const importedFile = { name: 'nested.md' } as File
    const importDropped = vi.fn().mockResolvedValue([])
    vi.stubGlobal('window', {
      nxcore: {
        files: { list: vi.fn().mockResolvedValue({ items: [], total: 0 }), importDropped },
        ingest: { listEvents: vi.fn().mockResolvedValue({ items: [], total: 0 }) },
      },
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
    })
    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })

    await act(async () => {
      renderer = TestRenderer.create(<FilesPage />)
    })
    const directoryEntry = {
      isDirectory: true,
      isFile: false,
      createReader: () => {
        let read = false
        return {
          readEntries: (resolve: (entries: unknown[]) => void) => {
            resolve(read ? [] : [{
              isDirectory: false,
              isFile: true,
              file: (onFile: (file: File) => void) => onFile(importedFile),
            }])
            read = true
          },
        }
      },
    }
    const dropTarget = renderer!.root.findByProps({ className: 'page files-page-drop-target' })
    await act(async () => {
      await dropTarget.props.onDrop({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        dataTransfer: {
          types: ['Files'],
          files: [],
          items: [{ kind: 'file', getAsFile: () => null, webkitGetAsEntry: () => directoryEntry }],
        },
      })
    })

    expect(importDropped).toHaveBeenCalledWith([importedFile])
  })
})
