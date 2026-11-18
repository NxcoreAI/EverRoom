import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spreadsheets } = vi.hoisted(() => ({
  spreadsheets: { workCopy: '', storage: '' },
}))

vi.mock('../src/main/office/spreadsheet-view-manager', () => ({
  prepareSpreadsheet: vi.fn(async () => spreadsheets.workCopy),
}))
vi.mock('../src/main/logging/desktop-logger', () => ({ logDesktop: vi.fn() }))

import { AgentSheetSessionManager } from '../src/main/office/office-agent-sheet-session'
import type { GenOfficeSheetsRuntime } from '../src/main/office/office-runtime'
import { prepareSpreadsheet } from '../src/main/office/spreadsheet-view-manager'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)

interface FakeView {
  webContents: {
    id: number
    isDestroyed: () => boolean
    close: ReturnType<typeof vi.fn>
    once: ReturnType<typeof vi.fn>
  }
  setBounds: ReturnType<typeof vi.fn>
  setVisible: ReturnType<typeof vi.fn>
}

function makeView(id: number): FakeView {
  let destroyed = false
  return {
    webContents: {
      id,
      isDestroyed: () => destroyed,
      close: vi.fn(() => { destroyed = true }),
      once: vi.fn(),
    },
    setBounds: vi.fn(),
    setVisible: vi.fn(),
  }
}

function makeWindow() {
  return {
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  }
}

function makeRuntime(views: FakeView[]) {
  let nextId = 700
  const applyImpl = vi.fn(async () => ({
    results: [{ id: 'call-1', name: 'propose_operations', output: 'ok', mutated: true }],
  }))
  const runtime = {
    sheets: {
      registerSheetsIpc: vi.fn(),
      createSheetsView: vi.fn((_options?: unknown) => {
        const view = makeView(nextId++)
        views.push(view)
        return view
      }),
      queueWorkbookForView: vi.fn(),
      waitForAgentReady: vi.fn(async () => true),
      describeAgentWorkbook: vi.fn(async () => ({
        context: 'Workbook sheets:\n0|Sheet1|A1:D20',
        guides: { writing: 'write cells with propose_operations' },
      })),
      applyAgentWorkbookTools: applyImpl,
      teardownSheetsRenderer: vi.fn(),
      requestSheetsClose: vi.fn(async () => true),
    },
  }
  return runtime
}

interface Harness {
  manager: AgentSheetSessionManager
  runtime: ReturnType<typeof makeRuntime>
  views: FakeView[]
  window: ReturnType<typeof makeWindow>
  editSync: {
    register: ReturnType<typeof vi.fn>
    drain: ReturnType<typeof vi.fn>
    flush: ReturnType<typeof vi.fn>
    release: ReturnType<typeof vi.fn>
  }
  meta: { fileId: string; originalName: string; storagePath: string; contentHash: string }
}

