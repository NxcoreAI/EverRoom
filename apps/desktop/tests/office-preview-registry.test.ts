import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const { savedListenersByWc, createCalls, slidesCalls, sheetCalls } = vi.hoisted(() => ({
  savedListenersByWc: new Map<number, Set<(filePath: string) => void>>(),
  createCalls: { options: [] as Array<{ editable?: boolean }> },
  slidesCalls: { options: [] as Array<{ editable?: boolean }> },
  sheetCalls: { options: [] as Array<{ editable?: boolean }> },
}))

vi.mock('../src/main/office/office-runtime', () => ({
  loadPreparedGenOfficeRuntime: vi.fn(() => runtime),
  preparedGenOfficeFixture: vi.fn(() => '/fixtures/simple.docx'),
}))
vi.mock('../src/main/office/office-generation', () => ({
  onOfficeFileSaved: vi.fn((wcId: number, listener: (filePath: string) => void) => {
    const set = savedListenersByWc.get(wcId) ?? new Set()
    set.add(listener)
    savedListenersByWc.set(wcId, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) savedListenersByWc.delete(wcId)
    }
  }),
  wireOfficeSavedHooks: vi.fn(),
}))
vi.mock('../src/main/office/office-view-manager', () => ({
  OfficeViewManager: {
    createWithRuntime: vi.fn((_window: unknown, _docs: unknown, _path: string, options?: { editable?: boolean }) => {
      createCalls.options.push(options ?? {})
      return makeView('docx')
    }),
  },
  prepareOfficeDocument: vi.fn(async () => '/tmp/workdir/document.docx'),
}))
vi.mock('../src/main/office/slides-view-manager', () => ({
  SlidesViewManager: {
    create: vi.fn(async (_window: unknown, _slides: unknown, _file: unknown, options?: { editable?: boolean }) => {
      slidesCalls.options.push(options ?? {})
      return { ...makeView('slides'), documentPath: '/tmp/workdir/deck.pptx' }
    }),
  },
}))
vi.mock('../src/main/office/pdf-view-manager', () => ({
  PdfViewManager: { create: vi.fn(async () => makeView('pdf')) },
}))
vi.mock('../src/main/office/spreadsheet-view-manager', () => ({
  SpreadsheetViewManager: {
    create: vi.fn(async (_window: unknown, _sheets: unknown, _file: unknown, options?: { editable?: boolean }) => {
      sheetCalls.options.push(options ?? {})
      return { ...makeView('spreadsheet'), documentPath: '/tmp/workdir/book.xlsx' }
    }),
  },
}))

import { OfficePreviewRegistry, officePreviewKindFor } from '../src/main/office/office-preview-registry'
import { OFFICE_TEST_INSTANCE_ID } from '../src/shared/sources'

/** 每个视图实例的 mock：记录 setActive/dispose 调用；disposeNextCancel 控制下一次返回。 */
interface ViewRecord {
  kind: string
  setActive: boolean[]
  disposed: boolean
  webContentsId: number
  disposeNextCancel: boolean
}
const viewCalls: ViewRecord[] = []
function makeView(kind: string): {
  setActive: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  webContentsId: number
} {
  const entry: ViewRecord = {
    kind, setActive: [], disposed: false,
    webContentsId: 1000 + viewCalls.length,
    disposeNextCancel: false,
  }
  viewCalls.push(entry)
  return {
    setActive: vi.fn((active: boolean) => entry.setActive.push(active)),
    dispose: vi.fn(async () => {
      if (entry.disposeNextCancel) return false
      entry.disposed = true
      return true
    }),
    webContentsId: entry.webContentsId,
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
    expect(officePreviewKindFor('f.pdf')).toBe('pdf')
  })
})

