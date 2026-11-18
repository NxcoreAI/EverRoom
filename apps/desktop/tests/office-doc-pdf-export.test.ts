import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

interface Harness {
  manager: AgentDocSessionManager
  docs: Record<string, ReturnType<typeof vi.fn>>
  views: FakeView[]
  meta: { fileId: string; originalName: string; storagePath: string; contentHash: string }
}

function makeHarness(overrides?: {
  exportImpl?: (contents: unknown, outPath: string) => Promise<{ path: string } | { error: string }>
}): Harness {
  const views: FakeView[] = []
  let nextId = 800
  const docs: Record<string, ReturnType<typeof vi.fn>> = {
    registerDocsIpc: vi.fn(),
    createDocsView: vi.fn(() => {
      const view = makeView(nextId++)
      views.push(view)
      return view
    }),
    waitForAgentReady: vi.fn(async () => true),
    describeAgentDoc: vi.fn(async () => ({ context: 'Document block list:\n0|h1|Title' })),
    applyAgentDocTools: vi.fn(async () => ({ results: [] })),
    teardownDocsRenderer: vi.fn(),
    ...(overrides?.exportImpl ? { exportDocsPdf: vi.fn(overrides.exportImpl) } : {}),
  }
  const window = makeWindow()
  const editSync = {
    register: vi.fn(() => vi.fn()),
    drain: vi.fn(async () => null),
    flush: vi.fn(async () => null),
    release: vi.fn(async () => undefined),
  }
  const meta = {
    fileId: 'file-export-doc',
    originalName: '报告.docx',
    storagePath: documents.storage,
    contentHash: HASH_A,
  }
  const manager = new AgentDocSessionManager({
    docs: docs as unknown as GenOfficeDocsRuntime,
    getWindow: () => window as never,
    resolveFile: async () => meta,
    editSync,
  })
  return { manager, docs, views, meta }
}

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'everroom-doc-export-'))
  documents.storage = join(directory, 'storage.docx')
  documents.workCopy = join(directory, 'work.docx')
  await writeFile(documents.storage, Buffer.from('PK\u0003\u0004 not really a docx'))
  await writeFile(documents.workCopy, Buffer.from('PK\u0003\u0004 edited'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('AgentDocSessionManager.exportPdf（进程内导出）', () => {
  it('复用隐藏会话装载文档并让渲染层写 PDF', async () => {
    const outPath = join(directory, 'out.pdf')
    const harness = makeHarness({
      exportImpl: async (_contents, target) => ({ path: target }),
    })

    const outcome = await harness.manager.exportPdf('file-export-doc', outPath)

    expect(outcome).toEqual({ ok: true, path: outPath })
    expect(harness.docs.createDocsView).toHaveBeenCalledWith(
      documents.workCopy,
      { hostMode: 'everroom' },
    )
    expect(harness.docs.exportDocsPdf).toHaveBeenCalledTimes(1)
    expect(harness.docs.exportDocsPdf).toHaveBeenCalledWith(
      harness.views[0]!.webContents,
      outPath,
    )
  })

  it('渲染层失败时返回 error 失败原因', async () => {
    const harness = makeHarness({
      exportImpl: async () => ({ error: 'renderer did not reply in time' }),
    })

    const outcome = await harness.manager.exportPdf('file-export-doc', join(directory, 'x.pdf'))

    expect(outcome).toEqual({
      ok: false,
      reason: 'error',
      message: 'renderer did not reply in time',
    })
  })

  it('运行时缺 exportDocsPdf（老 genoffice 构建）返回 unsupported，不拉起会话', async () => {
    const harness = makeHarness()

    const outcome = await harness.manager.exportPdf('file-export-doc', join(directory, 'y.pdf'))

    expect(outcome).toEqual({
      ok: false,
      reason: 'unsupported',
      message: '当前 GenOffice 运行时不支持进程内 PDF 导出',
    })
    expect(harness.docs.createDocsView).not.toHaveBeenCalled()
  })
})
