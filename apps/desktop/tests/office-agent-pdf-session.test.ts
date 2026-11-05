import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { userData } = vi.hoisted(() => ({ userData: { dir: '' } }))

vi.mock('electron', () => ({
  app: { getPath: (_name: string) => userData.dir },
}))
vi.mock('../src/main/logging/desktop-logger', () => ({ logDesktop: vi.fn() }))

import { AgentPdfSessionManager } from '../src/main/office/office-agent-pdf-session'
import type { GenOfficePdfRuntime } from '../src/main/office/office-runtime'

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
      close: vi.fn(() => {
        destroyed = true
      }),
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
  let nextId = 900
  const applyImpl = vi.fn(async () => ({
    results: [{ id: 'call-1', name: 'edit_text', output: 'Edited (unsaved → saved)', mutated: true }],
  }))
  const runtime = {
    createPdfView: vi.fn((_openPath?: unknown, _options?: unknown) => {
      const view = makeView(nextId++)
      views.push(view)
      return view
    }),
    waitForAgentReady: vi.fn(async () => true),
    describeAgentPdf: vi.fn(async () => ({
      context: 'Current document: "合同.pdf", 3 pages.',
      tools: [{ name: 'read_pages', description: 'read', inputSchema: {} }],
    })),
    applyAgentPdfTools: applyImpl,
  }
  return runtime
}

interface Harness {
  manager: AgentPdfSessionManager
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
  if (overrides?.ready === false) runtime.waitForAgentReady.mockResolvedValue(false)
  const window = makeWindow()
  const editSync = {
    register: vi.fn(() => vi.fn()),
    drain: vi.fn(async () => ({ contentHash: HASH_B, fileVersionId: 'file-version-2' })),
    flush: vi.fn(async () => ({ contentHash: HASH_B, fileVersionId: 'file-version-2' })),
    release: vi.fn(async () => undefined),
  }
  const meta = {
    fileId: 'file-agent-pdf',
    originalName: '合同.pdf',
    storagePath: join(userData.dir, 'storage.pdf'),
    contentHash: overrides?.contentHash ?? HASH_A,
  }
  const manager = new AgentPdfSessionManager({
    pdf: runtime as unknown as GenOfficePdfRuntime,
    getWindow: () => window as never,
    resolveFile: async () => meta,
    editSync,
  })
  return { manager, runtime, views, window, editSync, meta }
}

