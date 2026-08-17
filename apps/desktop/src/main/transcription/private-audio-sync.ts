import { createHash, randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import axios from 'axios'

import type { PrivateAudioAsset, SaasClient } from '../cloud/saas-client'
import { AccountKeyringService, combinedDecrypt, combinedEncrypt, keyId } from '../security/account-keyring-service'

const AUDIO_SCHEMA_VERSION = 1
const AUDIO_CHUNK_SIZE = 4 * 1024 * 1024

function hash(value: Buffer): string { return `sha256:${createHash('sha256').update(value).digest('hex')}` }

export class PrivateAudioSyncService {
  constructor(
    private readonly client: SaasClient,
    private readonly keyring: AccountKeyringService,
    private readonly recordingsDirectory: string,
    private readonly queueFile: string,
  ) {}

  async drainPending(): Promise<void> {
    let pending: Array<{ filePath: string; recordingId: string; durationMs: number; mimeType: string }> = []
    try { pending = JSON.parse(await readFile(this.queueFile, 'utf8')) as typeof pending } catch { return }
    const remaining: typeof pending = []
    for (const item of pending) {
      try { await this.upload(item.filePath, item.recordingId, item.durationMs, item.mimeType, false) } catch { remaining.push(item) }
    }
    await mkdir(dirname(this.queueFile), { recursive: true })
    await writeFile(this.queueFile, JSON.stringify(remaining), { mode: 0o600 })
  }

  async list(cursor = 0): Promise<{ assets: PrivateAudioAsset[]; nextCursor: number }> {
    return this.client.listPrivateAudio(cursor)
  }

  async downloadById(assetId: string, outputPath: string): Promise<string> {
    const page = await this.client.listPrivateAudio(0)
    const asset = page.assets.find((item) => item.id === assetId)
    if (!asset) throw new Error('音频资产不存在。')
    return this.download(asset, outputPath)
  }

  async upload(filePath: string, recordingId: string, durationMs: number, mimeType: string, enqueueOnFailure = true): Promise<PrivateAudioAsset> {
    const account = await this.client.status()
    if (!account.authenticated || !account.user) throw new Error('请先登录后同步录音。')
    const material = await this.keyring.getUmk(account.user.id)
    if (!material) throw new Error('账号主密钥不可用，无法同步音频。')
    const resolvedPath = isAbsolute(filePath) ? filePath : join(this.recordingsDirectory, filePath)
    const plain = await readFile(resolvedPath)
    if (!plain.length) throw new Error('录音文件为空。')
    const dataKey = randomBytes(32)
    const dataKeyId = keyId(dataKey)
    const wrappedAad = Buffer.from(`everroom.wrapped-dek.v1:${recordingId}:${dataKeyId}:${material.umkId}:${material.version}`, 'utf8')
    const chunks: Buffer[] = []
    for (let offset = 0, index = 0; offset < plain.length; offset += AUDIO_CHUNK_SIZE, index += 1) {
      const piece = plain.subarray(offset, Math.min(plain.length, offset + AUDIO_CHUNK_SIZE))
      chunks.push(Buffer.from(combinedEncrypt(dataKey, piece, Buffer.from(`everroom.private-audio.v${AUDIO_SCHEMA_VERSION}:${recordingId}:${dataKeyId}:${material.umkId}:${material.version}:${index}`, 'utf8')), 'base64'))
    }
    const cipher = Buffer.concat(chunks)
    const wrappedKey = combinedEncrypt(material.value, dataKey, wrappedAad)
    const plainContentHash = hash(plain)
    const cipherContentHash = hash(cipher)
    const asset = await this.client.createPrivateAudio({
      recordingId,
      fileName: basename(resolvedPath),
      mimeType,
      durationMs,
      plainSize: plain.length,
      cipherSize: cipher.length,
      plainContentHash,
      cipherContentHash,
      encryptionAlgorithm: 'AES-256-GCM',
      schemaVersion: AUDIO_SCHEMA_VERSION,
      dataKeyId,
      wrappingAlgorithm: 'AES-256-GCM',
      wrappingKeyId: material.umkId,
      wrappingKeyVersion: material.version,
      wrappedKey,
      chunkCount: chunks.length,
      chunkPlainSize: AUDIO_CHUNK_SIZE,
    })
    try {
      for (let index = 0, plainOffset = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]
        const plainSize = Math.min(AUDIO_CHUNK_SIZE, plain.length - plainOffset)
        plainOffset += plainSize
        const authorization = await this.client.authorizePrivateAudioChunk(asset.id, index, { plainSize, cipherSize: chunk.length, cipherContentHash: hash(chunk) })
        await axios.put(authorization.uploadUrl, chunk, { headers: { ...authorization.headers, 'Content-Length': String(chunk.length) }, maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 5 * 60_000 })
        await this.client.completePrivateAudioChunk(asset.id, index)
      }
      await this.client.completePrivateAudioChunks(asset.id)
      return asset
    } catch (error) {
      if (enqueueOnFailure) await this.enqueue({ filePath, recordingId, durationMs, mimeType })
      throw error
    }
  }

  private async enqueue(item: { filePath: string; recordingId: string; durationMs: number; mimeType: string }) {
    let pending: typeof item[] = []
    try { pending = JSON.parse(await readFile(this.queueFile, 'utf8')) as typeof pending } catch { }
    if (!pending.some((entry) => entry.recordingId === item.recordingId)) pending.push(item)
    await mkdir(dirname(this.queueFile), { recursive: true })
    await writeFile(this.queueFile, JSON.stringify(pending), { mode: 0o600 })
  }

  async download(asset: PrivateAudioAsset, outputPath: string): Promise<string> {
    const account = await this.client.status()
    if (!account.authenticated || !account.user) throw new Error('请先登录后下载录音。')
    const material = await this.keyring.getUmk(account.user.id)
    if (!material || material.umkId !== asset.wrappingKeyId || material.version !== asset.wrappingKeyVersion) throw new Error('本机账号主密钥版本无法解密该音频。')
    const dataKey = combinedDecrypt(material.value, asset.wrappedKey, Buffer.from(`everroom.wrapped-dek.v1:${asset.recordingId}:${asset.dataKeyId}:${material.umkId}:${material.version}`, 'utf8'))
    if (keyId(dataKey) !== asset.dataKeyId) throw new Error('音频数据密钥校验失败。')
    const chunks: Buffer[] = []
    const count = asset.chunkCount ?? 1
    for (let index = 0; index < count; index += 1) {
      const authorization = count > 1 ? await this.client.authorizePrivateAudioChunkDownload(asset.id, index) : await this.client.authorizePrivateAudioDownload(asset.id)
      const response = await axios.get<ArrayBuffer>(authorization.downloadUrl, { responseType: 'arraybuffer', timeout: 5 * 60_000 })
      const cipherChunk = Buffer.from(response.data)
      let chunkPlain: Buffer
      try { chunkPlain = combinedDecrypt(dataKey, cipherChunk.toString('base64'), Buffer.from(`everroom.private-audio.v${asset.schemaVersion}:${asset.recordingId}:${asset.dataKeyId}:${material.umkId}:${material.version}:${index}`, 'utf8')) }
      catch { if (count !== 1) throw new Error('音频分片认证失败。'); chunkPlain = combinedDecrypt(dataKey, cipherChunk.toString('base64'), Buffer.from(`everroom.private-audio.v${asset.schemaVersion}:${asset.recordingId}:${asset.dataKeyId}:${material.umkId}:${material.version}`, 'utf8')) }
      chunks.push(chunkPlain)
    }
    const plain = Buffer.concat(chunks)
    if (hash(plain) !== asset.plainContentHash) throw new Error('音频明文完整性校验失败。')
    await writeFile(outputPath, plain, { mode: 0o600 })
    return outputPath
  }
}