function makeHarness(overrides?: { ready?: boolean; contentHash?: string }): Harness {
  const views: FakeView[] = []
  const runtime = makeRuntime(views)
  if (overrides?.ready === false) runtime.sheets.waitForAgentReady.mockResolvedValue(false)
  const window = makeWindow()
  const editSync = {
    register: vi.fn(() => vi.fn()),
    drain: vi.fn(async () => ({ contentHash: HASH_B, fileVersionId: 'file-version-2' })),
    flush: vi.fn(async () => ({ contentHash: HASH_B, fileVersionId: 'file-version-2' })),
    release: vi.fn(async () => undefined),
  }
  const meta = {
    fileId: 'file-agent-sheet',
    originalName: '预算表.xlsx',
    storagePath: spreadsheets.storage,
    contentHash: overrides?.contentHash ?? HASH_A,
  }
  const manager = new AgentSheetSessionManager({
    sheets: runtime.sheets as unknown as GenOfficeSheetsRuntime,
    getWindow: () => window as never,
    resolveFile: async () => meta,
    editSync,
  })
  return { manager, runtime, views, window, editSync, meta }
}

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'everroom-agent-sheet-'))
  spreadsheets.storage = join(directory, 'storage.xlsx')
  spreadsheets.workCopy = join(directory, 'work.xlsx')
  await writeFile(spreadsheets.storage, Buffer.from('PK\u0003\u0004 not really an xlsx'))
  await writeFile(spreadsheets.workCopy, Buffer.from('PK\u0003\u0004 edited'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('AgentSheetSessionManager（后台 Excel 编辑会话）', () => {
  it('describe 会拉起隐藏视图：不抢 active、不装 AI 面板、挂主窗口、真实尺寸、不可见，并等工作簿就绪', async () => {
    const harness = makeHarness()
    const outcome = await harness.manager.describe('file-agent-sheet', { roomId: 'room-1' })

    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.describe.context).toContain('Workbook sheets')
    expect(harness.runtime.sheets.createSheetsView).toHaveBeenCalledWith({
      includeAiHandlers: false,
      readonly: false,
      claimActive: false,
    })
    const view = harness.views[0]!
    expect(harness.window.contentView.addChildView).toHaveBeenCalledWith(view)
    expect(view.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1100, height: 1400 })
    expect(view.setVisible).toHaveBeenCalledWith(false)
    // 先排目标工作簿、再等“装载的就是这份路径”，顺序不能反。
    expect(harness.runtime.sheets.queueWorkbookForView).toHaveBeenCalledWith(
      view.webContents,
      spreadsheets.workCopy,
    )
    expect(harness.runtime.sheets.waitForAgentReady).toHaveBeenCalledWith(
      view.webContents,
      spreadsheets.workCopy,
      15_000,
    )
    expect(harness.editSync.register).toHaveBeenCalledWith({
      fileId: 'file-agent-sheet',
      webContentsId: view.webContents.id,
      filePath: spreadsheets.workCopy,
      originalName: '预算表.xlsx',
      roomId: 'room-1',
      workspaceId: null,
    })
    // 隐藏会话用 agent 专用工作副本文件名：不能命中用户可见视图的恢复副本。
    expect(vi.mocked(prepareSpreadsheet)).toHaveBeenCalledWith(
      'file-agent-sheet',
      HASH_A,
      '预算表.xlsx',
      spreadsheets.storage,
      { agent: true },
    )
    expect(harness.manager.has('file-agent-sheet')).toBe(true)
    expect(harness.manager.hasAny()).toBe(true)
  })

  it('apply 返回逐条结果和新版本号，并在版本回填后记住新指纹（同文件复用会话）', async () => {
    const harness = makeHarness()
    const first = await harness.manager.apply('file-agent-sheet', [
      { id: 'call-1', name: 'propose_operations', input: {} },
    ])
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.results).toHaveLength(1)
      expect(first.version).toBe('file-version-2')
    }
    expect(harness.editSync.drain).toHaveBeenCalledWith('file-agent-sheet')

    // 回填后 catalog 指纹变成 HASH_B：再次编辑必须复用同一个会话，不能重建。
    harness.meta.contentHash = HASH_B
    const second = await harness.manager.apply('file-agent-sheet', [
      { id: 'call-2', name: 'read_range', input: {} },
    ])
    expect(second.ok).toBe(true)
    expect(harness.runtime.sheets.createSheetsView).toHaveBeenCalledTimes(1)
    expect(harness.runtime.sheets.applyAgentWorkbookTools).toHaveBeenCalledTimes(2)
  })

  it('catalog 指纹变化 → 关闭旧会话并重建（不拿旧工作副本继续改）', async () => {
    const harness = makeHarness()
    await harness.manager.describe('file-agent-sheet')
    harness.meta.contentHash = HASH_C
    const outcome = await harness.manager.describe('file-agent-sheet')

    expect(outcome.ok).toBe(true)
    expect(harness.runtime.sheets.createSheetsView).toHaveBeenCalledTimes(2)
    expect(harness.runtime.sheets.teardownSheetsRenderer).toHaveBeenCalled()
    expect(harness.editSync.release).toHaveBeenCalledWith('file-agent-sheet')
  })

  it('工作簿未就绪 → open_failed，并清掉隐藏视图（不读空白工作簿）', async () => {
    const harness = makeHarness({ ready: false })
    const outcome = await harness.manager.describe('file-agent-sheet')

    expect(outcome).toMatchObject({ ok: false, reason: 'open_failed' })
    expect(harness.runtime.sheets.describeAgentWorkbook).not.toHaveBeenCalled()
    expect(harness.runtime.sheets.teardownSheetsRenderer).toHaveBeenCalled()
    expect(harness.manager.has('file-agent-sheet')).toBe(false)
    expect(harness.manager.hasAny()).toBe(false)
  })

  it('加密 xlsx（CFB 头）→ encrypted，不拉起编辑器', async () => {
    await writeFile(spreadsheets.storage, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]))
    const harness = makeHarness()
    const outcome = await harness.manager.describe('file-agent-sheet')

    expect(outcome).toMatchObject({ ok: false, reason: 'encrypted' })
    expect(harness.runtime.sheets.createSheetsView).not.toHaveBeenCalled()
  })

  it('非 OOXML 工作簿（旧版 .xls / Word）→ not_xlsx，不拉起编辑器', async () => {
    const harness = makeHarness()
    harness.meta.originalName = '旧表.xls'
    expect(await harness.manager.describe('file-agent-sheet')).toMatchObject({
      ok: false,
      reason: 'not_xlsx',
    })
    harness.meta.originalName = '报告.docx'
    expect(await harness.manager.describe('file-agent-sheet')).toMatchObject({
      ok: false,
      reason: 'not_xlsx',
    })
    expect(harness.runtime.sheets.createSheetsView).not.toHaveBeenCalled()
  })

  it('静默保存被拒绝（工作副本没变）→ save_failed，不谎报成功', async () => {
    const harness = makeHarness()
    await harness.manager.describe('file-agent-sheet')
    harness.editSync.drain.mockResolvedValue(null)
    harness.editSync.flush.mockResolvedValue(null)
    // 把基线设成工作副本当前字节的哈希：apply 声称 mutated 但没有任何保存，
    // 工作副本哈希不变 → 必须返回 save_failed 而不是成功。
    const actual = createHash('sha256').update(await readFile(spreadsheets.workCopy)).digest('hex')
    harness.meta.contentHash = actual
    const session = (harness.manager as unknown as {
      sessions: Map<string, { baseContentHash: string }>
    }).sessions.get('file-agent-sheet')!
    session.baseContentHash = actual
    const outcome = await harness.manager.apply('file-agent-sheet', [
      { id: 'call-1', name: 'propose_operations', input: {} },
    ])
    expect(outcome).toMatchObject({ ok: false, reason: 'save_failed' })
  })

  it('保存已落盘但版本回填失败 → 仍返回结果，但带明确 error（不谎报版本）', async () => {
    const harness = makeHarness()
    await harness.manager.describe('file-agent-sheet')
    harness.editSync.drain.mockResolvedValue(null)
    harness.editSync.flush.mockResolvedValue(null)
    const outcome = await harness.manager.apply('file-agent-sheet', [
      { id: 'call-1', name: 'propose_operations', input: {} },
    ])
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.version).toBeUndefined()
      expect(outcome.error).toContain('版本回填失败')
    }
  })

  it('同一文件的并发 apply 串行执行（隐藏渲染器只有一个工作簿状态）', async () => {
    const harness = makeHarness()
    let inFlight = 0
    let maxInFlight = 0
    harness.runtime.sheets.applyAgentWorkbookTools.mockImplementation(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 15))
      inFlight--
      return { results: [{ id: 'call', name: 'propose_operations', output: 'ok' }] }
    })

    await Promise.all([
      harness.manager.apply('file-agent-sheet', [{ id: 'a', name: 'propose_operations', input: {} }]),
      harness.manager.apply('file-agent-sheet', [{ id: 'b', name: 'propose_operations', input: {} }]),
    ])
    expect(maxInFlight).toBe(1)
  })

  it('disposeAll 硬清理：teardown + 注销保存回填，不请求脏关闭对话框', async () => {
    const harness = makeHarness()
    await harness.manager.describe('file-agent-sheet')
    const unsubscribe = harness.editSync.register.mock.results[0]!.value as ReturnType<typeof vi.fn>

    await harness.manager.disposeAll()

    expect(harness.manager.has('file-agent-sheet')).toBe(false)
    expect(harness.manager.hasAny()).toBe(false)
    expect(harness.runtime.sheets.teardownSheetsRenderer).toHaveBeenCalled()
    expect(harness.editSync.release).toHaveBeenCalledWith('file-agent-sheet')
    expect(unsubscribe).toHaveBeenCalled()
    // 会话销毁只走 teardown/close；脏关闭守卫（requestSheetsClose）不在隐藏会话路径上。
    expect(harness.runtime.sheets.requestSheetsClose).not.toHaveBeenCalled()
    expect(harness.views[0]!.webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
  })
})