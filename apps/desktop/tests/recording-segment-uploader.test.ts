import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { AsrJob, AsrResult } from '../src/shared/sources'
import type { SaasClient } from '../src/main/cloud/saas-client'
import { RecordingSegmentUploader } from '../src/main/recording/recording-segment-uploader'

type SaasMock = SaasClient & Record<string, ReturnType<typeof vi.fn>>

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

function fakeSaas(
  resultsByJob: Record<string, AsrJob | AsrJob[]> = {},
  overrides: Partial<Record<'createAsrJobShell' | 'authorizeAsrSegmentUpload' | 'putAsrUpload' | 'completeAsrJobSegments' | 'cancelAsrJob' | 'getAsrJob', ReturnType<typeof vi.fn>>> = {},
): SaasMock {
  let shells = 0
  const queue = new Map<string, AsrJob[]>()
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
      const id = prefixedId.replace(/^saas:/, '')
      const scripted = resultsByJob[id]
      if (!scripted) throw new Error(`no scripted result for ${id}`)
      const queueForJob = queue.get(id) ?? (Array.isArray(scripted) ? [...scripted] : [scripted])
      if (!queue.has(id)) queue.set(id, queueForJob)
      return queueForJob.shift()!
    }),
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
  return { uploader: new RecordingSegmentUploader(saas, directory, { pollIntervalMs: 10 }), directory }
}

const SEG_A = resultOf([segment('第一分钟。', 0, 1000)])
const SEG_B = resultOf([segment('第二分钟。', 500, 900)])

