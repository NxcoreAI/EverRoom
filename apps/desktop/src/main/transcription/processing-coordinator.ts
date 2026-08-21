import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type {
  CompleteProcessingJobInput,
  PrivateRecordEnvelope,
  ProcessingJob,
  SaasClient,
} from '../cloud/saas-client'
import type { AgentGatewayBridge } from '../gateway/agent-gateway-bridge'
import { AccountKeyringService } from '../security/account-keyring-service'
import { getDesktopLocale } from '../desktop-locale'
import type { PrivateTranscriptionSyncService } from './private-transcription-sync'
import { summaryDetailMinimum } from './summary-quality'

const POLL_INTERVAL_MS = 30_000
const LEASE_RENEW_INTERVAL_MS = 45_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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
  eventType: 'MEETING' | 'WORK' | 'MEAL' | 'SOCIAL' | 'LEARNING' | 'CHITCHAT' | 'OTHER'
  title: string
  overview: string
  keyPoints: string[]
  decisions: string[]
  actionItems: Array<{ text: string; owner: string | null; dueDate: string | null }>
  unresolvedQuestions: string[]
  topics: string[]
  representativeTags: SummaryTagValue[]
}

interface SummaryTagValue {
  kind: 'entity' | 'fact'
  label: string
  entityType?: 'person' | 'organization' | 'project' | 'product' | 'place' | 'other'
  subject?: string
  predicate?: string
  object?: string
  confidence: number
  evidence: string
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
    private readonly sync?: PrivateTranscriptionSyncService,
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
    await this.sync?.reconcileLocalTranscriptions()
    await this.sync?.flushPendingSources()
    await this.sync?.sync()
    const registrationKey = `${account.user.id}:${account.device.id}`
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
          const source = this.readSource(envelope, job)
          const transcript = transcriptText(source)
          const response = await this.agent.summarizeTranscription({
            jobId: job.id,
            sourceRecordId: job.sourceRecordId,
            transcript,
            language: getDesktopLocale(),
          })
          const summary = parseSummary(response.content, transcript)
          const result = createSummary(job, summary)
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
      await this.sync?.sync()
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

