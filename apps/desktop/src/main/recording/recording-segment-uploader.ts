import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AsrJob, AsrResult, AsrSegment } from '../../shared/sources'
import { isSaasPermanentError, type CloudJob, type SaasClient } from '../cloud/saas-client'

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
  status: 'pending' | 'submitted' | 'transcribed' | 'uploadFailed' | 'jobFailed' | 'blocked'
  result?: AsrResult
  provider?: string
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
  /** 服务端判定永久失败（设备不匹配/额度不足）后记录原因；后续分段直接标记 blocked，不再逐段重试。 */
  blockedReason?: string
  pushChannel: ReturnType<SaasClient['createAsrJobChannel']> | null
}

/** 合并任务在事件上占位的 job id 前缀（不与 'saas:' 前缀冲突，Coordinator 拦截路由）。 */
export const SEGMENT_JOB_PREFIX = 'saas-seg:'

/** finalize 等待循环的检查间隔：终态由 WS 推送落地，循环只负责重试与超时。 */
const FINALIZE_WAIT_INTERVAL_MS = 1_000
const FINALIZE_WAIT_MS = 180_000
const V5_NAMESPACE = '8f2d1c4a-6b3e-4f9a-a5d7-2c8e0b6f4d21'

/** SaaS 按 recording_id 全局去重，分段任务必须各持独立 UUID；确定性派生保证重试幂等。 */
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

/** 按段序合并各分段任务结果：偏移 = max(段声明时长, 段内最大语音结束点)，与 SaaS 侧同一套数学。 */
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
 * 录制中的分段上传：每段立即建成独立的 SaaS 转写任务（边录边转），
 * 终态一律经 WS 推送通道落地（订阅即回快照，断线重连自动补齐），
 * 转完经 preview 回调推送实时文字；停止时等全部转完、按段序合并成整篇结果。
 * 任一分段两轮仍失败 → 取消全部，调用方回退整段上传老路。
 */
export class RecordingSegmentUploader {
  private readonly recordings = new Map<string, RecordingState>()
  private preview?: (event: SegmentTranscriptionPreview) => void
  private readonly waitIntervalMs: number

  constructor(
    private readonly saas: SaasClient,
    private readonly directory: string,
    options: { waitIntervalMs?: number } = {},
  ) {
    this.waitIntervalMs = options.waitIntervalMs ?? FINALIZE_WAIT_INTERVAL_MS
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
    if (!Number.isInteger(index) || index < 0) return
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
        pushChannel: null,
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
    const mini: MiniJobState = {
      index,
      fileName,
      bytes: buffer.byteLength,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      durationMs: Math.round(durationMs),
      attempt: 0,
      derivedRecordingId: uuidV5(`${recordingId}:${index}`),
      status: 'pending',
    }
    state.minis.set(index, mini)
    if (state.blockedReason) {
      mini.status = 'blocked'
      return
    }
    state.chain = state.chain.then(() => this.submitMini(recordingId, index))
  }

  /** 录音结束收尾：全部分段任务转完返回合并结果；任何失败返回 null（调用方回退整段上传）。 */
  async finalize(recordingId: string): Promise<AsrJob | null> {
    const state = this.recordings.get(recordingId)
    if (!state) return null
    state.finalized = true
    await state.chain.catch(() => undefined)
    for (const mini of sortedMinis(state)) {
      if (mini.status === 'pending' || mini.status === 'uploadFailed') await this.submitMini(recordingId, mini.index)
    }
    // 永久性失败（设备不匹配/额度不足）：不再等推送窗口，直接放弃分段路径，让调用方回退并报出真实原因。
    if (sortedMinis(state).some((mini) => mini.status === 'blocked')) {
      await this.cancelAll(state)
      await this.discard(recordingId)
      return null
    }
    const deadline = Date.now() + FINALIZE_WAIT_MS
    for (;;) {
      if (sortedMinis(state).some((mini) => mini.status === 'uploadFailed')) break
      const minis = sortedMinis(state)
      if (minis.length > 0 && minis.every((mini) => mini.status === 'transcribed')) {
        await rm(this.segmentDirectory(recordingId), { recursive: true, force: true }).catch(() => undefined)
        await this.persistManifest(recordingId, state).catch(() => undefined)
        this.closePushChannel(state)
        return mergeMiniJobs(recordingId, state.mimeType, minis, state)
      }
      let giveUp = false
      for (const mini of minis.filter((entry) => entry.status === 'jobFailed')) {
        if (mini.attempt >= 1) { giveUp = true; break }
        await this.saas.cancelAsrJob(mini.jobId!).catch(() => undefined)
        mini.attempt += 1
        mini.jobId = undefined
        mini.objectKey = undefined
        mini.derivedRecordingId = uuidV5(`${recordingId}:${mini.index}:r${mini.attempt}`)
        await this.submitMini(recordingId, mini.index)
      }
      if (giveUp) break
      if (Date.now() > deadline) break
      await new Promise((resolve) => setTimeout(resolve, this.waitIntervalMs))
    }
    await this.cancelAll(state)
    await this.discard(recordingId)
    return null
  }

