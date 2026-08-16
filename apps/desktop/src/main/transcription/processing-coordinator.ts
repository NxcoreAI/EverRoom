import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type {
  CompleteProcessingJobInput,
  PrivateRecordEnvelope,
  ProcessingJob,
  SaasClient,
} from '../cloud/saas-client'
import type { AgentGatewayBridge } from '../gateway/agent-gateway-bridge'
import { AccountKeyringService, combinedEncrypt, keyId } from '../security/account-keyring-service'
import { decryptPrivateRecordPayload } from './private-transcription-sync'

const POLL_INTERVAL_MS = 30_000
const LEASE_RENEW_INTERVAL_MS = 45_000

interface StoredProcessingJob {
  sourceRecordId: string
  sourceRevision: number
  sourceContentHash: string
  result?: Omit<CompleteProcessingJobInput, 'leaseToken'>
  updatedAt: string
}

interface StoredProcessingState {
  version: 1
  jobs: Record<string, StoredProcessingJob>
}

interface SourceRecord {
  kind: 'everroom.transcription-source'
  schemaVersion: 3
  eventId: string
  detailMarkdown?: string
  transcriptLines?: Array<{ speaker?: string; startOffsetMillis?: number; text?: string }>
}

interface SummaryValue {
  title: string
  overview: string
  keyPoints: string[]
  decisions: string[]
  actionItems: Array<{ text: string; owner: string | null; dueDate: string | null }>
  topics: string[]
}

export class TranscriptionProcessingCoordinator {
  private state: StoredProcessingState = { version: 1, jobs: {} }
  private loaded = false
  private running = false
  private stopped = true
  private timer: NodeJS.Timeout | null = null
  private registeredKey: string | null = null

  constructor(
    private readonly filePath: string,
    private readonly client: SaasClient,
    private readonly keyring: AccountKeyringService,
    private readonly agent: AgentGatewayBridge,
  ) {}

  async initialize(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<StoredProcessingState>
      if (value.version === 1 && value.jobs && typeof value.jobs === 'object') {
        this.state = { version: 1, jobs: value.jobs as StoredProcessingState['jobs'] }
      }
    } catch {
      // The SaaS queue remains authoritative when no local outbox exists.
    }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) return
    this.running = true
    try {
      await this.processOne()
    } catch (error) {
      console.warn('Background transcription processing tick failed.', error)
    } finally {
      this.running = false
      if (!this.stopped) this.timer = setTimeout(() => void this.tick(), POLL_INTERVAL_MS)
    }
  }

  private async processOne(): Promise<void> {
    await this.initialize()
    const account = await this.client.status()
    if (!account.authenticated || !account.user || !account.device) return
    const keyringStatus = await this.keyring.status(this.client, account.user.id)
    if (!keyringStatus.enabled || keyringStatus.deviceStatus !== 'ready') return
    const umk = await this.keyring.getUmk(account.user.id)
    if (!umk || umk.umkId !== keyringStatus.umkId || umk.version !== keyringStatus.activeVersion) return

    const registrationKey = `${account.user.id}:${account.device.id}:${umk.umkId}:${umk.version}`
    if (this.registeredKey !== registrationKey) {
      await this.client.registerProcessorDevice()
      this.registeredKey = registrationKey
    }

    const claim = await this.client.claimProcessingJob()
    if (!claim) return
    const { job, leaseToken } = claim
    const stored = this.state.jobs[job.id]
    const reusable = stored
      && stored.sourceRecordId === job.sourceRecordId
      && stored.sourceRevision === job.sourceRevision
      && stored.sourceContentHash === job.sourceContentHash
      ? stored.result
      : undefined
    this.state.jobs[job.id] = {
      sourceRecordId: job.sourceRecordId,
      sourceRevision: job.sourceRevision,
      sourceContentHash: job.sourceContentHash,
      ...(reusable ? { result: reusable } : {}),
      updatedAt: new Date().toISOString(),
    }
    await this.persist()

    let resultReady = Boolean(reusable)
    try {
      await this.client.startProcessingJob(job.id, leaseToken)
      const renewTimer = setInterval(() => {
        void this.client.renewProcessingJob(job.id, leaseToken).catch((error) => {
          console.warn(`Unable to renew processing lease ${job.id}.`, error)
        })
      }, LEASE_RENEW_INTERVAL_MS)
      try {
        if (!reusable) {
          const envelope = await this.client.getPrivateRecord(job.sourceRecordId)
          const source = this.decryptSource(envelope, job, umk.value, umk.umkId, umk.version)
          const transcript = transcriptText(source)
          const response = await this.agent.summarizeTranscription({
            jobId: job.id,
            sourceRecordId: job.sourceRecordId,
            transcript,
            language: 'zh-CN',
          })
          const summary = parseSummary(response.content)
          const result = encryptSummary(job, summary, umk.value, umk.umkId, umk.version)
          this.state.jobs[job.id]!.result = result
          this.state.jobs[job.id]!.updatedAt = new Date().toISOString()
          await this.persist()
          resultReady = true
        }
      } finally {
        clearInterval(renewTimer)
      }
      const result = this.state.jobs[job.id]?.result
      if (!result) throw new Error('processing_result_missing')
      await this.client.completeProcessingJob(job.id, { ...result, leaseToken })
      delete this.state.jobs[job.id]
      await this.persist()
    } catch (error) {
      if (!resultReady) {
        await this.client.failProcessingJob(job.id, {
          leaseToken,
          errorCode: errorCode(error),
          errorClass: isPermanent(error) ? 'permanent' : 'retryable',
        }).catch(() => undefined)
      }
      throw error
    }
  }

  private decryptSource(
    envelope: PrivateRecordEnvelope,
    job: ProcessingJob,
    umk: Buffer,
    umkId: string,
    umkVersion: number,
  ): SourceRecord {
    if (envelope.recordType !== 'transcription_source') throw new Error('invalid_source_record_type')
    if (envelope.recordId !== job.sourceRecordId || envelope.revision !== job.sourceRevision || envelope.contentHash !== job.sourceContentHash) {
      throw new Error('source_revision_changed')
    }
    const value = JSON.parse(
      decryptPrivateRecordPayload(envelope, umk, umkId, umkVersion).toString('utf8'),
    ) as Partial<SourceRecord>
    if (value.kind !== 'everroom.transcription-source' || value.schemaVersion !== 3 || value.eventId !== envelope.recordId) {
      throw new Error('invalid_transcription_source')
    }
    return value as SourceRecord
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(this.state), { mode: 0o600 })
    await chmod(this.filePath, 0o600)
  }
}

