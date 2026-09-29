import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { AsrJob, AsrResult } from '../src/shared/sources'
import type { CloudJob, SaasClient } from '../src/main/cloud/saas-client'
import type { AsrGatewayBridge } from '../src/main/gateway/asr-gateway-bridge'
import type { LocalSegmentEngine, LocalSegmentEngineJob } from '../src/main/recording/local-recording-segment-transcriber'
import { RecordingSegmentUploader } from '../src/main/recording/recording-segment-uploader'

// 接线契约（编译期）：AsrGatewayBridge 必须结构满足本地分段引擎面，index.ts 构造点可直接注入。
const _bridgeSatisfiesEngine: LocalSegmentEngine = null as unknown as AsrGatewayBridge

type SaasMock = SaasClient & Record<string, ReturnType<typeof vi.fn>> & { emit(job: CloudJob): void }

function segment(text: string, beginTime: number, endTime: number, overrides: Record<string, unknown> = {}) {
  return { text, beginTime, endTime, speakerId: 'spk_a', speakerName: '说话人1', ...overrides }
}

function resultOf(segments: Array<ReturnType<typeof segment>>): AsrResult {
  return { transcript: segments.map((entry) => entry.text).join('\n'), segments }
}

function completed(id: string, result: AsrResult): AsrJob {
  return {
    id,
    source: 'saas',
    provider: 'nxcore',
    status: 'completed',
    fileName: 'segment.webm',
    languageHints: [],
    diarizationEnabled: true,
    contextPrompt: '',
    result,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function pushed(id: string, status: 'completed', result: AsrResult): CloudJob {
  return { id, status, provider: 'nxcore', transcript: result.transcript, segments: result.segments } as unknown as CloudJob
}

function pushedStatus(id: string, status: 'running' | 'failed' | 'cancelled' | 'expired'): CloudJob {
  return { id, status } as unknown as CloudJob
}

function fakeSaas(
  resultsByJob: Record<string, AsrJob> = {},
  overrides: Partial<Record<'createAsrJobShell' | 'authorizeAsrSegmentUpload' | 'putAsrUpload' | 'completeAsrJobSegments' | 'cancelAsrJob' | 'getAsrJob', ReturnType<typeof vi.fn>>> = {},
): SaasMock {
  let shells = 0
  let onJob: ((job: CloudJob) => void) | undefined
  return {
    createAsrJobShell: vi.fn().mockImplementation(async () => ({ id: `job-${++shells}`, status: 'awaiting_upload' })),
    authorizeAsrSegmentUpload: vi.fn().mockImplementation(async (jobId: string, index: number) => ({
      uploadUrl: `https://oss.example/put/${jobId}/${index}`,
      objectKey: `asr-staging/${jobId}/${index}`,
      headers: {},
    })),
    putAsrUpload: vi.fn().mockResolvedValue(undefined),
    completeAsrJobSegments: vi.fn().mockImplementation(async (jobId: string) => ({ id: `saas:${jobId}`, status: 'queued' })),
    cancelAsrJob: vi.fn().mockResolvedValue(undefined),
    getAsrJob: vi.fn().mockImplementation(async (prefixedId: string) => {
      const scripted = resultsByJob[prefixedId.replace(/^saas:/, '')]
      if (!scripted) throw new Error(`no scripted result for ${prefixedId}`)
      return scripted
    }),
    createAsrJobChannel: vi.fn().mockImplementation((handler: (job: CloudJob) => void) => {
      onJob = handler
      return { subscribe: vi.fn(), close: vi.fn() }
    }),
    emit: (job: CloudJob) => onJob?.(job),
    ...overrides,
  } as unknown as SaasMock
}

function chunk(seed: number, size = 64): Uint8Array {
  const value = new Uint8Array(size)
  value.fill(seed)
  return value
}

async function createUploader(saas: SaasClient) {
  const directory = await mkdtemp(join(tmpdir(), 'segment-upload-'))
  return { uploader: new RecordingSegmentUploader(saas, directory, { waitIntervalMs: 10 }), directory }
}

async function submitted(saas: SaasMock, count: number): Promise<void> {
  await vi.waitFor(() => expect(saas.createAsrJobShell).toHaveBeenCalledTimes(count))
  await vi.waitFor(() => expect(saas.completeAsrJobSegments).toHaveBeenCalledTimes(count))
}

const SEG_A = resultOf([segment('第一段。', 0, 1000)])
const SEG_B = resultOf([segment('第二段。', 500, 900)])

describe('RecordingSegmentUploader', () => {
  it('creates one mini job per segment, merges in index order with offsets', async () => {
    const saas = fakeSaas()
    const { uploader } = await createUploader(saas)
    await uploader.onSegment('rec-1', 0, chunk(1), 5_000, { mimeType: 'audio/webm', languageHints: ['zh'] })
    await uploader.onSegment('rec-1', 1, chunk(2), 5_000, { mimeType: 'audio/webm' })
    await submitted(saas, 2)
    saas.emit(pushed('job-1', 'completed', SEG_A))
    saas.emit(pushed('job-2', 'completed', SEG_B))
    const job = await uploader.finalize('rec-1')
    expect(job).toMatchObject({ id: 'saas-seg:rec-1', status: 'completed' })
    const shells = vi.mocked(saas.createAsrJobShell).mock.calls.map(([input]) => input)
    expect(shells.map((input) => input.idempotencyKey)).toEqual(['recording:rec-1:asr:seg:0', 'recording:rec-1:asr:seg:1'])
    // SaaS 按 recording_id 去重：两个分段任务必须各持独立派生 UUID。
    expect(shells[0]!.recordingId).not.toBe(shells[1]!.recordingId)
    expect(shells[0]!.recordingId).toMatch(/^[0-9a-f-]{36}$/)
    expect(shells[0]).toMatchObject({ estimatedDurationMs: 5_000, languageHints: ['zh'] })
    // 每个单内部段号都是 0。
    for (const [jobId] of vi.mocked(saas.authorizeAsrSegmentUpload).mock.calls) expect(jobId).toMatch(/^job-\d+$/)
    expect(vi.mocked(saas.completeAsrJobSegments).mock.calls.map(([jobId, segs]) => [jobId, segs.map((entry) => entry.index)]))
      .toEqual([['job-1', [0]], ['job-2', [0]]])
    // 两个在转任务整体进入推送订阅。
    expect(vi.mocked(saas.createAsrJobChannel).mock.calls).toHaveLength(1)
    expect(job!.result!.segments).toEqual([
      { text: '第一段。', beginTime: 0, endTime: 1000, speakerId: 'spk_a', speakerName: '说话人1' },
      { text: '第二段。', beginTime: 5_500, endTime: 5_900, speakerId: 'spk_a', speakerName: '说话人1' },
    ])
    expect(job!.result!.transcript).toBe('第一段。\n第二段。')
    expect(saas.cancelAsrJob).not.toHaveBeenCalled()
  })

  it('ignores duplicate and out-of-range segments, and rejects arrivals after finalize', async () => {
    const saas = fakeSaas()
    const { uploader } = await createUploader(saas)
    await uploader.onSegment('rec-1', 0, chunk(1), 5_000, { mimeType: 'audio/webm' })
    await uploader.onSegment('rec-1', 0, chunk(9), 5_000, { mimeType: 'audio/webm' })
    await uploader.onSegment('rec-1', -1, chunk(3), 5_000, { mimeType: 'audio/webm' })
    await uploader.onSegment('rec-1', 1.5, chunk(4), 5_000, { mimeType: 'audio/webm' })
    await uploader.onSegment('rec-1', 1, chunk(6), 5_000, { mimeType: 'audio/webm' })
    await submitted(saas, 2)
    saas.emit(pushed('job-1', 'completed', SEG_A))
    saas.emit(pushed('job-2', 'completed', resultOf([segment('第二段。', 0, 800)])))
    const job = await uploader.finalize('rec-1')
    expect(job).not.toBeNull()
    await uploader.onSegment('rec-1', 2, chunk(5), 5_000, { mimeType: 'audio/webm' })
    // 只有两个合法段各建一次单；finalize 后新段被拒收。
    expect(saas.createAsrJobShell).toHaveBeenCalledTimes(2)
    expect(job!.result!.segments.map((entry) => entry.text)).toEqual(['第一段。', '第二段。'])
  })

  it('retries failed uploads during finalize and falls back to null when retries fail', async () => {
    const saas = fakeSaas({}, {
      authorizeAsrSegmentUpload: vi.fn().mockRejectedValue(new Error('network down')),
    })
    const { uploader } = await createUploader(saas)
    await uploader.onSegment('rec-1', 0, chunk(1), 5_000, { mimeType: 'audio/webm' })
    const job = await uploader.finalize('rec-1')
    expect(job).toBeNull()
    // 初次上传失败 + finalize 补试一次。
    expect(saas.authorizeAsrSegmentUpload).toHaveBeenCalledTimes(2)
    expect(saas.cancelAsrJob).toHaveBeenCalledWith('job-1')
    expect(saas.completeAsrJobSegments).not.toHaveBeenCalled()
  })

  it('recovers a segment once authorization succeeds on the finalize retry', async () => {
    let failures = 0
    const saas = fakeSaas({}, {
      authorizeAsrSegmentUpload: vi.fn().mockImplementation(async (jobId: string, index: number) => {
        if (failures++ < 1) throw new Error('transient')
        return { uploadUrl: `https://oss.example/put/${jobId}/${index}`, objectKey: `asr-staging/${jobId}/${index}`, headers: {} }
      }),
    })
    const { uploader } = await createUploader(saas)
    await uploader.onSegment('rec-1', 0, chunk(1), 5_000, { mimeType: 'audio/webm' })
    const finishing = uploader.finalize('rec-1')
    await vi.waitFor(() => expect(saas.completeAsrJobSegments).toHaveBeenCalledTimes(1))
    saas.emit(pushed('job-1', 'completed', SEG_A))
    const job = await finishing
    expect(job).toMatchObject({ id: 'saas-seg:rec-1', status: 'completed' })
    expect(saas.completeAsrJobSegments).toHaveBeenCalledTimes(1)
    expect(saas.cancelAsrJob).not.toHaveBeenCalled()
  })

  it('reauthorizes once when the presigned put expires mid-upload', async () => {
    let puts = 0
    const saas = fakeSaas({}, {
      putAsrUpload: vi.fn().mockImplementation(async () => {
        if (puts++ === 0) throw new Error('410 gone')
      }),
    })
    const { uploader } = await createUploader(saas)
    await uploader.onSegment('rec-1', 0, chunk(1), 5_000, { mimeType: 'audio/webm' })
    const finishing = uploader.finalize('rec-1')
    await vi.waitFor(() => expect(saas.completeAsrJobSegments).toHaveBeenCalledTimes(1))
    saas.emit(pushed('job-1', 'completed', SEG_A))
    const job = await finishing
    expect(job).not.toBeNull()
    expect(saas.authorizeAsrSegmentUpload).toHaveBeenCalledTimes(2)
    expect(saas.putAsrUpload).toHaveBeenCalledTimes(2)
  })

  it('aborts by cancelling every mini job and removing segment files', async () => {
    const saas = fakeSaas()
    const { uploader, directory } = await createUploader(saas)
    await uploader.onSegment('rec-1', 0, chunk(1), 5_000, { mimeType: 'audio/webm' })
    await uploader.onSegment('rec-1', 1, chunk(2), 5_000, { mimeType: 'audio/webm' })
    await submitted(saas, 2)
    await uploader.abort('rec-1')
    expect(saas.cancelAsrJob).toHaveBeenCalledWith('job-1')
    expect(saas.cancelAsrJob).toHaveBeenCalledWith('job-2')
    expect(await readdir(join(directory, 'segments'))).toEqual([])
    // abort 后再 finalize 不产出任务。
    expect(await uploader.finalize('rec-1')).toBeNull()
  })

  it('returns null without creating a shell job when no segment ever arrived', async () => {
    const saas = fakeSaas()
    const { uploader } = await createUploader(saas)
    expect(await uploader.finalize('rec-1')).toBeNull()
    expect(saas.createAsrJobShell).not.toHaveBeenCalled()
  })

  it('waits for a still-running mini during finalize and then merges', async () => {
    const saas = fakeSaas()
    const { uploader } = await createUploader(saas)
    await uploader.onSegment('rec-1', 0, chunk(1), 5_000, { mimeType: 'audio/webm' })
    await uploader.onSegment('rec-1', 1, chunk(2), 5_000, { mimeType: 'audio/webm' })
    await submitted(saas, 2)
    // 非终态推送不推进状态。
    saas.emit(pushedStatus('job-2', 'running'))
    const finishing = uploader.finalize('rec-1')
    saas.emit(pushed('job-1', 'completed', SEG_A))
    saas.emit(pushed('job-2', 'completed', SEG_B))
    const job = await finishing
    expect(job).toMatchObject({ status: 'completed' })
    expect(job!.result!.segments).toHaveLength(2)
  })

  it('recreates a failed mini once with a salted idempotency key, giving up on the second failure', async () => {
    const saas = fakeSaas()
    const { uploader } = await createUploader(saas)
    await uploader.onSegment('rec-1', 0, chunk(1), 5_000, { mimeType: 'audio/webm' })
    await uploader.onSegment('rec-1', 1, chunk(2), 5_000, { mimeType: 'audio/webm' })
    await submitted(saas, 2)
    saas.emit(pushedStatus('job-1', 'failed'))
    const finishing = uploader.finalize('rec-1')
    // 重试段以新派生 id 重建任务。
    await vi.waitFor(() => expect(saas.createAsrJobShell).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(saas.completeAsrJobSegments).toHaveBeenCalledTimes(3))
    saas.emit(pushed('job-3', 'completed', SEG_A))
    saas.emit(pushed('job-2', 'completed', SEG_B))
    const job = await finishing
    expect(job).toMatchObject({ status: 'completed' })
    const shells = vi.mocked(saas.createAsrJobShell).mock.calls.map(([input]) => input)
    expect(shells.map((input) => input.idempotencyKey)).toEqual([
      'recording:rec-1:asr:seg:0',
      'recording:rec-1:asr:seg:1',
      'recording:rec-1:asr:seg:0:r1',
    ])
    expect(saas.cancelAsrJob).toHaveBeenCalledWith('job-1')
  })

  it('falls back to null when the retried mini fails again', async () => {
    const saas = fakeSaas()
    const { uploader } = await createUploader(saas)
    await uploader.onSegment('rec-1', 0, chunk(1), 5_000, { mimeType: 'audio/webm' })
    await submitted(saas, 1)
    saas.emit(pushedStatus('job-1', 'failed'))
    const finishing = uploader.finalize('rec-1')
    await vi.waitFor(() => expect(saas.createAsrJobShell).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(saas.completeAsrJobSegments).toHaveBeenCalledTimes(2))
    saas.emit(pushedStatus('job-2', 'failed'))
    expect(await finishing).toBeNull()
    expect(saas.cancelAsrJob).toHaveBeenCalledWith('job-1')
    expect(saas.cancelAsrJob).toHaveBeenCalledWith('job-2')
  })

  it('emits preview events offset to the recording timeline, using max(declared, spoken) duration', async () => {
    // 第一段声明 5s 但语音到 6.5s：第二段的偏移必须取 6.5s。
    const longA = resultOf([segment('说满了。', 0, 6_500)])
    const saas = fakeSaas()
    const { uploader } = await createUploader(saas)
    const previews: Array<{ recordingId: string; index: number; result: AsrResult }> = []
    uploader.setPreviewListener((event) => previews.push(event))
    await uploader.onSegment('rec-1', 0, chunk(1), 5_000, { mimeType: 'audio/webm' })
    await uploader.onSegment('rec-1', 1, chunk(2), 5_000, { mimeType: 'audio/webm' })
    await submitted(saas, 2)
    saas.emit(pushed('job-1', 'completed', longA))
    saas.emit(pushed('job-2', 'completed', SEG_B))
    const job = await uploader.finalize('rec-1')
    expect(job).not.toBeNull()
    const second = previews.find((event) => event.index === 1)
    expect(second).toBeDefined()
    expect(second!.result.segments[0]).toMatchObject({ beginTime: 6_500 + 500, endTime: 6_500 + 900 })
    expect(job!.result!.segments[1]).toMatchObject({ beginTime: 7_000 })
  })

  it('restores minis from the manifest after restart for rename refetch', async () => {
    const saas = fakeSaas({ 'job-1': completed('saas:job-1', SEG_A), 'job-2': completed('saas:job-2', SEG_B) })
    const { uploader, directory } = await createUploader(saas)
    await uploader.onSegment('rec-1', 0, chunk(1), 5_000, { mimeType: 'audio/webm' })
    await uploader.onSegment('rec-1', 1, chunk(2), 5_000, { mimeType: 'audio/webm' })
    await submitted(saas, 2)
    saas.emit(pushed('job-1', 'completed', SEG_A))
    saas.emit(pushed('job-2', 'completed', SEG_B))
    const first = await uploader.finalize('rec-1')
    expect(first).not.toBeNull()
    // 重启：新实例只能靠 manifest 找回分段任务。
    const revived = new RecordingSegmentUploader(saas, directory, { waitIntervalMs: 10 })
    const renamed = completed('saas:job-1', resultOf([segment('第一段。', 0, 1000, { speakerName: '张三' })]))
    vi.mocked(saas.getAsrJob).mockImplementation(async (id: string) => (
      id === 'saas:job-1' ? renamed : completed(id, SEG_B)
    ))
    const refetched = await revived.refetchMerged('rec-1')
    expect(refetched!.anchorJobId).toBe('job-1')
    expect(refetched!.merged.result!.segments[0]).toMatchObject({ speakerName: '张三' })
    expect(refetched!.merged.result!.segments[1]).toMatchObject({ beginTime: 5_500, speakerName: '说话人1' })
    expect(refetched!.merged.updatedAt > first!.updatedAt).toBe(true)
  })
})

function gatewayJob(id: string, status: LocalSegmentEngineJob['status'], result?: AsrResult): LocalSegmentEngineJob {
  return { id, provider: 'openai-compatible', status, ...(result ? { result } : {}) }
}

type GatewayMock = LocalSegmentEngine & { complete(jobId: string, result: AsrResult): void; fail(jobId: string): void }

/** 网关分段引擎桩：createJob 建 pending 任务，测试侧用 complete/fail 推终态（模拟轮询到结果）。 */
function fakeGateway(options: { immediate?: (id: string) => LocalSegmentEngineJob } = {}): GatewayMock {
  let created = 0
  const jobs = new Map<string, LocalSegmentEngineJob>()
  return {
    createJob: vi.fn().mockImplementation(async () => {
      created += 1
      const id = `gw-${created}`
      const job = options.immediate ? options.immediate(id) : gatewayJob(id, 'pending')
      jobs.set(id, job)
      return { ...job }
    }),
    getJob: vi.fn().mockImplementation(async (id: string) => {
      const current = jobs.get(id)
      if (!current) throw new Error(`no scripted gateway job ${id}`)
      return { ...current }
    }),
    complete: (id: string, result: AsrResult) => {
      if (jobs.has(id)) jobs.set(id, gatewayJob(id, 'completed', result))
    },
    fail: (id: string) => {
      if (jobs.has(id)) jobs.set(id, gatewayJob(id, 'failed'))
    },
  } as unknown as GatewayMock
}

async function createLocalUploader(gateway: LocalSegmentEngine, saas: SaasClient = fakeSaas()) {
  const directory = await mkdtemp(join(tmpdir(), 'segment-local-'))
  const uploader = new RecordingSegmentUploader(saas, directory, {
    waitIntervalMs: 10,
    localEngine: () => gateway,
    localPollIntervalMs: 5,
  })
  return { uploader, directory }
}

describe('RecordingSegmentUploader local segments (gateway engine)', () => {
  it('local mode submits minis to the gateway, previews with offsets and merges (synthesizing timeline for plain-text results)', async () => {
    const gateway = fakeGateway()
    const saas = fakeSaas()
    const { uploader } = await createLocalUploader(gateway, saas)
    const previews: Array<{ recordingId: string; index: number; result: AsrResult }> = []
    uploader.setPreviewListener((event) => previews.push(event))
    await uploader.onSegment('rec-1', 0, chunk(1), 5_000, { mimeType: 'audio/webm', mode: 'local', languageHints: ['zh'] })
    await uploader.onSegment('rec-1', 1, chunk(2), 5_000, { mimeType: 'audio/webm', mode: 'local' })
    await vi.waitFor(() => expect(gateway.createJob).toHaveBeenCalledTimes(2))
    const createInputs = vi.mocked(gateway.createJob).mock.calls.map(([input]) => input)
    // 分段落盘到网关录音输入目录内，建单以绝对路径引用；语言提示随首段（与云路同口径）。
    expect(createInputs[0]!.filePath).toMatch(/[/\\]segments[/\\]rec-1[/\\]0\.webm$/)
    expect(createInputs[0]).toMatchObject({ languageHints: ['zh'], diarizationEnabled: true })
    // 自建引擎只回纯文本（segments 空）也要可见；带时间戳的结果原样偏移。
    gateway.complete('gw-1', { transcript: '第一段。', segments: [] })
    gateway.complete('gw-2', { transcript: '第二段。', segments: [segment('第二段。', 500, 900)] })
    await vi.waitFor(() => expect(previews).toHaveLength(2))
    const job = await uploader.finalize('rec-1')
    expect(job).toMatchObject({ id: 'saas-seg:rec-1', status: 'completed', source: 'local', provider: 'openai-compatible' })
    expect(job!.result!.segments).toEqual([
      { text: '第一段。', beginTime: 0, endTime: 5_000, speakerId: null },
      { text: '第二段。', beginTime: 5_500, endTime: 5_900, speakerId: 'spk_a', speakerName: '说话人1' },
    ])
    expect(job!.result!.transcript).toBe('第一段。\n第二段。')
    expect(previews.find((event) => event.index === 0)!.result.segments[0]).toMatchObject({ text: '第一段。', beginTime: 0, endTime: 5_000 })
    expect(previews.find((event) => event.index === 1)!.result.segments[0]).toMatchObject({ text: '第二段。', beginTime: 5_500 })
    // 云路完全未被触碰。
    expect(saas.createAsrJobShell).not.toHaveBeenCalled()
    expect(saas.createAsrJobChannel).not.toHaveBeenCalled()
  })

  it('handles gateway jobs that complete synchronously at creation without polling', async () => {
    const gateway = fakeGateway({ immediate: (id) => gatewayJob(id, 'completed', { transcript: '同步完成。', segments: [] }) })
    const { uploader } = await createLocalUploader(gateway)
    const previews: Array<{ index: number }> = []
    uploader.setPreviewListener((event) => previews.push(event))
    await uploader.onSegment('rec-1', 0, chunk(1), 5_000, { mimeType: 'audio/webm', mode: 'local' })
    await vi.waitFor(() => expect(previews).toHaveLength(1))
    const job = await uploader.finalize('rec-1')
    expect(job).toMatchObject({ status: 'completed', source: 'local' })
    expect(job!.result!.transcript).toBe('同步完成。')
    // 建单即终态：不起轮询。
    expect(gateway.getJob).not.toHaveBeenCalled()
  })

  it('silently degrades when the gateway asr is not configured', async () => {
    const gateway: LocalSegmentEngine = {
      createJob: vi.fn().mockRejectedValue(new Error('转写服务请求失败（503）')),
      getJob: vi.fn(),
    }
    const saas = fakeSaas()
    const { uploader } = await createLocalUploader(gateway, saas)
    await uploader.onSegment('rec-1', 0, chunk(1), 5_000, { mimeType: 'audio/webm', mode: 'local' })
    await uploader.onSegment('rec-1', 1, chunk(2), 5_000, { mimeType: 'audio/webm', mode: 'local' })
    // 首段建单失败后整条分段路放弃：后续段不再尝试。
    await vi.waitFor(() => expect(gateway.createJob).toHaveBeenCalledTimes(1))
    // 静默降级：finalize 返回 null（调用方回退停止后整段转），云路未被触碰。
    expect(await uploader.finalize('rec-1')).toBeNull()
    expect(gateway.getJob).not.toHaveBeenCalled()
    expect(saas.createAsrJobShell).not.toHaveBeenCalled()
  })

  it('falls back to null when a local mini fails twice', async () => {
    const gateway = fakeGateway()
    const { uploader } = await createLocalUploader(gateway)
    await uploader.onSegment('rec-1', 0, chunk(1), 5_000, { mimeType: 'audio/webm', mode: 'local' })
    await vi.waitFor(() => expect(gateway.createJob).toHaveBeenCalledTimes(1))
    gateway.fail('gw-1')
    const finishing = uploader.finalize('rec-1')
    // 失败段以新任务重试一次。
    await vi.waitFor(() => expect(gateway.createJob).toHaveBeenCalledTimes(2))
    gateway.fail('gw-2')
    expect(await finishing).toBeNull()
    expect(gateway.createJob).toHaveBeenCalledTimes(2)
  })

  it('routes recordings without a mode to the cloud pipeline (现状不变)', async () => {
    const gateway = fakeGateway()
    const saas = fakeSaas()
    const { uploader } = await createLocalUploader(gateway, saas)
    await uploader.onSegment('rec-1', 0, chunk(1), 5_000, { mimeType: 'audio/webm' })
    await submitted(saas, 1)
    expect(gateway.createJob).not.toHaveBeenCalled()
  })

  it('restores local minis from the manifest after restart for merged queries', async () => {
    const gateway = fakeGateway()
    const { uploader, directory } = await createLocalUploader(gateway)
    await uploader.onSegment('rec-1', 0, chunk(1), 5_000, { mimeType: 'audio/webm', mode: 'local' })
    await uploader.onSegment('rec-1', 1, chunk(2), 5_000, { mimeType: 'audio/webm', mode: 'local' })
    await vi.waitFor(() => expect(gateway.createJob).toHaveBeenCalledTimes(2))
    gateway.complete('gw-1', { transcript: '第一段。', segments: [] })
    gateway.complete('gw-2', { transcript: '第二段。', segments: [] })
    expect(await uploader.finalize('rec-1')).not.toBeNull()
    // 重启：新实例靠 manifest（engine:'local'）找回分段任务并路由到本地引擎。
    const revived = new RecordingSegmentUploader(fakeSaas(), directory, { waitIntervalMs: 10, localEngine: () => gateway, localPollIntervalMs: 5 })
    const merged = await revived.getMergedJob('rec-1')
    expect(merged).toMatchObject({ status: 'completed', source: 'local' })
    expect(merged!.result!.transcript).toBe('第一段。\n第二段。')
    expect(merged!.result!.segments.map((entry) => entry.beginTime)).toEqual([0, 5_000])
  })
})
