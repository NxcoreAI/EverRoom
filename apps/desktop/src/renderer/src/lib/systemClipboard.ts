interface ClipboardTextWriter {
  writeText(text: string): void | Promise<void>
}

export async function writeTextToClipboard(
  text: string,
  desktopClipboard: ClipboardTextWriter | undefined = typeof window === 'undefined'
    ? undefined
    : window.nxcore?.clipboard,
  browserClipboard: ClipboardTextWriter | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator.clipboard,
): Promise<void> {
  const writer = desktopClipboard ?? browserClipboard
  if (!writer) throw new Error('剪贴板服务不可用。')
  await writer.writeText(text)
}
