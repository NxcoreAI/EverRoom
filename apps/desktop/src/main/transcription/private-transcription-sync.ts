import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { AccountKeyringStatus, AsrSegment, PrivateTranscriptionRecord, PrivateTranscriptionSyncResult } from '../../shared/sources'
import type { PairingSessionResponse, PrivateRecordEnvelope, SaasClient } from '../cloud/saas-client'
import { AccountKeyringService, combinedDecrypt, keyId } from '../security/account-keyring-service'

interface StoredSyncState {
  accounts: Record<string, { cursor: number; records: Record<string, PrivateTranscriptionRecord> }>
}

function hashBase64(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function parsePlaintext(recordId: string, plaintext: Buffer, envelope: PrivateRecordEnvelope): PrivateTranscriptionRecord {
  let value: unknown
  try {
    value = JSON.parse(plaintext.toString('utf8'))
  } catch {
    value = { transcript: plaintext.toString('utf8') }
  }
  const object = value && typeof value === 'object' ? value as Record<string, unknown> : { transcript: String(value ?? '') }
  if (
    object.kind !== undefined
    && !['everroom.transcription', 'everroom.transcription-source', 'everroom.transcription-summary'].includes(String(object.kind))
  ) throw new Error(`转写记录 ${recordId} 的类型无效。`)
  if (object.eventId !== undefined && object.eventId !== recordId) throw new Error(`转写记录 ${recordId} 的事件标识无效。`)
  const transcriptLines = Array.isArray(object.transcriptLines) ? object.transcriptLines : []
  const transcript = typeof object.transcript === 'string'
    ? object.transcript
    : typeof object.rawTranscript === 'string'
      ? object.rawTranscript
      : typeof object.detailMarkdown === 'string'
        ? object.detailMarkdown
        : object.summary && typeof object.summary === 'object' && typeof (object.summary as Record<string, unknown>).overview === 'string'
          ? (object.summary as Record<string, unknown>).overview as string
        : transcriptLines.map((line) => line && typeof line === 'object' && typeof (line as Record<string, unknown>).text === 'string' ? (line as Record<string, unknown>).text : '').filter(Boolean).join('\n')
  const segments = Array.isArray(object.segments) ? object.segments.filter((segment): segment is AsrSegment => {
    if (!segment || typeof segment !== 'object') return false
    const item = segment as Record<string, unknown>
    return typeof item.text === 'string' && typeof item.beginTime === 'number' && typeof item.endTime === 'number'
  }).map((segment) => ({
    text: segment.text,
    beginTime: segment.beginTime,
    endTime: segment.endTime,
    speakerId: typeof segment.speakerId === 'number' ? segment.speakerId : null,
  })) : []
  const { transcript: _transcript, rawTranscript: _rawTranscript, segments: _segments, ...metadata } = object
  return {
    recordId,
    revision: envelope.revision,
    createdAt: envelope.createdAt,
    updatedAt: envelope.updatedAt,
    transcript,
    segments,
    ...(Object.keys(metadata).length ? { metadata } : {}),
  }
}

export class PrivateTranscriptionSyncService {
  private loaded = false
  private state: StoredSyncState = { accounts: {} }
  private syncing: Promise<PrivateTranscriptionSyncResult> | null = null

  constructor(
    private readonly filePath: string,
    private readonly client: SaasClient,
    private readonly keyring: AccountKeyringService,
  ) {}

  async initialize(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<StoredSyncState>
      if (parsed.accounts && typeof parsed.accounts === 'object') this.state = { accounts: parsed.accounts as StoredSyncState['accounts'] }
    } catch {
      // First launch or a missing local sync file.
    }
  }

  async keyringStatus(): Promise<AccountKeyringStatus> {
    const account = await this.client.status()
    if (!account.authenticated || !account.user) {
      return { enabled: false, reason: '请先登录 EverRoom。', initialized: false, umkId: null, activeVersion: null, deviceStatus: 'unregistered', verificationCode: null }
    }
    return this.keyring.status(this.client, account.user.id)
  }

  async createPairingSession(): Promise<PairingSessionResponse> {
    const account = await this.client.status()
    if (!account.authenticated || !account.user) throw new Error('请先登录 EverRoom。')
    return this.keyring.createPairingSession(this.client, account.user.id)
  }

  async getPairingSession(id: string): Promise<PairingSessionResponse> {
    return this.client.getPairingSession(id)
  }

  async approvePairingSession(id: string): Promise<PairingSessionResponse> {
    const account = await this.client.status()
    if (!account.authenticated || !account.user) throw new Error('请先登录 EverRoom。')
    return this.keyring.approvePairingSession(this.client, account.user.id, id)
  }

  async sync(): Promise<PrivateTranscriptionSyncResult> {
    if (this.syncing) return this.syncing
    this.syncing = this.performSync().finally(() => { this.syncing = null })
    return this.syncing
  }

  async list(): Promise<PrivateTranscriptionRecord[]> {
    await this.initialize()
    const account = await this.client.status()
    if (!account.authenticated || !account.user) return []
    return Object.values(this.state.accounts[account.user.id]?.records ?? {}).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  private async performSync(): Promise<PrivateTranscriptionSyncResult> {
    await this.initialize()
    const account = await this.client.status()
    if (!account.authenticated || !account.user) throw new Error('请先登录 EverRoom。')
    const userId = account.user.id
    const status = await this.keyring.status(this.client, userId)
    const current = this.state.accounts[userId] ?? { cursor: 0, records: {} }
    if (!status.enabled || status.deviceStatus !== 'ready' || !status.umkId || !status.activeVersion) {
      return { status, cursor: current.cursor, synced: 0, removed: 0, records: Object.values(current.records) }
    }
    const material = await this.keyring.getUmk(userId)
    if (!material || material.umkId !== status.umkId || material.version !== status.activeVersion) {
      throw new Error('本机尚未保存当前 UMK，请等待 iPhone 批准后重试。')
    }
    let cursor = current.cursor
    let synced = 0
    let removed = 0
    for (;;) {
      const page = await this.client.listPrivateRecords(cursor)
      if (!page.records.length) break
      for (const envelope of page.records) {
        if (envelope.operation === 'delete') {
          if (current.records[envelope.recordId]) removed += 1
          delete current.records[envelope.recordId]
          cursor = Math.max(cursor, envelope.cursor)
          continue
        }
        current.records[envelope.recordId] = this.decryptRecord(envelope, material.value, material.umkId, material.version)
        synced += 1
        cursor = Math.max(cursor, envelope.cursor)
      }
      if (page.nextCursor <= cursor && page.records.length < 200) break
      if (page.nextCursor <= cursor && page.records.length >= 200) break
      cursor = Math.max(cursor, page.nextCursor)
      if (page.records.length < 200) break
    }
    current.cursor = cursor
    this.state.accounts[userId] = current
    await this.persist()
    if (cursor > 0) await this.client.acknowledgeSync(cursor)
    return { status, cursor, synced, removed, records: Object.values(current.records).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) }
  }

  private decryptRecord(envelope: PrivateRecordEnvelope, umk: Buffer, umkId: string, umkVersion: number): PrivateTranscriptionRecord {
    return parsePlaintext(
      envelope.recordId,
      decryptPrivateRecordPayload(envelope, umk, umkId, umkVersion),
      envelope,
    )
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(this.state), { mode: 0o600 })
    await chmod(this.filePath, 0o600)
  }
}

