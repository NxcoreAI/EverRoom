import { dialog, shell } from 'electron'
import { desktopText } from '../desktop-locale'
import { readFile } from 'node:fs/promises'
import type {
  KnowledgeAttachInput,
  KnowledgeDecisionDto,
  KnowledgeEntityDetailDto,
  KnowledgeEntityDto,
  KnowledgeFileDto,
  KnowledgeFileUploadResult,
  KnowledgeRoomContextDto,
  KnowledgeRoomDto,
  KnowledgeUnmatchedItemDto,
  KnowledgeWikiDto,
  KnowledgeWikiGraphDto,
  KnowledgeWikiPageDto,
} from '../../shared/knowledge'
import type { GatewaySupervisor } from './gateway-supervisor'

/** Room 注册表 / Wiki 页面 / 待归类队列 / Room 文件清单（docs/room-wiki-plan.md §7.2）。 */

/**
 * 渲染器 → gateway knowledge 模块的 IPC 桥。
 * 与 DocumentGatewayBridge 同构（Bearer token 只在主进程，渲染器零感知）。
 * 文件上传统一走 FilesGatewayBridge.pickAndImport（/v1/files + /v1/ingest）。
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

  getRoomContext(roomId: string): Promise<KnowledgeRoomContextDto> {
    return this.request(`/v1/knowledge/rooms/${encodeURIComponent(roomId)}/context`)
  }

  listWikiPages(roomId: string): Promise<{ status: string; items: KnowledgeWikiPageDto[]; pageCount: number | null }> {
    return this.request(`/v1/knowledge/rooms/${encodeURIComponent(roomId)}/wiki/pages`)
  }

  readWikiPage(roomId: string, ref: string): Promise<{ ref: string; markdown: string }> {
    // ref 是带斜杠的页面路径，逐段编码
    const encoded = ref.split('/').map(encodeURIComponent).join('/')
    return this.request(`/v1/knowledge/rooms/${encodeURIComponent(roomId)}/wiki/pages/${encoded}`)
  }

  /** 全部 Room 的 wiki 映射（Wiki 应用清单）。 */
  listWikis(): Promise<{ items: KnowledgeWikiDto[] }> {
    return this.request('/v1/knowledge/wikis')
  }

  /** Room wiki 内链图谱（页面=节点、md 内链=边；无 wiki/失败为空图）。 */
  getWikiGraph(roomId: string): Promise<KnowledgeWikiGraphDto> {
    return this.request(`/v1/knowledge/rooms/${encodeURIComponent(roomId)}/wiki/graph`)
  }

  /** 候选实体列表（按状态筛；ready = 首页推荐池）。 */
  listEntities(status: 'weak' | 'ready' | 'promoting' | 'room' | 'archived' | 'suppressed'): Promise<{ items: KnowledgeEntityDto[] }> {
    return this.request(`/v1/knowledge/entities?${new URLSearchParams({ status })}`)
  }

  getEntity(entityId: string): Promise<KnowledgeEntityDetailDto> {
    return this.request(`/v1/knowledge/entities/${encodeURIComponent(entityId)}`)
  }

  /** 手动转正：跳过阈值走晋升全流程（202 异步入队）。 */
  promoteEntity(entityId: string): Promise<{ queued: boolean; jobId: string }> {
    return this.request(`/v1/knowledge/entities/${encodeURIComponent(entityId)}/promote`, { method: 'POST' })
  }

  suppressEntity(entityId: string): Promise<{ ok: boolean }> {
    return this.request(`/v1/knowledge/entities/${encodeURIComponent(entityId)}/suppress`, { method: 'POST' })
  }

  restoreSuppressedEntity(entityId: string): Promise<{ ok: boolean }> {
    return this.request(`/v1/knowledge/entities/${encodeURIComponent(entityId)}/restore`, { method: 'POST' })
  }

  /** 手动合并：from（路径）并入 targetId。 */
  mergeEntity(fromId: string, targetId: string): Promise<{ ok: boolean }> {
    return this.request(`/v1/knowledge/entities/${encodeURIComponent(fromId)}/merge`, {
      method: 'POST',
      body: JSON.stringify({ targetId }),
    })
  }

  /** 未识别资料手动挂实体（role=manual，+1.5 证据分）。 */
  attachDoc(
    sourceKind: string,
    sourceId: string,
    input: KnowledgeAttachInput,
  ): Promise<{ entityId: string }> {
    return this.request(
      `/v1/knowledge/docs/${encodeURIComponent(sourceKind)}/${encodeURIComponent(sourceId)}/attach`,
      { method: 'POST', body: JSON.stringify(input) },
    )
  }

  listUnmatched(): Promise<{ items: KnowledgeUnmatchedItemDto[] }> {
    return this.request('/v1/knowledge/docs/unmatched')
  }

  listRecentDecisions(limit = 20): Promise<{ items: KnowledgeDecisionDto[] }> {
    return this.request(`/v1/knowledge/decisions?${new URLSearchParams({ limit: String(limit) })}`)
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

  /**
   * 在系统文件管理器中定位文件本体（对象库 files/sha256/…）。
   */
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
      title: desktopText('dialog.knowledgeMarkdown.title'),
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
        // 无 body 不带 Content-Type：Fastify 5 对「JSON 头 + 空 body」的
        // POST 直接 400（FST_ERR_CTP_EMPTY_JSON_BODY），promote/revert 均无 body
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
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