  private readSource(
    envelope: PrivateRecordEnvelope,
    job: ProcessingJob,
  ): SourceRecord {
    if (envelope.recordType !== 'transcription_source') throw new Error('invalid_source_record_type')
    if (envelope.recordId !== job.sourceRecordId || envelope.revision !== job.sourceRevision || envelope.contentHash !== job.sourceContentHash) {
      throw new Error('source_revision_changed')
    }
    const value = envelope.payload as Partial<SourceRecord> | undefined
    if (!value || value.kind !== 'everroom.transcription-source' || value.schemaVersion !== 3
      || typeof value.eventId !== 'string' || !UUID_PATTERN.test(value.eventId)) {
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
  // Gateway performs line-aware chunking. Keep the full source here so the
  // final synthesis can still see the ending of long recordings.
  const maxBytes = 1_900_000
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const marker = '\n\n[转写中间过长，已省略]\n\n'
  const availableBytes = maxBytes - Buffer.byteLength(marker, 'utf8')
  let headChars = Math.floor(text.length * 0.65)
  let tailChars = Math.floor(text.length * 0.35)
  while (Buffer.byteLength(text.slice(0, headChars), 'utf8')
    + Buffer.byteLength(text.slice(-tailChars), 'utf8') > availableBytes) {
    headChars = Math.floor(headChars * 0.95)
    tailChars = Math.floor(tailChars * 0.95)
  }
  return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`
}

function parseSummary(raw: string, transcript: string): SummaryValue {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    throw new Error('invalid_agent_json')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_agent_summary')
  const object = value as Record<string, unknown>
  const eventTypes: SummaryValue['eventType'][] = ['MEETING', 'WORK', 'MEAL', 'SOCIAL', 'LEARNING', 'CHITCHAT', 'OTHER']
  const eventType = eventTypes.includes(object.eventType as SummaryValue['eventType'])
    ? object.eventType as SummaryValue['eventType']
    : 'OTHER'
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
  const representativeTags = object.representativeTags === undefined
    ? []
    : parseRepresentativeTags(object.representativeTags)
  const summary = {
    eventType,
    title: string('title', 200),
    overview: string('overview', 5_000),
    keyPoints: strings('keyPoints', 50),
    decisions: strings('decisions', 50),
    actionItems,
    unresolvedQuestions: object.unresolvedQuestions === undefined ? [] : strings('unresolvedQuestions', 50),
    topics: strings('topics', 30),
    representativeTags,
  }
  if (!summary.title || summary.title === '后台转写总结' || !summary.overview || !summary.keyPoints.length) {
    throw new Error('empty_agent_summary')
  }
  const transcriptLength = transcript.trim().length
  const minimum = summaryDetailMinimum(transcriptLength)
  if (minimum && (summary.overview.length < minimum.overview || summary.keyPoints.length < minimum.keyPoints)) {
    throw new Error('incomplete_agent_summary')
  }
  return summary
}

function parseRepresentativeTags(value: unknown): SummaryTagValue[] {
  if (!Array.isArray(value)) throw new Error('invalid_agent_representativeTags')
  return value.slice(0, 12).map((item) => {
    // Older/background models sometimes return a plain label. Preserve it as
    // a low-confidence entity so the otherwise valid summary can be materialized.
    if (typeof item === 'string') {
      const label = item.trim().slice(0, 200)
      if (!label) throw new Error('invalid_agent_representativeTag_label')
      return {
        kind: 'entity',
        label,
        entityType: 'other',
        confidence: 0.5,
        evidence: label,
      }
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid_agent_representativeTag')
    const tag = item as Record<string, unknown>
    if (tag.kind !== 'entity' && tag.kind !== 'fact') throw new Error('invalid_agent_representativeTag_kind')
    if (typeof tag.label !== 'string' || !tag.label.trim()) throw new Error('invalid_agent_representativeTag_label')
    if (typeof tag.confidence !== 'number' || !Number.isFinite(tag.confidence)) throw new Error('invalid_agent_representativeTag_confidence')
    if (typeof tag.evidence !== 'string') throw new Error('invalid_agent_representativeTag_evidence')
    const common = {
      kind: tag.kind,
      label: tag.label.trim().slice(0, 200),
      confidence: Math.max(0, Math.min(1, tag.confidence)),
      evidence: tag.evidence.trim().slice(0, 1_000),
    }
    if (tag.kind === 'entity') {
      const entityTypes: SummaryTagValue['entityType'][] = ['person', 'organization', 'project', 'product', 'place', 'other']
      const normalizedType = typeof tag.entityType === 'string' ? tag.entityType.trim().toLowerCase() : ''
      const entityType = entityTypes.includes(normalizedType as SummaryTagValue['entityType'])
        ? normalizedType as SummaryTagValue['entityType']
        : 'other'
      return { ...common, kind: 'entity', entityType }
    }
    if (typeof tag.subject !== 'string' || typeof tag.predicate !== 'string' || typeof tag.object !== 'string') {
      throw new Error('invalid_agent_representativeTag_fact')
    }
    const subject = tag.subject.trim().slice(0, 200)
    const predicate = tag.predicate.trim().slice(0, 200)
    const factObject = tag.object.trim().slice(0, 500)
    if (!subject || !predicate || !factObject) throw new Error('invalid_agent_representativeTag_fact')
    return { ...common, kind: 'fact', subject, predicate, object: factObject }
  })
}

function createSummary(
  job: ProcessingJob,
  summary: SummaryValue,
): Omit<CompleteProcessingJobInput, 'leaseToken'> {
  const resultRecordId = randomUUID()
  const payload = {
    kind: 'everroom.transcription-summary',
    schemaVersion: 1,
    workflow: job.workflow,
    workflowVersion: job.workflowVersion,
    sourceRecordId: job.sourceRecordId,
    sourceRevision: job.sourceRevision,
    sourceContentHash: job.sourceContentHash,
    summary,
    generatedAt: new Date().toISOString(),
  }
  return {
    resultRecordId,
    payload,
  }
}

function errorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120) || 'processing_failed'
}

function isPermanent(error: unknown): boolean {
  return error instanceof Error && /invalid_source|invalid_transcription|empty_transcription|source_revision/.test(error.message)
}
