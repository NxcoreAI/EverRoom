import { dialog, shell } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, relative, resolve, sep } from 'node:path'
import type { AgentAttachmentReference } from '@nxcore/agent-contract'
import type {
  FileDto,
  FileCatalogDto,
  FileFormatCapabilityDto,
  FileImportAcceptedDto,
  FileImportOutcome,
  FileImportProgressEvent,
  HighRiskImportResolution,
  IngestPipelines,
} from '../../shared/ingest'
import type {
  BrowserExtensionCapture,
  BrowserExtensionCaptureResult,
  BrowserExtensionClipperCapture,
  BrowserExtensionClipperListInput,
  BrowserExtensionClipperListResult,
} from '../../shared/browser-extension'
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
  '.mdx', '.ods', '.odp', '.pdf', '.pot', '.potx', '.potm', '.pps', '.ppsx', '.ppsm', '.ppt',
  '.pptx', '.pptm', '.rtf', '.sldx', '.sldm', '.text', '.txt', '.xls', '.xla', '.xlam', '.xlsb',
  '.xlsx', '.xlsm', '.xlt', '.xltx', '.xltm',
])
const AGENT_IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp'])
const AGENT_MAX_ATTACHMENTS = 5
const AGENT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

function imageMime(extension: string): string {
  return extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
    : extension === '.png' ? 'image/png'
      : extension === '.gif' ? 'image/gif' : 'image/webp'
}

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
  private readonly importProgressListeners = new Set<(event: FileImportProgressEvent) => void>()

  constructor(
    private readonly supervisor: GatewaySupervisor,
    private readonly highRiskImports: HighRiskImportQueue | null = null,
  ) {
    this.highRiskImports?.setManualResolver((batch, accepted) => this.resolveManualBatch(batch, accepted))
  }

  onImportProgress(listener: (event: FileImportProgressEvent) => void): () => void {
    this.importProgressListeners.add(listener)
    return () => this.importProgressListeners.delete(listener)
  }

  list(limit = 100, offset = 0): Promise<{ items: FileCatalogDto[]; total: number }> {
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) })
    return this.request(`/v1/files/catalog?${query}`)
  }

  listClipCaptures(inputOrLimit: BrowserExtensionClipperListInput | number = {}, legacyOffset = 0): Promise<BrowserExtensionClipperListResult> {
    const input: BrowserExtensionClipperListInput = typeof inputOrLimit === 'number'
      ? { limit: inputOrLimit, offset: legacyOffset }
      : inputOrLimit
    const query = new URLSearchParams()
    if (input.query) query.set('query', input.query)
    if (input.filter) query.set('filter', input.filter)
    if (input.sort) query.set('sort', input.sort)
    query.set('limit', String(input.limit ?? 100))
    query.set('offset', String(input.offset ?? 0))
    return this.request(`/v1/clipper/captures?${query}`)
  }

  setClipCaptureFavorite(captureId: string, favorite: boolean): Promise<BrowserExtensionClipperCapture> {
    return this.request(`/v1/clipper/captures/${encodeURIComponent(captureId)}/favorite`, {
      method: 'PATCH',
      body: JSON.stringify({ favorite }),
    })
  }

  getClipCaptureDetail(captureId: string): Promise<BrowserExtensionClipperCapture> {
    return this.request(`/v1/clipper/captures/${encodeURIComponent(captureId)}`)
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
  async readMarkdown(fileId: string, options?: { waitMs?: number; pollMs?: number }): Promise<{ markdown: string }> {
    const waitMs = Math.min(Math.max(options?.waitMs ?? 0, 0), 120_000)
    const pollMs = Math.min(Math.max(options?.pollMs ?? 500, 100), 5_000)
    const deadline = Date.now() + waitMs
    while (true) {
      try {
        return await this.request(`/v1/files/${encodeURIComponent(fileId)}/markdown`)
      } catch (error) {
        if (Date.now() >= deadline || !(error instanceof Error) || !/file_not_parsed/i.test(error.message)) throw error
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))))
      }
    }
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

  async importAgentAttachments(selectedPaths: string[]): Promise<AgentAttachmentReference[]> {
    const candidates = await collectImportCandidates(
      selectedPaths,
      new Set([...DEFAULT_IMPORT_EXTENSIONS, ...AGENT_IMAGE_EXTENSIONS]),
    )
    if (candidates.length > AGENT_MAX_ATTACHMENTS) throw new Error('最多只能添加 5 个附件')
    const attachments: AgentAttachmentReference[] = []
    for (const candidate of candidates) {
      const fileStat = await stat(candidate.filePath)
      if (fileStat.size > AGENT_MAX_ATTACHMENT_BYTES) throw new Error(`附件超过 10 MB：${candidate.filename}`)
      const extension = extname(candidate.filename).toLowerCase()
      if (AGENT_IMAGE_EXTENSIONS.has(extension)) {
        const uploaded = await this.request<{ id: string; bytes: number; originalName: string }>('/v1/files', {
          method: 'POST',
          body: JSON.stringify({
            filename: basename(candidate.filename),
            contentBase64: (await readFile(candidate.filePath)).toString('base64'),
            mime: imageMime(extension),
            assetKind: 'photo',
            originChannel: 'agent-composer',
            visibility: 'private',
          }),
        })
        attachments.push({
          fileId: uploaded.id,
          filename: uploaded.originalName,
          mimeType: imageMime(extension),
          size: uploaded.bytes,
          kind: 'image',
        })
      } else {
        const imported = await this.importPath({
          filePath: candidate.filePath,
          sourceKind: 'manual-upload',
          sourceKey: `agent:${randomUUID()}`,
          originalName: basename(candidate.filename),
          relativePath: candidate.filename,
        })
        await this.waitForMarkdown(imported.fileEntryId)
        attachments.push({
          fileId: imported.fileEntryId,
          filename: basename(candidate.filename),
          mimeType: 'text/plain',
          size: fileStat.size,
          kind: 'document',
        })
      }
    }
    return attachments
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
    const storagePath = await this.storagePath(fileId)
    shell.showItemInFolder(storagePath)
  }

  async storagePath(fileId: string): Promise<string> {
    const result = await this.request<{ storagePath: string }>(
      `/v1/files/${encodeURIComponent(fileId)}/storage`,
    )
    return result.storagePath
  }

  /** 使用操作系统为该文件类型配置的默认查看器打开文件本体。 */
  async openOriginal(fileId: string): Promise<void> {
    const storagePath = await this.storagePath(fileId)
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
      // Allow the same import action to select individual files or directories.
      // Directories are expanded by importPathsOnce, so they retain the same
      // allowlist, ignored-directory rules, and high-risk review behavior.
      properties: ['openFile', 'openDirectory', 'multiSelections'],
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
   * 仅选择：系统选择框返回文件/文件夹路径，不立即导入。创建 Room 弹窗
   * 先暂存选择，用户提交后才由 importPathsOnce 开始导入。
   */
  async pickImportPaths(): Promise<string[]> {
    const picked = await dialog.showOpenDialog({
      title: desktopText('dialog.importFiles.title'),
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [
        {
          name: desktopText('dialog.importFiles.documents'),
          extensions: [...DEFAULT_IMPORT_EXTENSIONS].map((extension) => extension.slice(1)),
        },
      ],
    })
    return picked.canceled ? [] : picked.filePaths
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
    // 本会话已明确跳过的文件直接排除：重试/再导入同一目录不再重复进入高风险审查。
    const highRiskImports = this.highRiskImports
    let candidates = highRiskImports
      ? importPlan.candidates.filter((candidate) => !highRiskImports.isSkippedManualPath(candidate.filePath))
      : importPlan.candidates
    const highRiskFileCount = candidates
      .filter((candidate) => !isLowRiskFileExtension(extname(candidate.filePath))).length
    if (highRiskFileCount > HIGH_RISK_FILE_BATCH_THRESHOLD && this.highRiskImports) {
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

  async importObsidianProject(input: {
    rootPath: string
    projectId: string
    projectName: string
    pipelines: IngestPipelines
    roomId?: string
    resourceIdsByRelativePath?: Readonly<Record<string, string>>
  }): Promise<FileImportOutcome[]> {
    const manualExtensions = new Set((await this.capabilities()).items
      .filter((item) => item.manualImport).map((item) => item.extension))
    const collected = await collectImportCandidates([input.rootPath], manualExtensions)
    const candidates = input.resourceIdsByRelativePath
      ? collected.filter((candidate) => Object.hasOwn(input.resourceIdsByRelativePath!, candidate.filename))
      : collected
    return this.importCandidates(candidates, {
      pipelines: input.pipelines,
      ...(input.roomId ? { roomId: input.roomId } : {}),
      source: {
        id: input.projectId,
        label: `Obsidian · ${input.projectName}`,
        ...(input.resourceIdsByRelativePath ? { resourceIdsByRelativePath: input.resourceIdsByRelativePath } : {}),
      },
    })
  }

  async importMigrationFile(input: {
    filePath: string
    sourceKey: string
    originalName: string
    relativePath: string
    provider: 'notion'
    sourceId: string
  }): Promise<FileImportAcceptedDto> {
    return this.importPath({
      filePath: input.filePath,
      sourceKind: 'migration',
      sourceKey: input.sourceKey,
      originalName: input.originalName,
      relativePath: input.relativePath,
      provider: input.provider,
      connectionId: input.sourceId,
      pipelines: { room: true, wiki: true, memory: true },
    })
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
    source?: { id: string; label: string; resourceIdsByRelativePath?: Readonly<Record<string, string>> }
  }): Promise<FileImportOutcome[]> {
    const outcomes: FileImportOutcome[] = []
    const batchId = randomUUID()
    let succeeded = 0
    let failed = 0
    this.emitImportProgress({ batchId, status: 'started', total: candidates.length, completed: 0, filename: null, succeeded, failed })
    for (const { filePath, filename } of candidates) {
      this.emitImportProgress({ batchId, status: 'file-started', total: candidates.length, completed: outcomes.length, filename, succeeded, failed })
      try {
        const uploaded = await this.importPath({
          filePath,
          sourceKind: 'manual-upload',
          sourceKey: options?.source
            ? `obsidian:${options.source.id}:${options.source.resourceIdsByRelativePath?.[filename] ?? filename}`
            // 确定性 key（同路径重导入命中同一 entry）：版本级去重才生效，
            // 否则每次重导入都铸新 entry + 重复排队路由，决策也挂到新 id 上。
            : `manual:path:${createHash('sha256').update(filePath).digest('hex').slice(0, 40)}`,
          originalName: basename(filePath),
          relativePath: filename,
          ...(options?.source ? { provider: options.source.label, connectionId: options.source.id } : {}),
          ...(options?.pipelines ? { pipelines: options.pipelines } : {}),
          ...(options?.roomId ? { roomId: options.roomId } : {}),
        })
        outcomes.push({
          filename,
          fileId: uploaded.fileEntryId,
          fileVersionId: uploaded.fileVersionId,
          eventId: null,
          dataType: null,
          deduped: uploaded.versionDeduped,
          pipelines: options?.pipelines ?? null,
          memoryResult: null,
          routeJobId: uploaded.jobId,
          error: null,
        })
        succeeded += 1
      } catch (error) {
        outcomes.push({
          filename,
          fileId: null,
          fileVersionId: null,
          eventId: null,
          dataType: null,
          deduped: false,
          pipelines: null,
          memoryResult: null,
          routeJobId: null,
          error: error instanceof Error ? error.message : String(error),
        })
        failed += 1
      }
      this.emitImportProgress({ batchId, status: 'file-completed', total: candidates.length, completed: outcomes.length, filename, succeeded, failed })
    }
    this.emitImportProgress({ batchId, status: 'completed', total: candidates.length, completed: outcomes.length, filename: null, succeeded, failed })
    return outcomes
  }

  private emitImportProgress(event: FileImportProgressEvent): void {
    for (const listener of this.importProgressListeners) listener(event)
  }

  async importLocalFile(input: {
    filePath: string
    contentHash: string
    byteSize: number
    sourceKey: string
    originalName: string
    localSourceId: string
    localItemId: string
    relativePath: string
    sourceModifiedAt: string
    roomId?: string
  }): Promise<FileImportAcceptedDto> {
    return this.request('/v1/local-file-references', {
      method: 'POST',
      body: JSON.stringify({
        sourceKey: input.sourceKey,
        originalName: input.originalName,
        sourcePath: input.filePath,
        contentHash: input.contentHash,
        byteSize: input.byteSize,
        localSourceId: input.localSourceId,
        localItemId: input.localItemId,
        relativePath: input.relativePath,
        sourceModifiedAt: input.sourceModifiedAt,
      }),
    })
  }

  markLocalFileMissing(input: { localSourceId: string; localItemId: string }): Promise<{ updated: boolean }> {
    return this.request('/v1/local-file-references/status', {
      method: 'PATCH',
      body: JSON.stringify({ ...input, status: 'missing' }),
    })
  }

  async projectVaultNote(input: {
    filePath: string
    vaultId: string
    resourceId: string
    relativePath: string
    sourceModifiedAt: string
    roomId: string
  }): Promise<FileImportAcceptedDto> {
    const buffer = await readFile(input.filePath)
    return this.importLocalFile({
      filePath: input.filePath,
      sourceKey: `obsidian:${input.vaultId}:${input.resourceId}`,
      originalName: basename(input.relativePath),
      localSourceId: input.vaultId,
      localItemId: input.resourceId,
      relativePath: input.relativePath,
      sourceModifiedAt: input.sourceModifiedAt,
      contentHash: createHash('sha256').update(buffer).digest('hex'),
      byteSize: buffer.byteLength,
      roomId: input.roomId,
    })
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

  createClipCapture(input: BrowserExtensionCapture): Promise<BrowserExtensionCaptureResult> {
    return this.request('/v1/clipper/captures', { method: 'POST', body: JSON.stringify({
      captureId: input.captureId,
      sourceUrl: input.url,
      canonicalUrl: input.canonicalUrl,
      title: input.title,
      author: input.author,
      publishedAt: input.publishedAt,
      capturedAt: input.capturedAt,
      extractionMode: input.extractionMode,
      markdown: input.markdown,
      extractorVersion: input.extractorVersion,
      assets: input.assets,
    }) })
  }

  uploadClipAsset(captureId: string, assetId: string, data: string): Promise<BrowserExtensionClipperCapture['assets'][number]> {
    return this.request(`/v1/clipper/captures/${encodeURIComponent(captureId)}/assets/${encodeURIComponent(assetId)}`, {
      method: 'PUT', body: JSON.stringify({ data }),
    })
  }

  finalizeClipCapture(captureId: string, failures: Array<{ assetId: string; code?: string }>): Promise<BrowserExtensionClipperCapture> {
    return this.request(`/v1/clipper/captures/${encodeURIComponent(captureId)}/finalize`, {
      method: 'POST', body: JSON.stringify({ failures }),
    })
  }

  retryClipCapture(captureId: string): Promise<{ capture: BrowserExtensionClipperCapture; pendingAssetIds: string[] }> {
    return this.request(`/v1/clipper/captures/${encodeURIComponent(captureId)}/retry`, { method: 'POST' })
  }

  getClipCapture(fileEntryId: string): Promise<BrowserExtensionClipperCapture> {
    return this.request(`/v1/clipper/files/${encodeURIComponent(fileEntryId)}`)
  }

  async readClipAsset(assetId: string): Promise<{ buffer: Buffer; mime: string }> {
    const connection = this.supervisor.getConnection()
    const response = await fetch(`${connection.baseUrl}/v1/clipper/assets/${encodeURIComponent(assetId)}/content`, {
      headers: { Authorization: `Bearer ${connection.token}` },
    })
    if (!response.ok) throw new Error(`网页剪藏图片读取失败（${response.status}）`)
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mime: response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream',
    }
  }

  private async importPath(input: {
    filePath: string
    sourceKind: 'manual-upload' | 'local-folder' | 'connector' | 'migration'
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

  private async waitForMarkdown(fileId: string): Promise<void> {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      try {
        await this.readMarkdown(fileId)
        return
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'file_not_parsed') {
          throw new Error(`附件解析失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
      }
    }
    throw new Error(`附件解析超时：${fileId}`)
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
