import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  writeText: vi.fn(),
  handle: vi.fn(),
  owner: { isDestroyed: vi.fn(() => false) },
  fromWebContents: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electronMocks.fromWebContents },
  clipboard: { writeText: electronMocks.writeText },
  ipcMain: { handle: electronMocks.handle },
}))

import {
  registerSystemClipboardHandler,
  SYSTEM_CLIPBOARD_WRITE_TEXT_CHANNEL,
  validatedClipboardText,
} from '../src/main/system-clipboard'
import { writeTextToClipboard } from '../src/renderer/src/lib/systemClipboard'

function registeredHandler(): (event: unknown, value: unknown) => void {
  registerSystemClipboardHandler()
  expect(electronMocks.handle).toHaveBeenCalledWith(
    SYSTEM_CLIPBOARD_WRITE_TEXT_CHANNEL,
    expect.any(Function),
  )
  return electronMocks.handle.mock.calls.at(-1)?.[1] as (event: unknown, value: unknown) => void
}

function mainFrameEvent() {
  const mainFrame = {}
  const sender = { isDestroyed: vi.fn(() => false), mainFrame }
  return { sender, senderFrame: mainFrame }
}

beforeEach(() => {
  vi.clearAllMocks()
  electronMocks.fromWebContents.mockReturnValue(electronMocks.owner)
})

describe('system clipboard', () => {
  it('writes validated text through the Electron clipboard', () => {
    registeredHandler()(mainFrameEvent(), 'everroom://room/room-1/doc-1/block-1')

    expect(electronMocks.writeText).toHaveBeenCalledWith('everroom://room/room-1/doc-1/block-1')
  })

  it('rejects non-main-frame calls and oversized text', () => {
    const event = mainFrameEvent()
    expect(() => registeredHandler()({ ...event, senderFrame: {} }, 'text'))
      .toThrow('无法验证剪贴板写入来源')
    expect(() => validatedClipboardText('x'.repeat(1024 * 1024 + 1)))
      .toThrow('剪贴板文本过大')
  })

  it('prefers the desktop bridge and falls back to the browser writer', async () => {
    const desktopWriter = { writeText: vi.fn(async () => undefined) }
    const browserWriter = { writeText: vi.fn(async () => undefined) }

    await writeTextToClipboard('desktop', desktopWriter, browserWriter)
    await writeTextToClipboard('browser', undefined, browserWriter)

    expect(desktopWriter.writeText).toHaveBeenCalledWith('desktop')
    expect(browserWriter.writeText).toHaveBeenCalledTimes(1)
    expect(browserWriter.writeText).toHaveBeenCalledWith('browser')
  })
})
