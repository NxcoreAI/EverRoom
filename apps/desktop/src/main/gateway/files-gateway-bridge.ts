import { dialog, shell } from 'electron'
import { readFile } from 'node:fs/promises'
import type {
  FileDto,
  FileImportOutcome,
  IngestPipelines,
  IngestResultDto,
} from '../../shared/ingest'
import type { GatewaySupervisor } from './gateway-supervisor'

/**
 * 文件中心桥（unified-ingest-plan §8-§9）：modules/files 的管理面 +
 * 统一导入主路径（选文件 → /v1/files 唯一字节入口 → /v1/ingest 进链路）。
 * 与 KnowledgeGatewayBridge 同构（Bearer token 只在主进程）。
 */
export class FilesGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  list(limit = 100, offset = 0): Promise<{ items: FileDto[]; total: number }> {
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) })
    return this.request(`/v1/files?${query}`)
  }

  get(fileId: string): Promise<FileDto & { storagePath: string; currentParsedId: string | null }> {
    return this.request(`/v1/files/${encodeURIComponent(fileId)}`)
  }

  /** 文件当前解析产物的 markdown（渲染器预览用；未进过链路 404）。 */
  readMarkdown(fileId: string): Promise<{ markdown: string }> {
    return this.request(`/v1/files/${encodeURIComponent(fileId)}/markdown`)
  }

  async readDataUrl(fileId: string): Promise<{ dataUrl: string }> {
    const connection = this.supervisor.getConnection()
    const response = await fetch(`${connection.baseUrl}/v1/files/${encodeURIComponent(fileId)}/content`, {
      headers: { Authorization: `Bearer ${connection.token}` },
    })
    if (!response.ok) throw new Error(`图片读取失败（${response.status}）`)
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream'
    const bytes = Buffer.from(await response.arrayBuffer())
    return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
  }

  rename(fileId: string, displayName: string): Promise<FileDto> {
    return this.request(`/v1/files/${encodeURIComponent(fileId)}/meta`, {
      method: 'PATCH',
      body: JSON.stringify({ displayName }),
    })
  }

  delete(fileId: string): Promise<{
    deleted: boolean
    knowledgeCleanup: boolean
    deletedMemoryDocuments: string[]
    blobCollected: boolean
  }> {
    return this.request(`/v1/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' })
  }

  /** 在系统文件管理器中定位文件本体（对象库 files/sha256/…）。 */
  async reveal(fileId: string): Promise<void> {
    const { storagePath } = await this.request<{ storagePath: string }>(
      `/v1/files/${encodeURIComponent(fileId)}/storage`,
    )
    shell.showItemInFolder(storagePath)
  }

  /**
   * 统一导入（用户主路径）：系统选择框 → 逐文件 multipart 上传（唯一字节
   * 入口）→ ref 形态进引擎。失败互不影响，逐行回报。
   */
  async pickAndImport(options?: { pipelines?: IngestPipelines }): Promise<FileImportOutcome[]> {
    const picked = await dialog.showOpenDialog({
      title: '选择要导入的文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '文档',
          extensions: ['md', 'markdown', 'txt', 'json', 'docx', 'xlsx', 'pptx', 'csv', 'html', 'htm'],
        },
      ],
    })
    if (picked.canceled || picked.filePaths.length === 0) return []

    const outcomes: FileImportOutcome[] = []
    for (const filePath of picked.filePaths) {
      const filename = filePath.split(/[\\/]/).pop() ?? filePath
      try {
        const buffer = await readFile(filePath)
        const uploaded = await this.uploadBytes(filename, buffer)
        const ingested = await this.ingestRef(uploaded.id, options?.pipelines)
        outcomes.push({
          filename,
          fileId: uploaded.id,
          eventId: ingested.eventId,
          dataType: ingested.dataType,
          deduped: ingested.deduped,
          pipelines: ingested.pipelines,
          memoryResult: ingested.memoryResult,
          routeJobId: ingested.routeJobId,
          error: null,
        })
      } catch (error) {
        outcomes.push({
          filename,
          fileId: null,
          eventId: null,
          dataType: null,
          deduped: false,
          pipelines: null,
          memoryResult: null,
          routeJobId: null,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return outcomes
  }

  private async uploadBytes(filename: string, buffer: Buffer) {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(buffer)]), filename)
    const connection = this.supervisor.getConnection()
    const response = await fetch(`${connection.baseUrl}/v1/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${connection.token}` },
      body: form,
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown } | null
      throw new Error(typeof body?.error === 'string' ? body.error : `文件上传失败（${response.status}）`)
    }
    return response.json() as Promise<{ id: string; contentHash: string; deduped: boolean; bytes: number }>
  }

  private async ingestRef(fileId: string, pipelines?: IngestPipelines) {
    return this.request<IngestResultDto>('/v1/ingest', {
      method: 'POST',
      body: JSON.stringify({
        source: { ref: { sourceKind: 'file', sourceId: fileId } },
        ...(pipelines ? { pipelines } : {}),
      }),
    })
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const connection = this.supervisor.getConnection()
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { message?: unknown; error?: unknown } | null
      const message = typeof body?.message === 'string' && body.message
        ? body.message
        : typeof body?.error === 'string' ? body.error : `文件服务请求失败（${response.status}）`
      throw new Error(message)
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }
}
