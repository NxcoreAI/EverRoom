import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { DocumentGatewayBridge } from '../src/main/gateway/document-gateway-bridge'
import type { GatewaySupervisor } from '../src/main/gateway/gateway-supervisor'

const servers: Array<ReturnType<typeof createServer>> = []

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
})

describe('DocumentGatewayBridge CRUD', () => {
  it('sends JSON headers only for requests with bodies and supports a full CRUD cycle', async () => {
    const requests: Array<{ method: string; path: string; contentType?: string; body: string }> = []
    let version = 1
    let contentJson: Record<string, unknown> = { type: 'doc', content: [] }
    const document = () => ({
      id: 'doc-crud',
      roomId: 'room-crud',
      title: 'CRUD 文档',
      contentJson,
      version,
      status: 'active',
      activeTransactionId: null,
      deletedAt: null,
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z',
    })
    const server = createServer(async (request, response) => {
      const requestBody = await body(request)
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        ...(request.headers['content-type'] ? { contentType: request.headers['content-type'] } : {}),
        body: requestBody,
      })
      if (request.headers.authorization !== 'Bearer test-token') return json(response, 401, {})
      if (request.method === 'POST') return json(response, 200, document())
      if (request.method === 'PUT') {
        const input = JSON.parse(requestBody) as { contentJson: Record<string, unknown> }
        contentJson = input.contentJson
        version += 1
        return json(response, 200, document())
      }
      if (request.method === 'DELETE') {
        response.writeHead(204)
        return response.end()
      }
      if (request.url?.startsWith('/v1/documents?')) return json(response, 200, [document()])
      return json(response, 200, document())
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const supervisor = {
      getConnection: () => ({ pid: 1, baseUrl: `http://127.0.0.1:${String(port)}`, token: 'test-token', version: 'test' }),
    } as GatewaySupervisor
    const bridge = new DocumentGatewayBridge(supervisor)

    await bridge.import({ id: 'doc-crud', roomId: 'room-crud', title: 'CRUD 文档', contentJson })
    await expect(bridge.list('room-crud')).resolves.toHaveLength(1)
    await expect(bridge.listTrash('room-crud')).resolves.toHaveLength(1)
    await expect(bridge.get('doc-crud')).resolves.toMatchObject({ id: 'doc-crud', version: 1 })
    await bridge.listBlocks('doc-crud')
    await bridge.resolveBlockReferences({
      sourceRoomId: 'room-crud',
      references: [{ roomId: 'room-crud', documentId: 'doc-crud', blockId: 'block-1' }],
    })
    await bridge.listPatches('doc-crud', 'pending')
    await bridge.getPatch('patch-1')
    await bridge.applyPatch('patch-1', { baseVersion: 1, acceptedHunkIds: ['hunk-1'] })
    await bridge.rejectPatch('patch-2')
    await bridge.acceptContinuationBlock('patch-3', { baseVersion: 1, blockId: 'block-1' })
    await bridge.rejectContinuationBlock('patch-3', { baseVersion: 2, blockId: 'block-2' })
    await bridge.closeContinuation('patch-3')
    await expect(bridge.save('doc-crud', {
      baseVersion: 1,
      contentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
    })).resolves.toMatchObject({ version: 2 })
    await expect(bridge.delete('doc-crud')).resolves.toBeUndefined()
    await expect(bridge.restore('doc-crud')).resolves.toMatchObject({ id: 'doc-crud' })
    await expect(bridge.deletePermanently('doc-crud')).resolves.toBeUndefined()
    await expect(bridge.emptyTrash('room-crud')).resolves.toBeUndefined()

    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ['POST', '/v1/documents/import'],
      ['GET', '/v1/documents?roomId=room-crud'],
      ['GET', '/v1/documents?roomId=room-crud&trashed=true'],
      ['GET', '/v1/documents/doc-crud'],
      ['GET', '/v1/documents/doc-crud/blocks'],
      ['POST', '/v1/document-blocks/resolve'],
      ['GET', '/v1/document-patches?documentId=doc-crud&status=pending'],
      ['GET', '/v1/document-patches/patch-1'],
      ['POST', '/v1/document-patches/patch-1/apply'],
      ['POST', '/v1/document-patches/patch-2/reject'],
      ['POST', '/v1/document-patches/patch-3/continuation/accept'],
      ['POST', '/v1/document-patches/patch-3/continuation/reject'],
      ['POST', '/v1/document-patches/patch-3/continuation/close'],
      ['PUT', '/v1/documents/doc-crud'],
      ['DELETE', '/v1/documents/doc-crud'],
      ['POST', '/v1/documents/doc-crud/restore'],
      ['DELETE', '/v1/documents/doc-crud/permanent'],
      ['DELETE', '/v1/documents/trash?roomId=room-crud'],
    ])
    expect(requests[0]).toMatchObject({ contentType: 'application/json', body: expect.stringContaining('doc-crud') })
    expect(requests[1]).toMatchObject({ body: '' })
    expect(requests[1]).not.toHaveProperty('contentType')
    expect(requests[2]).not.toHaveProperty('contentType')
    expect(requests[3]).not.toHaveProperty('contentType')
    expect(requests[5]).toMatchObject({ contentType: 'application/json', body: expect.stringContaining('sourceRoomId') })
    expect(requests[8]).toMatchObject({ contentType: 'application/json', body: expect.stringContaining('acceptedHunkIds') })
    expect(requests[10]).toMatchObject({ contentType: 'application/json', body: expect.stringContaining('blockId') })
    expect(requests[11]).toMatchObject({ contentType: 'application/json', body: expect.stringContaining('baseVersion') })
    expect(requests[13]).toMatchObject({ contentType: 'application/json', body: expect.stringContaining('baseVersion') })
    for (const index of [4, 6, 7, 9, 12, 14, 15, 16, 17]) {
      expect(requests[index]).toMatchObject({ body: '' })
      expect(requests[index]).not.toHaveProperty('contentType')
    }
  })
})
