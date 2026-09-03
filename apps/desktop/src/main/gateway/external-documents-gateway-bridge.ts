import type {
  AgentDocumentExportRunView,
  CanonicalDocumentArtifact,
  DocumentImportCommentDiffSummary,
  DocumentImportHistoryEntry,
  DocumentImportRunView,
  ExternalDocumentPreview,
  ExternalDocumentProvider,
  ExternalDocumentSearchResponse,
  AgentDocumentExportTarget,
  AgentDocumentExportMode,
} from '@nxcore/agent-contract'
import type { GatewaySupervisor } from './gateway-supervisor'

/**
 * 外部文档导入（飞书/Notion，OpenConnector 读）与 Agent 一次性导出的网关桥。
 * 只做结构化 DTO 的透传；授权挑战与 token 永不经过本桥（见 agent-auth 控制器）。
 */
export class ExternalDocumentsGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  async importSearch(provider: ExternalDocumentProvider, query: string): Promise<ExternalDocumentSearchResponse> {
    return this.request('/v1/document-import/search', {
      method: 'POST',
      body: JSON.stringify({ provider, query }),
    })
  }

  async importPreview(provider: ExternalDocumentProvider, remoteDocumentId: string): Promise<ExternalDocumentPreview> {
    return this.request('/v1/document-import/preview', {
      method: 'POST',
      body: JSON.stringify({ provider, remoteDocumentId }),
    })
  }

  async importCommit(input: { runId: string; roomId: string; targetDocumentId?: string }): Promise<{
    run: DocumentImportRunView
    roomImportId: string
    relation: 'primary' | 'candidate'
    documentId: string
  }> {
    return this.request('/v1/document-import/runs', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  async importRun(runId: string): Promise<DocumentImportRunView> {
    return this.request(`/v1/document-import/runs/${encodeURIComponent(runId)}`)
  }

  async cancelImportRun(runId: string): Promise<DocumentImportRunView> {
    return this.request(`/v1/document-import/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
  }

  async importHistory(roomId: string, documentId: string): Promise<{
    entries: DocumentImportHistoryEntry[]
    commentDiff: DocumentImportCommentDiffSummary | null
  }> {
    return this.request(
      `/v1/rooms/${encodeURIComponent(roomId)}/documents/${encodeURIComponent(documentId)}/import-history`,
    )
  }

  async checkExternalUpdate(roomId: string, documentId: string): Promise<{
    run: DocumentImportRunView
    roomImportId: string
    relation: 'primary' | 'candidate'
    documentId: string
  }> {
    return this.request(
      `/v1/rooms/${encodeURIComponent(roomId)}/documents/${encodeURIComponent(documentId)}/check-external-update`,
      { method: 'POST' },
    )
  }

  async applyCandidate(roomImportId: string): Promise<{ documentId: string; version: number }> {
    return this.request(`/v1/document-import/room-imports/${encodeURIComponent(roomImportId)}/apply`, {
      method: 'POST',
    })
  }

  async createExport(input: {
    roomId: string
    documentId: string
    version?: number
    provider: ExternalDocumentProvider
    mode: AgentDocumentExportMode
    target?: AgentDocumentExportTarget | null
  }): Promise<AgentDocumentExportRunView> {
    return this.request('/v1/agent/document-exports', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  async getExport(exportId: string): Promise<AgentDocumentExportRunView> {
    return this.request(`/v1/agent/document-exports/${encodeURIComponent(exportId)}`)
  }

  async confirmExport(exportId: string): Promise<AgentDocumentExportRunView> {
    return this.request(`/v1/agent/document-exports/${encodeURIComponent(exportId)}/confirm`, { method: 'POST' })
  }

  async retryExport(exportId: string): Promise<AgentDocumentExportRunView> {
    return this.request(`/v1/agent/document-exports/${encodeURIComponent(exportId)}/retry`, { method: 'POST' })
  }

  async cancelExport(exportId: string): Promise<AgentDocumentExportRunView> {
    return this.request(`/v1/agent/document-exports/${encodeURIComponent(exportId)}/cancel`, { method: 'POST' })
  }

  async listExports(documentId?: string): Promise<{ items: AgentDocumentExportRunView[] }> {
    const query = documentId ? `?documentId=${encodeURIComponent(documentId)}` : ''
    return this.request(`/v1/agent/document-exports${query}`)
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const connection = this.supervisor.getConnection()
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(init?.body !== undefined && init.body !== null ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null
      const message = typeof body?.message === 'string' ? body.message : `外部文档请求失败（${response.status}）`
      throw new Error(typeof body?.error === 'string' ? `${body.error}: ${message}` : message)
    }
    return response.json() as Promise<T>
  }
}

export type { CanonicalDocumentArtifact }
