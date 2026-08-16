import { dialog, shell } from 'electron'
import { readFile } from 'node:fs/promises'
import type {
  KnowledgeConfirmInput,
  KnowledgeDecisionDto,
  KnowledgeFileDto,
  KnowledgeFileUploadResult,
  KnowledgePendingItemDto,
  KnowledgeRoomDto,
  KnowledgeWikiPageDto,
} from '../../shared/knowledge'
import type { GatewaySupervisor } from './gateway-supervisor'

/** Room 注册表 / Wiki 页面 / 待归类队列 / 文件上传（docs/room-wiki-plan.md §7.2）。 */

/**
 * 渲染器 → gateway knowledge 模块的 IPC 桥。
 * 与 DocumentGatewayBridge 同构（Bearer token 只在主进程，渲染器零感知）。
 */
export class KnowledgeGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  listRooms(origin?: 'user' | 'auto'): Promise<{ items: KnowledgeRoomDto[] }> {
    const query = origin ? `?${new URLSearchParams({ origin })}` : ''
    return this.request(`/v1/knowledge/rooms${query}`)
  }

  upsertRoom(input: { id: string; title: string; kind?: string }): Promise<KnowledgeRoomDto> {
    return this.request('/v1/knowledge/rooms', { method: 'POST', body: JSON.stringify(input) })
  }

  deleteRoom(roomId: string): Promise<void> {
    return this.request(`/v1/knowledge/rooms/${encodeURIComponent(roomId)}`, { method: 'DELETE' })
  }

  listWikiPages(roomId: string): Promise<{ status: string; items: KnowledgeWikiPageDto[]; pageCount: number | null }> {
    return this.request(`/v1/knowledge/rooms/${encodeURIComponent(roomId)}/wiki/pages`)
  }

  readWikiPage(roomId: string, ref: string): Promise<{ ref: string; markdown: string }> {
    // ref 是带斜杠的页面路径，逐段编码
    const encoded = ref.split('/').map(encodeURIComponent).join('/')
    return this.request(`/v1/knowledge/rooms/${encodeURIComponent(roomId)}/wiki/pages/${encoded}`)
  }

  listPending(): Promise<{ items: KnowledgePendingItemDto[] }> {
    return this.request('/v1/knowledge/pending')
  }

  listRecentDecisions(limit = 20): Promise<{ items: KnowledgeDecisionDto[] }> {
    return this.request(`/v1/knowledge/decisions?${new URLSearchParams({ limit: String(limit) })}`)
  }

  confirmDecision(decisionId: string, input: KnowledgeConfirmInput): Promise<{ ok: boolean; roomId: string }> {
    return this.request(`/v1/knowledge/route/${encodeURIComponent(decisionId)}/confirm`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  revertDecision(decisionId: string): Promise<{ ok: boolean }> {
    return this.request(`/v1/knowledge/route/${encodeURIComponent(decisionId)}/revert`, { method: 'POST' })
  }

  uploadFile(input: {
    filename: string
    contentBase64: string
    occurredAt?: string
  }): Promise<{ queued: boolean; sourceId: string; title: string; deduped: boolean }> {
    return this.request('/v1/knowledge/files', { method: 'POST', body: JSON.stringify(input) })
  }

  /** Room 的上传文件清单（uploaded_files ⨝ 最新归属决策）。 */
  listRoomFiles(roomId: string): Promise<{ items: KnowledgeFileDto[] }> {
    return this.request(`/v1/knowledge/rooms/${encodeURIComponent(roomId)}/files`)
  }

  /** 文件当前解析产物的 markdown（渲染器预览用）。 */
  readFileMarkdown(fileId: string): Promise<{ markdown: string }> {
    return this.request(`/v1/knowledge/files/${encodeURIComponent(fileId)}/markdown`)
  }

  /** 在系统文件管理器中定位文件本体（对象库 files/sha256/…）。 */
  async revealFile(fileId: string): Promise<void> {
    const { storagePath } = await this.request<{ storagePath: string }>(
      `/v1/knowledge/files/${encodeURIComponent(fileId)}/storage`,
    )
    shell.showItemInFolder(storagePath)
  }

  /**
   * 系统文件选择框 → 读文件 → 上传路由（用户主路径的入口）。
   * 首期仅接受 .md / .markdown；每份文件独立上传，失败互不影响。
   */
  async pickAndUploadFiles(): Promise<KnowledgeFileUploadResult[]> {
    const picked = await dialog.showOpenDialog({
      title: '选择要归类的 Markdown 文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    })
    if (picked.canceled || picked.filePaths.length === 0) return []

    const results: KnowledgeFileUploadResult[] = []
    for (const filePath of picked.filePaths) {
      const filename = filePath.split(/[\\/]/).pop() ?? filePath
      try {
        const contentBase64 = (await readFile(filePath)).toString('base64')
        const uploaded = await this.uploadFile({ filename, contentBase64 })
        results.push({
          filename,
          title: uploaded.title,
          sourceId: uploaded.sourceId,
          deduped: uploaded.deduped,
        })
      } catch (error) {
        results.push({ filename, title: filename, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return results
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const connection = this.supervisor.getConnection()
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { message?: unknown; error?: unknown } | null
      const message = typeof body?.message === 'string' && body.message
        ? body.message
        : typeof body?.error === 'string' ? body.error : `知识服务请求失败（${response.status}）`
      throw new Error(message)
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }
}