describe('OfficePreviewRegistry', () => {
  let registry: OfficePreviewRegistry

  beforeEach(() => {
    vi.clearAllMocks()
    viewCalls.length = 0
    createCalls.options.length = 0
    slidesCalls.options.length = 0
    sheetCalls.options.length = 0
    savedListenersByWc.clear()
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

    await registry.close('file-1')
    expect(runtime.sheets.stopSheetsSidecar).toHaveBeenCalledTimes(1)
    // 还有 docx 实例：共享 shell window 不能被清掉。
    expect(runtime.docs.setDocsShellWindow).not.toHaveBeenCalledWith(null)

    await registry.close('file-2')
    expect(runtime.docs.setActiveDocsResolver).toHaveBeenCalledWith(null)
    expect(runtime.docs.setDocsShellWindow).toHaveBeenCalledWith(null)
    expect(runtime.slides.setSlidesShellWindow).toHaveBeenCalledWith(null)
    expect(viewCalls.every((view) => view.disposed)).toBe(true)
  })

  it('keeps the sidecar while another spreadsheet stays open', async () => {
    const window = makeWindow()
    await registry.open(window, file('file-1', 'file-1.xlsx'))
    await registry.open(window, file('file-2', 'file-2.xlsm'))

    await registry.close('file-1')
    expect(runtime.sheets.stopSheetsSidecar).not.toHaveBeenCalled()

    await registry.close('file-2')
    expect(runtime.sheets.stopSheetsSidecar).toHaveBeenCalledTimes(1)
  })

  it('disposeAll tears down every instance and the shared runtime', async () => {
    const window = makeWindow()
    await registry.open(window, file('file-1', 'file-1.docx'))
    await registry.open(window, file('file-2', 'file-2.pptx'))
    registry.setActive('file-1')

    await registry.disposeAll()

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

  describe('editable docx', () => {
    it('creates an editable view and treats editable as instance identity', async () => {
      const window = makeWindow()
      const base = file('file-9', 'file-9.docx')
      await registry.open(window, { ...base, editable: true, roomId: 'room-1' })
      // 可编辑实例：editable 透传到视图工厂。
      expect(createCalls.options).toEqual([{ editable: true }])

      // 同 hash 同 editable：复用。
      await registry.open(window, { ...base, editable: true, roomId: 'room-1' })
      expect(viewCalls).toHaveLength(1)

      // 同 hash 但 editable 变化：原地重建（顶栏只读标签与产物编辑互不复用）。
      await registry.open(window, base)
      expect(viewCalls).toHaveLength(2)
      expect(viewCalls[0]!.disposed).toBe(true)
      expect(createCalls.options[1]).toEqual({ editable: false })
    })

    it('rebuilds a slides instance in place when editable flips', async () => {
      const window = makeWindow()
      const base = file('file-p1', 'deck.pptx')
      await registry.open(window, base)
      expect(slidesCalls.options).toEqual([{ editable: false }])

      await registry.open(window, { ...base, editable: true, roomId: 'room-p1' })
      expect(viewCalls).toHaveLength(2)
      expect(viewCalls[0]!.disposed).toBe(true)
      expect(slidesCalls.options[1]).toEqual({ editable: true })
    })

    it('keeps the instance when the dirty-close guard is cancelled', async () => {
      const window = makeWindow()
      await registry.open(window, file('file-1', 'file-1.docx'))

      viewCalls[0]!.disposeNextCancel = true
      await expect(registry.close('file-1')).resolves.toBe(false)
      expect(registry.has('file-1')).toBe(true)
      expect(viewCalls[0]!.disposed).toBe(false)
    })

    describe('save sync', () => {
      beforeEach(() => {
        vi.useFakeTimers()
      })
      afterEach(() => {
        vi.useRealTimers()
      })

      function emitSave(view: ViewRecord) {
        for (const listener of savedListenersByWc.get(view.webContentsId) ?? []) listener('/tmp/workdir/document.docx')
      }

      it('debounces saves into a single pinned re-import and broadcasts edited', async () => {
        const importAgentFile = vi.fn(async () => ({}))
        const broadcast = vi.fn()
        registry.setEditSync({ importAgentFile, broadcast })
        const window = makeWindow()
        await registry.open(window, { ...file('file-5', 'file-5.docx'), editable: true, roomId: 'room-5' })

        emitSave(viewCalls[0]!)
        emitSave(viewCalls[0]!)
        emitSave(viewCalls[0]!)
        // 去抖窗口内连发保存只落一次导入。
        await vi.advanceTimersByTimeAsync(2_500)
        expect(importAgentFile).toHaveBeenCalledTimes(1)
        expect(importAgentFile).toHaveBeenCalledWith(expect.objectContaining({
          fileEntryId: 'file-5',
          sourceKey: 'agent:word:edit:file-5',
          roomId: 'room-5',
          originalName: 'file-5.docx',
        }))
        expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'edited', fileId: 'file-5' }))
      })

      it('retries once when the mid-read file changed', async () => {
        let calls = 0
        const importAgentFile = vi.fn(async () => {
          calls += 1
          if (calls === 1) throw new Error('文件在导入过程中发生变化，请稍后重试。')
          return {}
        })
        registry.setEditSync({ importAgentFile, broadcast: vi.fn() })
        const window = makeWindow()
        await registry.open(window, { ...file('file-6', 'file-6.docx'), editable: true })

        emitSave(viewCalls[0]!)
        await vi.advanceTimersByTimeAsync(3_000)
        expect(importAgentFile).toHaveBeenCalledTimes(2)
      })

      it('flushes the pending debounce exactly once on close', async () => {
        const importAgentFile = vi.fn(async () => ({}))
        const broadcast = vi.fn()
        registry.setEditSync({ importAgentFile, broadcast })
        const window = makeWindow()
        await registry.open(window, { ...file('file-7', 'file-7.docx'), editable: true, roomId: 'room-7' })

        emitSave(viewCalls[0]!)
        await registry.close('file-7')
        // 关闭立即落库，不等去抖窗口；且只导入一次。
        expect(importAgentFile).toHaveBeenCalledTimes(1)
        expect(importAgentFile).toHaveBeenCalledWith(expect.objectContaining({ fileEntryId: 'file-7' }))
        expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'edited' }))
      })

      it('syncs editable slides saves with the slides source key and pptx format', async () => {
        const importAgentFile = vi.fn(async () => ({}))
        const broadcast = vi.fn()
        registry.setEditSync({ importAgentFile, broadcast })
        const window = makeWindow()
        await registry.open(window, { ...file('file-s1', '季度汇报.pptx'), editable: true, roomId: 'room-s1' })
        // editable 透传到 slides 视图工厂（readonly 反转点在真实现里）。
        expect(slidesCalls.options).toEqual([{ editable: true }])

        emitSave(viewCalls[0]!)
        await vi.advanceTimersByTimeAsync(2_500)
        expect(importAgentFile).toHaveBeenCalledTimes(1)
        expect(importAgentFile).toHaveBeenCalledWith(expect.objectContaining({
          fileEntryId: 'file-s1',
          sourceKey: 'agent:slides:edit:file-s1',
          filePath: '/tmp/workdir/deck.pptx',
          roomId: 'room-s1',
        }))
        expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'edited', format: 'pptx', fileId: 'file-s1' }))
      })

      it('syncs editable spreadsheet saves with the sheets source key and xlsx format', async () => {
        const importAgentFile = vi.fn(async () => ({}))
        const broadcast = vi.fn()
        registry.setEditSync({ importAgentFile, broadcast })
        const window = makeWindow()
        await registry.open(window, { ...file('file-x1', '预算表.xlsx'), editable: true, roomId: 'room-x1' })
        expect(sheetCalls.options).toEqual([{ editable: true }])

        emitSave(viewCalls[0]!)
        await vi.advanceTimersByTimeAsync(2_500)
        expect(importAgentFile).toHaveBeenCalledTimes(1)
        expect(importAgentFile).toHaveBeenCalledWith(expect.objectContaining({
          fileEntryId: 'file-x1',
          sourceKey: 'agent:sheets:edit:file-x1',
          filePath: '/tmp/workdir/book.xlsx',
          roomId: 'room-x1',
        }))
        expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'edited', format: 'xlsx', fileId: 'file-x1' }))
      })

      it('surfaces a persistent import failure via the error broadcast', async () => {
        const importAgentFile = vi.fn(async () => {
          throw new Error('gateway down')
        })
        const broadcast = vi.fn()
        registry.setEditSync({ importAgentFile, broadcast })
        const window = makeWindow()
        await registry.open(window, { ...file('file-8', 'file-8.docx'), editable: true })

        emitSave(viewCalls[0]!)
        await vi.advanceTimersByTimeAsync(3_500)
        expect(importAgentFile).toHaveBeenCalledTimes(2)
        expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', fileId: 'file-8' }))
      })
    })
  })
})
