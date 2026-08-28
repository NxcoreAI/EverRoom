import { dialog } from 'electron'
import { readFile } from 'node:fs/promises'
import { desktopText } from '../desktop-locale'

import type {
  MemoryAtomicListOptions,
  MemoryAtomicPageDto,
  MemoryAtomicProvenanceDto,
  MemoryConversationListOptions,
  MemoryConversationPageDto,
  MemoryCoreDto,
  MemoryDocumentDetailDto,
  MemoryDocumentDto,
  MemoryImportMarkdownResultDto,
  MemoryDocumentRewriteInput,
  MemoryOnboardingInput,
  MemoryOnboardingResultDto,
  MemoryOverviewDto,
  MemoryScenarioContentDto,
  MemoryScenarioEntryDto,
} from '../../shared/memory'
import type { GatewaySupervisor } from './gateway-supervisor'

/** 与 MemoryCore / gateway 的导入上限一致（2MB）。 */
const MAX_IMPORT_BYTES = 2 * 1024 * 1024

/**
 * 记忆功能的 gateway 错误码。IPC 只能可靠传回 message 字符串，
 * 因此用 `[code] ` 前缀把 gateway 的 error code 带到渲染层，
 * 渲染层据此区分「未启用 / 不可达 / 其他错误」三种降级态。
 */
export type MemoryErrorCode = 'memory_disabled' | 'memory_unreachable' | 'memory_error'

export function parseMemoryErrorCode(message: string): MemoryErrorCode | null {
  const match = /^\[(memory_disabled|memory_unreachable|memory_error)\]/.exec(message)
  return match ? (match[1] as MemoryErrorCode) : null
}

interface GatewayErrorBody {
  error?: unknown
  message?: unknown
}

