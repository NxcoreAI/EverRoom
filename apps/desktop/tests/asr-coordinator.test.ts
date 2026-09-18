import { describe, expect, it, vi } from 'vitest'

import type { AsrJob } from '../src/shared/sources'
import { AsrCoordinator } from '../src/main/asr/asr-coordinator'

function makeJob(): AsrJob {
  return {
    id: 'saas:11111111-1111-4111-8111-111111111111',
    source: 'saas',
    provider: 'nxcore',
    status: 'completed',
    fileName: 'a.m4a',
    languageHints: [],
    diarizationEnabled: true,
    contextPrompt: '',
    result: { transcript: '你好。', segments: [{ text: '你好。', beginTime: 0, endTime: 1_000, speakerId: 'spk_a', speakerName: '张三' }] },
    error: null,
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:01:00.000Z',
  }
}

function makeDeps() {
  const job = makeJob()
  const cloud = {
    renameAsrSpeaker: vi.fn().mockResolvedValue(undefined),
    getAsrJob: vi.fn().mockResolvedValue(job),
    createAsrJob: vi.fn().mockResolvedValue(job),
  }
  const applyVersions: Array<number | undefined> = []
  const reality = {
    applyAsrByJob: vi.fn().mockImplementation((_job: AsrJob, version?: number) => {
      applyVersions.push(version)
      return Promise.resolve({ id: 'event-1' })
    }),
  }
  const transcriptionSync = { publishLocalTranscription: vi.fn().mockResolvedValue(undefined) }
  const coordinator = new AsrCoordinator({} as never, cloud as never, reality as never, undefined, transcriptionSync as never)
  return { cloud, reality, transcriptionSync, applyVersions, coordinator }
}

describe('AsrCoordinator.renameSpeaker', () => {
  it('renames on the cloud, refetches, re-applies with a bumped version and republishes', async () => {
    const { cloud, applyVersions, transcriptionSync, coordinator } = makeDeps()
    const before = Date.now()
    const job = await coordinator.renameSpeaker('saas:11111111-1111-4111-8111-111111111111', 'spk_a', '张三')
    expect(cloud.renameAsrSpeaker).toHaveBeenCalledWith('saas:11111111-1111-4111-8111-111111111111', 'spk_a', '张三')
    expect(cloud.getAsrJob).toHaveBeenCalledWith('saas:11111111-1111-4111-8111-111111111111')
    expect(job.result?.segments[0]).toMatchObject({ speakerId: 'spk_a', speakerName: '张三' })
    // SaaS 改名不推进 job.updatedAt，本地回写必须用当前时间顶高 resultVersion，否则会被版本守卫跳过。
    expect(applyVersions[0]).toBeGreaterThanOrEqual(before)
    expect(transcriptionSync.publishLocalTranscription).toHaveBeenCalledTimes(1)
  })

  it('still returns the refreshed job when the local reality event cannot be updated', async () => {
    const { reality, transcriptionSync, coordinator } = makeDeps()
    ;(reality.applyAsrByJob as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('gateway down'))
    const job = await coordinator.renameSpeaker('saas:11111111-1111-4111-8111-111111111111', 'spk_a', null)
    expect(job.status).toBe('completed')
    expect(transcriptionSync.publishLocalTranscription).not.toHaveBeenCalled()
  })

  it('rejects local jobs outright', async () => {
    const { cloud, coordinator } = makeDeps()
    await expect(coordinator.renameSpeaker('local-job-1', 'spk_a', '张三')).rejects.toThrow()
    expect(cloud.renameAsrSpeaker).not.toHaveBeenCalled()
  })
})

function makeSegmentedJob(): AsrJob {
  return { ...makeJob(), id: 'saas-seg:rec-1' }
}

function makeSegmentDeps(finalize: AsrJob | null = makeSegmentedJob()) {
  const deps = makeDeps()
  const uploader = {
    finalize: vi.fn().mockResolvedValue(finalize),
    getMergedJob: vi.fn().mockResolvedValue(finalize),
    refetchMerged: vi.fn().mockResolvedValue({ merged: makeSegmentedJob(), anchorJobId: 'job-1' }),
  }
  ;(deps.reality as Record<string, unknown>).applyAsr = vi.fn().mockResolvedValue({ id: 'event-1' })
  const audioSync = { upload: vi.fn().mockResolvedValue(undefined) }
  const coordinator = new AsrCoordinator(
    {} as never, deps.cloud as never, deps.reality as never, audioSync as never, deps.transcriptionSync as never, uploader as never,
  )
  return { ...deps, uploader, audioSync, coordinator }
}

