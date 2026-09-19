import { createHash } from 'node:crypto'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'

import { VersionedJsonStore } from '@nxcore/migration-kit'

import type { PrivateAudioAsset, SaasClient } from '../cloud/saas-client'
import { AccountKeyringService } from '../security/account-keyring-service'
import { createLoggedHttpClient } from '../network/http-client'

const AUDIO_CHUNK_SIZE = 4 * 1024 * 1024
// OSS 直传/下载走共享工厂，外网请求由 Chromium 网络栈处理（系统代理）。
const http = createLoggedHttpClient('saas-audio', { timeout: 5 * 60_000 })

function hash(value: Buffer): string { return `sha256:${createHash('sha256').update(value).digest('hex')}` }

interface PendingAudioItem { filePath: string; recordingId: string; durationMs: number; mimeType: string }

function isPendingAudioItem(value: unknown): value is PendingAudioItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item['filePath'] === 'string' && typeof item['recordingId'] === 'string'
    && typeof item['durationMs'] === 'number' && typeof item['mimeType'] === 'string'
}

export class PrivateAudioSyncService {
  private eventResolver: ((recordingId: string) => Promise<string | null>) | null = null
  private readonly queue: VersionedJsonStore<PendingAudioItem[]>

  constructor(
    private readonly client: SaasClient,
    private readonly keyring: AccountKeyringService,
    private readonly recordingsDirectory: string,
    queueFile: string,
    backupDir?: string,
  ) {
    this.queue = new VersionedJsonStore<PendingAudioItem[]>({
      filePath: queueFile,
      migrations: [],
      adoptBaseline: (raw) => (Array.isArray(raw) ? raw.filter(isPendingAudioItem) : []),
      fallback: [],
      ...(backupDir !== undefined ? { backupDir } : {}),
    })
  }

  setEventResolver(resolver: (recordingId: string) => Promise<string | null>): void { this.eventResolver = resolver }

  async drainPending(): Promise<void> {
    const pending = this.queue.read()
    if (!pending.length) return
    const remaining: PendingAudioItem[] = []
    for (const item of pending) {
      try { await this.upload(item.filePath, item.recordingId, item.durationMs, item.mimeType, false) } catch { remaining.push(item) }
    }
    this.queue.write(remaining)
  }

  async list(cursor = 0): Promise<{ assets: PrivateAudioAsset[]; nextCursor: number }> {
    const page = await this.client.listPrivateAudio(cursor)
    if (!this.eventResolver) return page
    return { ...page, assets: await Promise.all(page.assets.map(async (asset) => ({ ...asset, eventId: asset.eventId && asset.eventId !== asset.recordingId ? asset.eventId : await this.eventResolver!(asset.recordingId) ?? asset.eventId }))) }
  }

  async downloadById(assetId: string, outputPath: string): Promise<string> {
    const page = await this.list(0)
    const asset = page.assets.find((item) => item.id === assetId)
    if (!asset) throw new Error('音频资产不存在。')
    return this.download(asset, outputPath)
  }

  async read(assetId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const page = await this.list(0)
    const asset = page.assets.find((item) => item.id === assetId && item.status === 'uploaded')
    if (!asset) throw new Error('音频资产不存在或尚未上传完成。')
    const outputPath = join(this.recordingsDirectory, `.synced-${asset.id}`)
    try {
      await this.download(asset, outputPath)
      return { bytes: new Uint8Array(await readFile(outputPath)), mimeType: asset.mimeType }
    } finally {
      await rm(outputPath, { force: true }).catch(() => undefined)
    }
  }

  async upload(filePath: string, recordingId: string, durationMs: number, mimeType: string, enqueueOnFailure = true): Promise<PrivateAudioAsset> {
    const account = await this.client.status()
    if (!account.authenticated || !account.user) throw new Error('请先登录后同步录音。')
    const resolvedPath = isAbsolute(filePath) ? filePath : join(this.recordingsDirectory, filePath)
    const plain = await readFile(resolvedPath)
    if (!plain.length) throw new Error('录音文件为空。')
    const chunks: Buffer[] = []
    for (let offset = 0, index = 0; offset < plain.length; offset += AUDIO_CHUNK_SIZE, index += 1) {
      const piece = plain.subarray(offset, Math.min(plain.length, offset + AUDIO_CHUNK_SIZE))
      chunks.push(piece)
    }
    const asset = await this.client.createPrivateAudio({
      recordingId,
      fileName: basename(resolvedPath),
      mimeType,
      durationMs,
      fileSize: plain.length,
      contentHash: hash(plain),
      chunkCount: chunks.length,
      chunkSize: AUDIO_CHUNK_SIZE,
    })
    try {
      for (let index = 0, plainOffset = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]
        const plainSize = Math.min(AUDIO_CHUNK_SIZE, plain.length - plainOffset)
        plainOffset += plainSize
        const authorization = await this.client.authorizePrivateAudioChunk(asset.id, index, { fileSize: plainSize, contentHash: hash(chunk) })
        await http.put(authorization.uploadUrl, chunk, { headers: { ...authorization.headers }, maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 5 * 60_000 })
        await this.client.completePrivateAudioChunk(asset.id, index)
      }
      return await this.client.completePrivateAudioChunks(asset.id)
    } catch (error) {
      if (enqueueOnFailure) await this.enqueue({ filePath, recordingId, durationMs, mimeType })
      throw error
    }
  }

  private async enqueue(item: PendingAudioItem) {
    const pending = this.queue.read()
    if (!pending.some((entry) => entry.recordingId === item.recordingId)) pending.push(item)
    this.queue.write(pending)
  }

  async download(asset: PrivateAudioAsset, outputPath: string): Promise<string> {
    const account = await this.client.status()
    if (!account.authenticated || !account.user) throw new Error('请先登录后下载录音。')
    const chunks: Buffer[] = []
    const count = asset.chunkCount ?? 1
    const chunked = !asset.objectKey
    for (let index = 0; index < count; index += 1) {
      const authorization = chunked ? await this.client.authorizePrivateAudioChunkDownload(asset.id, index) : await this.client.authorizePrivateAudioDownload(asset.id)
      const response = await http.get<ArrayBuffer>(authorization.downloadUrl, { responseType: 'arraybuffer', timeout: 5 * 60_000 })
      chunks.push(Buffer.from(response.data))
    }
    const plain = Buffer.concat(chunks)
    if (hash(plain) !== asset.contentHash) throw new Error('音频完整性校验失败。')
    await writeFile(outputPath, plain, { mode: 0o600 })
    return outputPath
  }
}
