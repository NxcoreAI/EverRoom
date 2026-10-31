/**
 * 论文格式管线的桌面→网关桥（按工作区隔离）：设为论文模版（库内文件/磁盘直传 zip）、
 * 格式卡列表/删除、一键装订。装订是长任务（子代理映射 + 本机渲染 + 入库），
 * 超时放宽；完成事件由 office:agent-file 广播（装订产物走同一入库通道）。
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import type { GatewaySupervisor } from './gateway-supervisor'

export interface ThesisFormatCardDto {
  id: string
  sourceName: string
  sourceFileEntryId: string | null
  updatedAt: string
  /** ThesisFormatCard 全量 JSON（预览样张的数据源）。 */
  card: Record<string, unknown>
}

export interface ThesisReformatOutcomeDto {
  fileEntryId: string
  originalName: string
  /** v2 映射报告（守恒核对、每条分配规则/置信度、未匹配块、待复核章节）。 */
  report?: Record<string, unknown>
}

export class ThesisFormatGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  /** 解析结果里的模版事实缺口（图片抽不出、条文冲突等），UI 据此提示。 */
  static readonly EMPTY_FACT_GAPS: string[] = []

  async listCards(workspaceId: string): Promise<ThesisFormatCardDto[]> {
    const response = await this.request(`/v1/thesis-format/workspaces/${encodeURIComponent(workspaceId)}/cards`)
    if (!response.ok) throw new Error(`论文格式卡列表读取失败（${response.status}）`)
    return await response.json() as ThesisFormatCardDto[]
  }

  /** 资料区已有文件设为模版（docx/doc/pdf）。 */
  async parseFromLibrary(workspaceId: string, fileEntryId: string): Promise<{ cardId: string; sourceName: string; factGaps: string[] }> {
    return this.parse(workspaceId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileEntryId }),
    })
  }

  /** 磁盘直传模版（zip 不进文件库；docx/doc/pdf 也走此通道）。 */
  async parseFromDisk(
    workspaceId: string,
    filePath: string,
    fileEntryId?: string | null,
  ): Promise<{ cardId: string; sourceName: string; factGaps: string[] }> {
    const bytes = await readFile(filePath)
    const name = basename(filePath)
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(bytes)]), name)
    return this.parse(workspaceId, { method: 'POST', body: form }, fileEntryId ?? null)
  }

  /**
   * 彻底删除一份模版：先删模版文件，再删格式卡。
   * 文件删除失败（例如早已不存在）不阻断删卡。
   */
  async deleteTemplate(
    workspaceId: string,
    cardId: string,
    deleteFile: (fileEntryId: string) => Promise<{ deleted: boolean }>,
    keepCard = false,
  ): Promise<{ fileDeleted: boolean; hadFile: boolean; cardKept: boolean }> {
    const cards = await this.listCards(workspaceId)
    const card = cards.find((entry) => entry.id === cardId)
    const fileEntryId = card?.sourceFileEntryId ?? null
    let fileDeleted = false
    if (fileEntryId) {
      try {
        fileDeleted = (await deleteFile(fileEntryId)).deleted
      } catch (error) {
        console.warn('[thesis] 删除模版文件失败（继续删卡）：', error instanceof Error ? error.message : String(error))
      }
    }
    // keepCard=true：只删模版文件，格式卡留着继续可用（用户可自选）
    if (!keepCard) await this.removeCard(workspaceId, cardId)
    return { fileDeleted, hadFile: Boolean(fileEntryId), cardKept: keepCard }
  }

  /** 从内存字节解析模版（工作台拖拽上传用，不落盘）。 */
  async parseFromBytes(
    workspaceId: string,
    name: string,
    bytes: Uint8Array,
    fileEntryId?: string | null,
  ): Promise<{ cardId: string; sourceName: string; factGaps: string[] }> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(bytes)]), name)
    return this.parse(workspaceId, { method: 'POST', body: form }, fileEntryId ?? null)
  }

  /** 提交排版作业（立即返回 jobId，长任务在网关侧推进）。 */
  async startReformatJob(
    workspaceId: string,
    fileEntryId: string,
    cardId?: string,
    options?: Parameters<ThesisFormatGatewayBridge["reformat"]>[3],
  ): Promise<{ jobId: string; phase: string }> {
    const response = await this.request(`/v1/thesis-format/workspaces/${encodeURIComponent(workspaceId)}/reformat-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileEntryId, cardId, ...(options ? { options } : {}) }),
    })
    if (!response.ok) {
      // 服务端的原因（thesis_format_card_not_found 等）比状态码有用得多：
      // 上游 describeThesisError 就靠这串码给用户可执行的提示，吞掉等于白排查。
      const body = await response.json().catch(() => ({}) as { error?: string })
      console.warn('[thesis] 网关拒绝排版作业', {
        workspaceId,
        fileEntryId,
        cardId: cardId ?? null,
        status: response.status,
        error: body.error ?? null,
      })
      throw new Error(body.error || `排版作业提交失败（${response.status}）`)
    }
    return await response.json() as { jobId: string; phase: string }
  }

  /** 查作业状态（轮询）。 */
  async reformatJobStatus(jobId: string): Promise<{
    id: string
    status: 'running' | 'completed' | 'failed'
    phase: string
    progress: number
    result?: unknown
    error?: string
  }> {
    const response = await this.request(`/v1/thesis-format/jobs/${encodeURIComponent(jobId)}`)
    if (!response.ok) throw new Error(`排版作业查询失败（${response.status}）`)
    return await response.json() as {
      id: string
      status: 'running' | 'completed' | 'failed'
      phase: string
      progress: number
      result?: unknown
      error?: string
    }
  }

  async removeCard(workspaceId: string, cardId: string): Promise<void> {
    const response = await this.request(
      `/v1/thesis-format/workspaces/${encodeURIComponent(workspaceId)}/cards/${encodeURIComponent(cardId)}`,
      { method: 'DELETE' },
    )
    if (!response.ok) throw new Error(`论文格式卡删除失败（${response.status}）`)
  }

  private async parse(
    workspaceId: string,
    init: RequestInit,
    fileEntryId: string | null = null,
  ): Promise<{ cardId: string; sourceName: string; factGaps: string[] }> {
    const upload = init.body instanceof FormData
    const query = fileEntryId ? `?fileEntryId=${encodeURIComponent(fileEntryId)}` : ''
    const response = await this.request(
      `/v1/thesis-format/workspaces/${encodeURIComponent(workspaceId)}/${upload ? 'parse-upload' : 'parse'}${query}`,
      init,
      // 必须大于网关侧代理超时（thesis-formatter 15 分钟）：客户端先断就等于白跑。
      20 * 60_000,
    )
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(body.error || `论文模版解析失败（${response.status}）`)
    }
    const body = await response.json() as { cardId?: string; sourceName?: string; factGaps?: string[] }
    return {
      cardId: typeof body.cardId === 'string' ? body.cardId : '',
      sourceName: typeof body.sourceName === 'string' ? body.sourceName : '',
      factGaps: Array.isArray(body.factGaps)
        ? body.factGaps.filter((g): g is string => typeof g === 'string' && g.trim().length > 0).slice(0, 20)
        : [],
    }
  }

  /** 一键装订：产物为新文件（xxx-排版版.docx），完成后 office:agent-file 广播。 */
  async reformat(
    workspaceId: string,
    fileEntryId: string,
    cardId?: string,
    options?: {
      keepLogo?: boolean
      keepHeaderFooter?: boolean
      headingMapping?: { chapter?: number; section?: number; subsection?: number }
      aiFill?: boolean
    },
  ): Promise<ThesisReformatOutcomeDto> {
    const response = await this.request(
      `/v1/thesis-format/workspaces/${encodeURIComponent(workspaceId)}/reformat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileEntryId, cardId, ...(options ? { options } : {}) }),
      },
      // 与 parse 同理：装订代理超时 15 分钟，客户端留足余量。
      20 * 60_000,
    )
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(body.error || `论文排版失败（${response.status}）`)
    }
    return await response.json() as ThesisReformatOutcomeDto
  }

  private async request(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<Response> {
    const connection = this.supervisor.getConnection()
    return fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  }
}
