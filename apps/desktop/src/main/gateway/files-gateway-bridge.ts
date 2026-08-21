import { dialog, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, relative, resolve, sep } from 'node:path'
import type {
  FileDto,
  FileCatalogDto,
  FileFormatCapabilityDto,
  FileImportAcceptedDto,
  FileImportOutcome,
  HighRiskImportResolution,
  IngestPipelines,
} from '../../shared/ingest'
import type { GatewaySupervisor } from './gateway-supervisor'
import { desktopText } from '../desktop-locale'
import {
  HIGH_RISK_FILE_BATCH_THRESHOLD,
  isIgnoredLocalDirectory,
  isLowRiskFileExtension,
} from '../file-format-policy'
import type {
  HighRiskImportQueue,
  PendingManualImportBatch,
} from '../high-risk-import-coordinator'

export interface ImportCandidate {
  filePath: string
  filename: string
}

const DEFAULT_IMPORT_EXTENSIONS = new Set([
  '.csv', '.doc', '.docx', '.docm', '.dot', '.dotx', '.dotm', '.html', '.htm', '.md', '.markdown',
  '.mdx', '.odt', '.ods', '.odp', '.pdf', '.pot', '.potx', '.potm', '.pps', '.ppsx', '.ppsm', '.ppt',
  '.pptx', '.pptm', '.rtf', '.sldx', '.sldm', '.text', '.txt', '.xls', '.xla', '.xlam', '.xlsb',
  '.xlsx', '.xlsm', '.xlt', '.xltx', '.xltm',
])

interface ImportCollectionPlan {
  candidates: ImportCandidate[]
}

function isSupportedImportFile(filePath: string, extensions: ReadonlySet<string>): boolean {
  return extensions.has(extname(filePath).toLowerCase())
}

async function collectDirectoryFiles(directory: string, extensions: ReadonlySet<string>): Promise<ImportCollectionPlan> {
  const rootPath = resolve(directory)
  const candidates: ImportCandidate[] = []
  const visit = async (currentDirectory: string, isRoot = false): Promise<void> => {
    let entries
    try {
      entries = await readdir(currentDirectory, { withFileTypes: true })
    } catch (error) {
      if (isRoot) throw error
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const filePath = resolve(currentDirectory, entry.name)
      if (entry.isDirectory()) {
        if (isIgnoredLocalDirectory(entry.name)) continue
        await visit(filePath)
      } else if (entry.isFile()) {
        if (isSupportedImportFile(filePath, extensions)) {
          candidates.push({ filePath, filename: relative(rootPath, filePath).split(sep).join('/') })
        }
      }
    }
  }
  await visit(rootPath, true)
  candidates.sort((left, right) => left.filename.localeCompare(right.filename))
  return { candidates }
}

export async function collectImportPlan(
  selectedPaths: string[],
  extensions: ReadonlySet<string> = DEFAULT_IMPORT_EXTENSIONS,
): Promise<{ candidates: ImportCandidate[]; highRiskFileCount: number }> {
  const candidates: ImportCandidate[] = []
  const seen = new Set<string>()
  for (const selectedPath of selectedPaths) {
    const resolvedPath = resolve(selectedPath)
    if (seen.has(resolvedPath)) continue
    seen.add(resolvedPath)
    let selectedStat
    try {
      selectedStat = await stat(resolvedPath)
    } catch {
      continue
    }
    if (selectedStat.isDirectory()) {
      const plan = await collectDirectoryFiles(resolvedPath, extensions)
      candidates.push(...plan.candidates)
    }
    else if (selectedStat.isFile() && isSupportedImportFile(resolvedPath, extensions)) candidates.push({ filePath: resolvedPath, filename: basename(resolvedPath) })
  }
  const uniqueCandidates = [...new Map(candidates.map((candidate) => [resolve(candidate.filePath), candidate])).values()]
  return {
    candidates: uniqueCandidates,
    highRiskFileCount: uniqueCandidates.filter((candidate) => !isLowRiskFileExtension(extname(candidate.filePath))).length,
  }
}

export async function collectImportCandidates(
  selectedPaths: string[],
  extensions: ReadonlySet<string> = DEFAULT_IMPORT_EXTENSIONS,
): Promise<ImportCandidate[]> {
  return (await collectImportPlan(selectedPaths, extensions)).candidates
}

