import { BrowserWindow, clipboard, ipcMain } from 'electron'

export const SYSTEM_CLIPBOARD_WRITE_TEXT_CHANNEL = 'system-clipboard:write-text'

const MAX_CLIPBOARD_TEXT_BYTES = 1024 * 1024

export function validatedClipboardText(value: unknown): string {
  if (typeof value !== 'string') throw new Error('无效的剪贴板文本。')
  if (Buffer.byteLength(value, 'utf8') > MAX_CLIPBOARD_TEXT_BYTES) {
    throw new Error('剪贴板文本过大。')
  }
  return value
}

export function registerSystemClipboardHandler(): void {
  ipcMain.handle(SYSTEM_CLIPBOARD_WRITE_TEXT_CHANNEL, (event, value: unknown) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner || owner.isDestroyed() || event.sender.isDestroyed()) {
      throw new Error('无法验证剪贴板写入来源。')
    }
    if (event.senderFrame !== event.sender.mainFrame) {
      throw new Error('无法验证剪贴板写入来源。')
    }
    clipboard.writeText(validatedClipboardText(value))
  })
}
