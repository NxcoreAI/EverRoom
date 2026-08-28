import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

vi.mock('../src/main/office/office-runtime', () => ({
  loadPreparedGenOfficeRuntime: vi.fn(() => runtime),
  preparedGenOfficeFixture: vi.fn(() => '/fixtures/simple.docx'),
}))
vi.mock('../src/main/office/office-view-manager', () => ({
  OfficeViewManager: { createWithRuntime: vi.fn(() => makeView('docx')) },
  prepareOfficeDocument: vi.fn(async () => '/tmp/workdir/document.docx'),
}))
vi.mock('../src/main/office/slides-view-manager', () => ({
  SlidesViewManager: { create: vi.fn(async () => makeView('slides')) },
}))
vi.mock('../src/main/office/spreadsheet-view-manager', () => ({
  SpreadsheetViewManager: { create: vi.fn(async () => makeView('spreadsheet')) },
}))

import { OfficePreviewRegistry, officePreviewKindFor } from '../src/main/office/office-preview-registry'
import { OFFICE_TEST_INSTANCE_ID } from '../src/shared/sources'

/** 每个视图实例的 mock：记录 setActive/dispose 调用。 */
const viewCalls: { kind: string; setActive: boolean[]; disposed: boolean }[] = []
function makeView(kind: string) {
  const entry = { kind, setActive: [] as boolean[], disposed: false }
  viewCalls.push(entry)
  return {
    setActive: vi.fn((active: boolean) => entry.setActive.push(active)),
    dispose: vi.fn(() => { entry.disposed = true }),
  }
}

const runtime = {
  docs: {
    setDocsShellWindow: vi.fn(),
    setActiveDocsResolver: vi.fn(),
  },
  sheets: {
    setSheetsShellWindow: vi.fn(),
    setActiveSheetsWebContents: vi.fn(),
    stopSheetsSidecar: vi.fn(),
  },
  slides: {
    setSlidesShellWindow: vi.fn(),
    setActiveSlidesWebContents: vi.fn(),
  },
}

function makeWindow(): BrowserWindow {
  return {
    contentView: { addChildView: vi.fn() },
    once: vi.fn(),
    getContentBounds: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
  } as unknown as BrowserWindow
}

function file(
  id: string,
  name: string,
  hash = `${id}000000000000000000000000000000000000000000000000000000000`.slice(0, 64),
) {
  return { id, contentHash: hash, originalName: name, storagePath: `/blobs/${id}` }
}

describe('officePreviewKindFor', () => {
  it('maps OOXML and legacy binary office extensions', () => {
    expect(officePreviewKindFor('a.docx')).toBe('docx')
    expect(officePreviewKindFor('a.doc')).toBe('docx')
    expect(officePreviewKindFor('b.pptx')).toBe('slides')
    expect(officePreviewKindFor('b.ppt')).toBe('slides')
    expect(officePreviewKindFor('c.xlsx')).toBe('spreadsheet')
    expect(officePreviewKindFor('c.xlsm')).toBe('spreadsheet')
    expect(officePreviewKindFor('c.xls')).toBe('spreadsheet')
    expect(officePreviewKindFor('f.pdf')).toBeNull()
  })
})

