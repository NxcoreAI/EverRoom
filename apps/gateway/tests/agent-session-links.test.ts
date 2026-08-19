import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentRun, AgentSession, AgentSessionLink } from '@nxcore/agent-contract'
import { afterEach, describe, expect, it } from 'vitest'

import type { GatewayConfig } from '../src/config.js'
import { createServer } from '../src/server/create-server.js'

const temporaryDirectories: string[] = []

async function testConfig(): Promise<GatewayConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), 'nxcore-agent-link-test-'))
  temporaryDirectories.push(dataDir)
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    databasePath: join(dataDir, 'database', 'gateway.sqlite'),
    migrationsDir: resolve('drizzle'),
    runtimeManifestPath: join(dataDir, 'runtime', 'gateway.json'),
    logLevel: 'silent',
    authToken: 'test-token-0123456789',
    agentRuntime: 'fake',
    memory: null,
    pi: null,
    backgroundPi: null,
    asrInputDir: join(dataDir, 'recordings'),
    asr: null,
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('agent session links', () => {
  it('creates, deduplicates, returns, and cascades a link', async () => {
    const config = await testConfig()
    const app = await createServer(config)
    const headers = { authorization: `Bearer ${config.authToken}` }
    const createSession = async (pageLabel: string, roomId?: string) => (await app.inject({
      method: 'POST',
      url: '/v1/agent/sessions',
      headers,
      payload: { pageLabel, roomId },
    })).json<AgentSession>()

    const source = await createSession('Documents')
    const target = await createSession('Context Room', 'room-1')
    const run = (await app.inject({
      method: 'POST',
      url: `/v1/agent/sessions/${source.id}/runs`,
      headers,
      payload: { prompt: 'Create a document', idempotencyKey: 'link-source-run' },
    })).json<AgentRun>()
    const payload = {
      sourceSessionId: source.id,
      targetSessionId: target.id,
      sourceRunId: run.id,
      sourcePageId: 'docs',
      sourcePageLabel: 'Documents',
      sourceRoomId: null,
      target: {
        pageId: 'rooms',
        title: 'Release notes',
        action: 'created',
        roomId: 'room-1',
        objectId: 'document-1',
        objectType: 'document',
      },
    }
    const created = await app.inject({ method: 'POST', url: '/v1/agent/session-links', headers, payload })
    const duplicate = await app.inject({ method: 'POST', url: '/v1/agent/session-links', headers, payload })
    const link = created.json<AgentSessionLink>()

    expect(created.statusCode).toBe(201)
    expect(duplicate.json<AgentSessionLink>().id).toBe(link.id)
    expect((await app.inject({
      method: 'GET',
      url: `/v1/agent/sessions/${target.id}/links`,
      headers,
    })).json<AgentSessionLink[]>()).toHaveLength(1)

    const returned = await app.inject({
      method: 'POST',
      url: `/v1/agent/session-links/${link.id}/return`,
      headers,
    })
    expect(returned.json<AgentSessionLink>().returnedAt).not.toBeNull()

    await app.inject({ method: 'DELETE', url: `/v1/agent/sessions/${target.id}`, headers })
    expect((await app.inject({
      method: 'GET',
      url: `/v1/agent/sessions/${source.id}/links`,
      headers,
    })).json<AgentSessionLink[]>()).toEqual([])
    await app.close()
  })
})
