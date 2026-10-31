import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const { savedListenersByWc, createCalls, slidesCalls, sheetCalls } = vi.hoisted(() => ({
  savedListenersByWc: new Map<number, Set<(filePath: string) => void>>(),
  createCalls: { options: [] as Array<{ editable?: boolean }> },
  slidesCalls: { options: [] as Array<{ editable?: boolean }> },
  sheetCalls: { options: [] as Array<{ editable?: boolean }> },
}))

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn((id: number) => ({ id, isDestroyed: () => false })) },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
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
  prepareSpreadsheet: vi.fn(async () => '/tmp/workdir/book.xlsx'),
}))

import { OfficePreviewRegistry, officePreviewKindFor } from '../src/main/office/office-preview-registry'
import { prepareOfficeDocument } from '../src/main/office/office-view-manager'
import { prepareSpreadsheet } from '../src/main/office/spreadsheet-view-manager'

/** 每个视图实例的 mock：记录 setActive/dispose 调用；disposeNextCancel 控制下一次返回。 */
interface ViewRecord {
  kind: string
  setActive: boolean[]
  disposed: boolean
  webContentsId: number
  disposeNextCancel: boolean
  dirty: boolean
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
    dirty: false,
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
    isDirty: vi.fn(async () => entry.dirty),
    // 后台 Agent 隐藏会话需要的最小 view 面（setBounds/setVisible/close/once）。
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    webContents: {
      id: entry.webContentsId,
      isDestroyed: () => entry.disposed,
      close: vi.fn(() => { entry.disposed = true }),
      once: vi.fn(),
    },
  }
}

const runtime = {
  docs: {
    setDocsShellWindow: vi.fn(),
    setActiveDocsResolver: vi.fn(),
    setDocsMenuGate: vi.fn(),
    setDocsChromeHidden: vi.fn(),
    registerDocsIpc: vi.fn(),
    teardownDocsRenderer: vi.fn(),
    createDocsView: vi.fn(() => makeView('docx')),
    waitForAgentReady: vi.fn(async () => true),
    describeAgentDoc: vi.fn(async () => ({ context: 'Document block list:\n0|h1|Title' })),
    applyAgentDocTools: vi.fn(async () => ({
      results: [{ id: 'call-1', name: 'insert_content', output: 'ok', mutated: true }],
    })),
  },
  sheets: {
    setSheetsShellWindow: vi.fn(),
    setActiveSheetsWebContents: vi.fn(),
    stopSheetsSidecar: vi.fn(),
    registerSheetsIpc: vi.fn(),
    // 后台 Excel 隐藏会话的面：建视图 / 排队工作簿 / 就绪闸门 / 描述 / 应用 / 拆除。
    createSheetsView: vi.fn(() => makeView('sheets-hidden')),
    queueWorkbookForView: vi.fn(),
    waitForAgentReady: vi.fn(async () => true),
    teardownSheetsRenderer: vi.fn(),
    sheetsPendingEditCount: vi.fn(() => 0),
    describeAgentWorkbook: vi.fn(async () => ({
      context: 'Workbook sheets:\n0|Sheet1|A1:D20',
      guides: { writing: 'propose_operations' },
    })),
    applyAgentWorkbookTools: vi.fn(async () => ({
      results: [{ id: 'call-1', name: 'propose_operations', output: 'ok', mutated: true }],
    })),
  },
  slides: {
    setSlidesShellWindow: vi.fn(),
    setActiveSlidesWebContents: vi.fn(),
    describeAgentDeck: vi.fn(),
    applyAgentDeckOps: vi.fn(),
    applyAgentDeckPage: vi.fn(),
  },
}