describe('OfficePreviewRegistry', () => {
  let registry: OfficePreviewRegistry

  beforeEach(() => {
    vi.clearAllMocks()
    viewCalls.length = 0
    registry = new OfficePreviewRegistry()
  })

  it('opens a preview per extension family without auto-activating it', async () => {
    const window = makeWindow()
    const descriptor = await registry.open(window, file('file-1', 'file-1.docx'))

    expect(descriptor).toMatchObject({ id: 'file-1', kind: 'docx', title: 'file-1.docx' })
    expect(viewCalls).toHaveLength(1)
    // 渲染端是焦点唯一事实源：open 不自动激活。
    expect(viewCalls[0]!.setActive).toEqual([])
  })

  it('reuses the instance for the same file and content hash', async () => {
    const window = makeWindow()
    await registry.open(window, file('file-1', 'file-1.docx'))
    await registry.open(window, file('file-1', 'file-1.docx'))

    expect(viewCalls).toHaveLength(1)
    expect(viewCalls[0]!.disposed).toBe(false)
  })

  it('rebuilds in place when the content hash changes', async () => {
    const window = makeWindow()
    await registry.open(window, file('file-1', 'file-1.docx', 'a'.repeat(64)))
    await registry.open(window, file('file-1', 'file-1.docx', 'b'.repeat(64)))

    expect(viewCalls).toHaveLength(2)
    expect(viewCalls[0]!.disposed).toBe(true)
    expect(viewCalls[1]!.disposed).toBe(false)
  })

  it('activates exactly one instance and deactivates the rest', async () => {
    const window = makeWindow()
    await registry.open(window, file('file-1', 'file-1.docx'))
    await registry.open(window, file('file-2', 'file-2.pptx'))

    expect(registry.setActive('file-1')).toBe(true)
    expect(viewCalls[0]!.setActive).toEqual([true])
    // 激活一个实例时其余实例一律隐藏。
    expect(viewCalls[1]!.setActive).toEqual([false])

    expect(registry.setActive('file-2')).toBe(true)
    expect(viewCalls[0]!.setActive).toEqual([true, false])
    expect(viewCalls[1]!.setActive).toEqual([false, true])

    expect(registry.setActive(null)).toBe(true)
    expect(viewCalls[0]!.setActive).toEqual([true, false, false])
    expect(viewCalls[1]!.setActive).toEqual([false, true, false])

    expect(registry.setActive('missing')).toBe(false)
  })

  it('stops the sheets sidecar once the last spreadsheet closes, keeping other instances alive', async () => {
    const window = makeWindow()
    await registry.open(window, file('file-1', 'file-1.xlsx'))
    await registry.open(window, file('file-2', 'file-2.docx'))

    registry.close('file-1')
    expect(runtime.sheets.stopSheetsSidecar).toHaveBeenCalledTimes(1)
    // 还有 docx 实例：共享 shell window 不能被清掉。
    expect(runtime.docs.setDocsShellWindow).not.toHaveBeenCalledWith(null)

    registry.close('file-2')
    expect(runtime.docs.setActiveDocsResolver).toHaveBeenCalledWith(null)
    expect(runtime.docs.setDocsShellWindow).toHaveBeenCalledWith(null)
    expect(runtime.slides.setSlidesShellWindow).toHaveBeenCalledWith(null)
    expect(viewCalls.every((view) => view.disposed)).toBe(true)
  })

  it('keeps the sidecar while another spreadsheet stays open', async () => {
    const window = makeWindow()
    await registry.open(window, file('file-1', 'file-1.xlsx'))
    await registry.open(window, file('file-2', 'file-2.xlsm'))

    registry.close('file-1')
    expect(runtime.sheets.stopSheetsSidecar).not.toHaveBeenCalled()

    registry.close('file-2')
    expect(runtime.sheets.stopSheetsSidecar).toHaveBeenCalledTimes(1)
  })

  it('disposeAll tears down every instance and the shared runtime', async () => {
    const window = makeWindow()
    await registry.open(window, file('file-1', 'file-1.docx'))
    await registry.open(window, file('file-2', 'file-2.pptx'))
    registry.setActive('file-1')

    registry.disposeAll()

    expect(viewCalls.every((view) => view.disposed)).toBe(true)
    expect(runtime.docs.setActiveDocsResolver).toHaveBeenCalledWith(null)
    expect(runtime.sheets.stopSheetsSidecar).toHaveBeenCalledTimes(1)
    // disposeAll 后仍可继续使用（窗口重建场景）。
    await registry.open(window, file('file-3', 'file-3.docx'))
    expect(viewCalls.filter((view) => !view.disposed)).toHaveLength(1)
  })

  it('rebinds to a new window by disposing the previous instances', async () => {
    const first = makeWindow()
    const second = makeWindow()
    await registry.open(first, file('file-1', 'file-1.docx'))
    await registry.open(second, file('file-2', 'file-2.docx'))

    expect(viewCalls[0]!.disposed).toBe(true)
    expect(viewCalls[1]!.disposed).toBe(false)
  })

  it('exposes the dev test instance under the shared constant id', () => {
    const window = makeWindow()
    const descriptor = registry.openTest(window)

    expect(descriptor.kind).toBe('docx')
    expect(registry.setActive(OFFICE_TEST_INSTANCE_ID)).toBe(true)
    expect(viewCalls[0]!.setActive).toEqual([true])
  })
})
