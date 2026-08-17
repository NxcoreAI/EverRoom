import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ImportRealityEventInput, RealityEvent, RealityInsights } from '@nxcore/reality-contract'
import type { AccountKeyringStatus, AsrResult, AsrSegment, PrivateTranscriptionRecord, PrivateTranscriptionSyncResult } from '../../shared/sources'
import type { PairingSessionResponse, PrivateRecordEnvelope, PutPrivateRecordInput, SaasClient } from '../cloud/saas-client'
import type { RealityGatewayBridge } from '../gateway/reality-gateway-bridge'
import { AccountKeyringService, combinedDecrypt, combinedEncrypt, keyId } from '../security/account-keyring-service'

interface PendingSourcePublication {
  recordId: string
  input: PutPrivateRecordInput
  queuedAt: string
}

interface StoredSyncState {
  accounts: Record<string, {
    cursor: number
    records: Record<string, PrivateTranscriptionRecord>
    materialized?: Record<string, string>
    pendingSources?: Record<string, PendingSourcePublication>
    invalidSummaryReports?: Record<string, string>
  }>
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function metadata(record: PrivateTranscriptionRecord): Record<string, unknown> {
  return record.metadata ?? {}
}

function metadataString(record: PrivateTranscriptionRecord, key: string): string | null {
  const value = metadata(record)[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function validIso(value: string | null, fallback: string): string {
  const date = new Date(value ?? fallback)
  const fallbackDate = new Date(fallback)
  return (Number.isNaN(date.getTime()) ? fallbackDate : date).toISOString()
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : []
}

function importedInsights(record: PrivateTranscriptionRecord | undefined, transcript: string): RealityInsights | undefined {
  const value = record ? metadata(record).summary : null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const summary = value as Record<string, unknown>
  const title = typeof summary.title === 'string' ? summary.title.trim() : ''
  const overview = typeof summary.overview === 'string' ? summary.overview.trim() : ''
  const keyPoints = stringArray(summary.keyPoints)
  const decisions = stringArray(summary.decisions)
  const topics = stringArray(summary.topics)
  const actionItems = Array.isArray(summary.actionItems) ? summary.actionItems.flatMap((item): string[] => {
    if (typeof item === 'string') return item.trim() ? [item.trim()] : []
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const action = item as Record<string, unknown>
    if (typeof action.text !== 'string' || !action.text.trim()) return []
    const details = [
      typeof action.owner === 'string' && action.owner.trim() ? `负责人：${action.owner.trim()}` : '',
      typeof action.dueDate === 'string' && action.dueDate.trim() ? `截止：${action.dueDate.trim()}` : '',
    ].filter(Boolean)
    return [`${action.text.trim()}${details.length ? `（${details.join('；')}）` : ''}`]
  }) : []
  if (!title && !overview && !keyPoints.length && !decisions.length && !actionItems.length && !topics.length) return undefined
  const firstSentence = transcript.split(/(?<=[。！？!?])|\n+/).map((item) => item.trim()).find(Boolean) ?? ''
  return {
    source: 'generated',
    currentTopic: topics[0] || title || firstSentence.replace(/[。！？!?]$/, '').slice(0, 50) || null,
    summary: overview || null,
    keyPoints,
    decisions,
    actionItems,
    people: [],
    projects: [],
    unresolvedQuestions: [],
  }
}

export function hasMeaningfulSummary(record: PrivateTranscriptionRecord | undefined): boolean {
  const value = record ? metadata(record).summary : null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const summary = value as Record<string, unknown>
  const title = typeof summary.title === 'string' ? summary.title.trim() : ''
  return Boolean(
    title && title !== '后台转写总结'
    && typeof summary.overview === 'string' && summary.overview.trim()
    && stringArray(summary.keyPoints).length
  )
}

function speakerId(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = value.match(/\d+/)
  return match ? Number(match[0]) : null
}

export function toImportedRealityEvent(
  source: PrivateTranscriptionRecord,
  summary?: PrivateTranscriptionRecord,
): ImportRealityEventInput | null {
  const sourceMetadata = metadata(source)
  const id = metadataString(source, 'eventId') ?? source.recordId
  if (!UUID_PATTERN.test(id)) return null
  const startedAt = validIso(metadataString(source, 'startedAt'), source.createdAt)
  const durationMs = typeof sourceMetadata.durationMillis === 'number' && Number.isFinite(sourceMetadata.durationMillis)
    ? Math.max(0, Math.round(sourceMetadata.durationMillis))
    : Math.max(0, Date.parse(metadataString(source, 'endedAt') ?? source.updatedAt) - Date.parse(startedAt))
  const endedAt = metadataString(source, 'endedAt')
    ? validIso(metadataString(source, 'endedAt'), source.updatedAt)
    : new Date(Date.parse(startedAt) + durationMs).toISOString()
  const transcriptLines = Array.isArray(sourceMetadata.transcriptLines) ? sourceMetadata.transcriptLines : []
  const normalizedLines = transcriptLines.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const line = value as Record<string, unknown>
    if (typeof line.text !== 'string' || !line.text.trim()) return []
    return [{
      text: line.text.trim(),
      beginTime: typeof line.startOffsetMillis === 'number' ? Math.max(0, line.startOffsetMillis) : 0,
      speakerId: speakerId(line.speaker),
    }]
  })
  const transcript = normalizedLines.map((line) => line.text).join('\n')
    || source.transcript.trim().replace(/^#\s*转写结果\s*/u, '')
  const transcriptSegments = normalizedLines.length
    ? normalizedLines.map((line, index) => ({
      ...line,
      endTime: Math.max(line.beginTime, normalizedLines[index + 1]?.beginTime ?? durationMs),
    }))
    : source.segments.map((segment) => ({
      text: segment.text,
      beginTime: Math.max(0, segment.beginTime),
      endTime: Math.max(segment.beginTime, segment.endTime),
      speakerId: segment.speakerId,
    }))
  const insights = importedInsights(summary, transcript)
  const summaryTitle = summary && metadata(summary).summary && typeof metadata(summary).summary === 'object'
    ? (metadata(summary).summary as Record<string, unknown>).title
    : null
  const title = typeof summaryTitle === 'string' && summaryTitle.trim()
    ? summaryTitle.trim().slice(0, 120)
    : insights?.currentTopic?.slice(0, 120) || 'iPhone 录音'
  const resultVersion = Math.max(
    1,
    Date.parse(source.updatedAt) || source.revision,
    summary ? Date.parse(summary.updatedAt) || summary.revision : 0,
  )
  const captureDevice = sourceMetadata.captureDevice
  const normalizedCaptureDevice = captureDevice && typeof captureDevice === 'object' && !Array.isArray(captureDevice)
    && typeof (captureDevice as Record<string, unknown>).id === 'string'
    && typeof (captureDevice as Record<string, unknown>).name === 'string'
    && ['desktop', 'iphone', 'watch'].includes(String((captureDevice as Record<string, unknown>).kind))
    ? captureDevice as ImportRealityEventInput['captureDevice']
    : { id: 'synced-iphone', name: 'iPhone', kind: 'iphone' as const }
  const audioSource = sourceMetadata.audioSource === 'system' ? 'system' : 'microphone'
  return {
    id,
    title,
    captureDevice: normalizedCaptureDevice,
    audioSource,
    durationMs,
    transcript,
    transcriptSegments,
    ...(insights ? { insights } : {}),
    resultVersion,
    startedAt,
    endedAt,
  }
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
    private readonly reality: RealityGatewayBridge,
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

  async publishLocalTranscription(event: RealityEvent, result: AsrResult, provider: string): Promise<void> {
    await this.initialize()
    const account = await this.client.status()
    if (!account.authenticated || !account.user) throw new Error('请先登录 EverRoom。')
    const status = await this.keyring.status(this.client, account.user.id)
    const material = await this.keyring.getUmk(account.user.id)
    if (!status.enabled || status.deviceStatus !== 'ready' || !material
      || material.umkId !== status.umkId || material.version !== status.activeVersion) {
      throw new Error('本机账号主密钥尚未就绪。')
    }
    const recordId = event.id
    const dataKey = randomBytes(32)
    const dataKeyId = keyId(dataKey)
    const transcriptLines = result.segments.length
      ? result.segments.map((segment) => ({
        speaker: segment.speakerId === null ? '发言人' : `发言人 ${segment.speakerId}`,
        startOffsetMillis: segment.beginTime,
        text: segment.text,
      }))
      : [{ speaker: '发言人', startOffsetMillis: 0, text: result.transcript }]
    const plaintext = Buffer.from(JSON.stringify({
      kind: 'everroom.transcription-source',
      schemaVersion: 3,
      eventId: recordId,
      startedAt: event.startedAt,
      endedAt: event.endedAt ?? new Date().toISOString(),
      durationMillis: event.durationMs,
      provider,
      captureDevice: event.captureDevice,
      audioSource: event.audioSource,
      detailMarkdown: `# 转写结果\n\n${result.transcript}`,
      transcriptLines,
      completedAt: new Date().toISOString(),
    }), 'utf8')
    const ciphertext = combinedEncrypt(dataKey, plaintext, Buffer.from(`everroom.private-record.v3:${recordId}:${dataKeyId}:${material.umkId}:${material.version}`, 'utf8'))
    const input: PutPrivateRecordInput = {
      recordType: 'transcription_source',
      algorithm: 'AES-256-GCM',
      schemaVersion: 3,
      keyId: dataKeyId,
      ciphertext,
      contentHash: hashBase64(ciphertext),
      wrappingAlgorithm: 'AES-256-GCM',
      wrappingKeyId: material.umkId,
      wrappingKeyVersion: material.version,
      wrappedKey: combinedEncrypt(material.value, dataKey, Buffer.from(`everroom.wrapped-dek.v1:${recordId}:${dataKeyId}:${material.umkId}:${material.version}`, 'utf8')),
      expectedRevision: 0,
    }
    const current = this.state.accounts[account.user.id] ?? { cursor: 0, records: {} }
    current.pendingSources ??= {}
    current.pendingSources[recordId] = { recordId, input, queuedAt: new Date().toISOString() }
    this.state.accounts[account.user.id] = current
    await this.persist()
    await this.flushPendingSources()
  }

  async flushPendingSources(): Promise<void> {
    await this.initialize()
    const account = await this.client.status()
    if (!account.authenticated || !account.user) return
    const current = this.state.accounts[account.user.id]
    if (!current?.pendingSources) return
    for (const pending of Object.values(current.pendingSources)) {
      try {
        await this.client.putPrivateRecord(pending.recordId, pending.input)
        delete current.pendingSources[pending.recordId]
      } catch (error) {
        if (error instanceof Error && /revision mismatch.*actual [1-9]/i.test(error.message)) {
          delete current.pendingSources[pending.recordId]
          continue
        }
        throw error
      }
    }
    await this.persist()
  }

  async reconcileLocalTranscriptions(): Promise<number> {
    await this.initialize()
    const account = await this.client.status()
    if (!account.authenticated || !account.user) return 0
    const current = this.state.accounts[account.user.id] ?? { cursor: 0, records: {} }
    this.state.accounts[account.user.id] = current
    const events = await this.reality.listEvents()
    let queued = 0
    for (const event of events) {
      if (event.captureDevice.kind !== 'desktop' || !event.transcript.trim()) continue
      const existing = current.records[event.id]
      if (existing && metadataString(existing, 'kind') === 'everroom.transcription-source') continue
      if (current.pendingSources?.[event.id]) continue
      await this.publishLocalTranscription(event, {
        transcript: event.transcript,
        segments: event.transcriptSegments.map((segment) => ({
          text: segment.text,
          beginTime: segment.beginTime,
          endTime: segment.endTime,
          speakerId: segment.speakerId,
        })),
      }, event.asrSource ?? 'unknown')
      queued += 1
    }
    return queued
  }

  async list(): Promise<PrivateTranscriptionRecord[]> {
    await this.initialize()
    const account = await this.client.status()
    if (!account.authenticated || !account.user) return []
    return Object.values(this.state.accounts[account.user.id]?.records ?? {}).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async eventIdForSegment(segmentId: string): Promise<string | null> {
    const records = await this.list()
    for (const record of records) {
      const lines = metadata(record).transcriptLines
      if (!Array.isArray(lines)) continue
      if (lines.some((line) => line && typeof line === 'object' && (line as Record<string, unknown>).segmentId === segmentId)) return metadataString(record, 'eventId') ?? record.recordId
    }
    return null
  }

  async materializeCached(): Promise<void> {
    await this.initialize()
    const account = await this.client.status()
    if (!account.authenticated || !account.user) return
    const current = this.state.accounts[account.user.id]
    if (!current) return
    await this.materialize(current)
    await this.persist()
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
    await this.materialize(current)
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

  private async materialize(current: StoredSyncState['accounts'][string]): Promise<void> {
    const materialized = current.materialized ?? {}
    const invalidSummaryReports = current.invalidSummaryReports ?? {}
    const summaries = new Map<string, PrivateTranscriptionRecord>()
    for (const record of Object.values(current.records)) {
      if (metadataString(record, 'kind') !== 'everroom.transcription-summary') continue
      const sourceRecordId = metadataString(record, 'sourceRecordId')
      if (sourceRecordId) summaries.set(sourceRecordId, record)
    }
    const activeEventIds = new Set<string>()
    for (const source of Object.values(current.records)) {
      if (metadataString(source, 'kind') === 'everroom.transcription-summary') continue
      const candidateSummary = summaries.get(source.recordId)
      const summary = hasMeaningfulSummary(candidateSummary) ? candidateSummary : undefined
      if (candidateSummary && !summary && !invalidSummaryReports[candidateSummary.recordId]) {
        const sourceContentHash = metadataString(candidateSummary, 'sourceContentHash')
        const sourceRevision = metadata(candidateSummary).sourceRevision
        if (sourceContentHash && typeof sourceRevision === 'number') {
          await this.client.reprocessTranscriptionSummary({
            sourceRecordId: source.recordId,
            sourceRevision,
            sourceContentHash,
            reason: 'invalid_summary',
          })
          invalidSummaryReports[candidateSummary.recordId] = new Date().toISOString()
        }
      }
      const input = toImportedRealityEvent(source, summary)
      if (!input) continue
      activeEventIds.add(input.id)
      const fingerprint = `${source.revision}:${source.updatedAt}:${summary?.revision ?? 0}:${summary?.updatedAt ?? ''}:${summary ? 'valid' : 'missing'}`
      if (materialized[input.id] === fingerprint) continue
      await this.reality.importEvent(input)
      materialized[input.id] = fingerprint
    }
    for (const eventId of Object.keys(materialized)) {
      if (activeEventIds.has(eventId)) continue
      await this.reality.discard(eventId).catch(() => undefined)
      delete materialized[eventId]
    }
    for (const recordId of Object.keys(invalidSummaryReports)) {
      if (current.records[recordId]) continue
      delete invalidSummaryReports[recordId]
    }
    current.materialized = materialized
    current.invalidSummaryReports = invalidSummaryReports
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