export class MemoryGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  overview(): Promise<MemoryOverviewDto> {
    return this.request('/v1/memory/overview')
  }

  startOnboarding(input: MemoryOnboardingInput): Promise<MemoryOnboardingResultDto> {
    return this.request('/v1/memory/onboarding', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  listAtomic(options: MemoryAtomicListOptions): Promise<MemoryAtomicPageDto> {
    return this.request(`/v1/memory/atomic?${this.query(options)}`)
  }

  searchAtomic(query: string, limit = 10): Promise<{ items: MemoryAtomicPageDto['items'] }> {
    return this.request('/v1/memory/atomic/search', {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    })
  }

  updateAtomic(
    id: string,
    content: string,
    background?: string,
  ): Promise<{ id: string; version: number; updatedAt: string }> {
    return this.request(`/v1/memory/atomic/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ content, ...(background !== undefined ? { background } : {}) }),
    })
  }

  deleteAtomic(ids: string[]): Promise<{ deletedCount: number }> {
    return this.request('/v1/memory/atomic', { method: 'DELETE', body: JSON.stringify({ ids }) })
  }

  listScenarios(pathPrefix?: string): Promise<{ entries: MemoryScenarioEntryDto[]; total: number }> {
    const query = pathPrefix ? `?${new URLSearchParams({ pathPrefix })}` : ''
    return this.request(`/v1/memory/scenario${query}`)
  }

  readScenario(path: string): Promise<MemoryScenarioContentDto> {
    return this.request(`/v1/memory/scenario/content?${new URLSearchParams({ path })}`)
  }

  readCore(): Promise<MemoryCoreDto> {
    return this.request('/v1/memory/core')
  }

  writeCore(content: string): Promise<{ version: number; updatedAt: string }> {
    return this.request('/v1/memory/core', { method: 'PUT', body: JSON.stringify({ content }) })
  }

  listConversations(options: MemoryConversationListOptions): Promise<MemoryConversationPageDto> {
    return this.request(`/v1/memory/conversation?${this.query(options)}`)
  }

  importConversation(input: {
    sessionId: string
    messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: string; recordedAt?: string }>
  }): Promise<{ sessionId: string; messagesImported: number }> {
    return this.request('/v1/memory/conversation/import', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  searchConversations(
    query: string,
    limit = 10,
    sessionId?: string,
  ): Promise<{ messages: MemoryConversationPageDto['messages'] }> {
    return this.request('/v1/memory/conversation/search', {
      method: 'POST',
      body: JSON.stringify({ query, limit, ...(sessionId ? { sessionId } : {}) }),
    })
  }

  deleteConversations(target: {
    sessionIds?: string[]
    messageIds?: string[]
  }): Promise<{ deletedCount: number }> {
    return this.request('/v1/memory/conversation', { method: 'DELETE', body: JSON.stringify(target) })
  }

  // ── md 文档一等来源（资产化 + /v3/document/* 代理） ──

  importMarkdown(input: {
    title: string
    markdown: string
    filename?: string
  }): Promise<MemoryImportMarkdownResultDto> {
    return this.request('/v1/memory/import/markdown', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  captureDocumentRewrite(input: MemoryDocumentRewriteInput): Promise<{ captured: boolean }> {
    return this.request('/v1/memory/document-rewrite', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  captureSourceDocument(input: {
    sourceId: string
    sourceKind: string
    documentId: string
    title: string
    markdown: string
    uri?: string
    contentHash?: string
  }): Promise<{ captured: boolean }> {
    return this.request('/v1/memory/source-document', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  listDocuments(limit = 50, offset = 0): Promise<{ documents: MemoryDocumentDto[]; total: number }> {
    return this.request(`/v1/memory/documents?limit=${limit}&offset=${offset}`)
  }

  getDocument(id: string): Promise<MemoryDocumentDetailDto> {
    return this.request(`/v1/memory/documents/${encodeURIComponent(id)}`)
  }

  deleteDocument(id: string): Promise<{ documentId: string; deleted: boolean }> {
    return this.request(`/v1/memory/documents/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  atomicProvenance(id: string): Promise<MemoryAtomicProvenanceDto> {
    return this.request(`/v1/memory/atomic/${encodeURIComponent(id)}/provenance`)
  }

  /**
   * 主进程文件选择框（仅 .md）→ 读文本上行由渲染层走 importMarkdown。
   * 超过导入上限的文件直接报错跳过（不截断，避免半篇入库）。
   */
  async pickMarkdownFiles(): Promise<Array<{ filename: string; markdown: string } | { filename: string; error: string }>> {
    const picked = await dialog.showOpenDialog({
      title: desktopText('dialog.memoryMarkdown.title'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    })
    if (picked.canceled || picked.filePaths.length === 0) return []

    const results: Array<{ filename: string; markdown: string } | { filename: string; error: string }> = []
    for (const filePath of picked.filePaths) {
      const filename = filePath.split(/[\\/]/).pop() ?? filePath
      try {
        const buffer = await readFile(filePath)
        if (buffer.byteLength > MAX_IMPORT_BYTES) {
          results.push({
            filename,
            error: desktopText('error.memory.fileTooLarge', {
              size: (buffer.byteLength / 1024 / 1024).toFixed(1),
            }),
          })
          continue
        }
        results.push({ filename, markdown: buffer.toString('utf8') })
      } catch (error) {
        results.push({ filename, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return results
  }

  private query(
    options: MemoryAtomicListOptions | MemoryConversationListOptions,
  ): string {
    const params = new URLSearchParams()
    if ('type' in options && options.type) params.set('type', options.type)
    if ('sessionId' in options && options.sessionId) params.set('sessionId', options.sessionId)
    if ('sourceKind' in options && options.sourceKind) params.set('sourceKind', options.sourceKind)
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.offset !== undefined) params.set('offset', String(options.offset))
    if (options.timeStart) params.set('timeStart', options.timeStart)
    if (options.timeEnd) params.set('timeEnd', options.timeEnd)
    return params.toString()
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const connection = this.supervisor.getConnection()
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        // 无 body 不带 Content-Type：Fastify 5 对「JSON 头 + 空 body」直接
        // 400（FST_ERR_CTP_EMPTY_JSON_BODY），GET/DELETE 均无 body
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as GatewayErrorBody | null
      const code = typeof body?.error === 'string' ? body.error : ''
      const message = typeof body?.message === 'string' ? body.message : `记忆请求失败（${response.status}）`
      throw new Error(code ? `[${code}] ${message}` : message)
    }
    return response.json() as Promise<T>
  }
}
