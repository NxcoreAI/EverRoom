import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { GatewaySupervisor } from '../gateway/gateway-supervisor'
import type { WindowScreenshotResult } from './window-screenshot-service'

interface ScreenshotOutboxItem {
  id: string
  filePath: string
  fileName: string
  width: number
  height: number
  capturedAt: string
  perceptualHash: string
  uploadedFileId?: string
}

export class ScreenshotOutbox {
  private items: ScreenshotOutboxItem[] = []
  private initialized = false
  private operation: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly statePath: string,
    private readonly getSupervisor: () => GatewaySupervisor | null,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return
    await mkdir(dirname(this.statePath), { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as unknown
      this.items = Array.isArray(parsed) ? parsed.filter(isOutboxItem) : []
    } catch {
      this.items = []
    }
    this.initialized = true
    this.timer = setInterval(() => void this.flush(), 15_000)
    this.timer.unref?.()
    void this.flush()
  }

  async enqueue(result: WindowScreenshotResult): Promise<void> {
    if (!result.perceptualHash) throw new Error('Screenshot perceptual hash is missing')
    const perceptualHash = result.perceptualHash
    await this.initialize()
    await this.serial(async () => {
      if (this.items.some((item) => item.filePath === result.filePath)) return
      this.items.push({
        id: randomUUID(), filePath: result.filePath, fileName: result.fileName,
        width: result.width, height: result.height, capturedAt: result.capturedAt,
        perceptualHash,
      })
      await this.persist()
    })
    void this.flush()
  }

  flush(): Promise<void> {
    return this.serial(async () => {
      const supervisor = this.getSupervisor()
      if (!supervisor || this.items.length === 0) return
      let connection
      try { connection = await supervisor.ensureConnection() } catch { return }
      while (this.items[0]) {
        const item = this.items[0]
        try {
          if (!item.uploadedFileId) {
            const bytes = await readFile(item.filePath)
            const upload = await fetch(`${connection.baseUrl}/v1/files`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                filename: item.fileName,
                contentBase64: bytes.toString('base64'),
                mime: 'image/jpeg',
                assetKind: 'screenshot',
                originChannel: 'everroom-window-capture',
                visibility: 'private',
                capturedAt: item.capturedAt,
              }),
            })
            if (!upload.ok) throw new Error(`Screenshot upload failed (${String(upload.status)})`)
            const uploaded = await upload.json() as { id?: unknown }
            if (typeof uploaded.id !== 'string') throw new Error('Screenshot upload returned no file id')
            item.uploadedFileId = uploaded.id
            await this.persist()
          }
          const observation = await fetch(`${connection.baseUrl}/v1/perception/visual-observations`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fileId: item.uploadedFileId, kind: 'screenshot', capturedAt: item.capturedAt,
              perceptualHash: item.perceptualHash, width: item.width, height: item.height,
            }),
          })
          if (!observation.ok) throw new Error(`Screenshot observation failed (${String(observation.status)})`)
          this.items.shift()
          await this.persist()
          await unlink(item.filePath).catch(() => undefined)
        } catch {
          return
        }
      }
    })
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.operation
  }

  private serial(action: () => Promise<void>): Promise<void> {
    const next = this.operation.then(action, action)
    this.operation = next.catch(() => undefined)
    return next
  }

  private async persist(): Promise<void> {
    const temporary = `${this.statePath}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(this.items), { flag: 'wx', mode: 0o600 })
      await rename(temporary, this.statePath)
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }
}

function isOutboxItem(value: unknown): value is ScreenshotOutboxItem {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return ['id', 'filePath', 'fileName', 'capturedAt', 'perceptualHash'].every((key) => typeof row[key] === 'string')
    && typeof row.width === 'number' && typeof row.height === 'number'
    && (row.uploadedFileId === undefined || typeof row.uploadedFileId === 'string')
}
