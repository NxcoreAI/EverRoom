import type {
  ExternalDocumentProjectionBinding,
  ExternalDocumentSourceKind,
  SyncExternalDocumentProjectionInput,
} from '@nxcore/agent-contract'
import type { GatewaySupervisor } from './gateway-supervisor'

/**
 * 文稿（documents）网关桥的残余面（2026-11 文稿 UI 下线后）。
 *
 * Markdown 文稿的 CRUD / 操作 / 订阅 IPC 随 context-room UI 一并移除；本桥只保留
 * Obsidian Vault 投影链路需要的两个方法（sources 页的目录笔记投影：
 * `projectRoomVault` / vault 移除清理，见 main/index.ts 的 vault 事件处理）。
 * 网关侧 /v1/external-document-projections 路由仍在服务。
 */
export class DocumentGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  syncExternalProjection(input: SyncExternalDocumentProjectionInput): Promise<ExternalDocumentProjectionBinding> {
    return this.request(
      `/v1/external-document-projections/${input.sourceKind}/${encodeURIComponent(input.sourceId)}/${encodeURIComponent(input.resourceId)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          roomId: input.roomId,
          relativePath: input.relativePath,
          sourceHash: input.sourceHash,
          title: input.title,
          markdown: input.markdown,
        }),
      },
      true,
    )
  }

  removeExternalProjections(sourceId: string, resourceId: string | undefined, sourceKind: ExternalDocumentSourceKind): Promise<{ removed: number }> {
    const query = resourceId ? `?${new URLSearchParams({ resourceId })}` : ''
    return this.request(
      `/v1/external-document-projections/${sourceKind}/${encodeURIComponent(sourceId)}${query}`,
      { method: 'DELETE' },
      true,
    )
  }

  /** Vault 移除笔记后按 documentId 清投影（vault 事件清理路径）。 */
  removeExternalDocumentProjection(documentId: string): Promise<void> {
    return this.request(
      `/v1/external-document-projections/documents/${encodeURIComponent(documentId)}`,
      { method: 'DELETE' },
      true,
    )
  }

  /** 订阅通道已随文稿 UI 下线；保留空实现以兼容既有装配/退出清理调用。 */
  dispose(): void {
    // no-op
  }

  private async request<T>(
    path: string,
    init?: RequestInit,
    _retryWhenUnavailable = false,
  ): Promise<T> {
    const connection = this.supervisor.getConnection()
    const response = await fetch(new URL(path, connection.baseUrl), {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`${String(response.status)} ${response.statusText} ${body}`.trim())
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }
}
