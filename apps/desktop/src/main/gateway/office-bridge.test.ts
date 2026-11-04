import { afterEach, describe, expect, it, vi } from 'vitest'

import { OfficeBridgeServer, type OfficeAgentToolsRequest } from './office-bridge'
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

describe('office-apply-bytes：Agent 改写当前打开的 Word/Excel', () => {
  it('把字节交给 registry，并把守卫原因原样回传', async () => {
    const apply = vi.fn(async (_fileId: string, _bytes: Buffer, _hash: string) => ({
      ok: true as const,
      contentHash: 'b'.repeat(64),
    }))
    const server = new OfficeBridgeServer(
      () => null,
      () => undefined,
      () => null,
      () => null,
      () => apply,
    )
    const { baseUrl, token } = await server.start()
    try {
      const response = await fetch(`${baseUrl}/v1/office-apply-bytes`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: 'file-1',
          bytesBase64: Buffer.from('docx-bytes').toString('base64'),
          expectedContentHash: 'a'.repeat(64),
        }),
      })
      expect(response.status).toBe(200)
      expect(apply).toHaveBeenCalledOnce()
      const [fileId, bytes, hash] = apply.mock.calls[0]!
      expect(fileId).toBe('file-1')
      expect(bytes.toString()).toBe('docx-bytes')
      expect(hash).toBe('a'.repeat(64))
      expect((await response.json()).data).toMatchObject({ ok: true, contentHash: 'b'.repeat(64) })
    } finally {
      await server.stop()
    }
  })

  it('未保存修改 → 409 unsaved，由网关转成“先保存”的提示', async () => {
    const server = new OfficeBridgeServer(
      () => null,
      () => undefined,
      () => null,
      () => null,
      () => async () => ({ ok: false as const, reason: 'unsaved' as const, message: '文档有未保存的修改' }),
    )
    const { baseUrl, token } = await server.start()
    try {
      const response = await fetch(`${baseUrl}/v1/office-apply-bytes`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: 'file-1',
          bytesBase64: Buffer.from('x').toString('base64'),
          expectedContentHash: 'a'.repeat(64),
        }),
      })
      expect(response.status).toBe(409)
      expect((await response.json()).data).toMatchObject({ reason: 'unsaved' })
    } finally {
      await server.stop()
    }
  })

  it('未注入写回能力 → 503（工具在网关侧仍按不可用处理）', async () => {
    const server = new OfficeBridgeServer(() => null, () => undefined, () => null, () => null)
    const { baseUrl, token } = await server.start()
    try {
      const response = await fetch(`${baseUrl}/v1/office-apply-bytes`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: 'file-1',
          bytesBase64: Buffer.from('x').toString('base64'),
          expectedContentHash: 'a'.repeat(64),
        }),
      })
      expect(response.status).toBe(503)
    } finally {
      await server.stop()
    }
  })
})

describe('office-agent-tools：后台 Word 会话', () => {
  it('docx not_open 不再广播 open-edit（registry 会后台拉起隐藏编辑会话）', async () => {
    const events: OfficeAgentFileEvent[] = []
    const agentTools = vi.fn(async (_req: OfficeAgentToolsRequest) => ({
      ok: false as const,
      reason: 'not_open' as const,
      message: '后台编辑器未就绪',
      open: [],
    }))
    const fileEntryLookup = vi.fn(async () => fileEntry({ originalName: '报告.docx' }))
    const server = new OfficeBridgeServer(
      () => ({ get: fileEntryLookup, catalogEntry: fileEntryLookup }) as unknown as FilesGatewayBridge,
      (event) => events.push(event),
      () => null,
      () => null,
      () => null,
      () => agentTools,
    )
    const { baseUrl, token } = await server.start()
    try {
      const response = await fetch(`${baseUrl}/v1/office-agent-tools`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'docx',
          mode: 'read',
          fileId: 'file-1',
          roomId: 'room-1',
          workspaceId: 'ws-1',
        }),
      })
      expect(response.status).toBe(422)
      const body = await response.json() as { code?: string; message?: string }
      expect(body.code).toBe('not_open')
      expect(body.message).toContain('后台')
      // Word 不再走“请渲染端开可见页签”的旧兜底：只调一次，不广播 open-edit。
      expect(agentTools).toHaveBeenCalledOnce()
      expect(agentTools.mock.calls[0]![0]).toMatchObject({
        kind: 'docx',
        fileId: 'file-1',
        roomId: 'room-1',
        workspaceId: 'ws-1',
      })
      expect(events).toEqual([])
    } finally {
      await server.stop()
    }
  })
})

describe('office-export-pdf：Word → PDF 并入库', () => {
  it('把 fileId/归属转给桌面导出器，并回传新 PDF fileId', async () => {
    const exportPdf = vi.fn(async (req: {
      fileId: string
      fileName?: string | null
      roomId?: string | null
      workspaceId?: string | null
    }) => ({
      ok: true as const,
      fileId: 'file-pdf-1',
      originalName: req.fileName ?? '报告.pdf',
      contentHash: 'e'.repeat(64),
    }))
    const server = new OfficeBridgeServer(
      () => null,
      () => undefined,
      () => null,
      () => null,
      () => null,
      () => null,
      () => exportPdf,
    )
    const { baseUrl, token } = await server.start()
    try {
      const response = await fetch(`${baseUrl}/v1/office-export-pdf`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: 'file-docx-1',
          fileName: '季度报告.pdf',
          roomId: 'room-1',
          workspaceId: 'ws-1',
        }),
      })
      expect(response.status).toBe(200)
      expect(exportPdf).toHaveBeenCalledWith(expect.objectContaining({
        fileId: 'file-docx-1',
        fileName: '季度报告.pdf',
        roomId: 'room-1',
        workspaceId: 'ws-1',
      }))
      expect((await response.json()).data).toMatchObject({
        ok: true,
        fileId: 'file-pdf-1',
        originalName: '季度报告.pdf',
      })
    } finally {
      await server.stop()
    }
  })

  it('导出器报错 → 422，可读原因回传', async () => {
    const server = new OfficeBridgeServer(
      () => null,
      () => undefined,
      () => null,
      () => null,
      () => null,
      () => null,
      () => async () => ({ ok: false as const, message: '本机未安装 LibreOffice' }),
    )
    const { baseUrl, token } = await server.start()
    try {
      const response = await fetch(`${baseUrl}/v1/office-export-pdf`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: 'file-1' }),
      })
      expect(response.status).toBe(422)
      const body = await response.json() as { code?: string; message?: string }
      expect(body.code).toBe('export_failed')
      expect(body.message).toContain('LibreOffice')
    } finally {
      await server.stop()
    }
  })

  it('未注入导出能力 → 503', async () => {
    const server = new OfficeBridgeServer(() => null, () => undefined, () => null, () => null)
    const { baseUrl, token } = await server.start()
    try {
      const response = await fetch(`${baseUrl}/v1/office-export-pdf`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: 'file-1' }),
      })
      expect(response.status).toBe(503)
    } finally {
      await server.stop()
    }
  })
})
