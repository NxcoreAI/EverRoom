import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { documents } = vi.hoisted(() => ({
  documents: { workCopy: '', storage: '' },
}))

vi.mock('../src/main/office/office-view-manager', () => ({
  prepareOfficeDocument: vi.fn(async () => documents.workCopy),
}))
vi.mock('../src/main/logging/desktop-logger', () => ({ logDesktop: vi.fn() }))

import { AgentDocSessionManager } from '../src/main/office/office-agent-doc-session'
import type { GenOfficeDocsRuntime } from '../src/main/office/office-runtime'

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
    results: [{ id: 'call-1', name: 'insert_content', output: 'ok', mutated: true }],
  }))
  const runtime = {
    docs: {
      registerDocsIpc: vi.fn(),
      createDocsView: vi.fn(() => {
        const view = makeView(nextId++)
        views.push(view)
        return view
      }),
      waitForAgentReady: vi.fn(async () => true),
      describeAgentDoc: vi.fn(async () => ({ context: 'Document block list:\n0|h1|Title' })),
      applyAgentDocTools: applyImpl,
      teardownDocsRenderer: vi.fn(),
    },
  }
  return runtime
}

interface Harness {
  manager: AgentDocSessionManager
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
  if (overrides?.ready === false) runtime.docs.waitForAgentReady.mockResolvedValue(false)
  const window = makeWindow()
  const editSync = {
    register: vi.fn(() => vi.fn()),
    drain: vi.fn(async () => ({ contentHash: HASH_B, fileVersionId: 'file-version-2' })),
    flush: vi.fn(async () => ({ contentHash: HASH_B, fileVersionId: 'file-version-2' })),
    release: vi.fn(async () => undefined),
  }
  const meta = {
    fileId: 'file-agent-doc',
    originalName: '报告.docx',
    storagePath: documents.storage,
    contentHash: overrides?.contentHash ?? HASH_A,
  }
  const manager = new AgentDocSessionManager({
    docs: runtime.docs as unknown as GenOfficeDocsRuntime,
    getWindow: () => window as never,
    resolveFile: async () => meta,
    editSync,
  })
  return { manager, runtime, views, window, editSync, meta }
}

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'everroom-agent-doc-'))
  documents.storage = join(directory, 'storage.docx')
  documents.workCopy = join(directory, 'work.docx')
  await writeFile(documents.storage, Buffer.from('PK\u0003\u0004 not really a docx'))
  await writeFile(documents.workCopy, Buffer.from('PK\u0003\u0004 edited'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('AgentDocSessionManager（后台 Word 编辑会话）', () => {
  it('describe 会拉起隐藏视图：挂主窗口、设真实尺寸、不可见，并等文档就绪', async () => {
    const harness = makeHarness()
    const outcome = await harness.manager.describe('file-agent-doc', { roomId: 'room-1' })

    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.describe.context).toContain('Document block list')
    expect(harness.runtime.docs.createDocsView).toHaveBeenCalledWith(
      documents.workCopy,
      { hostMode: 'everroom' },
    )
    const view = harness.views[0]!
    expect(harness.window.contentView.addChildView).toHaveBeenCalledWith(view)
    expect(view.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1100, height: 1400 })
    expect(view.setVisible).toHaveBeenCalledWith(false)
    expect(harness.runtime.docs.waitForAgentReady).toHaveBeenCalledWith(
      view.webContents,
      documents.workCopy,
      15_000,
    )
    expect(harness.editSync.register).toHaveBeenCalledWith({
      fileId: 'file-agent-doc',
      webContentsId: view.webContents.id,
      filePath: documents.workCopy,
      originalName: '报告.docx',
      roomId: 'room-1',
      workspaceId: null,
    })
    expect(harness.manager.has('file-agent-doc')).toBe(true)
  })

  it('apply 返回逐条结果和新版本号，并在版本回填后记住新指纹（同文件复用会话）', async () => {
    const harness = makeHarness()
    const first = await harness.manager.apply('file-agent-doc', [
      { id: 'call-1', name: 'insert_content', input: {} },
    ])
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.results).toHaveLength(1)
      expect(first.version).toBe('file-version-2')
    }
    expect(harness.editSync.drain).toHaveBeenCalledWith('file-agent-doc')

    // 回填后 catalog 指纹变成 HASH_B：再次编辑必须复用同一个会话，不能重建。
    harness.meta.contentHash = HASH_B
    const second = await harness.manager.apply('file-agent-doc', [
      { id: 'call-2', name: 'apply_commands', input: {} },
    ])
    expect(second.ok).toBe(true)
    expect(harness.runtime.docs.createDocsView).toHaveBeenCalledTimes(1)
    expect(harness.runtime.docs.applyAgentDocTools).toHaveBeenCalledTimes(2)
  })

  it('catalog 指纹变化 → 关闭旧会话并重建（不拿旧工作副本继续改）', async () => {
    const harness = makeHarness()
    await harness.manager.describe('file-agent-doc')
    harness.meta.contentHash = HASH_C
    const outcome = await harness.manager.describe('file-agent-doc')

    expect(outcome.ok).toBe(true)
    expect(harness.runtime.docs.createDocsView).toHaveBeenCalledTimes(2)
    expect(harness.runtime.docs.teardownDocsRenderer).toHaveBeenCalled()
    expect(harness.editSync.release).toHaveBeenCalled()
  })

  it('文档未就绪 → open_failed，并清掉隐藏视图（不写空白文档）', async () => {
    const harness = makeHarness({ ready: false })
    const outcome = await harness.manager.describe('file-agent-doc')

    expect(outcome).toMatchObject({ ok: false, reason: 'open_failed' })
    expect(harness.runtime.docs.describeAgentDoc).not.toHaveBeenCalled()
    expect(harness.runtime.docs.teardownDocsRenderer).toHaveBeenCalled()
    expect(harness.manager.has('file-agent-doc')).toBe(false)
  })

  it('加密 docx（CFB 头）→ encrypted，不拉起编辑器', async () => {
    await writeFile(documents.storage, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]))
    const harness = makeHarness()
    const outcome = await harness.manager.describe('file-agent-doc')

    expect(outcome).toMatchObject({ ok: false, reason: 'encrypted' })
    expect(harness.runtime.docs.createDocsView).not.toHaveBeenCalled()
  })

  it('静默保存被拒绝（工作副本没变）→ save_failed，不谎报成功', async () => {
    const harness = makeHarness()
    await harness.manager.describe('file-agent-doc')
    harness.editSync.drain.mockResolvedValue(null)
    harness.editSync.flush.mockResolvedValue(null)
    // 把基线设成工作副本当前字节的哈希：apply 声称 mutated 但没有任何保存，
    // 工作副本哈希不变 → 必须返回 save_failed 而不是成功。
    const actual = createHash('sha256').update(await readFile(documents.workCopy)).digest('hex')
    harness.meta.contentHash = actual
    const session = (harness.manager as unknown as {
      sessions: Map<string, { baseContentHash: string }>
    }).sessions.get('file-agent-doc')!
    session.baseContentHash = actual
    const outcome = await harness.manager.apply('file-agent-doc', [
      { id: 'call-1', name: 'insert_content', input: {} },
    ])
    expect(outcome).toMatchObject({ ok: false, reason: 'save_failed' })
  })

  it('保存已落盘但版本回填失败 → 仍返回结果，但带明确 error（不谎报版本）', async () => {
    const harness = makeHarness()
    await harness.manager.describe('file-agent-doc')
    harness.editSync.drain.mockResolvedValue(null)
    harness.editSync.flush.mockResolvedValue(null)
    const outcome = await harness.manager.apply('file-agent-doc', [
      { id: 'call-1', name: 'insert_content', input: {} },
    ])
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.version).toBeUndefined()
      expect(outcome.error).toContain('版本回填失败')
    }
  })

  it('同一文件的并发 apply 串行执行（隐藏渲染器只有一个文档状态）', async () => {
    const harness = makeHarness()
    let inFlight = 0
    let maxInFlight = 0
    harness.runtime.docs.applyAgentDocTools.mockImplementation(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 15))
      inFlight--
      return { results: [{ id: 'call', name: 'insert_content', output: 'ok' }] }
    })

    await Promise.all([
      harness.manager.apply('file-agent-doc', [{ id: 'a', name: 'apply_commands', input: {} }]),
      harness.manager.apply('file-agent-doc', [{ id: 'b', name: 'apply_commands', input: {} }]),
    ])
    expect(maxInFlight).toBe(1)
  })

  it('disposeAll 硬清理：teardown + 注销保存回填，不请求脏关闭对话框', async () => {
    const harness = makeHarness()
    await harness.manager.describe('file-agent-doc')
    const unsubscribe = harness.editSync.register.mock.results[0]!.value as ReturnType<typeof vi.fn>

    await harness.manager.disposeAll()

    expect(harness.manager.has('file-agent-doc')).toBe(false)
    expect(harness.runtime.docs.teardownDocsRenderer).toHaveBeenCalled()
    expect(harness.editSync.release).toHaveBeenCalledWith('file-agent-doc')
    expect(unsubscribe).toHaveBeenCalled()
    // 会话销毁只走 teardown/close；脏关闭守卫（requestDocsClose）不在隐藏会话路径上。
    expect(harness.views[0]!.webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
  })
})