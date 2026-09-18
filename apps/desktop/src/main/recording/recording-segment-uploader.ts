import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AsrJob, AsrResult, AsrSegment } from '../../shared/sources'
import type { SaasClient } from '../cloud/saas-client'

export interface SegmentUploadMeta {
  mimeType: string
  languageHints?: string[]
}

export interface SegmentTranscriptionPreview {
  recordingId: string
  index: number
  result: AsrResult
}

export interface MiniJobState {
  index: number
  fileName: string
  bytes: number
  sha256: string
  durationMs: number
  attempt: number
  derivedRecordingId: string
  jobId?: string
  objectKey?: string
  status: 'pending' | 'submitted' | 'transcribed' | 'uploadFailed' | 'jobFailed'
  result?: AsrResult
  provider?: string
  pollErrors: number
}

interface RecordingState {
  createdAt: string
  mimeType: string
  languageHints?: string[]
  diarizationEnabled: boolean
  minis: Map<number, MiniJobState>
  chain: Promise<void>
  finalized: boolean
  aborted: boolean
  pollTimer: NodeJS.Timeout | null
}

/** 合并任务在事件上占位的 job id 前缀（不与 'saas:' 前缀冲突，Coordinator 拦截路由）。 */
export const SEGMENT_JOB_PREFIX = 'saas-seg:'

const MAX_SEGMENT_INDEX = 63
const POLL_INTERVAL_MS = 5_000
const FINALIZE_WAIT_MS = 180_000
const MAX_POLL_ERRORS = 30
const V5_NAMESPACE = '8f2d1c4a-6b3e-4f9a-a5d7-2c8e0b6f4d21'

/** SaaS 按 recording_id 全局去重，分钟任务必须各持独立 UUID；确定性派生保证重试幂等。 */
function uuidV5(name: string): string {
  const hash = createHash('sha1')
  hash.update(Buffer.from(V5_NAMESPACE.replace(/-/g, ''), 'hex'))
  hash.update(Buffer.from(name, 'utf8'))
  const bytes = hash.digest()
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes('mp4')) return '.m4a'
  if (normalized.includes('ogg')) return '.ogg'
  return '.webm'
}

function sortedMinis(state: RecordingState): MiniJobState[] {
  return [...state.minis.values()].sort((a, b) => a.index - b.index)
}

function miniDurationMs(mini: MiniJobState): number {
  const localEnd = mini.result?.segments.length ? Math.max(...mini.result.segments.map((segment) => segment.endTime)) : 0
  return Math.max(mini.durationMs, localEnd)
}

function offsetForIndex(state: RecordingState, index: number): number {
  let offset = 0
  for (const mini of sortedMinis(state)) {
    if (mini.index >= index) break
    offset += miniDurationMs(mini)
  }
  return offset
}