let directory = ''
let workCopy = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'everroom-agent-pdf-'))
  userData.dir = directory
  const storage = join(directory, 'storage.pdf')
  await writeFile(storage, Buffer.from('%PDF-1.4 plain pdf bytes'))
  workCopy = join(directory, 'office-pdfs', 'file-agent-pdf', HASH_A, '合同.pdf')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('AgentPdfSessionManager（后台 PDF 编辑会话）', () => {
  it('describe 会拉起隐藏可编辑视图：挂主窗口、真实尺寸、不可见，并等文档就绪；工作副本落在 agent 桶', async () => {
    const harness = makeHarness()
    const outcome = await harness.manager.describe('file-agent-pdf', { roomId: 'room-1' })

    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.describe.context).toContain('合同.pdf')
    // 可编辑会话：readonly 必须是 false（缺省 true 会锁死整个编辑面）。
    expect(harness.runtime.createPdfView).toHaveBeenCalledWith(workCopy, { readonly: false })
    const view = harness.views[0]!
    expect(harness.window.contentView.addChildView).toHaveBeenCalledWith(view)
    expect(view.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1100, height: 1400 })
    expect(view.setVisible).toHaveBeenCalledWith(false)
    expect(harness.runtime.waitForAgentReady).toHaveBeenCalledWith(view.webContents, workCopy, 15_000)
    expect(harness.editSync.register).toHaveBeenCalledWith({
      fileId: 'file-agent-pdf',
      webContentsId: view.webContents.id,
      filePath: workCopy,
      originalName: '合同.pdf',
      roomId: 'room-1',
      workspaceId: null,
    })
    expect(harness.manager.has('file-agent-pdf')).toBe(true)
    expect(harness.manager.hasAny()).toBe(true)
  })

  it('apply 返回逐条结果和新版本号，并在版本回填后记住新指纹（同文件复用会话）', async () => {
    const harness = makeHarness()
    const first = await harness.manager.apply('file-agent-pdf', [
      { id: 'call-1', name: 'edit_text', input: {} },
    ])
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.results).toHaveLength(1)
      expect(first.version).toBe('file-version-2')
    }
    expect(harness.editSync.drain).toHaveBeenCalledWith('file-agent-pdf')

    // 回填后 catalog 指纹变成 HASH_B：再次编辑必须复用同一个会话，不能重建。
    harness.meta.contentHash = HASH_B
    const second = await harness.manager.apply('file-agent-pdf', [
      { id: 'call-2', name: 'read_pages', input: {} },
    ])
    expect(second.ok).toBe(true)
    expect(harness.runtime.createPdfView).toHaveBeenCalledTimes(1)
    expect(harness.runtime.applyAgentPdfTools).toHaveBeenCalledTimes(2)
  })

  it('catalog 指纹变化 → 关闭旧会话并重建（不拿旧工作副本继续改）', async () => {
    const harness = makeHarness()
    await harness.manager.describe('file-agent-pdf')
    harness.meta.contentHash = HASH_C
    const outcome = await harness.manager.describe('file-agent-pdf')

    expect(outcome.ok).toBe(true)
    expect(harness.runtime.createPdfView).toHaveBeenCalledTimes(2)
    expect(harness.editSync.release).toHaveBeenCalledWith('file-agent-pdf')
    expect(harness.window.contentView.removeChildView).toHaveBeenCalledWith(harness.views[0])
  })

  it('文档未就绪 → open_failed，并清掉隐藏视图（不读空白文档）', async () => {
    const harness = makeHarness({ ready: false })
    const outcome = await harness.manager.describe('file-agent-pdf')

    expect(outcome).toMatchObject({ ok: false, reason: 'open_failed' })
    expect(harness.runtime.describeAgentPdf).not.toHaveBeenCalled()
    expect(harness.views[0]!.webContents.close).toHaveBeenCalled()
    expect(harness.manager.has('file-agent-pdf')).toBe(false)
  })

  it('加密 PDF（头部 /Encrypt）→ encrypted，不拉起编辑器', async () => {
    await writeFile(
      join(directory, 'storage.pdf'),
      Buffer.from('%PDF-1.4 /Encrypt 12 0 R rest of header'),
    )
    const harness = makeHarness()
    const outcome = await harness.manager.describe('file-agent-pdf')

    expect(outcome).toMatchObject({ ok: false, reason: 'encrypted' })
    expect(harness.runtime.createPdfView).not.toHaveBeenCalled()
  })

  it('非 PDF（docx/xlsx）→ not_pdf，不拉起编辑器', async () => {
    const harness = makeHarness()
    harness.meta.originalName = '报告.docx'
    expect(await harness.manager.describe('file-agent-pdf')).toMatchObject({
      ok: false,
      reason: 'not_pdf',
    })
    harness.meta.originalName = '预算.xlsx'
    expect(await harness.manager.describe('file-agent-pdf')).toMatchObject({
      ok: false,
      reason: 'not_pdf',
    })
    expect(harness.runtime.createPdfView).not.toHaveBeenCalled()
  })

  it('文件内容不可读 → not_found', async () => {
    const harness = makeHarness()
    harness.meta.storagePath = join(directory, 'missing.pdf')
    const outcome = await harness.manager.describe('file-agent-pdf')
    expect(outcome).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('渲染层拒绝 apply（如加密文件在渲染层才暴露）→ not_editable', async () => {
    const harness = makeHarness()
    await harness.manager.describe('file-agent-pdf')
    harness.runtime.applyAgentPdfTools.mockResolvedValue({ error: 'this document is open read-only' })
    const outcome = await harness.manager.apply('file-agent-pdf', [
      { id: 'call-1', name: 'edit_text', input: {} },
    ])
    expect(outcome).toMatchObject({ ok: false, reason: 'not_editable' })
  })

  it('空闲回收：3 分钟无访问自动销毁会话', async () => {
    vi.useFakeTimers()
    try {
      const harness = makeHarness()
      await harness.manager.describe('file-agent-pdf')
      expect(harness.manager.has('file-agent-pdf')).toBe(true)
      vi.advanceTimersByTime(3 * 60_000 + 100)
      // dispose 是异步的：让微任务队列走完再断言。
      await vi.advanceTimersByTimeAsync(0)
      expect(harness.manager.has('file-agent-pdf')).toBe(false)
      expect(harness.editSync.release).toHaveBeenCalledWith('file-agent-pdf')
    } finally {
      vi.useRealTimers()
    }
  })
})