export function decryptPrivateRecordPayload(
  envelope: PrivateRecordEnvelope,
  umk: Buffer,
  umkId: string,
  umkVersion: number,
): Buffer {
    if (!envelope.ciphertext || !envelope.keyId || !envelope.contentHash || envelope.algorithm !== 'AES-256-GCM') throw new Error(`转写记录 ${envelope.recordId} 缺少加密字段。`)
    if (hashBase64(envelope.ciphertext) !== envelope.contentHash) throw new Error(`转写记录 ${envelope.recordId} 完整性校验失败。`)
    if (envelope.schemaVersion === 1) {
      if (envelope.keyId !== keyId(umk)) throw new Error(`转写记录 ${envelope.recordId} 的旧版 UMK 不匹配。`)
      return combinedDecrypt(umk, envelope.ciphertext, Buffer.from(`everroom.private-record.v1:${envelope.recordId}:${envelope.keyId}`, 'utf8'))
    }
    if (envelope.schemaVersion === 2 || envelope.schemaVersion === 3) {
      if (envelope.wrappingAlgorithm !== 'AES-256-GCM' || envelope.wrappingKeyId !== umkId || envelope.wrappingKeyVersion !== umkVersion || !envelope.wrappedKey) {
        throw new Error(`转写记录 ${envelope.recordId} 使用了不可用的 UMK 版本。`)
      }
      const wrappingAad = Buffer.from(`everroom.wrapped-dek.v1:${envelope.recordId}:${envelope.keyId}:${umkId}:${umkVersion}`, 'utf8')
      const dek = combinedDecrypt(umk, envelope.wrappedKey, wrappingAad)
      if (dek.length !== 32 || keyId(dek) !== envelope.keyId) throw new Error(`转写记录 ${envelope.recordId} 的 DEK 校验失败。`)
      return combinedDecrypt(dek, envelope.ciphertext, Buffer.from(`everroom.private-record.v${envelope.schemaVersion}:${envelope.recordId}:${envelope.keyId}:${umkId}:${umkVersion}`, 'utf8'))
    }
    throw new Error(`转写记录 ${envelope.recordId} 的加密版本不受支持。`)
}
