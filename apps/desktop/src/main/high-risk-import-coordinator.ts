import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import type { HighRiskImportResolution, HighRiskImportReview, IngestPipelines } from '../shared/ingest'

export interface PendingManualImportFile {
  filePath: string
  filename: string
}

export interface PendingManualImportBatch {
  files: PendingManualImportFile[]
  pipelines?: IngestPipelines
  roomId?: string
}

export interface PendingAutoScanBatch {
  sourceId: string
  versionIds: string[]
}

type StoredBatch = {
  id: string
  sourceLabel: string
  createdAt: string
} & (
  | { origin: 'manual-import'; payload: PendingManualImportBatch }
  | { origin: 'auto-scan'; payload: PendingAutoScanBatch }
)

interface StoredState {
  version: 1
  batches: StoredBatch[]
}

type ManualResolver = (batch: PendingManualImportBatch, accepted: boolean) => Promise<HighRiskImportResolution>
type AutoResolver = (batch: PendingAutoScanBatch, accepted: boolean) => Promise<HighRiskImportResolution>

export interface HighRiskImportQueue {
  enqueueManual(batch: PendingManualImportBatch, sourceLabel: string): Promise<HighRiskImportReview>
  enqueueAuto(batch: PendingAutoScanBatch, sourceLabel: string): Promise<HighRiskImportReview>
  setManualResolver(resolver: ManualResolver): void
  setAutoResolver(resolver: AutoResolver): void
  discardAutoSource(sourceId: string): Promise<void>
  /** 本次会话内用户明确跳过的手动导入文件：重试同批导入时不再复审。 */
  isSkippedManualPath(filePath: string): boolean
}

export class HighRiskImportCoordinator implements HighRiskImportQueue {
  private batches: StoredBatch[] = []
  /** 用户「跳过」决定只对本次应用会话生效；重启后重新给一次确认机会。 */
  private readonly skippedManualPaths = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private readonly resolving = new Set<string>()
  private persistChain: Promise<void> = Promise.resolve()
  private manualResolver: ManualResolver | null = null
  private autoResolver: AutoResolver | null = null

  constructor(private readonly statePath: string) {}

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<StoredState>
      if (parsed.version === 1 && Array.isArray(parsed.batches)) {
        this.batches = parsed.batches.filter(isStoredBatch)
      }
    } catch {
      this.batches = []
    }
  }

  list(): HighRiskImportReview[] {
    return this.batches.map(toReview)
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setManualResolver(resolver: ManualResolver): void {
    this.manualResolver = resolver
  }

  setAutoResolver(resolver: AutoResolver): void {
    this.autoResolver = resolver
  }

  enqueueManual(batch: PendingManualImportBatch, sourceLabel: string): Promise<HighRiskImportReview> {
    return this.enqueue({
      id: randomUUID(),
      origin: 'manual-import',
      sourceLabel,
      createdAt: new Date().toISOString(),
      payload: batch,
    })
  }

  enqueueAuto(batch: PendingAutoScanBatch, sourceLabel: string): Promise<HighRiskImportReview> {
    return this.enqueue({
      id: randomUUID(),
      origin: 'auto-scan',
      sourceLabel,
      createdAt: new Date().toISOString(),
      payload: batch,
    })
  }

  async resolve(id: string, accepted: boolean): Promise<HighRiskImportResolution> {
    const batch = this.batches.find((item) => item.id === id)
    if (!batch) throw new Error('待确认的文件批次不存在。')
    if (this.resolving.has(id)) throw new Error('该文件批次正在处理中。')
    this.resolving.add(id)
    try {
      let result: HighRiskImportResolution
      if (batch.origin === 'manual-import') {
        if (!this.manualResolver) throw new Error('文件导入服务尚未就绪。')
        result = await this.manualResolver(batch.payload, accepted)
        if (!accepted) {
          // 记住跳过的文件：同会话内重试/再导入这批路径时直接排除，不再重复弹审查。
          for (const file of batch.payload.files) this.skippedManualPaths.add(resolve(file.filePath))
        }
      } else {
        if (!this.autoResolver) throw new Error('文件导入服务尚未就绪。')
        result = await this.autoResolver(batch.payload, accepted)
      }
      this.batches = this.batches.filter((item) => item.id !== id)
      await this.persistWithoutBlockingUserWork()
      this.notifyChanged()
      return result
    } finally {
      this.resolving.delete(id)
    }
  }

  isSkippedManualPath(filePath: string): boolean {
    return this.skippedManualPaths.has(resolve(filePath))
  }

  async discardAutoSource(sourceId: string): Promise<void> {
    const next = this.batches.filter((batch) =>
      batch.origin !== 'auto-scan' || batch.payload.sourceId !== sourceId)
    if (next.length === this.batches.length) return
    this.batches = next
    await this.persistWithoutBlockingUserWork()
    this.notifyChanged()
  }

  private async enqueue(batch: StoredBatch): Promise<HighRiskImportReview> {
    this.batches.push(batch)
    await this.persistWithoutBlockingUserWork()
    this.notifyChanged()
    return toReview(batch)
  }

  private persist(): Promise<void> {
    this.persistChain = this.persistChain.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.statePath), { recursive: true })
      const temporaryPath = `${this.statePath}.tmp`
      await writeFile(
        temporaryPath,
        JSON.stringify({ version: 1, batches: this.batches } satisfies StoredState),
        { encoding: 'utf8', mode: 0o600 },
      )
      await rename(temporaryPath, this.statePath)
    })
    return this.persistChain
  }

  private async persistWithoutBlockingUserWork(): Promise<void> {
    try {
      await this.persist()
    } catch (error) {
      console.error('[high-risk-imports] unable to persist review state', error)
    }
  }

  private notifyChanged(): void {
    for (const listener of this.listeners) listener()
  }
}

function toReview(batch: StoredBatch): HighRiskImportReview {
  return {
    id: batch.id,
    origin: batch.origin,
    sourceLabel: batch.sourceLabel,
    fileCount: batch.origin === 'manual-import' ? batch.payload.files.length : batch.payload.versionIds.length,
    createdAt: batch.createdAt,
  }
}

function isStoredBatch(value: unknown): value is StoredBatch {
  if (!value || typeof value !== 'object') return false
  const batch = value as Partial<StoredBatch>
  if (typeof batch.id !== 'string' || typeof batch.sourceLabel !== 'string' || typeof batch.createdAt !== 'string') return false
  if (batch.origin === 'manual-import') {
    return Boolean(
      batch.payload && 'files' in batch.payload && Array.isArray(batch.payload.files) &&
      batch.payload.files.every((file) => file && typeof file === 'object' &&
        'filePath' in file && typeof file.filePath === 'string' &&
        'filename' in file && typeof file.filename === 'string'),
    )
  }
  return batch.origin === 'auto-scan' && Boolean(
    batch.payload && 'sourceId' in batch.payload && typeof batch.payload.sourceId === 'string' &&
    'versionIds' in batch.payload && Array.isArray(batch.payload.versionIds) &&
    batch.payload.versionIds.every((id) => typeof id === 'string'),
  )
}
