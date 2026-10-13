import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AsrJob, AsrResult } from '../../shared/sources'
import {
  extensionForMimeType,
  mergeMiniJobs,
  miniResultSegments,
  offsetForIndex,
  sortedMinis,
  type MiniJobState,
  type SegmentTranscriptionPreview,
  type SegmentUploadMeta,
} from './recording-segment-uploader'

/** 本地分段引擎（AsrGatewayBridge 即满足）：网关任务可能建单即完成，也可能要轮询。 */
export interface LocalSegmentEngineJob {
  id: string
  provider: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  result?: AsrResult | null
}

export interface LocalSegmentEngine {
  createJob(input: { filePath: string; languageHints?: string[]; diarizationEnabled: boolean; externalId?: string }): Promise<LocalSegmentEngineJob>
  getJob(id: string): Promise<LocalSegmentEngineJob>
}

interface LocalRecordingState {
  createdAt: string
  mimeType: string
  languageHints?: string[]
  diarizationEnabled: boolean
  minis: Map<number, MiniJobState>
  chain: Promise<void>
  finalized: boolean
  aborted: boolean
  /** 建单失败（网关 asr 未配置/不可达）后整条分段路放弃：静默回退停止后整段转。 */
  blockedReason?: string
}

const LOCAL_POLL_INTERVAL_MS = 2_000
const LOCAL_MINI_DEADLINE_MS = 300_000
const LOCAL_POLL_ERROR_LIMIT = 5
const LOCAL_FINALIZE_WAIT_MS = 180_000

/**
 * 本地路的录制中分段转写：分段落盘（网关录音输入目录内）→ 网关建转写任务 →
 * 轮询取结果（自建引擎可能建单即完成）→ preview 回调推实时文字；停止时
 * 等全部转完按段序合并成整篇。任一分段两轮仍失败 → 返回 null，调用方回退整段转老路。
 * 引擎不可用/建单失败一律静默降级，不向调用方抛错。
 */
export class LocalRecordingSegmentTranscriber {
  private readonly states = new Map<string, LocalRecordingState>()
  private preview?: (event: SegmentTranscriptionPreview) => void
  private readonly waitIntervalMs: number
  private readonly pollIntervalMs: number
  private readonly miniDeadlineMs: number
  private readonly finalizeWaitMs: number

  constructor(
    private readonly directory: string,
    private readonly engineProvider: () => LocalSegmentEngine | null,
    options: { waitIntervalMs?: number; pollIntervalMs?: number; miniDeadlineMs?: number; finalizeWaitMs?: number } = {},
  ) {
    this.waitIntervalMs = options.waitIntervalMs ?? LOCAL_POLL_INTERVAL_MS
    this.pollIntervalMs = options.pollIntervalMs ?? LOCAL_POLL_INTERVAL_MS
    this.miniDeadlineMs = options.miniDeadlineMs ?? LOCAL_MINI_DEADLINE_MS
    this.finalizeWaitMs = options.finalizeWaitMs ?? LOCAL_FINALIZE_WAIT_MS
  }

  setPreviewListener(fn: (event: SegmentTranscriptionPreview) => void): void {
    this.preview = fn
  }