/**
 * 文件中心桥（unified-ingest-plan §8-§9）：modules/files 的管理面 +
 * 统一导入主路径（选文件 → /v1/files 唯一字节入口 → /v1/ingest 进链路）。
 * 与 KnowledgeGatewayBridge 同构（Bearer token 只在主进程）。
 */
export class FilesGatewayBridge {
  constructor(
    private readonly supervisor: GatewaySupervisor,
    private readonly highRiskImports: HighRiskImportQueue | null = null,
  ) {
    this.highRiskImports?.setManualResolver((batch, accepted) => this.resolveManualBatch(batch, accepted))
  }

  list(limit = 100, offset = 0): Promise<{ items: FileCatalogDto[]; total: number }> {
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) })
    return this.request(`/v1/files/catalog?${query}`)
  }

  catalog(limit = 100, offset = 0): Promise<{ items: FileCatalogDto[]; total: number }> {
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) })
    return this.request(`/v1/files/catalog?${query}`)
  }

  capabilities(): Promise<{ items: FileFormatCapabilityDto[] }> {
    return this.request('/v1/files/capabilities')
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

  rename(fileId: string, displayName: string): Promise<FileCatalogDto> {
    return this.request(`/v1/file-entries/${encodeURIComponent(fileId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ displayName }),
    })
  }

  pinClusterTitle(clusterId: string, sharedTitle: string): Promise<{ id: string; canonicalTitle: string; titlePinned: boolean }> {
    return this.request(`/v1/file-clusters/${encodeURIComponent(clusterId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sharedTitle }),
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

  /** 使用操作系统为该文件类型配置的默认查看器打开文件本体。 */
  async openOriginal(fileId: string): Promise<void> {
    const { storagePath } = await this.request<{ storagePath: string }>(
      `/v1/files/${encodeURIComponent(fileId)}/storage`,
    )
    const error = await shell.openPath(storagePath)
    if (error) throw new Error(error)
  }

  /**
   * 统一导入（用户主路径）：系统选择框 → 逐文件 multipart 上传（唯一字节
   * 入口）→ ref 形态进引擎。失败互不影响，逐行回报。
   * roomId（Room 内上传）→ /v1/ingest 的显式归属：入口直达该 Room。
   */
  async pickAndImport(options?: {
    pipelines?: IngestPipelines
    roomId?: string
  }): Promise<FileImportOutcome[]> {
    const picked = await dialog.showOpenDialog({
      title: desktopText('dialog.importFiles.title'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: desktopText('dialog.importFiles.documents'),
          extensions: [...DEFAULT_IMPORT_EXTENSIONS].map((extension) => extension.slice(1)),
        },
      ],
    })
    if (picked.canceled || picked.filePaths.length === 0) return []

    return this.importPathsOnce(picked.filePaths, options)
  }

  /**
   * 一次性手动采集：展开本次明确选择的文件/目录并导入。不会注册本地
   * 数据源或 watcher，后续文件变化也不会触发自动重扫。
   */
  async importPathsOnce(selectedPaths: string[], options?: {
    pipelines?: IngestPipelines
    roomId?: string
  }): Promise<FileImportOutcome[]> {
    if (!Array.isArray(selectedPaths) || selectedPaths.length === 0) return []

    const manualExtensions = new Set((await this.capabilities()).items
      .filter((item) => item.manualImport).map((item) => item.extension))
    const importPlan = await collectImportPlan(
      selectedPaths.filter((filePath): filePath is string => typeof filePath === 'string' && filePath.length > 0),
      manualExtensions,
    )
    let candidates = importPlan.candidates
    if (importPlan.highRiskFileCount > HIGH_RISK_FILE_BATCH_THRESHOLD && this.highRiskImports) {
      const lowRiskCandidates = candidates.filter((candidate) => isLowRiskFileExtension(extname(candidate.filePath)))
      const highRiskCandidates = candidates.filter((candidate) => !isLowRiskFileExtension(extname(candidate.filePath)))
      await this.highRiskImports.enqueueManual({
        files: highRiskCandidates,
        ...(options?.pipelines ? { pipelines: options.pipelines } : {}),
        ...(options?.roomId ? { roomId: options.roomId } : {}),
      }, basename(resolve(selectedPaths[0]!)))
      candidates = lowRiskCandidates
    }

    return this.importCandidates(candidates, options)
  }

  private async resolveManualBatch(
    batch: PendingManualImportBatch,
    accepted: boolean,
  ): Promise<HighRiskImportResolution> {
    if (!accepted) return { accepted: false, imported: 0, failed: 0 }
    const outcomes = await this.importCandidates(batch.files, {
      ...(batch.pipelines ? { pipelines: batch.pipelines } : {}),
      ...(batch.roomId ? { roomId: batch.roomId } : {}),
    })
    return {
      accepted: true,
      imported: outcomes.filter((outcome) => outcome.fileId !== null).length,
      failed: outcomes.filter((outcome) => outcome.error !== null).length,
    }
  }

  private async importCandidates(candidates: ImportCandidate[], options?: {
    pipelines?: IngestPipelines
    roomId?: string
  }): Promise<FileImportOutcome[]> {
    const outcomes: FileImportOutcome[] = []
    for (const { filePath, filename } of candidates) {
      try {
        const uploaded = await this.importPath({
          filePath,
          sourceKind: 'manual-upload',
          sourceKey: `manual:${randomUUID()}`,
          originalName: basename(filePath),
          relativePath: filename,
          ...(options?.pipelines ? { pipelines: options.pipelines } : {}),
          ...(options?.roomId ? { roomId: options.roomId } : {}),
        })
        outcomes.push({
          filename,
          fileId: uploaded.fileEntryId,
          eventId: null,
          dataType: null,
          deduped: uploaded.versionDeduped,
          pipelines: options?.pipelines ?? null,
          memoryResult: null,
          routeJobId: uploaded.jobId,
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

  async importLocalFile(input: {
    filePath: string
    sourceKey: string
    originalName: string
    localSourceId: string
    localItemId: string
    relativePath: string
    sourceModifiedAt: string
  }): Promise<FileImportAcceptedDto> {
    return this.importPath({ ...input, sourceKind: 'local-folder' })
  }

  async importConnectorFile(input: {
    filePath: string
    sourceKey: string
    originalName: string
    provider: string
    connectionId: string
    relativePath: string
    sourceUri: string
    sourceModifiedAt: string
  }): Promise<FileImportAcceptedDto> {
    return this.importPath({ ...input, sourceKind: 'connector' })
  }

  private async importPath(input: {
    filePath: string
    sourceKind: 'manual-upload' | 'local-folder' | 'connector'
    sourceKey: string
    originalName: string
    localSourceId?: string
    localItemId?: string
    relativePath?: string
    sourceModifiedAt?: string
    pipelines?: IngestPipelines
    roomId?: string
    provider?: string
    connectionId?: string
    sourceUri?: string
  }): Promise<FileImportAcceptedDto> {
    const before = await stat(input.filePath)
    const buffer = await readFile(input.filePath)
    const after = await stat(input.filePath)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('文件在导入过程中发生变化，请稍后重试。')
    }
    const form = new FormData()
    form.append('metadata', JSON.stringify({
      sourceKind: input.sourceKind,
      sourceKey: input.sourceKey,
      originalName: input.originalName,
      ...(input.localSourceId ? { localSourceId: input.localSourceId } : {}),
      ...(input.localItemId ? { localItemId: input.localItemId } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(input.sourceUri ? { sourceUri: input.sourceUri } : {}),
      ...(input.relativePath ? { relativePath: input.relativePath } : {}),
      sourceModifiedAt: input.sourceModifiedAt ?? after.mtime.toISOString(),
      ...(input.pipelines ? { pipelines: input.pipelines } : {}),
      ...(input.roomId ? { roomId: input.roomId } : {}),
    }))
    form.append('file', new Blob([new Uint8Array(buffer)]), input.originalName)
    const connection = this.supervisor.getConnection()
    const response = await fetch(`${connection.baseUrl}/v1/file-imports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${connection.token}` },
      body: form,
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown } | null
      throw new Error(typeof body?.error === 'string' ? body.error : `文件上传失败（${response.status}）`)
    }
    return response.json() as Promise<FileImportAcceptedDto>
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
