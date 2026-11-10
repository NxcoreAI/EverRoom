import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const { userData, runtimeMock } = vi.hoisted(() => ({
  userData: { dir: '' as string },
  runtimeMock: {
    registerMarkdownIpc: vi.fn(),
    createMarkdownView: vi.fn(),
    requestMarkdownClose: vi.fn(),
    teardownMarkdownRenderer: vi.fn(),
    setMarkdownChromeHidden: vi.fn(),
    waitForMarkdownAgentReady: vi.fn(),
  },
}))

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: (_name: string) => userData.dir },
}))

import { MarkdownViewManager } from '../src/main/office/markdown-view-manager'

/** createMarkdownView 返回的最小 WebContentsView 壳（真实现构造于 runtime 内）。 */
function fakeView() {
  const contents = {
    id: 42,
    isDestroyed: vi.fn(() => false),
    close: vi.fn(),
    once: vi.fn(),
    on: vi.fn(),
  }
  return {
    webContents: contents,
    setVisible: vi.fn(),
    setBounds: vi.fn(),
  }
}

function fakeWindow() {
  return {
    contentView: { addChildView: vi.fn() },
    isDestroyed: () => false,
    on: vi.fn(),
    removeListener: vi.fn(),
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
  } as unknown as BrowserWindow
}

const HASH = 'a'.repeat(64)

describe('MarkdownViewManager', () => {
  beforeEach(async () => {
    userData.dir = await mkdtemp(join(tmpdir(), 'md-view-'))
    vi.clearAllMocks()
  })
  afterEach(async () => {
    await rm(userData.dir, { recursive: true, force: true })
  })

  it('prepares a working copy and opens the view in everroom mode', async () => {
    const source = join(userData.dir, 'src.md')
    await writeFile(source, '# hello')
    runtimeMock.createMarkdownView.mockReturnValue(fakeView())

    const manager = await MarkdownViewManager.create(
      fakeWindow(),
      runtimeMock as never,
      { id: 'file-abc', contentHash: HASH, originalName: 'doc.md', storagePath: source },
      { editable: true },
    )

    expect(runtimeMock.registerMarkdownIpc).toHaveBeenCalled()
    const [openPath, options] = runtimeMock.createMarkdownView.mock.calls[0]!
    expect(openPath).toBe(join(userData.dir, 'office-markdowns', 'file-abc', HASH, 'doc.md'))
    expect(options).toEqual({ hostMode: 'everroom', readonly: false })
    expect(manager.documentPath).toBe(join(userData.dir, 'office-markdowns', 'file-abc', HASH, 'doc.md'))
    expect(manager.webContentsId).toBe(42)
  })

  it('rejects non-markdown internal names and malformed identities', async () => {
    const source = join(userData.dir, 'src.md')
    await writeFile(source, '# hello')
    await expect(MarkdownViewManager.create(
      fakeWindow(), runtimeMock as never,
      { id: 'file-abc', contentHash: HASH, originalName: 'doc.docx', storagePath: source },
    )).rejects.toThrow(/Unsupported internal markdown/)
    await expect(MarkdownViewManager.create(
      fakeWindow(), runtimeMock as never,
      { id: 'evil!', contentHash: HASH, originalName: 'doc.md', storagePath: source },
    )).rejects.toThrow(/invalid/i)
    expect(runtimeMock.createMarkdownView).not.toHaveBeenCalled()
  })

  it('reuses the existing working copy across opens (same hash)', async () => {
    const source = join(userData.dir, 'src.md')
    await writeFile(source, '# hello')
    runtimeMock.createMarkdownView.mockReturnValue(fakeView())

    await MarkdownViewManager.create(
      fakeWindow(), runtimeMock as never,
      { id: 'file-abc', contentHash: HASH, originalName: 'doc.md', storagePath: source },
    )
    // 同一 (fileId, hash) 再开：工作副本已存在，直接复用同一路径。
    const again = await MarkdownViewManager.create(
      fakeWindow(), runtimeMock as never,
      { id: 'file-abc', contentHash: HASH, originalName: 'doc.md', storagePath: source },
    )
    expect(again.documentPath).toBe(join(userData.dir, 'office-markdowns', 'file-abc', HASH, 'doc.md'))
  })

  it('forwards chrome toggle and agent-ready wait to the runtime', async () => {
    const source = join(userData.dir, 'src.md')
    await writeFile(source, '# hello')
    runtimeMock.createMarkdownView.mockReturnValue(fakeView())
    runtimeMock.waitForMarkdownAgentReady.mockResolvedValue(true)

    const manager = await MarkdownViewManager.create(
      fakeWindow(), runtimeMock as never,
      { id: 'file-abc', contentHash: HASH, originalName: 'doc.md', storagePath: source },
    )

    manager.setChromeHidden(true)
    expect(runtimeMock.setMarkdownChromeHidden).toHaveBeenCalledWith(expect.anything(), true)
    manager.setChromeHidden()
    expect(runtimeMock.setMarkdownChromeHidden).toHaveBeenCalledWith(expect.anything(), undefined)

    await expect(manager.waitForAgentReady(500)).resolves.toBe(true)
    expect(runtimeMock.waitForMarkdownAgentReady).toHaveBeenCalledWith(
      expect.anything(),
      join(userData.dir, 'office-markdowns', 'file-abc', HASH, 'doc.md'),
      500,
    )
  })

  it('runs the dirty-close guard and tears down the renderer state on dispose', async () => {
    const source = join(userData.dir, 'src.md')
    await writeFile(source, '# hello')
    const view = fakeView()
    runtimeMock.createMarkdownView.mockReturnValue(view)
    runtimeMock.requestMarkdownClose.mockResolvedValue(true)

    const manager = await MarkdownViewManager.create(
      fakeWindow(), runtimeMock as never,
      { id: 'file-abc', contentHash: HASH, originalName: 'doc.md', storagePath: source },
      { editable: true },
    )

    // 编辑态关闭：先问脏守卫，通过后 teardown + close。
    await expect(manager.dispose()).resolves.toBe(true)
    expect(runtimeMock.requestMarkdownClose).toHaveBeenCalledTimes(1)
    expect(runtimeMock.teardownMarkdownRenderer).toHaveBeenCalledWith(view.webContents)
    expect(view.webContents.close).toHaveBeenCalled()

    // 守卫取消：视图原样保留（不 teardown）。
    runtimeMock.requestMarkdownClose.mockResolvedValue(false)
    const manager2 = await MarkdownViewManager.create(
      fakeWindow(), runtimeMock as never,
      { id: 'file-abc', contentHash: 'b'.repeat(64), originalName: 'doc.md', storagePath: source },
      { editable: true },
    )
    await expect(manager2.dispose()).resolves.toBe(false)
    expect(runtimeMock.teardownMarkdownRenderer).toHaveBeenCalledTimes(1)
  })
})