function transcriptText(source: SourceRecord): string {
  const lines = (source.transcriptLines ?? [])
    .filter((line): line is { speaker?: string; startOffsetMillis?: number; text: string } => typeof line?.text === 'string' && Boolean(line.text.trim()))
    .map((line) => {
      const seconds = Math.max(0, Math.floor((line.startOffsetMillis ?? 0) / 1000))
      const timestamp = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
      return `[${timestamp}] ${line.speaker?.trim() || '发言人'}：${line.text.trim()}`
    })
  const text = lines.join('\n') || source.detailMarkdown?.trim() || ''
  if (!text) throw new Error('empty_transcription_source')
  let limited = text
  while (Buffer.byteLength(limited, 'utf8') > 480_000) limited = limited.slice(0, Math.floor(limited.length * 0.9))
  return limited === text ? text : `${limited}\n\n[转写过长，已截断]`
}

function parseSummary(raw: string): SummaryValue {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    throw new Error('invalid_agent_json')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_agent_summary')
  const object = value as Record<string, unknown>
  const string = (key: string, max: number) => {
    if (typeof object[key] !== 'string') throw new Error(`invalid_agent_${key}`)
    return (object[key] as string).trim().slice(0, max)
  }
  const strings = (key: string, maxItems: number) => {
    if (!Array.isArray(object[key]) || !(object[key] as unknown[]).every((item) => typeof item === 'string')) throw new Error(`invalid_agent_${key}`)
    return (object[key] as string[]).slice(0, maxItems).map((item) => item.trim().slice(0, 1_000)).filter(Boolean)
  }
  if (!Array.isArray(object.actionItems)) throw new Error('invalid_agent_actionItems')
  const actionItems = object.actionItems.slice(0, 50).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid_agent_actionItem')
    const action = item as Record<string, unknown>
    if (typeof action.text !== 'string') throw new Error('invalid_agent_actionItem_text')
    if (action.owner !== null && typeof action.owner !== 'string') throw new Error('invalid_agent_actionItem_owner')
    if (action.dueDate !== null && typeof action.dueDate !== 'string') throw new Error('invalid_agent_actionItem_dueDate')
    return {
      text: action.text.trim().slice(0, 1_000),
      owner: typeof action.owner === 'string' ? action.owner.trim().slice(0, 200) || null : null,
      dueDate: typeof action.dueDate === 'string' ? action.dueDate.trim().slice(0, 100) || null : null,
    }
  }).filter((item) => item.text)
  return {
    title: string('title', 200),
    overview: string('overview', 5_000),
    keyPoints: strings('keyPoints', 50),
    decisions: strings('decisions', 50),
    actionItems,
    topics: strings('topics', 30),
  }
}

function encryptSummary(
  job: ProcessingJob,
  summary: SummaryValue,
  umk: Buffer,
  umkId: string,
  umkVersion: number,
): Omit<CompleteProcessingJobInput, 'leaseToken'> {
  const resultRecordId = randomUUID()
  const dataKey = randomBytes(32)
  const dataKeyId = keyId(dataKey)
  const plaintext = Buffer.from(JSON.stringify({
    kind: 'everroom.transcription-summary',
    schemaVersion: 1,
    workflow: job.workflow,
    workflowVersion: job.workflowVersion,
    sourceRecordId: job.sourceRecordId,
    sourceRevision: job.sourceRevision,
    sourceContentHash: job.sourceContentHash,
    summary,
    generatedAt: new Date().toISOString(),
  }), 'utf8')
  const ciphertext = combinedEncrypt(dataKey, plaintext, Buffer.from(`everroom.private-record.v3:${resultRecordId}:${dataKeyId}:${umkId}:${umkVersion}`, 'utf8'))
  const wrappedKey = combinedEncrypt(umk, dataKey, Buffer.from(`everroom.wrapped-dek.v1:${resultRecordId}:${dataKeyId}:${umkId}:${umkVersion}`, 'utf8'))
  return {
    resultRecordId,
    algorithm: 'AES-256-GCM',
    schemaVersion: 3,
    keyId: dataKeyId,
    ciphertext,
    contentHash: `sha256:${createHash('sha256').update(ciphertext).digest('hex')}`,
    wrappingAlgorithm: 'AES-256-GCM',
    wrappingKeyId: umkId,
    wrappingKeyVersion: umkVersion,
    wrappedKey,
  }
}

function errorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120) || 'processing_failed'
}

function isPermanent(error: unknown): boolean {
  return error instanceof Error && /invalid_source|invalid_transcription|empty_transcription|source_revision/.test(error.message)
}
