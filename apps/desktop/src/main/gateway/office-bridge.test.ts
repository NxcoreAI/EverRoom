import { afterEach, describe, expect, it, vi } from 'vitest'

import { OfficeBridgeServer } from './office-bridge'
import type { OfficeAgentFileEvent } from '../../shared/office'
import type { FilesGatewayBridge } from './files-gateway-bridge'
import type {
  SlidesEditArtifactOutcome,
  SlidesEditArtifactRequest,
} from '../office/office-preview-registry'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
}))

function fileEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-1',
    originalName: '季度汇报.pptx',
    bytes: 1024,
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    assetKind: 'document',
    originChannel: 'agent',
    visibility: 'private',
    capturedAt: null,
    contentHash: 'abc123',
    parsed: true,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
    storagePath: '/tmp/quarter.pptx',
    currentParsedId: null,
    ...overrides,
  }
}

const notOpen = (): SlidesEditArtifactOutcome => ({
  ok: false,
  reason: 'not_open',
  open: [],
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('office-edit 未打开产物的自动打开重试', () => {
  it('显式 fileId 未打开时广播 open-edit 并重试成功', async () => {
    const events: OfficeAgentFileEvent[] = []
    const slidesEdit = vi.fn<(fileId: string, req: SlidesEditArtifactRequest) => Promise<SlidesEditArtifactOutcome>>()
      .mockImplementationOnce(async () => notOpen())
      .mockImplementationOnce(async () => ({
        ok: true,
        info: { outline: 'deck-outline', opVocabulary: 'vocab', editable: true },
      }))
    const server = new OfficeBridgeServer(
      () => ({ get: async () => fileEntry() }) as unknown as FilesGatewayBridge,
      (event) => events.push(event),
      () => slidesEdit,
    )
    const { baseUrl, token } = await server.start()
    try {
      const response = await fetch(`${baseUrl}/v1/office-edit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'read', fileId: 'file-1' }),
      })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.data.outline).toBe('deck-outline')
      expect(slidesEdit).toHaveBeenCalledTimes(2)
      expect(events).toEqual([{
        type: 'open-edit',
        title: '季度汇报.pptx',
        format: 'pptx',
        fileId: 'file-1',
        originalName: '季度汇报.pptx',
      }])
    } finally {
      await server.stop()
    }
  })

  it('开着的是只读预览（not_editable）同样广播 open-edit 重建可编辑实例后重试', async () => {
    const events: OfficeAgentFileEvent[] = []
    const slidesEdit = vi.fn<(fileId: string, req: SlidesEditArtifactRequest) => Promise<SlidesEditArtifactOutcome>>()
      .mockImplementationOnce(async () => ({ ok: false, reason: 'not_editable', open: [] }))
      .mockImplementationOnce(async () => ({
        ok: true,
        info: { outline: 'deck-outline', opVocabulary: 'vocab', editable: true },
      }))
    const server = new OfficeBridgeServer(
      () => ({ get: async () => fileEntry() }) as unknown as FilesGatewayBridge,
      (event) => events.push(event),
      () => slidesEdit,
    )
    const { baseUrl, token } = await server.start()
    try {
      const response = await fetch(`${baseUrl}/v1/office-edit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'read', fileId: 'file-1' }),
      })
      expect(response.status).toBe(200)
      expect(slidesEdit).toHaveBeenCalledTimes(2)
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('open-edit')
    } finally {
      await server.stop()
    }
  })

  it('fileId 为 active 时保持原报错，不触发自动打开', async () => {
    const events: OfficeAgentFileEvent[] = []
    const slidesEdit = vi.fn<(fileId: string, req: SlidesEditArtifactRequest) => Promise<SlidesEditArtifactOutcome>>()
      .mockImplementation(async () => notOpen())
    const server = new OfficeBridgeServer(
      () => ({ get: async () => fileEntry() }) as unknown as FilesGatewayBridge,
      (event) => events.push(event),
      () => slidesEdit,
    )
    const { baseUrl, token } = await server.start()
    try {
      const response = await fetch(`${baseUrl}/v1/office-edit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'read', fileId: 'active' }),
      })
      expect(response.status).toBe(422)
      const body = await response.json()
      expect(body.code).toBe('not_open')
      expect(body.message).toContain('fileEntryId')
      expect(slidesEdit).toHaveBeenCalledTimes(1)
      expect(events).toEqual([])
    } finally {
      await server.stop()
    }
  })

  it('fileId 不是 Office 产物时不广播，直接报错', async () => {
    const events: OfficeAgentFileEvent[] = []
    const slidesEdit = vi.fn<(fileId: string, req: SlidesEditArtifactRequest) => Promise<SlidesEditArtifactOutcome>>()
      .mockImplementation(async () => notOpen())
    const server = new OfficeBridgeServer(
      () => ({ get: async () => fileEntry({ originalName: 'notes.txt' }) }) as unknown as FilesGatewayBridge,
      (event) => events.push(event),
      () => slidesEdit,
    )
    const { baseUrl, token } = await server.start()
    try {
      const response = await fetch(`${baseUrl}/v1/office-edit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'read', fileId: 'file-1' }),
      })
      expect(response.status).toBe(422)
      const body = await response.json() as { message?: string }
      expect(body.message).toContain('fileEntryId')
      expect(slidesEdit).toHaveBeenCalledTimes(1)
      expect(events).toEqual([])
    } finally {
      await server.stop()
    }
  })
})