  /** manifest 是否标记为本地分段（重启后路由用；与云路共用文件路径，靠 engine 字段区分）。 */
  async ownsRecording(recordingId: string): Promise<boolean> {
    const manifest = await this.loadManifest(recordingId)
    return manifest !== null
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
    let state = this.states.get(recordingId)
    if (!state) {
      state = {
        createdAt: new Date().toISOString(),
        mimeType: meta.mimeType,
        ...(meta.languageHints ? { languageHints: meta.languageHints } : {}),
        diarizationEnabled: true,
        minis: new Map(),
        chain: Promise.resolve(),
        finalized: false,
        aborted: false,
      }
      this.states.set(recordingId, state)
    }
    if (state.finalized || state.aborted) return
    if (state.minis.has(index)) return
    const fileName = `${index}${extensionForMimeType(meta.mimeType)}`
    const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    const directory = this.segmentDirectory(recordingId)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, fileName), buffer, { mode: 0o600 })
    const mini: MiniJobState = {
      index,
      fileName,
      bytes: buffer.byteLength,
      sha256: '',
      durationMs: Math.round(durationMs),
      attempt: 0,
      derivedRecordingId: '',
      status: 'pending',
    }
    state.minis.set(index, mini)
    if (state.blockedReason) {
      mini.status = 'blocked'
      return
    }
    state.chain = state.chain.then(() => this.submitMini(recordingId, index))
  }

  /** 录音结束收尾：全部分段转完返回合并结果；任何失败返回 null（调用方回退整段转）。 */
  async finalize(recordingId: string): Promise<AsrJob | null> {
    const state = this.states.get(recordingId)
    if (!state) return null
    state.finalized = true
    await state.chain.catch(() => undefined)
    for (const mini of sortedMinis(state)) {
      if (mini.status === 'pending') await this.submitMini(recordingId, mini.index)
    }
    const deadline = Date.now() + this.finalizeWaitMs
    for (;;) {
      // 收尾轮询自带拉取：不依赖预览轮询循环也终能收敛。
      await this.refreshResults(state)
      const minis = sortedMinis(state)
      if (minis.length > 0 && minis.every((mini) => mini.status === 'transcribed')) {
        await rm(this.segmentDirectory(recordingId), { recursive: true, force: true }).catch(() => undefined)
        await this.persistManifest(recordingId, state).catch(() => undefined)
        return this.merge(recordingId, state)
      }
      if (minis.some((mini) => mini.status === 'blocked')) break
      let giveUp = false
      for (const mini of minis.filter((entry) => entry.status === 'jobFailed')) {
        if (mini.attempt >= 1) { giveUp = true; break }
        mini.attempt += 1
        mini.jobId = undefined
        await this.submitMini(recordingId, mini.index)
      }
      if (giveUp) break
      if (Date.now() > deadline) break
      await new Promise((resolve) => setTimeout(resolve, this.waitIntervalMs))
    }
    await this.discard(recordingId)
    return null
  }

  async abort(recordingId: string): Promise<void> {
    const state = this.states.get(recordingId)
    if (!state) return
    state.aborted = true
    await state.chain.catch(() => undefined)
    await this.discard(recordingId)
  }

  /** 合并任务查询：逐段拉网关当前状态，全转完返回 completed 合并结果，仍在转返回 running 占位。 */
  async getMergedJob(recordingId: string): Promise<AsrJob | null> {
    const state = await this.ensureState(recordingId)
    if (!state || state.minis.size === 0) return null
    await this.refreshResults(state)
    await this.persistManifest(recordingId, state).catch(() => undefined)
    const minis = sortedMinis(state)
    const done = minis.length > 0 && minis.every((mini) => mini.status === 'transcribed')
    if (!done) return { ...this.merge(recordingId, state), status: 'running', result: null }
    return this.merge(recordingId, state)
  }

  /** 本地段没有云端锚点任务：仅供改口径判 source 用，anchorJobId 恒为 null。 */
  async refetchMerged(recordingId: string): Promise<{ merged: AsrJob; anchorJobId: string | null } | null> {
    const state = await this.ensureState(recordingId)
    if (!state || state.minis.size === 0) return null
    await this.refreshResults(state)
    await this.persistManifest(recordingId, state).catch(() => undefined)
    return { merged: this.merge(recordingId, state), anchorJobId: null }
  }

  /** 崩溃遗留的段音频启动时清空；manifest 留存（重启后合并查询要用）。 */
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

  private merge(recordingId: string, state: LocalRecordingState): AsrJob {
    return mergeMiniJobs(recordingId, state.mimeType, sortedMinis(state), {
      createdAt: state.createdAt,
      ...(state.languageHints ? { languageHints: state.languageHints } : {}),
      diarizationEnabled: state.diarizationEnabled,
      source: 'local',
      defaultProvider: 'local-gateway',
    })
  }

  private async ensureState(recordingId: string): Promise<LocalRecordingState | null> {
    const existing = this.states.get(recordingId)
    if (existing) return existing
    const manifest = await this.loadManifest(recordingId)
    if (!manifest) return null
    const state: LocalRecordingState = {
      createdAt: manifest.createdAt,
      mimeType: manifest.mimeType,
      ...(manifest.languageHints ? { languageHints: manifest.languageHints } : {}),
      diarizationEnabled: manifest.diarizationEnabled,
      minis: new Map(manifest.minis.map((mini) => [mini.index, {
        index: mini.index,
        fileName: `${mini.index}${extensionForMimeType(manifest.mimeType)}`,
        bytes: 0,
        sha256: '',
        durationMs: mini.durationMs,
        attempt: mini.attempt,
        derivedRecordingId: '',
        jobId: mini.jobId,
        status: 'submitted',
      }])),
      chain: Promise.resolve(),
      finalized: true,
      aborted: false,
    }
    this.states.set(recordingId, state)
    return state
  }

  /** 与云路共用 asr-segments/ 下的 manifest 文件：engine 字段区分归属（loadManifest 只认 engine==='local'）。 */
  private async loadManifest(recordingId: string): Promise<{
    createdAt: string
    mimeType: string
    languageHints?: string[]
    diarizationEnabled: boolean
    minis: Array<{ index: number; durationMs: number; attempt: number; jobId?: string }>
  } | null> {
    const raw = await readFile(this.manifestPath(recordingId), 'utf8').catch(() => undefined)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed.engine !== 'local' || typeof parsed.createdAt !== 'string' || typeof parsed.mimeType !== 'string' || !Array.isArray(parsed.minis)) return null
      const minis = (parsed.minis as Array<Record<string, unknown>>).filter((mini) => typeof mini.index === 'number' && typeof mini.durationMs === 'number')
      return {
        createdAt: parsed.createdAt,
        mimeType: parsed.mimeType,
        languageHints: Array.isArray(parsed.languageHints) ? parsed.languageHints.filter((hint): hint is string => typeof hint === 'string') : undefined,
        diarizationEnabled: parsed.diarizationEnabled !== false,
        minis: minis.map((mini) => ({
          index: mini.index as number,
          durationMs: mini.durationMs as number,
          attempt: typeof mini.attempt === 'number' ? mini.attempt : 0,
          jobId: typeof mini.jobId === 'string' ? mini.jobId : undefined,
        })),
      }
    } catch {
      return null
    }
  }

  private async persistManifest(recordingId: string, state: LocalRecordingState): Promise<void> {
    const payload = {
      recordingId,
      engine: 'local' as const,
      createdAt: state.createdAt,
      mimeType: state.mimeType,
      languageHints: state.languageHints,
      diarizationEnabled: state.diarizationEnabled,
      minis: sortedMinis(state)
        .filter((mini) => mini.jobId)
        .map((mini) => ({ index: mini.index, durationMs: mini.durationMs, attempt: mini.attempt, jobId: mini.jobId })),
    }
    await mkdir(join(this.directory, 'asr-segments'), { recursive: true })
    await writeFile(this.manifestPath(recordingId), JSON.stringify(payload), { mode: 0o600 })
  }

  private async discard(recordingId: string): Promise<void> {
    this.states.delete(recordingId)
    await rm(this.segmentDirectory(recordingId), { recursive: true, force: true }).catch(() => undefined)
    await rm(this.manifestPath(recordingId), { force: true }).catch(() => undefined)
  }

  private async submitMini(recordingId: string, index: number): Promise<void> {
    const state = this.states.get(recordingId)
    if (!state || state.aborted) return
    const mini = state.minis.get(index)
    if (!mini) return
    if (state.blockedReason) {
      mini.status = 'blocked'
      return
    }
    if (mini.status === 'submitted' || mini.status === 'transcribed') return
    const engine = this.engineProvider()
    if (!engine) {
      state.blockedReason ??= '本地转写引擎不可用'
      mini.status = 'blocked'
      return
    }
    try {
      const job = await engine.createJob({
        filePath: join(this.segmentDirectory(recordingId), mini.fileName),
        ...(state.languageHints?.length ? { languageHints: state.languageHints } : {}),
        diarizationEnabled: state.diarizationEnabled,
        // 同一录音的分段共用 external_id → nxcore-asr 同一会话，说话人跨段连续。
        externalId: recordingId,
      })
      mini.jobId = job.id
      mini.provider = job.provider
      mini.status = 'submitted'
      await this.persistManifest(recordingId, state).catch(() => undefined)
      // 自建引擎可能建单即完成：终态直接落地，不起轮询。
      if (await this.applyEngineJob(recordingId, state, mini, job, true)) return
      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
        mini.status = 'jobFailed'
        return
      }
      void this.pollMini(recordingId, index)
    } catch (error) {
      // 建单失败（网关 asr 未配置/网关不可达）视为整条分段路的永久失败：静默回退整段转。
      state.blockedReason ??= error instanceof Error ? error.message : String(error)
      mini.status = 'blocked'
      console.warn('[segment-asr:local] submit failed; falling back to whole-file transcription', recordingId, index, state.blockedReason)
    }
  }

  /** 轮询直至终态：首轮查询前不等待（任务可能即刻可取）。 */
  private async pollMini(recordingId: string, index: number): Promise<void> {
    const deadline = Date.now() + this.miniDeadlineMs
    let errors = 0
    let first = true
    for (;;) {
      if (!first) await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs))
      first = false
      const state = this.states.get(recordingId)
      if (!state || state.aborted) return
      const mini = state.minis.get(index)
      if (!mini?.jobId || mini.status !== 'submitted') return
      const engine = this.engineProvider()
      if (!engine) return
      let job: LocalSegmentEngineJob
      try {
        job = await engine.getJob(mini.jobId)
      } catch {
        errors += 1
        if (errors >= LOCAL_POLL_ERROR_LIMIT) { mini.status = 'jobFailed'; return }
        continue
      }
      errors = 0
      if (await this.applyEngineJob(recordingId, state, mini, job, true)) return
      if (job.status === 'failed' || job.status === 'cancelled') { mini.status = 'jobFailed'; return }
      if (Date.now() > deadline) { mini.status = 'jobFailed'; return }
    }
  }

  /** 终态落地：完成段推实时预览（时间已偏移到整段时间轴）；emit=false 供收尾/查询刷新静默转正。 */
  private async applyEngineJob(
    recordingId: string,
    state: LocalRecordingState,
    mini: MiniJobState,
    job: LocalSegmentEngineJob,
    emit: boolean,
  ): Promise<boolean> {
    if (job.status !== 'completed' || !job.result) return false
    mini.result = { transcript: job.result.transcript ?? '', segments: Array.isArray(job.result.segments) ? job.result.segments : [] }
    mini.status = 'transcribed'
    await this.persistManifest(recordingId, state).catch(() => undefined)
    if (emit) {
      this.preview?.({
        recordingId,
        index: mini.index,
        result: this.offsetResult(state, mini),
      })
    }
    return true
  }

  /** 查询/收尾路径的按需刷新：逐段拉网关当前状态（不推预览）。 */
  private async refreshResults(state: LocalRecordingState): Promise<void> {
    const engine = this.engineProvider()
    if (!engine) return
    await Promise.all(sortedMinis(state).map(async (mini) => {
      if (!mini.jobId || mini.status !== 'submitted') return
      const job = await engine.getJob(mini.jobId).catch(() => undefined)
      if (!job) return
      if (job.status === 'completed' && job.result) {
        mini.result = { transcript: job.result.transcript ?? '', segments: Array.isArray(job.result.segments) ? job.result.segments : [] }
        mini.provider = job.provider
        mini.status = 'transcribed'
      } else if (job.status === 'failed' || job.status === 'cancelled') {
        mini.status = 'jobFailed'
      }
    }))
  }

  private offsetResult(state: LocalRecordingState, mini: MiniJobState): AsrResult {
    const offset = offsetForIndex(state, mini.index)
    return {
      transcript: mini.result?.transcript ?? '',
      segments: miniResultSegments(mini).map((segment) => ({
        ...segment,
        beginTime: segment.beginTime + offset,
        endTime: segment.endTime + offset,
      })),
    }
  }
}