function makeWindow(): BrowserWindow {
  return {
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    once: vi.fn(),
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: vi.fn() },
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
  // 论文排版桥是 genoffice 后加的导出：旧运行时（vendored 子模块还没升到含该导出的提交）
  // 缺这个函数时，曾把整个 ensureRuntime 打挂，Room 内所有 Office 内嵌预览一起退回
  // 「用系统默认应用打开」。这里钉住「缺能力只跳过桥、预览照开」。
  describe('thesis panel bridge', () => {
    type DocsWithThesisHook = { setDocsThesisPanelHook?: (hook: (wcId: number, action: unknown) => Promise<unknown>) => void }

    afterEach(() => {
      delete (runtime.docs as DocsWithThesisHook).setDocsThesisPanelHook
    })

    it('keeps Office previews working when the runtime has no thesis hook', async () => {
      const window = makeWindow()
      registry.setThesisPanelBridge({
        listCards: vi.fn(async () => []),
        pickAndSet: vi.fn(async () => null),
        removeCard: vi.fn(async () => undefined),
        reformat: vi.fn(async () => null),
      })

      const descriptor = await registry.open(window, file('file-1', 'file-1.docx'))

      expect(descriptor).toMatchObject({ id: 'file-1', kind: 'docx' })
      expect(viewCalls).toHaveLength(1)
    })

    it('wires the hook when the runtime provides it', async () => {
      const hook = vi.fn()
      ;(runtime.docs as DocsWithThesisHook).setDocsThesisPanelHook = hook
      const window = makeWindow()
      registry.setThesisPanelBridge({
        listCards: vi.fn(async () => []),
        pickAndSet: vi.fn(async () => null),
        removeCard: vi.fn(async () => undefined),
        reformat: vi.fn(async () => null),
      })

      await registry.open(window, file('file-1', 'file-1.docx'))

      expect(hook).toHaveBeenCalledTimes(1)
      expect(typeof hook.mock.calls[0]![0]).toBe('function')
    })

    it('scopes the AI thesis panel to the document workspace', async () => {
      const hook = vi.fn()
      ;(runtime.docs as DocsWithThesisHook).setDocsThesisPanelHook = hook
      const listCards = vi.fn(async () => [])
      registry.setThesisPanelBridge({
        listCards,
        pickAndSet: vi.fn(async () => null),
        removeCard: vi.fn(async () => undefined),
        reformat: vi.fn(async () => null),
      })
      const window = makeWindow()
      await registry.open(window, { ...file('file-w', 'thesis.docx'), workspaceId: 'ws-9' })

      const handler = hook.mock.calls[0]![0] as (wcId: number, action: unknown) => Promise<unknown>
      const outcome = await handler(viewCalls[0]!.webContentsId, { kind: 'list' })

      // 「排版」面板按工作区取模版卡：文档在哪个空间，就只列哪个空间的模版。
      expect(listCards).toHaveBeenCalledWith('ws-9')
      expect(outcome).toEqual({ ok: true, value: [] })
    })
  })

  let registry: OfficePreviewRegistry

  beforeEach(() => {
    vi.clearAllMocks()
    viewCalls.length = 0
    createCalls.options.length = 0
    slidesCalls.options.length = 0
    sheetCalls.options.length = 0
    savedListenersByWc.clear()
    registry = new OfficePreviewRegistry(0)
  })

  describe('后台 Word 编辑（UI 隐藏/未打开）', () => {
    it('未打开的 docx：describe/apply 走隐藏会话，且不进可见页签清单', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'agent-doc-'))
      const storage = join(dir, 'hidden.docx')
      await writeFile(storage, Buffer.from('PK\u0003\u0004 not a real docx'))
      try {
        const window = makeWindow()
        // 先开一份可见 docx，给 registry 一个主窗口（隐藏会话挂在它上面）。
        await registry.open(window, file('file-visible', 'visible.docx'))
        registry.setAgentFileResolver(async (fileId) => ({
          fileId,
          originalName: 'hidden.docx',
          storagePath: storage,
          contentHash: 'c'.repeat(64),
        }))
        // 工作副本用真实文件（隐藏会话 apply 后会校验“保存是否真的落盘”）。
        vi.mocked(prepareOfficeDocument).mockResolvedValueOnce(storage)

        const described = await registry.describeDocArtifact('file-hidden')
        expect(described.ok).toBe(true)
        expect(runtime.docs.createDocsView).toHaveBeenCalledWith(
          storage,
          { hostMode: 'everroom' },
        )
        expect(runtime.docs.waitForAgentReady).toHaveBeenCalled()

        const applied = await registry.applyDocAgentTools('file-hidden', [
          { id: 'call-1', name: 'insert_content', input: { html: '<p>x</p>' } },
        ])
        expect(applied.ok).toBe(true)
        if (applied.ok) expect(applied.results).toHaveLength(1)

        // 隐藏会话不是用户页签：openFiles 里只有可见的那份。
        expect(registry.openOfficeFiles().map((entry) => entry.fileId)).toEqual(['file-visible'])
        await registry.disposeAll()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('干净画布：宿主可隐藏可见 Word 实例的操作区，未命中返回 false', async () => {
      const window = makeWindow()
      await registry.open(window, file('file-chrome', 'chrome.docx'))

      expect(registry.setDocsChromeHidden('active', true)).toBe(true)
      expect(runtime.docs.setDocsChromeHidden).toHaveBeenCalledWith(
        expect.objectContaining({ id: viewCalls[0]!.webContentsId }),
        true,
      )
      expect(registry.setDocsChromeHidden('file-chrome', false)).toBe(true)
      expect(runtime.docs.setDocsChromeHidden).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: viewCalls[0]!.webContentsId }),
        false,
      )
      expect(registry.setDocsChromeHidden('missing', true)).toBe(false)
    })

    it('已打开的只读 docx 不会被后台会话绕过（保持 not_editable）', async () => {
      const window = makeWindow()
      await registry.open(window, {...file('file-readonly', 'readonly.docx'), editable: false})
      registry.setAgentFileResolver(async (fileId) => ({
        fileId,
        originalName: 'readonly.docx',
        storagePath: '/tmp/never-used.docx',
        contentHash: 'd'.repeat(64),
      }))

      const applied = await registry.applyDocAgentTools('file-readonly', [
        { id: 'call-1', name: 'insert_content', input: {} },
      ])
      expect(applied).toMatchObject({ ok: false, reason: 'not_editable' })
      expect(runtime.docs.createDocsView).not.toHaveBeenCalled()
    })
  })

  describe('后台 Excel 编辑（未打开/隐藏）', () => {
    async function withStorageBytes(
      name: string,
      bytes: Buffer,
      run: (storage: string) => Promise<void>,
    ): Promise<void> {
      const dir = await mkdtemp(join(tmpdir(), 'agent-sheet-'))
      const storage = join(dir, name)
      await writeFile(storage, bytes)
      try {
        await run(storage)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }

    function hiddenSheetMeta(storage: string) {
      return {
        fileId: 'file-hidden-sheet',
        originalName: 'hidden.xlsx',
        storagePath: storage,
        contentHash: 'c'.repeat(64),
      }
    }

    it('未打开的 xlsx：describe/apply 走隐藏会话，且不进可见页签清单', async () => {
      await withStorageBytes('hidden.xlsx', Buffer.from('PK\u0003\u0004 not a real xlsx'), async (storage) => {
        const window = makeWindow()
        // 先开一份可见文件，给 registry 一个主窗口（隐藏会话挂在它上面）。
        await registry.open(window, file('file-visible', 'visible.docx'))
        const importAgentFile = vi.fn(async () => ({ fileVersionId: 'file-version-2' }))
        registry.setEditSync({ importAgentFile, broadcast: vi.fn() })
        registry.setAgentFileResolver(async (fileId) => ({ ...hiddenSheetMeta(storage), fileId }))
        // 工作副本用真实文件（隐藏会话 apply 后会校验“保存是否真的落盘”）。
        vi.mocked(prepareSpreadsheet).mockResolvedValueOnce(storage)

        const described = await registry.describeSpreadsheetArtifact('file-hidden-sheet', { roomId: 'room-s1' })
        expect(described.ok).toBe(true)
        if (described.ok) expect(described.describe.context).toContain('Workbook sheets')
        expect(runtime.sheets.createSheetsView).toHaveBeenCalledWith({
          includeAiHandlers: false,
          readonly: false,
          claimActive: false,
        })
        expect(runtime.sheets.waitForAgentReady).toHaveBeenCalled()

        const applied = await registry.applySpreadsheetAgentTools('file-hidden-sheet', [
          { id: 'call-1', name: 'propose_operations', input: {} },
        ])
        expect(applied.ok).toBe(true)
        if (applied.ok) {
          expect(applied.results).toHaveLength(1)
          // 版本回填走与活实例同一条 sheets sourceKey / xlsx 广播链。
          expect(applied.version).toBe('file-version-2')
        }
        expect(importAgentFile).toHaveBeenCalledWith(expect.objectContaining({
          fileEntryId: 'file-hidden-sheet',
          sourceKey: 'agent:sheets:edit:file-hidden-sheet',
          filePath: storage,
          roomId: 'room-s1',
          originalName: 'hidden.xlsx',
        }))

        // 隐藏会话不是用户页签：openFiles 里只有可见的那份。
        expect(registry.openOfficeFiles().map((entry) => entry.fileId)).toEqual(['file-visible'])
        expect(registry.has('file-hidden-sheet')).toBe(false)
        await registry.disposeAll()
      })
    })

    it('已打开的只读 xlsx：读走可见会话（只读可读），写保持 not_editable、不绕过用户现场', async () => {
      const window = makeWindow()
      await registry.open(window, { ...file('file-ro', 'readonly.xlsx'), editable: false })
      const resolver = vi.fn(async (fileId: string) => ({ ...hiddenSheetMeta('/tmp/never-used.xlsx'), fileId }))
      registry.setAgentFileResolver(resolver)
      // 只读渲染器允许 describe（工作簿上下文/指南是只读信息），写仍由 desktop
      // 的 not_editable 闸门拒绝；registry 绝不偷偷开一份可编辑隐藏工作簿顶替。
      const read = await registry.describeSpreadsheetArtifact('file-ro')
      expect(read.ok).toBe(true)
      if (read.ok) expect(read.describe.context).toContain('Workbook sheets')
      expect(runtime.sheets.describeAgentWorkbook).toHaveBeenCalledWith(
        expect.objectContaining({ id: viewCalls[0]!.webContentsId }),
      )

      const applied = await registry.applySpreadsheetAgentTools('file-ro', [
        { id: 'call-1', name: 'propose_operations', input: {} },
      ])
      expect(applied).toMatchObject({ ok: false, reason: 'not_editable' })
      expect(runtime.sheets.applyAgentWorkbookTools).not.toHaveBeenCalled()
      expect(runtime.sheets.createSheetsView).not.toHaveBeenCalled()
      expect(resolver).not.toHaveBeenCalled()
    })

    it('隐藏工作簿会话存活时不停止 sheets sidecar（关闭最后一个可见实例后）', async () => {
      await withStorageBytes('hidden.xlsx', Buffer.from('PK\u0003\u0004 not a real xlsx'), async (storage) => {
        const window = makeWindow()
        await registry.open(window, file('file-visible', 'visible.docx'))
        registry.setAgentFileResolver(async (fileId) => ({ ...hiddenSheetMeta(storage), fileId }))
        vi.mocked(prepareSpreadsheet).mockResolvedValueOnce(storage)

        const described = await registry.describeSpreadsheetArtifact('file-hidden-sheet')
        expect(described.ok).toBe(true)

        await registry.close('file-visible')
        // teardownIfIdle 会跑，但隐藏会话还活着（它持有 live sidecar 会话）：不能停。
        expect(runtime.sheets.stopSheetsSidecar).not.toHaveBeenCalled()
        expect(runtime.sheets.setActiveSheetsWebContents).not.toHaveBeenCalledWith(null)

        await registry.disposeAll()
        expect(runtime.sheets.stopSheetsSidecar).toHaveBeenCalledTimes(1)
      })
    })

    it('已打开可编辑 xlsx 有未保存修改 → unsaved（写闸门保留，不走后台会话）', async () => {
      const window = makeWindow()
      await registry.open(window, { ...file('file-x1', '预算表.xlsx'), editable: true })
      const resolver = vi.fn(async (fileId: string) => ({ ...hiddenSheetMeta('/tmp/never-used.xlsx'), fileId }))
      registry.setAgentFileResolver(resolver)
      runtime.sheets.sheetsPendingEditCount.mockReturnValueOnce(1)

      const applied = await registry.applySpreadsheetAgentTools('file-x1', [
        { id: 'call-1', name: 'propose_operations', input: {} },
      ])
      expect(applied).toMatchObject({ ok: false, reason: 'unsaved' })
      expect(runtime.sheets.applyAgentWorkbookTools).not.toHaveBeenCalled()
      expect(runtime.sheets.createSheetsView).not.toHaveBeenCalled()
    })
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

  describe('editSlidesArtifact (Agent 编辑活会话)', () => {
    it('unknown fileId → not_open（附空打开清单）', async () => {
      const outcome = await registry.editSlidesArtifact('file-missing', { mode: 'read' })
      expect(outcome).toEqual({ ok: false, reason: 'not_open', open: [] })
      expect(runtime.slides.describeAgentDeck).not.toHaveBeenCalled()
    })

    it('readonly slides 实例：read 放行（editable:false），apply → not_editable', async () => {
      const window = makeWindow()
      await registry.open(window, file('file-r1', 'deck-readonly.pptx'))
      runtime.slides.describeAgentDeck.mockReturnValueOnce({ outline: 'Page 1…', opVocabulary: 'text: …' })

      const read = await registry.editSlidesArtifact('file-r1', { mode: 'read' })
      expect(read).toEqual({
        ok: true,
        info: { outline: 'Page 1…', opVocabulary: 'text: …', editable: false },
      })

      const apply = await registry.editSlidesArtifact('file-r1', { mode: 'apply', ops: [{ op: 'setNotes' }] })
      expect(apply).toEqual({ ok: false, reason: 'not_editable', open: [expect.objectContaining({ fileId: 'file-r1', editable: false })] })
    })

    it('read routes to the editable slides instance and returns the deck info', async () => {
      const window = makeWindow()
      await registry.open(window, { ...file('file-e1', 'deck-edit.pptx'), editable: true, roomId: 'room-e1' })
      runtime.slides.describeAgentDeck.mockReturnValueOnce({ outline: 'Page 1…', opVocabulary: 'text: …' })

      const outcome = await registry.editSlidesArtifact('file-e1', { mode: 'read' })

      expect(runtime.slides.describeAgentDeck).toHaveBeenCalledWith(viewCalls[0]!.webContentsId)
      expect(outcome).toEqual({
        ok: true,
        info: { outline: 'Page 1…', opVocabulary: 'text: …', editable: true },
      })
    })

    it('findByWebContentsId：按视图 wcId 反查文件与 Room（「AI 修改」转发用）', async () => {
      const window = makeWindow()
      await registry.open(window, { ...file('file-e1', 'deck-edit.pptx'), editable: true, roomId: 'room-e1' })
      await registry.open(window, file('file-d1', 'notes.docx'))

      expect(registry.findByWebContentsId(viewCalls[0]!.webContentsId)).toEqual({
        fileId: 'file-e1',
        title: 'deck-edit.pptx',
        kind: 'slides',
        roomId: 'room-e1',
        // 没有显式归属时按默认工作区兜底（论文排版面板按工作区取模版卡）。
        workspaceId: 'default',
      })
      // 非 Room 打开的实例 roomId 为空（转发层据此报错引导）。
      expect(registry.findByWebContentsId(viewCalls[1]!.webContentsId)).toMatchObject({
        fileId: 'file-d1',
        roomId: null,
        workspaceId: 'default',
      })
      expect(registry.findByWebContentsId(999_999)).toBeNull()
    })

    it("fileId 'active'：焦点 slides 实例优先，无焦点退化为唯一 slides 实例", async () => {
      const window = makeWindow()
      await registry.open(window, { ...file('file-a1', 'deck-a.pptx'), editable: true })
      await registry.open(window, file('file-d1', 'notes.docx'))
      // 焦点在 docx 上：退化到唯一打开的 slides 实例。
      registry.setActive('file-d1')
      runtime.slides.describeAgentDeck.mockReturnValueOnce({ outline: 'A…', opVocabulary: 'ops' })
      const byFallback = await registry.editSlidesArtifact('active', { mode: 'read' })
      expect(byFallback).toEqual({ ok: true, info: { outline: 'A…', opVocabulary: 'ops', editable: true } })

      // 焦点回到 slides：直接命中。
      registry.setActive('file-a1')
      runtime.slides.describeAgentDeck.mockReturnValueOnce({ outline: 'A…', opVocabulary: 'ops' })
      const byFocus = await registry.editSlidesArtifact('active', { mode: 'read' })
      expect(byFocus).toEqual({ ok: true, info: { outline: 'A…', opVocabulary: 'ops', editable: true } })
    })

    it("fileId 'active'：两个 slides 实例且无焦点 → not_open + 清单（焦点在前）", async () => {
      const window = makeWindow()
      await registry.open(window, { ...file('file-a1', 'deck-a.pptx'), editable: true })
      await registry.open(window, file('file-a2', 'deck-b.pptx'))
      registry.setActive(null)

      const outcome = await registry.editSlidesArtifact('active', { mode: 'read' })

      expect(outcome).toEqual({
        ok: false,
        reason: 'not_open',
        open: [
          expect.objectContaining({ fileId: 'file-a1', kind: 'slides' }),
          expect.objectContaining({ fileId: 'file-a2', kind: 'slides' }),
        ],
      })
      expect(runtime.slides.describeAgentDeck).not.toHaveBeenCalled()
    })

    it('session not ready yet → not_open（附清单）', async () => {
      const window = makeWindow()
      await registry.open(window, { ...file('file-e2', 'deck-late.pptx'), editable: true })
      runtime.slides.describeAgentDeck.mockReturnValueOnce(null)

      const outcome = await registry.editSlidesArtifact('file-e2', { mode: 'read' })

      expect(outcome).toEqual({
        ok: false,
        reason: 'not_open',
        open: [expect.objectContaining({ fileId: 'file-e2', kind: 'slides', editable: true })],
      })
    })

    it('apply forwards ops/dryRun/isolation and returns the fork result', async () => {
      const window = makeWindow()
      await registry.open(window, { ...file('file-e3', 'deck-ops.pptx'), editable: true })
      const ops = [{ op: 'setNotes', target: { slide: 0 }, text: 'x' }]
      runtime.slides.applyAgentDeckOps.mockResolvedValueOnce({ ok: true, applied: true, saved: true })

      const outcome = await registry.editSlidesArtifact('file-e3', { mode: 'apply', ops, dryRun: true, isolation: 'per_op' })

      expect(runtime.slides.applyAgentDeckOps).toHaveBeenCalledWith(
        viewCalls[0]!.webContentsId,
        ops,
        { dryRun: true, isolation: 'per_op' },
      )
      expect(outcome).toEqual({ ok: true, result: { ok: true, applied: true, saved: true } })
    })

    it('editable docx instance → not_editable（只有 slides 支持 Agent 编辑）', async () => {
      const window = makeWindow()
      await registry.open(window, { ...file('file-e4', 'notes.docx'), editable: true })
      const outcome = await registry.editSlidesArtifact('file-e4', { mode: 'read' })
      expect(outcome).toEqual({
        ok: false,
        reason: 'not_editable',
        open: [expect.objectContaining({ fileId: 'file-e4', kind: 'docx', editable: true })],
      })
    })

    it('listOpenOffice：焦点实例排最前', async () => {
      const window = makeWindow()
      await registry.open(window, file('file-l1', 'a.docx'))
      await registry.open(window, { ...file('file-l2', 'b.pptx'), editable: true })
      registry.setActive('file-l2')

      expect(registry.listOpenOffice()).toEqual([
        { fileId: 'file-l2', title: 'b.pptx', kind: 'slides', editable: true, active: true },
        { fileId: 'file-l1', title: 'a.docx', kind: 'docx', editable: false, active: false },
      ])
    })

    it('activeOfficeFile：只认焦点实例，离开 Office 页签即为 null', async () => {
      const window = makeWindow()
      await registry.open(window, file('file-a1', 'a.docx'))
      // 打开 ≠ 正在浏览：渲染端切到 office-document 才会 setActive。
      expect(registry.activeOfficeFile()).toBeNull()

      await registry.open(window, { ...file('file-a2', 'b.pptx'), editable: true })
      registry.setActive('file-a2')
      expect(registry.activeOfficeFile()).toEqual({
        fileId: 'file-a2',
        title: 'b.pptx',
        kind: 'slides',
        editable: true,
      })

      registry.setActive(null)
      expect(registry.activeOfficeFile()).toBeNull()
    })

    it('applyAgentFileBytes：覆盖工作副本、重开视图并通知渲染端', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'everroom-agent-apply-'))
      const target = join(directory, 'contract.docx')
      const baseBytes = Buffer.from('old-docx-bytes')
      await writeFile(target, baseBytes)
      const baseHash = createHash('sha256').update(baseBytes).digest('hex')
      vi.mocked(prepareOfficeDocument).mockResolvedValue(target)
      try {
        const window = makeWindow()
        await registry.open(window, { ...file('file-apply', 'contract.docx', baseHash), editable: true })
        const nextBytes = Buffer.from('new-docx-bytes-from-agent')
        const result = await registry.applyAgentFileBytes('file-apply', nextBytes, baseHash)

        expect(result.ok).toBe(true)
        expect((await readFile(target)).toString()).toBe('new-docx-bytes-from-agent')
        expect(window.webContents.send).toHaveBeenCalledWith('office:instance-reloaded', {
          id: 'file-apply',
          kind: 'docx',
        })
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('applyAgentFileBytes：工作副本与基线不符时拒绝覆盖（期间被保存过）', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'everroom-agent-conflict-'))
      const target = join(directory, 'contract.docx')
      await writeFile(target, Buffer.from('saved-by-user'))
      vi.mocked(prepareOfficeDocument).mockResolvedValue(target)
      try {
        const window = makeWindow()
        await registry.open(window, { ...file('file-conflict', 'contract.docx', 'a'.repeat(64)), editable: true })
        const result = await registry.applyAgentFileBytes('file-conflict', Buffer.from('agent'), 'a'.repeat(64))
        expect(result).toMatchObject({ ok: false, reason: 'conflict' })
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('applyAgentFileBytes：未打开/只读/有未保存修改时拒绝写回', async () => {
      const window = makeWindow()
      expect(await registry.applyAgentFileBytes('file-missing', Buffer.from('x'), 'a'.repeat(64))).toEqual({
        ok: false,
        reason: 'not_open',
        open: [],
      })

      await registry.open(window, file('file-pdf', 'manual.pdf'))
      expect(await registry.applyAgentFileBytes('file-pdf', Buffer.from('x'), 'a'.repeat(64)))
        .toMatchObject({ ok: false, reason: 'not_editable' })

      await registry.open(window, { ...file('file-dirty', 'contract.docx'), editable: true })
      viewCalls.at(-1)!.dirty = true
      expect(await registry.applyAgentFileBytes('file-dirty', Buffer.from('x'), 'a'.repeat(64)))
        .toEqual({ ok: false, reason: 'unsaved', message: '文档有未保存的修改' })
    })

    it('openOfficeFiles：完整列出工作区打开的页签，并标出焦点项', async () => {
      const window = makeWindow()
      await registry.open(window, file('file-o1', 'a.docx'))
      await registry.open(window, { ...file('file-o2', 'b.xlsx'), editable: true })
      await registry.open(window, { ...file('file-o3', 'c.pptx'), editable: true })
      registry.setActive('file-o2')

      expect(registry.openOfficeFiles()).toEqual([
        { fileId: 'file-o2', title: 'b.xlsx', kind: 'spreadsheet', editable: true, active: true },
        { fileId: 'file-o1', title: 'a.docx', kind: 'docx', editable: false, active: false },
        { fileId: 'file-o3', title: 'c.pptx', kind: 'slides', editable: true, active: false },
      ])

      // 切到别的页面（不关页签）后仍然知道开着哪些文件，只是没有焦点项。
      registry.setActive(null)
      expect(registry.openOfficeFiles().map((entry) => entry.active)).toEqual([false, false, false])
    })
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
