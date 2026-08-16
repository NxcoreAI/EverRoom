import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { PrivateRecordEnvelope, ProcessingJob, SaasClient } from '../src/main/cloud/saas-client'
import type { AgentGatewayBridge } from '../src/main/gateway/agent-gateway-bridge'
import { combinedEncrypt, keyId, type AccountKeyringService } from '../src/main/security/account-keyring-service'
import { TranscriptionProcessingCoordinator } from '../src/main/transcription/processing-coordinator'

const umk = Buffer.alloc(32, 7)
const umkId = keyId(umk)
const sourceRecordId = '10000000-0000-4000-8000-000000000001'

function sourceEnvelope(): PrivateRecordEnvelope {
  const dataKey = randomBytes(32)
  const dataKeyId = keyId(dataKey)
  const plaintext = Buffer.from(JSON.stringify({
    kind: 'everroom.transcription-source',
    schemaVersion: 3,
    eventId: sourceRecordId,
    detailMarkdown: '# 转写结果\n\n不能泄露的原始转写',
    transcriptLines: [{ speaker: '张三', startOffsetMillis: 0, text: '不能泄露的原始转写' }],
  }))
  const ciphertext = combinedEncrypt(dataKey, plaintext, Buffer.from(`everroom.private-record.v3:${sourceRecordId}:${dataKeyId}:${umkId}:1`))
  return {
    cursor: 1,
    operation: 'upsert',
    recordId: sourceRecordId,
    recordType: 'transcription_source',
    algorithm: 'AES-256-GCM',
    schemaVersion: 3,
    keyId: dataKeyId,
    ciphertext,
    contentHash: `sha256:${createHash('sha256').update(ciphertext).digest('hex')}`,
    wrappingAlgorithm: 'AES-256-GCM',
    wrappingKeyId: umkId,
    wrappingKeyVersion: 1,
    wrappedKey: combinedEncrypt(umk, dataKey, Buffer.from(`everroom.wrapped-dek.v1:${sourceRecordId}:${dataKeyId}:${umkId}:1`)),
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
  const keyring = {
    status: vi.fn(async () => ({ enabled: true, deviceStatus: 'ready', umkId, activeVersion: 1 })),
    getUmk: vi.fn(async () => ({ value: umk, umkId, version: 1 })),
  }
  const agent = {
    summarizeTranscription: vi.fn(async () => ({ content: JSON.stringify({
      title: '周会',
      overview: '讨论了发布计划。',
      keyPoints: ['确认范围'],
      decisions: [],
      actionItems: [{ text: '准备发布', owner: null, dueDate: null }],
      topics: ['发布'],
    }) })),
  }
  return { client, keyring, agent }
}

async function processOne(coordinator: TranscriptionProcessingCoordinator) {
  await (coordinator as unknown as { processOne(): Promise<void> }).processOne()
}

describe('TranscriptionProcessingCoordinator', () => {
  it('claims, decrypts, summarizes, encrypts and completes a SaaS job', async () => {
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
      algorithm: 'AES-256-GCM',
      schemaVersion: 3,
      wrappingKeyId: umkId,
      leaseToken: 'x'.repeat(43),
    }))
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ version: 1, jobs: {} })
  })

  it('keeps only encrypted outbox data when completion is temporarily unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-processing-'))
    const statePath = join(directory, 'state.json')
    const complete = vi.fn(async () => { throw new Error('network_unavailable') })
    const { client, keyring, agent } = dependencies(complete)
    const coordinator = new TranscriptionProcessingCoordinator(statePath, client as unknown as SaasClient, keyring as unknown as AccountKeyringService, agent as unknown as AgentGatewayBridge)

    await expect(processOne(coordinator)).rejects.toThrow('network_unavailable')

    const persisted = await readFile(statePath, 'utf8')
    expect(persisted).not.toContain('不能泄露的原始转写')
    expect(persisted).toContain('ciphertext')
    expect(client.failProcessingJob).not.toHaveBeenCalled()
  })
})
