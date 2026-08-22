import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { PrivateRecordEnvelope, ProcessingJob, SaasClient } from '../src/main/cloud/saas-client'
import type { AgentGatewayBridge } from '../src/main/gateway/agent-gateway-bridge'
import { type AccountKeyringService } from '../src/main/security/account-keyring-service'
import { TranscriptionProcessingCoordinator } from '../src/main/transcription/processing-coordinator'

const sourceRecordId = '10000000-0000-4000-8000-000000000001'
const distinctEventId = '30000000-0000-4000-8000-000000000003'

function sourceEnvelope(eventId = sourceRecordId): PrivateRecordEnvelope {
  const payload = {
    kind: 'everroom.transcription-source',
    schemaVersion: 3,
    eventId,
    detailMarkdown: '# 转写结果\n\n不能泄露的原始转写',
    transcriptLines: [{ speaker: '张三', startOffsetMillis: 0, text: '不能泄露的原始转写' }],
  }
  return {
    cursor: 1,
    operation: 'upsert',
    recordId: sourceRecordId,
    recordType: 'transcription_source',
    schemaVersion: 3,
    payload,
    contentHash: `sha256:${'a'.repeat(64)}`,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function job(envelope: PrivateRecordEnvelope): ProcessingJob {
  return {
    id: '20000000-0000-4000-8000-000000000002',
    workflow: 'transcription.summary.v1',
    workflowVersion: 1,
    sourceRecordId,
    sourceRevision: 1,
    sourceContentHash: envelope.contentHash!,
    status: 'leased',
    attemptCount: 0,
    maxAttempts: 5,
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    resultRecordId: null,
    lastErrorCode: null,
    lastErrorClass: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
  }
}

function dependencies(complete = vi.fn(async () => undefined)) {
  const envelope = sourceEnvelope()
  const processingJob = job(envelope)
  const client = {
    status: vi.fn(async () => ({ authenticated: true, user: { id: 'user' }, device: { id: 'device' } })),
    registerProcessorDevice: vi.fn(async () => undefined),
    claimProcessingJob: vi.fn(async () => ({ job: processingJob, leaseToken: 'x'.repeat(43) })),
    startProcessingJob: vi.fn(async () => processingJob),
    renewProcessingJob: vi.fn(async () => processingJob),
    getPrivateRecord: vi.fn(async () => envelope),
    completeProcessingJob: complete,
    failProcessingJob: vi.fn(async () => undefined),
  }
  const keyring = {}
  const agent = {
    summarizeTranscription: vi.fn(async () => ({ content: JSON.stringify({
      eventType: 'MEETING',
      title: '周会',
      overview: '讨论了发布计划。',
      keyPoints: ['确认范围'],
      decisions: [],
      actionItems: [{ text: '准备发布', owner: null, dueDate: null }],
      unresolvedQuestions: ['发布日期仍待确认'],
      topics: ['发布'],
      representativeTags: [
        { kind: 'entity', label: 'EverRoom', entityType: 'product', confidence: 0.98, evidence: '讨论了 EverRoom 发布计划' },
        { kind: 'fact', label: 'EverRoom 准备发布', subject: 'EverRoom', predicate: '准备', object: '发布', confidence: 0.9, evidence: '准备发布' },
      ],
    }) })),
  }
  return { client, keyring, agent }
}

async function processOne(coordinator: TranscriptionProcessingCoordinator) {
  await (coordinator as unknown as { processOne(): Promise<void> }).processOne()
}

describe('TranscriptionProcessingCoordinator', () => {
  it('claims, reads, summarizes and completes a SaaS job with plaintext', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-processing-'))
    const statePath = join(directory, 'state.json')
    const { client, keyring, agent } = dependencies()
    const coordinator = new TranscriptionProcessingCoordinator(statePath, client as unknown as SaasClient, keyring as unknown as AccountKeyringService, agent as unknown as AgentGatewayBridge)

    await processOne(coordinator)

    expect(client.registerProcessorDevice).toHaveBeenCalledOnce()
    expect(client.startProcessingJob).toHaveBeenCalledOnce()
    expect(agent.summarizeTranscription).toHaveBeenCalledWith(expect.objectContaining({
      transcript: expect.stringContaining('不能泄露的原始转写'),
    }))
    expect(client.completeProcessingJob).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      payload: expect.objectContaining({
        kind: 'everroom.transcription-summary',
        summary: expect.objectContaining({
          eventType: 'MEETING',
          unresolvedQuestions: ['发布日期仍待确认'],
          representativeTags: expect.arrayContaining([expect.objectContaining({ kind: 'fact', subject: 'EverRoom' })]),
        }),
      }),
      leaseToken: 'x'.repeat(43),
    }))
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ version: 1, jobs: {} })
  })

  it('still processes a summary when record sync is temporarily unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-processing-'))
    const { client, keyring, agent } = dependencies()
    const sync = {
      reconcileLocalTranscriptions: vi.fn(async () => { throw new Error('sync_unavailable') }),
      flushPendingSources: vi.fn(async () => undefined),
      sync: vi.fn(async () => { throw new Error('sync_unavailable') }),
    }
    const coordinator = new TranscriptionProcessingCoordinator(
      join(directory, 'state.json'),
      client as unknown as SaasClient,
      keyring as unknown as AccountKeyringService,
      agent as unknown as AgentGatewayBridge,
      sync as never,
    )

    await processOne(coordinator)

    expect(client.registerProcessorDevice).toHaveBeenCalledOnce()
    expect(client.completeProcessingJob).toHaveBeenCalledOnce()
  })

  it('processes a source whose record and Reality event use different IDs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-processing-'))
    const { client, keyring, agent } = dependencies()
    client.getPrivateRecord.mockResolvedValueOnce(sourceEnvelope(distinctEventId))
    const coordinator = new TranscriptionProcessingCoordinator(join(directory, 'state.json'), client as unknown as SaasClient, keyring as unknown as AccountKeyringService, agent as unknown as AgentGatewayBridge)

    await processOne(coordinator)

    expect(agent.summarizeTranscription).toHaveBeenCalledOnce()
    expect(client.completeProcessingJob).toHaveBeenCalledOnce()
  })

  it('keeps legacy Agent summaries compatible when tags are absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-processing-'))
    const { client, keyring, agent } = dependencies()
    agent.summarizeTranscription.mockResolvedValueOnce({ content: JSON.stringify({
      title: '旧版总结', overview: '旧版总结仍然有效。', keyPoints: ['兼容旧协议'], decisions: [], actionItems: [], topics: [],
    }) })
    const coordinator = new TranscriptionProcessingCoordinator(join(directory, 'state.json'), client as unknown as SaasClient, keyring as unknown as AccountKeyringService, agent as unknown as AgentGatewayBridge)

    await processOne(coordinator)

    expect(client.completeProcessingJob).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      payload: expect.objectContaining({ summary: expect.objectContaining({
        eventType: 'OTHER',
        unresolvedQuestions: [],
        representativeTags: [],
      }) }),
    }))
  })

  it('keeps a valid summary when an entity type is outside the preferred enum', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-processing-'))
    const { client, keyring, agent } = dependencies()
    agent.summarizeTranscription.mockResolvedValueOnce({ content: JSON.stringify({
      eventType: 'WORK',
      title: '客户交付准备',
      overview: '团队正在准备客户交付。',
      keyPoints: ['确认交付材料'],
      decisions: [],
      actionItems: [],
      unresolvedQuestions: [],
      topics: ['客户交付'],
      representativeTags: [
        { kind: 'entity', label: '客户团队', entityType: 'company', confidence: 0.8, evidence: '客户团队' },
      ],
    }) })
    const coordinator = new TranscriptionProcessingCoordinator(join(directory, 'state.json'), client as unknown as SaasClient, keyring as unknown as AccountKeyringService, agent as unknown as AgentGatewayBridge)

    await processOne(coordinator)

    expect(client.completeProcessingJob).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      payload: expect.objectContaining({
        summary: expect.objectContaining({
          representativeTags: [expect.objectContaining({ entityType: 'other' })],
        }),
      }),
    }))
  })

  it('retries a medium transcript when the Agent returns an under-detailed summary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-processing-'))
    const { client, keyring, agent } = dependencies()
    const envelope = sourceEnvelope()
    envelope.payload = {
      ...(envelope.payload as Record<string, unknown>),
      transcriptLines: [{ speaker: '张三', startOffsetMillis: 0, text: '这是一段包含多个议题、讨论过程、理由、限制条件和后续安排的有效转写。'.repeat(15) }],
    }
    client.getPrivateRecord.mockResolvedValueOnce(envelope)
    agent.summarizeTranscription.mockResolvedValueOnce({ content: JSON.stringify({
      eventType: 'MEETING',
      title: '过于简略的会议总结',
      overview: '讨论了多个议题。',
      keyPoints: ['进行了讨论'],
      decisions: [],
      actionItems: [],
      unresolvedQuestions: [],
      topics: ['测试议题'],
      representativeTags: [],
    }) })
    const coordinator = new TranscriptionProcessingCoordinator(join(directory, 'state.json'), client as unknown as SaasClient, keyring as unknown as AccountKeyringService, agent as unknown as AgentGatewayBridge)

    await expect(processOne(coordinator)).rejects.toThrow('incomplete_agent_summary')

    expect(client.completeProcessingJob).not.toHaveBeenCalled()
    expect(client.failProcessingJob).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      errorCode: 'incomplete_agent_summary',
      errorClass: 'retryable',
    }))
  })

  it('keeps a plaintext summary outbox when completion is temporarily unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-processing-'))
    const statePath = join(directory, 'state.json')
    const complete = vi.fn(async () => { throw new Error('network_unavailable') })
    const { client, keyring, agent } = dependencies(complete)
    const coordinator = new TranscriptionProcessingCoordinator(statePath, client as unknown as SaasClient, keyring as unknown as AccountKeyringService, agent as unknown as AgentGatewayBridge)

    await expect(processOne(coordinator)).rejects.toThrow('network_unavailable')

    const persisted = await readFile(statePath, 'utf8')
    expect(persisted).toContain('everroom.transcription-summary')
    expect(persisted).not.toContain('ciphertext')
    expect(client.failProcessingJob).not.toHaveBeenCalled()
  })

  it('rejects a placeholder title even when the summary has content and returns the job for retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-processing-'))
    const { client, keyring, agent } = dependencies()
    agent.summarizeTranscription.mockResolvedValueOnce({ content: JSON.stringify({
      title: '后台转写总结',
      overview: '这是一段已经生成的概览。',
      keyPoints: ['这是一条已经生成的要点。'],
      decisions: [],
      actionItems: [],
      topics: [],
    }) })
    const coordinator = new TranscriptionProcessingCoordinator(join(directory, 'state.json'), client as unknown as SaasClient, keyring as unknown as AccountKeyringService, agent as unknown as AgentGatewayBridge)

    await expect(processOne(coordinator)).rejects.toThrow('empty_agent_summary')

    expect(client.completeProcessingJob).not.toHaveBeenCalled()
    expect(client.failProcessingJob).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      errorCode: 'empty_agent_summary',
      errorClass: 'retryable',
    }))
  })
})