/** 按段序合并各分钟任务结果：偏移 = max(段声明时长, 段内最大语音结束点)，与 SaaS 侧同一套数学。 */
export function mergeMiniJobs(
  recordingId: string,
  mimeType: string,
  minis: MiniJobState[],
  meta: { createdAt: string; languageHints?: string[]; diarizationEnabled: boolean },
): AsrJob {
  const ordered = [...minis].sort((a, b) => a.index - b.index)
  const segments: AsrSegment[] = []
  let offset = 0
  for (const mini of ordered) {
    for (const segment of mini.result?.segments ?? []) {
      segments.push({ ...segment, beginTime: segment.beginTime + offset, endTime: segment.endTime + offset })
    }
    offset += miniDurationMs(mini)
  }
  return {
    id: `${SEGMENT_JOB_PREFIX}${recordingId}`,
    source: 'saas',
    provider: ordered.find((mini) => mini.provider)?.provider ?? 'nxcore',
    status: 'completed',
    fileName: `${recordingId}${extensionForMimeType(mimeType)}`,
    languageHints: meta.languageHints ?? [],
    diarizationEnabled: meta.diarizationEnabled,
    contextPrompt: '',
    result: { transcript: segments.map((segment) => segment.text).join('\n'), segments },
    error: null,
    // updatedAt 每次现取：改名后重合并靠它顶高事件版本守卫。
    createdAt: meta.createdAt,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * 录制中的分钟级分段：每段立即建成独立的 SaaS 转写任务（边录边转），
 * 转完经 preview 回调推送实时文字；停止时等全部转完、按段序合并成整篇结果。
 * 任一分钟两轮仍失败 → 取消全部，调用方回退整段上传老路。
 */
export class RecordingSegmentUploader {
  private readonly recordings = new Map<string, RecordingState>()
  private preview?: (event: SegmentTranscriptionPreview) => void
  private readonly pollIntervalMs: number

  constructor(
    private readonly saas: SaasClient,
    private readonly directory: string,
    options: { pollIntervalMs?: number } = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
  }

  setPreviewListener(fn: (event: SegmentTranscriptionPreview) => void): void {
    this.preview = fn
  }

  async onSegment(
    recordingId: string,
    index: number,
    chunk: Uint8Array,
    durationMs: number,
    meta: SegmentUploadMeta,
  ): Promise<void> {
    if (!Number.isInteger(index) || index < 0 || index > MAX_SEGMENT_INDEX) return
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) return
    if (!Number.isFinite(durationMs) || durationMs < 1000) return
    let state = this.recordings.get(recordingId)
    if (!state) {
      state = {
        createdAt: new Date().toISOString(),
        mimeType: meta.mimeType,
        languageHints: meta.languageHints,
        diarizationEnabled: true,
        minis: new Map(),
        chain: Promise.resolve(),
        finalized: false,
        aborted: false,
        pollTimer: null,
      }
      this.recordings.set(recordingId, state)
    }
    if (state.finalized || state.aborted) return
    if (state.minis.has(index)) return
    const fileName = `${index}${extensionForMimeType(meta.mimeType)}`
    const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    const directory = this.segmentDirectory(recordingId)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, fileName), buffer)
    state.minis.set(index, {
      index,
      fileName,
      bytes: buffer.byteLength,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      durationMs: Math.round(durationMs),
      attempt: 0,
      derivedRecordingId: uuidV5(`${recordingId}:${index}`),
      status: 'pending',
      pollErrors: 0,
    })
    state.chain = state.chain.then(() => this.submitMini(recordingId, index))
  }

  /** 录音结束收尾：全部分钟任务转完返回合并结果；任何失败返回 null（调用方回退整段上传）。 */
  async finalize(recordingId: string): Promise<AsrJob | null> {
    const state = this.recordings.get(recordingId)
    if (!state) return null
    state.finalized = true
    this.stopPolling(state)
    await state.chain.catch(() => undefined)
    for (const mini of sortedMinis(state)) {
      if (mini.status === 'pending' || mini.status === 'uploadFailed') await this.submitMini(recordingId, mini.index)
    }
    const deadline = Date.now() + FINALIZE_WAIT_MS
    for (;;) {
      if (sortedMinis(state).some((mini) => mini.status === 'uploadFailed')) break
      await this.pollOnce(recordingId)
      const minis = sortedMinis(state)
      if (minis.length > 0 && minis.every((mini) => mini.status === 'transcribed')) {
        await rm(this.segmentDirectory(recordingId), { recursive: true, force: true }).catch(() => undefined)
        await this.persistManifest(recordingId, state).catch(() => undefined)
        return mergeMiniJobs(recordingId, state.mimeType, minis, state)
      }
      let giveUp = false
      for (const mini of minis.filter((entry) => entry.status === 'jobFailed')) {
        if (mini.attempt >= 1) { giveUp = true; break }
        await this.saas.cancelAsrJob(mini.jobId!).catch(() => undefined)
        mini.attempt += 1
        mini.jobId = undefined
        mini.objectKey = undefined
        mini.pollErrors = 0
        mini.derivedRecordingId = uuidV5(`${recordingId}:${mini.index}:r${mini.attempt}`)
        await this.submitMini(recordingId, mini.index)
      }
      if (giveUp) break
      if (Date.now() > deadline) break
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs))
    }
    await this.cancelAll(state)
    await this.discard(recordingId)
    return null
  }

  async abort(recordingId: string): Promise<void> {
    const state = this.recordings.get(recordingId)
    if (!state) return
    state.aborted = true
    this.stopPolling(state)
    await state.chain.catch(() => undefined)
    await this.cancelAll(state)
    await this.discard(recordingId)
  }

  /** 合并任务查询：全转完返回 completed 合并结果，仍有在转返回 running 占位。 */
  async getMergedJob(recordingId: string): Promise<AsrJob | null> {
    const state = await this.ensureState(recordingId)
    if (!state || state.minis.size === 0) return null
    await this.pollOnce(recordingId).catch(() => undefined)
    const minis = sortedMinis(state)
    const done = minis.length > 0 && minis.every((mini) => mini.status === 'transcribed')
    if (!done) {
      return { ...mergeMiniJobs(recordingId, state.mimeType, minis, state), status: 'running', result: null }
    }
    await this.persistManifest(recordingId, state).catch(() => undefined)
    return mergeMiniJobs(recordingId, state.mimeType, minis, state)
  }

  /** 改名支持：重新拉取全部分钟结果合并，并给出可用于 SaaS 改名的锚点任务 id。 */
  async refetchMerged(recordingId: string): Promise<{ merged: AsrJob; anchorJobId: string | null } | null> {
    const state = await this.ensureState(recordingId)
    if (!state || state.minis.size === 0) return null
    await Promise.all(sortedMinis(state).map(async (mini) => {
      if (!mini.jobId) return
      const job = await this.saas.getAsrJob(`saas:${mini.jobId}`).catch(() => undefined)
      if (job?.status === 'completed' && job.result) {
        mini.result = job.result
        mini.provider = job.provider
        mini.status = 'transcribed'
      }
    }))
    await this.persistManifest(recordingId, state).catch(() => undefined)
    const anchor = sortedMinis(state).find((mini) => mini.status === 'transcribed' && mini.jobId)
    return { merged: mergeMiniJobs(recordingId, state.mimeType, sortedMinis(state), state), anchorJobId: anchor?.jobId ?? null }
  }

  /** 崩溃遗留的段音频启动时清空；分钟任务的 manifest 留存（重启后改名要用）。 */
  async cleanupAtStartup(): Promise<void> {
    await rm(this.segmentsRoot, { recursive: true, force: true }).catch(() => undefined)
  }

  private get segmentsRoot(): string {
    return join(this.directory, 'segments')
  }

  private segmentDirectory(recordingId: string): string {
    return join(this.segmentsRoot, recordingId)
  }

  private manifestPath(recordingId: string): string {
    return join(this.directory, 'asr-segments', `${recordingId}.json`)
  }

  private async ensureState(recordingId: string): Promise<RecordingState | null> {
    const existing = this.recordings.get(recordingId)
    if (existing) return existing
    const manifest = await this.loadManifest(recordingId)
    if (!manifest) return null
    const state: RecordingState = {
      createdAt: manifest.createdAt,
      mimeType: manifest.mimeType,
      languageHints: manifest.languageHints,
      diarizationEnabled: manifest.diarizationEnabled,
      minis: new Map(manifest.minis.map((mini) => [mini.index, {
        index: mini.index,
        fileName: `${mini.index}${extensionForMimeType(manifest.mimeType)}`,
        bytes: 0,
        sha256: '',
        durationMs: mini.durationMs,
        attempt: mini.attempt,
        derivedRecordingId: mini.derivedRecordingId,
        jobId: mini.jobId,
        status: 'submitted',
        pollErrors: 0,
      }])),
      chain: Promise.resolve(),
      finalized: true,
      aborted: false,
      pollTimer: null,
    }
    this.recordings.set(recordingId, state)
    return state
  }

  private async loadManifest(recordingId: string): Promise<{
    createdAt: string
    mimeType: string
    languageHints?: string[]
    diarizationEnabled: boolean
    minis: Array<{ index: number; durationMs: number; attempt: number; derivedRecordingId: string; jobId?: string }>
  } | null> {
    const raw = await readFile(this.manifestPath(recordingId), 'utf8').catch(() => undefined)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (typeof parsed.createdAt !== 'string' || typeof parsed.mimeType !== 'string' || !Array.isArray(parsed.minis)) return null
      const minis = (parsed.minis as Array<Record<string, unknown>>).filter((mini) => typeof mini.index === 'number' && typeof mini.durationMs === 'number' && typeof mini.derivedRecordingId === 'string')
      return {
        createdAt: parsed.createdAt,
        mimeType: parsed.mimeType,
        languageHints: Array.isArray(parsed.languageHints) ? parsed.languageHints.filter((hint): hint is string => typeof hint === 'string') : undefined,
        diarizationEnabled: parsed.diarizationEnabled !== false,
        minis: minis.map((mini) => ({
          index: mini.index as number,
          durationMs: mini.durationMs as number,
          attempt: typeof mini.attempt === 'number' ? mini.attempt : 0,
          derivedRecordingId: mini.derivedRecordingId as string,
          jobId: typeof mini.jobId === 'string' ? mini.jobId : undefined,
        })),
      }
    } catch {
      return null
    }
  }

  private async persistManifest(recordingId: string, state: RecordingState): Promise<void> {
    const payload = {
      recordingId,
      createdAt: state.createdAt,
      mimeType: state.mimeType,
      languageHints: state.languageHints,
      diarizationEnabled: state.diarizationEnabled,
      minis: sortedMinis(state)
        .filter((mini) => mini.jobId)
        .map((mini) => ({ index: mini.index, durationMs: mini.durationMs, attempt: mini.attempt, derivedRecordingId: mini.derivedRecordingId, jobId: mini.jobId })),
    }
    await mkdir(join(this.directory, 'asr-segments'), { recursive: true })
    await writeFile(this.manifestPath(recordingId), JSON.stringify(payload), { mode: 0o600 })
  }

  private async discard(recordingId: string): Promise<void> {
    this.recordings.delete(recordingId)
    await rm(this.segmentDirectory(recordingId), { recursive: true, force: true }).catch(() => undefined)
    await rm(this.manifestPath(recordingId), { force: true }).catch(() => undefined)
  }

  private async cancelAll(state: RecordingState): Promise<void> {
    await Promise.all([...state.minis.values()]
      .filter((mini) => mini.jobId)
      .map((mini) => this.saas.cancelAsrJob(mini.jobId!).catch(() => undefined)))
  }

  private async submitMini(recordingId: string, index: number): Promise<void> {
    const state = this.recordings.get(recordingId)
    if (!state || state.aborted) return
    const mini = state.minis.get(index)
    if (!mini || mini.status === 'submitted' || mini.status === 'transcribed') return
    try {
      const jobId = await this.ensureMiniJob(recordingId, state, mini)
      const objectKey = await this.putWithReauthorization(jobId, mini, recordingId)
      mini.objectKey = objectKey
      await this.saas.completeAsrJobSegments(jobId, [{
        index: 0,
        objectKey,
        sha256: mini.sha256,
        bytes: mini.bytes,
        durationMs: mini.durationMs,
      }])
      mini.status = 'submitted'
      await this.persistManifest(recordingId, state).catch(() => undefined)
      this.ensurePolling(recordingId)
    } catch {
      mini.status = 'uploadFailed'
    }
  }

  private async ensureMiniJob(recordingId: string, state: RecordingState, mini: MiniJobState): Promise<string> {
    if (mini.jobId) return mini.jobId
    const job = await this.saas.createAsrJobShell({
      recordingId: mini.derivedRecordingId,
      fileName: `segment-${mini.index}${extensionForMimeType(state.mimeType)}`,
      mimeType: state.mimeType,
      fileSize: mini.bytes,
      contentHash: mini.sha256,
      estimatedDurationMs: mini.durationMs,
      languageHints: state.languageHints,
      diarizationEnabled: state.diarizationEnabled,
      idempotencyKey: `recording:${recordingId}:asr:seg:${mini.index}${mini.attempt > 0 ? `:r${mini.attempt}` : ''}`,
    })
    mini.jobId = job.id
    await this.persistManifest(recordingId, state).catch(() => undefined)
    return job.id
  }

  private ensurePolling(recordingId: string): void {
    const state = this.recordings.get(recordingId)
    if (!state || state.pollTimer || state.finalized || state.aborted) return
    state.pollTimer = setInterval(() => {
      void this.pollOnce(recordingId).catch(() => undefined)
    }, this.pollIntervalMs)
  }

  private stopPolling(state: RecordingState): void {
    if (state.pollTimer) clearInterval(state.pollTimer)
    state.pollTimer = null
  }

  private async pollOnce(recordingId: string): Promise<void> {
    const state = this.recordings.get(recordingId)
    if (!state || state.aborted) return
    const pending = sortedMinis(state).filter((mini) => mini.status === 'submitted' && mini.jobId)
    if (!pending.length) {
      if (state.pollTimer) this.stopPolling(state)
      return
    }
    await Promise.all(pending.map(async (mini) => {
      try {
        const job = await this.saas.getAsrJob(`saas:${mini.jobId}`)
        mini.pollErrors = 0
        console.log('[segment-asr] poll', recordingId, 'index', mini.index, 'status', job.status)
        if (job.status === 'completed' && job.result) {
          mini.result = job.result
          mini.provider = job.provider
          mini.status = 'transcribed'
          await this.persistManifest(recordingId, state).catch(() => undefined)
          this.preview?.({
            recordingId,
            index: mini.index,
            result: this.offsetResult(state, mini),
          })
        } else if (job.status === 'failed' || job.status === 'cancelled') {
          mini.status = 'jobFailed'
        }
      } catch (error) {
        mini.pollErrors += 1
        console.warn('[segment-asr] poll error', recordingId, 'index', mini.index, 'errors', mini.pollErrors, error)
        if (mini.pollErrors >= MAX_POLL_ERRORS) mini.status = 'jobFailed'
      }
    }))
    if (!state.aborted && !state.finalized && !sortedMinis(state).some((mini) => mini.status === 'submitted')) {
      this.stopPolling(state)
    }
  }

  private offsetResult(state: RecordingState, mini: MiniJobState): AsrResult {
    const offset = offsetForIndex(state, mini.index)
    return {
      transcript: mini.result?.transcript ?? '',
      segments: (mini.result?.segments ?? []).map((segment) => ({
        ...segment,
        beginTime: segment.beginTime + offset,
        endTime: segment.endTime + offset,
      })),
    }
  }

  private async putWithReauthorization(
    jobId: string,
    mini: MiniJobState,
    recordingId: string,
  ): Promise<string> {
    const filePath = join(this.segmentDirectory(recordingId), mini.fileName)
    const authorize = () => this.saas.authorizeAsrSegmentUpload(jobId, 0, {
      fileSize: mini.bytes,
      contentHash: mini.sha256,
      durationMs: mini.durationMs,
    })
    const authorization = await authorize()
    try {
      await this.saas.putAsrUpload(filePath, authorization)
      return authorization.objectKey
    } catch {
      // 预签名 10 分钟过期：重新授权（同 index 同 hash → 同 objectKey，幂等）再传一次。
      const reauthorized = await authorize()
      await this.saas.putAsrUpload(filePath, reauthorized)
      return reauthorized.objectKey
    }
  }
}