describe('RecordingSegmentUploader', () => {
  it('creates one mini job per segment, merges in index order with offsets', async () => {
    const saas = fakeSaas({ 'job-1': completed('saas:job-1', SEG_A), 'job-2': completed('saas:job-2', SEG_B) })
    const { uploader } = await createUploader(saas)
    await uploader.onSegment('rec-1', 0, chunk(1), 60_000, { mimeType: 'audio/webm', languageHints: ['zh'] })
    await uploader.onSegment('rec-1', 1, chunk(2), 60_000, { mimeType: 'audio/webm' })
    const job = await uploader.finalize('rec-1')
    expect(job).toMatchObject({ id: 'saas-seg:rec-1', status: 'completed' })
    const shells = vi.mocked(saas.createAsrJobShell).mock.calls.map(([input]) => input)
    expect(shells.map((input) => input.idempotencyKey)).toEqual(['recording:rec-1:asr:seg:0', 'recording:rec-1:asr:seg:1'])
    // SaaS 按 recording_id 去重：两个分钟任务必须各持独立派生 UUID。
    expect(shells[0]!.recordingId).not.toBe(shells[1]!.recordingId)
    expect(shells[0]!.recordingId).toMatch(/^[0-9a-f-]{36}$/)
    expect(shells[0]).toMatchObject({ estimatedDurationMs: 60_000, languageHints: ['zh'] })
    // 每个单内部段号都是 0。
    for (const [jobId] of vi.mocked(saas.authorizeAsrSegmentUpload).mock.calls) expect(jobId).toMatch(/^job-\d+$/)
    expect(vi.mocked(saas.completeAsrJobSegments).mock.calls.map(([jobId, segs]) => [jobId, segs.map((entry) => entry.index)]))
      .toEqual([['job-1', [0]], ['job-2', [0]]])
    expect(job!.result!.segments).toEqual([
      { text: '第一分钟。', beginTime: 0, endTime: 1000, speakerId: 'spk_a', speakerName: '说话人1' },
      { text: '第二分钟。', beginTime: 60_500, endTime: 60_900, speakerId: 'spk_a', speakerName: '说话人1' },
    ])
    expect(job!.result!.transcript).toBe('第一分钟。\n第二分钟。')
    expect(saas.cancelAsrJob).not.toHaveBeenCalled()
  })

  it('ignores duplicate and out-of-range segments, and rejects arrivals after finalize', async () => {
    const saas = fakeSaas({
      'job-1': completed('saas:job-1', SEG_A),
      'job-2': completed('saas:job-2', resultOf([segment('第八段。', 0, 800)])),
    })
    const { uploader } = await createUploader(saas)
    await uploader.onSegment('rec-1', 0, chunk(1), 60_000, { mimeType: 'audio/webm' })
    await uploader.onSegment('rec-1', 0, chunk(9), 60_000, { mimeType: 'audio/webm' })
    await uploader.onSegment('rec-1', 7, chunk(3), 60_000, { mimeType: 'audio/webm' })
    await uploader.onSegment('rec-1', 99, chunk(4), 60_000, { mimeType: 'audio/webm' })
    const job = await uploader.finalize('rec-1')
    expect(job).not.toBeNull()
    await uploader.onSegment('rec-1', 2, chunk(5), 60_000, { mimeType: 'audio/webm' })
    // 只有两个合法段各建一次单；finalize 后新段被拒收。
    expect(saas.createAsrJobShell).toHaveBeenCalledTimes(2)
    expect(job!.result!.segments.map((entry) => entry.text)).toEqual(['第一分钟。', '第八段。'])
  })

  it('retries failed uploads during finalize and falls back to null when retries fail', async () => {
    const saas = fakeSaas({}, {
      authorizeAsrSegmentUpload: vi.fn().mockRejectedValue(new Error('network down')),
    })
    const { uploader } = await createUploader(saas)
    await uploader.onSegment('rec-1', 0, chunk(1), 60_000, { mimeType: 'audio/webm' })
    const job = await uploader.finalize('rec-1')
    expect(job).toBeNull()
    // 初次上传失败 + finalize 补试一次。
    expect(saas.authorizeAsrSegmentUpload).toHaveBeenCalledTimes(2)
    expect(saas.cancelAsrJob).toHaveBeenCalledWith('job-1')
    expect(saas.completeAsrJobSegments).not.toHaveBeenCalled()
  })

  it('recovers a segment once authorization succeeds on the finalize retry', async () => {
    let failures = 0
    const saas = fakeSaas({ 'job-1': completed('saas:job-1', SEG_A) }, {
      authorizeAsrSegmentUpload: vi.fn().mockImplementation(async (jobId: string, index: number) => {
        if (failures++ < 1) throw new Error('transient')
        return { uploadUrl: `https://oss.example/put/${jobId}/${index}`, objectKey: `asr-staging/${jobId}/${index}`, headers: {} }
      }),
    })
    const { uploader } = await createUploader(saas)
    await uploader.onSegment('rec-1', 0, chunk(1), 60_000, { mimeType: 'audio/webm' })
    const job = await uploader.finalize('rec-1')
    expect(job).toMatchObject({ id: 'saas-seg:rec-1', status: 'completed' })
    expect(saas.completeAsrJobSegments).toHaveBeenCalledTimes(1)
    expect(saas.cancelAsrJob).not.toHaveBeenCalled()
  })

  it('reauthorizes once when the presigned put expires mid-upload', async () => {
    let puts = 0
    const saas = fakeSaas({ 'job-1': completed('saas:job-1', SEG_A) }, {
      putAsrUpload: vi.fn().mockImplementation(async () => {
        if (puts++ === 0) throw new Error('410 gone')
      }),
    })
    const { uploader } = await createUploader(saas)
    await uploader.onSegment('rec-1', 0, chunk(1), 60_000, { mimeType: 'audio/webm' })
    const job = await uploader.finalize('rec-1')
    expect(job).not.toBeNull()
    expect(saas.authorizeAsrSegmentUpload).toHaveBeenCalledTimes(2)
    expect(saas.putAsrUpload).toHaveBeenCalledTimes(2)
  })

  it('aborts by cancelling every mini job and removing segment files', async () => {
    const saas = fakeSaas({ 'job-1': completed('saas:job-1', SEG_A) })
    const { uploader, directory } = await createUploader(saas)
    await uploader.onSegment('rec-1', 0, chunk(1), 60_000, { mimeType: 'audio/webm' })
    await uploader.onSegment('rec-1', 1, chunk(2), 60_000, { mimeType: 'audio/webm' })
    // 两个分钟任务都已提交（建单完成）后再中止。
    await vi.waitFor(() => expect(saas.createAsrJobShell).toHaveBeenCalledTimes(2))
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
    const running = { ...completed('saas:job-2', SEG_B), status: 'running' as const, result: null }
    const saas = fakeSaas({
      'job-1': completed('saas:job-1', SEG_A),
      'job-2': [running, completed('saas:job-2', SEG_B)],
    })
    const { uploader } = await createUploader(saas)
    await uploader.onSegment('rec-1', 0, chunk(1), 60_000, { mimeType: 'audio/webm' })
    await uploader.onSegment('rec-1', 1, chunk(2), 60_000, { mimeType: 'audio/webm' })
    const job = await uploader.finalize('rec-1')
    expect(job).toMatchObject({ status: 'completed' })
    expect(job!.result!.segments).toHaveLength(2)
    expect(vi.mocked(saas.getAsrJob).mock.calls.filter(([id]) => id === 'saas:job-2')).toHaveLength(2)
  })

  it('recreates a failed mini once with a salted idempotency key, giving up on the second failure', async () => {
    const failed = { ...completed('saas:job-1', SEG_A), status: 'failed' as const, result: null, error: 'boom' }
    const saas = fakeSaas({
      'job-1': failed,
      'job-2': completed('saas:job-2', SEG_B),
      'job-3': completed('saas:job-3', SEG_A),
    })
    const { uploader } = await createUploader(saas)
    await uploader.onSegment('rec-1', 0, chunk(1), 60_000, { mimeType: 'audio/webm' })
    await uploader.onSegment('rec-1', 1, chunk(2), 60_000, { mimeType: 'audio/webm' })
    const job = await uploader.finalize('rec-1')
    expect(job).toMatchObject({ status: 'completed' })
    const shells = vi.mocked(saas.createAsrJobShell).mock.calls.map(([input]) => input)
    expect(shells.map((input) => input.idempotencyKey)).toEqual([
      'recording:rec-1:asr:seg:0',
      'recording:rec-1:asr:seg:1',
      'recording:rec-1:asr:seg:0:r1',
    ])
    expect(saas.cancelAsrJob).toHaveBeenCalledWith('job-1')
  })

  it('emits preview events offset to the recording timeline, using max(declared, spoken) duration', async () => {
    // 第一段声明 60s 但语音到 61.5s：第二段的偏移必须取 61.5s。
    const longA = resultOf([segment('说满了。', 0, 61_500)])
    const saas = fakeSaas({ 'job-1': completed('saas:job-1', longA), 'job-2': completed('saas:job-2', SEG_B) })
    const { uploader } = await createUploader(saas)
    const previews: Array<{ recordingId: string; index: number; result: AsrResult }> = []
    uploader.setPreviewListener((event) => previews.push(event))
    await uploader.onSegment('rec-1', 0, chunk(1), 60_000, { mimeType: 'audio/webm' })
    await uploader.onSegment('rec-1', 1, chunk(2), 60_000, { mimeType: 'audio/webm' })
    const job = await uploader.finalize('rec-1')
    expect(job).not.toBeNull()
    const second = previews.find((event) => event.index === 1)
    expect(second).toBeDefined()
    expect(second!.result.segments[0]).toMatchObject({ beginTime: 61_500 + 500, endTime: 61_500 + 900 })
    expect(job!.result!.segments[1]).toMatchObject({ beginTime: 62_000 })
  })

  it('restores minis from the manifest after restart for rename refetch', async () => {
    const saas = fakeSaas({ 'job-1': completed('saas:job-1', SEG_A), 'job-2': completed('saas:job-2', SEG_B) })
    const { uploader, directory } = await createUploader(saas)
    await uploader.onSegment('rec-1', 0, chunk(1), 60_000, { mimeType: 'audio/webm' })
    await uploader.onSegment('rec-1', 1, chunk(2), 60_000, { mimeType: 'audio/webm' })
    const first = await uploader.finalize('rec-1')
    expect(first).not.toBeNull()
    // 重启：新实例只能靠 manifest 找回分钟任务。
    const revived = new RecordingSegmentUploader(saas, directory, { pollIntervalMs: 10 })
    const renamed = completed('saas:job-1', resultOf([segment('第一分钟。', 0, 1000, { speakerName: '张三' })]))
    vi.mocked(saas.getAsrJob).mockImplementation(async (id: string) => (
      id === 'saas:job-1' ? renamed : completed(id, SEG_B)
    ))
    const refetched = await revived.refetchMerged('rec-1')
    expect(refetched!.anchorJobId).toBe('job-1')
    expect(refetched!.merged.result!.segments[0]).toMatchObject({ speakerName: '张三' })
    expect(refetched!.merged.result!.segments[1]).toMatchObject({ beginTime: 60_500, speakerName: '说话人1' })
    expect(refetched!.merged.updatedAt > first!.updatedAt).toBe(true)
  })
})
