import { createHash, randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import axios from 'axios'

import type { PrivateAudioAsset, SaasClient } from '../cloud/saas-client'
import { AccountKeyringService, combinedDecrypt, combinedEncrypt, keyId } from '../security/account-keyring-service'

const AUDIO_SCHEMA_VERSION = 1

function hash(value: Buffer): string { return `sha256:${createHash('sha256').update(value).digest('hex')}` }

export class PrivateAudioSyncService {
  constructor(
    private readonly client: SaasClient,
    private readonly keyring: AccountKeyringService,
    private readonly recordingsDirectory: string,
  ) {}

  async list(cursor = 0): Promise<{ assets: PrivateAudioAsset[]; nextCursor: number }> {
    return this.client.listPrivateAudio(cursor)
  }

  async downloadById(assetId: string, outputPath: string): Promise<string> {
    const page = await this.client.listPrivateAudio(0)
    const asset = page.assets.find((item) => item.id === assetId)
    if (!asset) throw new Error('音频资产不存在。')
    return this.download(asset, outputPath)
  }

  async upload(filePath: string, recordingId: string, durationMs: number, mimeType: string): Promise<PrivateAudioAsset> {
    const account = await this.client.status()
    if (!account.authenticated || !account.user) throw new Error('请先登录后同步录音。')
    const material = await this.keyring.getUmk(account.user.id)
    if (!material) throw new Error('账号主密钥不可用，无法同步音频。')
    const resolvedPath = isAbsolute(filePath) ? filePath : join(this.recordingsDirectory, filePath)
    const plain = await readFile(resolvedPath)
    if (!plain.length) throw new Error('录音文件为空。')
    const dataKey = randomBytes(32)
    const dataKeyId = keyId(dataKey)
    const audioAad = Buffer.from(`everroom.private-audio.v${AUDIO_SCHEMA_VERSION}:${recordingId}:${dataKeyId}:${material.umkId}:${material.version}`, 'utf8')
    const wrappedAad = Buffer.from(`everroom.wrapped-dek.v1:${recordingId}:${dataKeyId}:${material.umkId}:${material.version}`, 'utf8')
    const cipher = Buffer.from(combinedEncrypt(dataKey, plain, audioAad), 'base64')
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
    })
    const authorization = await this.client.authorizePrivateAudioUpload(asset.id)
    await axios.put(authorization.uploadUrl, cipher, {
      headers: { ...authorization.headers, 'Content-Length': String(cipher.length) },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 5 * 60_000,
    })
    return this.client.completePrivateAudioUpload(asset.id)
  }

  async download(asset: PrivateAudioAsset, outputPath: string): Promise<string> {
    const account = await this.client.status()
    if (!account.authenticated || !account.user) throw new Error('请先登录后下载录音。')
    const material = await this.keyring.getUmk(account.user.id)
    if (!material || material.umkId !== asset.wrappingKeyId || material.version !== asset.wrappingKeyVersion) throw new Error('本机账号主密钥版本无法解密该音频。')
    const authorization = await this.client.authorizePrivateAudioDownload(asset.id)
    const response = await axios.get<ArrayBuffer>(authorization.downloadUrl, { responseType: 'arraybuffer', timeout: 5 * 60_000 })
    const cipher = Buffer.from(response.data)
    if (hash(cipher) !== asset.cipherContentHash) throw new Error('音频密文完整性校验失败。')
    const dataKey = combinedDecrypt(material.value, asset.wrappedKey, Buffer.from(`everroom.wrapped-dek.v1:${asset.recordingId}:${asset.dataKeyId}:${material.umkId}:${material.version}`, 'utf8'))
    if (keyId(dataKey) !== asset.dataKeyId) throw new Error('音频数据密钥校验失败。')
    const plain = combinedDecrypt(dataKey, cipher.toString('base64'), Buffer.from(`everroom.private-audio.v${asset.schemaVersion}:${asset.recordingId}:${asset.dataKeyId}:${material.umkId}:${material.version}`, 'utf8'))
    if (hash(plain) !== asset.plainContentHash) throw new Error('音频明文完整性校验失败。')
    await writeFile(outputPath, plain, { mode: 0o600 })
    return outputPath
  }
}