describe('AsrCoordinator segmented (saas-seg:) routing', () => {
  it('getJob routes to the uploader and never touches cloud.getAsrJob', async () => {
    const { cloud, uploader, reality, transcriptionSync, coordinator } = makeSegmentDeps()
    const job = await coordinator.getJob('saas-seg:rec-1')
    expect(job.id).toBe('saas-seg:rec-1')
    expect(uploader.getMergedJob).toHaveBeenCalledWith('rec-1')
    expect(cloud.getAsrJob).not.toHaveBeenCalled()
    expect((reality.applyAsrByJob as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(job)
    expect(transcriptionSync.publishLocalTranscription).toHaveBeenCalledTimes(1)
  })

  it('getJob throws when the uploader has no state for the recording', async () => {
    const { coordinator } = makeSegmentDeps(null)
    await expect(coordinator.getJob('saas-seg:rec-1')).rejects.toThrow('转写任务不存在或已过期。')
  })

  it('createJob finalizes minis, publishes once and never awaits the private audio backup', async () => {
    const neverSettles = new Promise<void>(() => {})
    const { cloud, uploader, audioSync, reality, transcriptionSync, coordinator } = makeSegmentDeps()
    audioSync.upload.mockReturnValue(neverSettles)
    const job = await coordinator.createJob({ mode: 'cloud', filePath: '/tmp/a.webm', recordingId: 'rec-1', durationMs: 120_000 } as never)
    expect(job.id).toBe('saas-seg:rec-1')
    expect(uploader.finalize).toHaveBeenCalledWith('rec-1')
    // 备份转入后台：createJob 在备份 promise 永不 settle 的情况下照常返回。
    expect(audioSync.upload).toHaveBeenCalledTimes(1)
    expect(cloud.createAsrJob).not.toHaveBeenCalled()
    expect((reality.applyAsr as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('rec-1', job)
    expect(transcriptionSync.publishLocalTranscription).toHaveBeenCalledTimes(1)
  })

  it('createJob falls back to a whole-file upload with retryToken seg-fallback when finalize fails', async () => {
    const fallback = makeJob()
    const { cloud, reality, transcriptionSync, coordinator } = makeSegmentDeps(null)
    cloud.createAsrJob.mockResolvedValue(fallback)
    const job = await coordinator.createJob({ mode: 'cloud', filePath: '/tmp/a.webm', recordingId: 'rec-1', durationMs: 120_000 } as never)
    expect(job.id).toBe(fallback.id)
    expect(cloud.createAsrJob).toHaveBeenCalledWith(expect.objectContaining({ retryToken: 'seg-fallback' }))
    expect((reality.applyAsr as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('rec-1', fallback)
    expect(transcriptionSync.publishLocalTranscription).toHaveBeenCalledTimes(1)
  })

  it('renameSpeaker renames via the anchor job and re-applies the refetched merge', async () => {
    const renamed = { ...makeSegmentedJob(), result: { transcript: '你好。', segments: [{ text: '你好。', beginTime: 0, endTime: 1_000, speakerId: 'spk_a', speakerName: '李四' }] } }
    const { cloud, uploader, reality, transcriptionSync, coordinator } = makeSegmentDeps()
    uploader.refetchMerged.mockResolvedValue({ merged: renamed, anchorJobId: 'job-2' })
    const job = await coordinator.renameSpeaker('saas-seg:rec-1', 'spk_a', '李四')
    expect(cloud.renameAsrSpeaker).toHaveBeenCalledWith('saas:job-2', 'spk_a', '李四')
    expect(uploader.refetchMerged).toHaveBeenCalledTimes(2)
    expect(job.result?.segments[0]).toMatchObject({ speakerName: '李四' })
    // 分段改名走 applyAsr(recordingId, merged)——merge 的 updatedAt 现取，天然顶高版本守卫。
    expect((reality.applyAsr as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('rec-1', renamed)
    expect(transcriptionSync.publishLocalTranscription).toHaveBeenCalledTimes(1)
  })

  it('renameSpeaker refuses when no mini has finished yet', async () => {
    const { cloud, uploader, coordinator } = makeSegmentDeps()
    uploader.refetchMerged.mockResolvedValue({ merged: makeSegmentedJob(), anchorJobId: null })
    await expect(coordinator.renameSpeaker('saas-seg:rec-1', 'spk_a', '张三')).rejects.toThrow('分段转写尚未完成')
    expect(cloud.renameAsrSpeaker).not.toHaveBeenCalled()
  })
})