  async abort(recordingId: string): Promise<void> {
    const state = this.recordings.get(recordingId)
    if (!state) return
    state.aborted = true
    await state.chain.catch(() => undefined)
    await this.cancelAll(state)
    await this.discard(recordingId)
  }

  /** 合并任务查询：REST 逐段拉当前状态，全转完返回 completed 合并结果，仍有在转返回 running 占位。 */
  async getMergedJob(recordingId: string): Promise<AsrJob | null> {
    const state = await this.ensureState(recordingId)
    if (!state || state.minis.size === 0) return null
    await this.refreshResults(state)
    await this.persistManifest(recordingId, state).catch(() => undefined)
    const minis = sortedMinis(state)
    const done = minis.length > 0 && minis.every((mini) => mini.status === 'transcribed')
    if (!done) {
      return { ...mergeMiniJobs(recordingId, state.mimeType, minis, state), status: 'running', result: null }
    }
    return mergeMiniJobs(recordingId, state.mimeType, minis, state)
  }

  /** 改名支持：重新拉取全部分段结果合并，并给出可用于 SaaS 改名的锚点任务 id。 */
  async refetchMerged(recordingId: string): Promise<{ merged: AsrJob; anchorJobId: string | null } | null> {
    const state = await this.ensureState(recordingId)
    if (!state || state.minis.size === 0) return null
    await this.refreshResults(state)
    await this.persistManifest(recordingId, state).catch(() => undefined)
    const anchor = sortedMinis(state).find((mini) => mini.status === 'transcribed' && mini.jobId)
    return { merged: mergeMiniJobs(recordingId, state.mimeType, sortedMinis(state), state), anchorJobId: anchor?.jobId ?? null }
  }

  /** 崩溃遗留的段音频启动时清空；分段任务的 manifest 留存（重启后改名要用）。 */
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
      }])),
      chain: Promise.resolve(),
      finalized: true,
      aborted: false,
      pushChannel: null,
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
    const state = this.recordings.get(recordingId)
    this.recordings.delete(recordingId)
    if (state) this.closePushChannel(state)
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
    if (!state || state.aborted || state.blockedReason) return
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
      this.syncPushSubscription(recordingId)
    } catch (error) {
      if (isSaasPermanentError(error)) {
        mini.status = 'blocked'
        state.blockedReason ??= error.message
        console.warn('[segment-asr] permanent failure; skipping remaining segments', recordingId, error.message)
        return
      }
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

  private closePushChannel(state: RecordingState): void {
    state.pushChannel?.close()
    state.pushChannel = null
  }

  /** 每次新任务提交后，把全部在转任务的 id 整体重放给推送通道（订阅是替换语义，服务端订阅即回快照）。 */
  private syncPushSubscription(recordingId: string): void {
    const state = this.recordings.get(recordingId)
    if (!state || state.aborted) return
    state.pushChannel ??= this.saas.createAsrJobChannel((job) => { void this.applyPushedJob(recordingId, job) })
    const ids = sortedMinis(state).filter((mini) => mini.status === 'submitted' && mini.jobId).map((mini) => mini.jobId!)
    if (ids.length) state.pushChannel.subscribe(ids)
  }

  /** WS 推送（终态单推 + 订阅快照同路）：完成段立刻转正并推实时预览，失败段进 jobFailed 待收尾重试。 */
  private async applyPushedJob(recordingId: string, job: CloudJob): Promise<void> {
    const state = this.recordings.get(recordingId)
    if (!state || state.aborted || !job?.id) return
    if (job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled' && job.status !== 'expired') return
    const mini = sortedMinis(state).find((entry) => entry.jobId === job.id && entry.status === 'submitted')
    if (!mini) return
    console.log('[segment-asr] push', recordingId, 'index', mini.index, 'status', job.status)
    await this.applyJobToMini(recordingId, state, mini, job)
  }

  /** 任务终态落地。 */
  private async applyJobToMini(recordingId: string, state: RecordingState, mini: MiniJobState, job: CloudJob): Promise<void> {
    if (job.status === 'completed' && job.transcript) {
      mini.result = { transcript: job.transcript, segments: job.segments ?? [] }
      mini.provider = job.provider
      mini.status = 'transcribed'
      await this.persistManifest(recordingId, state).catch(() => undefined)
      this.preview?.({
        recordingId,
        index: mini.index,
        result: this.offsetResult(state, mini),
      })
    } else if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'expired') {
      mini.status = 'jobFailed'
    }
  }

  /** 查询路径的按需刷新：逐段 REST 拉当前状态（不建轮询循环）。 */
  private async refreshResults(state: RecordingState): Promise<void> {
    await Promise.all(sortedMinis(state).map(async (mini) => {
      if (!mini.jobId) return
      const job = await this.saas.getAsrJob(`saas:${mini.jobId}`).catch(() => undefined)
      if (job?.status === 'completed' && job.result) {
        mini.result = job.result
        mini.provider = job.provider
        mini.status = 'transcribed'
      } else if (job && (job.status === 'failed' || job.status === 'cancelled')) {
        mini.status = 'jobFailed'
      }
    }))
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
