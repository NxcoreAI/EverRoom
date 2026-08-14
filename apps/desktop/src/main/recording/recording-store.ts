import { randomUUID } from 'node:crypto'
import { mkdir, open, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

interface ActiveRecording {
  handle: FileHandle
  fileName: string
  size: number
  writes: Promise<void>
}

const MAX_CHUNK_BYTES = 8 * 1024 * 1024
const MAX_RECORDING_BYTES = 2 * 1024 * 1024 * 1024

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes('mp4')) return '.m4a'
  if (normalized.includes('ogg')) return '.ogg'
  return '.webm'
}

function requireRecordingId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)) {
    throw new Error('无效的录音标识。')
  }
  return value
}

export class RecordingStore {
  private readonly recordings = new Map<string, ActiveRecording>()

  constructor(private readonly directory: string) {}

  async begin(mimeType: unknown): Promise<{ id: string }> {
    if (typeof mimeType !== 'string' || mimeType.length > 100) throw new Error('无效的录音格式。')
    await mkdir(this.directory, { recursive: true })
    const id = randomUUID()
    const fileName = `${id}${extensionForMimeType(mimeType)}`
    const handle = await open(join(this.directory, fileName), 'wx')
    this.recordings.set(id, { handle, fileName, size: 0, writes: Promise.resolve() })
    return { id }
  }

  async append(idValue: unknown, chunkValue: unknown): Promise<void> {
    const id = requireRecordingId(idValue)
    const recording = this.recordings.get(id)
    if (!recording) throw new Error('录音不存在或已经结束。')
    if (!(chunkValue instanceof Uint8Array)) throw new Error('无效的录音数据。')
    if (chunkValue.byteLength === 0) return
    if (chunkValue.byteLength > MAX_CHUNK_BYTES) throw new Error('单个录音数据块过大。')
    if (recording.size + chunkValue.byteLength > MAX_RECORDING_BYTES) throw new Error('录音文件过大。')
    const chunk = Buffer.from(chunkValue.buffer, chunkValue.byteOffset, chunkValue.byteLength)
    recording.size += chunk.byteLength
    recording.writes = recording.writes.then(async () => {
      await recording.handle.write(chunk)
    })
    await recording.writes
  }

  async finish(idValue: unknown): Promise<{ filePath: string }> {
    const id = requireRecordingId(idValue)
    const recording = this.recordings.get(id)
    if (!recording) throw new Error('录音不存在或已经结束。')
    this.recordings.delete(id)
    await recording.writes
    await recording.handle.close()
    if (recording.size === 0) {
      await rm(join(this.directory, recording.fileName), { force: true })
      throw new Error('没有录到音频，请重试。')
    }
    return { filePath: recording.fileName }
  }

  async cancel(idValue: unknown): Promise<void> {
    const id = requireRecordingId(idValue)
    const recording = this.recordings.get(id)
    if (!recording) return
    this.recordings.delete(id)
    await recording.writes.catch(() => undefined)
    await recording.handle.close().catch(() => undefined)
    await rm(join(this.directory, recording.fileName), { force: true })
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.recordings.keys()].map((id) => this.cancel(id)))
  }
}
