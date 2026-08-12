import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, mkdirSync, watch, type FSWatcher } from 'node:fs'
import { copyFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type {
  DataSourceSummary,
  SourceFileStatus,
  SourceFileSummary,
  SyncResult,
} from '../../shared/sources'

const SUPPORTED_EXTENSIONS = new Set([
  '.docx',
  '.gif',
  '.heic',
  '.htm',
  '.html',
  '.jpeg',
  '.jpg',
  '.md',
  '.mdx',
  '.pdf',
  '.png',
  '.pptx',
  '.rtf',
  '.text',
  '.txt',
  '.tif',
  '.tiff',
  '.webp',
  '.xlsx',
  '.xml',
  '.yaml',
  '.yml',
])

interface ScannedFile {
  absolutePath: string
  relativePath: string
  identity: string
  extension: string
  size: number
  modifiedAt: string
}

interface SourceRow {
  id: string
  kind: 'local-folder'
  name: string
  root_path: string
  status: DataSourceSummary['status']
  disconnected_at: string | null
  last_synced_at: string | null
  last_error: string | null
  last_change_run_id: string | null
  created_at: string
}

interface CountRow {
  file_count: number
  version_count: number
  total_bytes: number
}

interface ItemRow {
  id: string
  file_identity: string
  relative_path: string
  content_hash: string | null
  state: 'present' | 'missing'
}

interface FileSummaryRow {
  id: string
  relative_path: string
  previous_relative_path: string | null
  extension: string
  size: number
  modified_at: string
  state: 'present' | 'missing'
  sync_status: SourceFileStatus
  last_change_run_id: string | null
  last_changed_at: string
  content_hash: string | null
  last_seen_at: string
  version_count: number
}

export class LocalDataService {
  private readonly database: DatabaseSync
  private readonly objectsDirectory: string
  private readonly activeScans = new Map<string, Promise<SyncResult>>()
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly watchTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly verificationTimers = new Map<string, ReturnType<typeof setInterval>>()

  constructor(private readonly dataDirectory: string) {
    this.objectsDirectory = join(dataDirectory, 'objects', 'sha256')
    mkdirSync(join(dataDirectory, 'database'), { recursive: true })
    this.database = new DatabaseSync(join(dataDirectory, 'database', 'nexcore.db'))
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(join(this.dataDirectory, 'database'), { recursive: true }),
      mkdir(this.objectsDirectory, { recursive: true }),
      mkdir(join(this.dataDirectory, 'logs'), { recursive: true }),
    ])

    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS data_sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind = 'local-folder'),
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        last_synced_at TEXT,
        last_error TEXT,
        last_change_run_id TEXT,
        disconnected_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_items (
        id TEXT PRIMARY KEY,
        data_source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
        file_identity TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        extension TEXT NOT NULL,
        size INTEGER NOT NULL,
        modified_at TEXT NOT NULL,
        content_hash TEXT,
        state TEXT NOT NULL DEFAULT 'present' CHECK (state IN ('present', 'missing')),
        sync_status TEXT NOT NULL DEFAULT 'unchanged',
        previous_relative_path TEXT,
        last_change_run_id TEXT,
        last_changed_at TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(data_source_id, file_identity)
      );

      CREATE INDEX IF NOT EXISTS idx_source_items_source_path
        ON source_items(data_source_id, relative_path);

      CREATE TABLE IF NOT EXISTS source_versions (
        id TEXT PRIMARY KEY,
        source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        object_hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        source_modified_at TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        UNIQUE(source_item_id, content_hash)
      );

      CREATE INDEX IF NOT EXISTS idx_source_versions_object_hash
        ON source_versions(object_hash);

      CREATE TABLE IF NOT EXISTS sync_runs (
        id TEXT PRIMARY KEY,
        data_source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
        discovered INTEGER NOT NULL DEFAULT 0,
        added INTEGER NOT NULL DEFAULT 0,
        updated INTEGER NOT NULL DEFAULT 0,
        moved INTEGER NOT NULL DEFAULT 0,
        unchanged INTEGER NOT NULL DEFAULT 0,
        removed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
    `)

    const sourceColumns = this.database
      .prepare('PRAGMA table_info(data_sources)')
      .all() as unknown as Array<{ name: string }>
    if (!sourceColumns.some((column) => column.name === 'disconnected_at')) {
      this.database.exec('ALTER TABLE data_sources ADD COLUMN disconnected_at TEXT')
    }
    if (!sourceColumns.some((column) => column.name === 'last_change_run_id')) {
      this.database.exec('ALTER TABLE data_sources ADD COLUMN last_change_run_id TEXT')
    }
    const itemColumns = this.database
      .prepare('PRAGMA table_info(source_items)')
      .all() as unknown as Array<{ name: string }>
    if (!itemColumns.some((column) => column.name === 'sync_status')) {
      this.database.exec("ALTER TABLE source_items ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'unchanged'")
    }
    if (!itemColumns.some((column) => column.name === 'previous_relative_path')) {
      this.database.exec('ALTER TABLE source_items ADD COLUMN previous_relative_path TEXT')
    }
    if (!itemColumns.some((column) => column.name === 'last_change_run_id')) {
      this.database.exec('ALTER TABLE source_items ADD COLUMN last_change_run_id TEXT')
    }
    if (!itemColumns.some((column) => column.name === 'last_changed_at')) {
      this.database.exec('ALTER TABLE source_items ADD COLUMN last_changed_at TEXT')
      this.database.exec(`
        UPDATE source_items
        SET last_changed_at = COALESCE(last_seen_at, first_seen_at)
        WHERE last_changed_at IS NULL
      `)
    }

    const recoveredAt = new Date().toISOString()
    this.database.prepare(`
      UPDATE sync_runs
      SET status = 'failed', error_message = '应用在同步完成前退出', finished_at = ?
      WHERE status = 'running'
    `).run(recoveredAt)
    this.database.prepare(`
      UPDATE data_sources
      SET status = 'error', last_error = '上次同步未完成，请重新扫描', updated_at = ?
      WHERE status = 'syncing'
    `).run(recoveredAt)

    const connectedSources = this.database.prepare(`
      SELECT * FROM data_sources
      WHERE status = 'connected' AND disconnected_at IS NULL
    `).all() as unknown as SourceRow[]
    for (const source of connectedSources) this.startWatching(source)
  }

  async shutdown(): Promise<void> {
    for (const timer of this.watchTimers.values()) clearTimeout(timer)
    this.watchTimers.clear()
    for (const timer of this.verificationTimers.values()) clearInterval(timer)
    this.verificationTimers.clear()
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    await Promise.allSettled(this.activeScans.values())
    this.database.close()
  }

  listSources(): DataSourceSummary[] {
    const rows = this.database
      .prepare('SELECT * FROM data_sources ORDER BY created_at DESC')
      .all() as unknown as SourceRow[]

    return rows.map((row) => this.toSummary(row))
  }

  listFiles(dataSourceId: string): SourceFileSummary[] {
    this.requireSource(dataSourceId)
    const rows = this.database.prepare(`
      SELECT
        source_items.id,
        source_items.relative_path,
        source_items.previous_relative_path,
        source_items.extension,
        source_items.size,
        source_items.modified_at,
        source_items.state,
        source_items.sync_status,
        source_items.last_change_run_id,
        source_items.last_changed_at,
        source_items.content_hash,
        source_items.last_seen_at,
        COUNT(source_versions.id) AS version_count
      FROM source_items
      LEFT JOIN source_versions ON source_versions.source_item_id = source_items.id
      WHERE source_items.data_source_id = ?
      GROUP BY source_items.id
      ORDER BY source_items.state = 'missing', source_items.relative_path COLLATE NOCASE
    `).all(dataSourceId) as unknown as FileSummaryRow[]

    const source = this.requireSource(dataSourceId)
    return rows.map((row) => ({
      id: row.id,
      name: basename(row.relative_path),
      relativePath: row.relative_path,
      previousRelativePath: row.previous_relative_path,
      originalPath: join(source.root_path, row.relative_path),
      extension: row.extension,
      size: Number(row.size),
      modifiedAt: row.modified_at,
      exists: row.state === 'present',
      status: row.state === 'missing'
        ? 'missing'
        : source.last_change_run_id !== null && row.last_change_run_id === source.last_change_run_id
          ? row.sync_status
          : 'unchanged',
      changedAt: row.last_changed_at,
      versionCount: Number(row.version_count),
      contentHash: row.content_hash,
      lastSeenAt: row.last_seen_at,
    }))
  }

  getOriginalFilePath(dataSourceId: string, fileId: string): string {
    const source = this.requireSource(dataSourceId)
    const item = this.database.prepare(`
      SELECT relative_path, state
      FROM source_items
      WHERE id = ? AND data_source_id = ?
    `).get(fileId, dataSourceId) as unknown as
      | { relative_path: string; state: 'present' | 'missing' }
      | undefined

    if (!item) throw new Error('文件记录不存在。')
    if (item.state !== 'present') throw new Error('原始文件当前不存在。')

    const rootPath = resolve(source.root_path)
    const originalPath = resolve(rootPath, item.relative_path)
    if (!isAbsolute(originalPath) || (originalPath !== rootPath && !originalPath.startsWith(`${rootPath}${sep}`))) {
      throw new Error('文件位置超出已授权目录。')
    }
    return originalPath
  }

  async addLocalFolder(rootPath: string): Promise<SyncResult> {
    const existing = this.database
      .prepare('SELECT * FROM data_sources WHERE root_path = ?')
      .get(rootPath) as unknown as SourceRow | undefined

    if (existing) {
      if (existing.status === 'paused' || existing.disconnected_at) {
        this.setPaused(existing.id, false)
      }
      const result = await this.sync(existing.id)
      this.startWatching(this.requireSource(existing.id))
      return result
    }

    const now = new Date().toISOString()
    const id = randomUUID()
    this.database.prepare(`
      INSERT INTO data_sources (id, kind, name, root_path, status, created_at, updated_at)
      VALUES (?, 'local-folder', ?, ?, 'connected', ?, ?)
    `).run(id, basename(rootPath), rootPath, now, now)

    const result = await this.sync(id)
    this.startWatching(this.requireSource(id))
    return result
  }

  sync(id: string): Promise<SyncResult> {
    const running = this.activeScans.get(id)
    if (running) return running

    const scan = this.performSync(id).finally(() => this.activeScans.delete(id))
    this.activeScans.set(id, scan)
    return scan
  }

  setPaused(id: string, paused: boolean): DataSourceSummary {
    if (this.activeScans.has(id)) throw new Error('同步进行中，请等待完成后再更改状态。')
    const source = this.requireSource(id)
    const now = new Date().toISOString()
    this.database
      .prepare('UPDATE data_sources SET status = ?, disconnected_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?')
      .run(paused ? 'paused' : 'connected', now, id)

    if (paused) this.stopWatching(id)
    else {
      this.startWatching({ ...source, status: 'connected', disconnected_at: null })
      void this.sync(id).catch(() => undefined)
    }

    return this.toSummary({
      ...source,
      status: paused ? 'paused' : 'connected',
      disconnected_at: null,
      last_error: null,
    })
  }

  async disconnect(id: string, deleteLocalData: boolean): Promise<void> {
    if (this.activeScans.has(id)) throw new Error('同步进行中，请等待完成后再断开。')
    this.requireSource(id)
    this.stopWatching(id)
    if (!deleteLocalData) {
      this.database.prepare(`
        UPDATE data_sources SET status = 'paused', disconnected_at = ?, last_error = NULL, updated_at = ? WHERE id = ?
      `).run(new Date().toISOString(), new Date().toISOString(), id)
      return
    }

    const objectHashes = deleteLocalData
      ? (this.database.prepare(`
          SELECT DISTINCT source_versions.object_hash AS object_hash
          FROM source_versions
          JOIN source_items ON source_items.id = source_versions.source_item_id
          WHERE source_items.data_source_id = ?
        `).all(id) as unknown as Array<{ object_hash: string }>)
      : []

    this.database.prepare('DELETE FROM data_sources WHERE id = ?').run(id)

    for (const { object_hash: objectHash } of objectHashes) {
      const reference = this.database
        .prepare('SELECT 1 FROM source_versions WHERE object_hash = ? LIMIT 1')
        .get(objectHash)
      if (!reference && /^[a-f0-9]{64}$/.test(objectHash)) {
        await unlink(this.objectPath(objectHash)).catch(() => undefined)
      }
    }
  }

  private async performSync(id: string): Promise<SyncResult> {
    const source = this.requireSource(id)
    if (source.disconnected_at) throw new Error('该数据源已断开，请先重新连接。')
    if (source.status === 'paused') throw new Error('该数据源已暂停，请先恢复同步。')

    const runId = randomUUID()
    const startedAt = new Date().toISOString()
    const counts = { discovered: 0, added: 0, updated: 0, moved: 0, unchanged: 0, removed: 0, failed: 0 }

    this.database.prepare(`
      INSERT INTO sync_runs (id, data_source_id, status, started_at)
      VALUES (?, ?, 'running', ?)
    `).run(runId, id, startedAt)
    this.database
      .prepare("UPDATE data_sources SET status = 'syncing', last_error = NULL, updated_at = ? WHERE id = ?")
      .run(startedAt, id)

    try {
      const files = await this.collectFiles(source.root_path, counts)
      counts.discovered = files.length
      const existingItems = this.database
        .prepare('SELECT id, file_identity, relative_path, content_hash, state FROM source_items WHERE data_source_id = ?')
        .all(id) as unknown as ItemRow[]
      const itemsByIdentity = new Map(existingItems.map((item) => [item.file_identity, item]))
      const itemsByPath = new Map(existingItems.map((item) => [item.relative_path, item]))
      const seenIdentities = new Set<string>()

      for (const file of files) {
        const existingItem = itemsByIdentity.get(file.identity) ?? itemsByPath.get(file.relativePath)
        seenIdentities.add(file.identity)
        if (existingItem) seenIdentities.add(existingItem.file_identity)

        try {
          const contentHash = await this.hashFile(file.absolutePath)

          if (!existingItem) {
            await this.storeObject(file.absolutePath, contentHash)
            this.insertItemAndVersion(id, runId, file, contentHash)
            counts.added += 1
            continue
          }

          const moved = existingItem.relative_path !== file.relativePath
          const restored = existingItem.state === 'missing'
          if (existingItem.content_hash === contentHash) {
            if (moved) {
              const status = basename(existingItem.relative_path) === basename(file.relativePath)
                ? 'moved'
                : 'renamed'
              this.recordItemChange(existingItem, runId, file, contentHash, status)
              counts.moved += 1
            } else if (restored) {
              this.recordItemChange(existingItem, runId, file, contentHash, 'restored')
              counts.added += 1
            } else {
              this.markItemSeen(existingItem.id, file, contentHash)
              counts.unchanged += 1
            }
            continue
          }

          await this.storeObject(file.absolutePath, contentHash)
          this.recordItemChange(existingItem, runId, file, contentHash, 'updated')
          this.insertVersion(existingItem.id, file, contentHash)
          if (moved) counts.moved += 1
          counts.updated += 1
        } catch {
          if (existingItem) {
            const failedAt = new Date().toISOString()
            this.database.prepare(`
              UPDATE source_items
              SET sync_status = 'error', previous_relative_path = NULL,
                  last_change_run_id = ?, last_changed_at = ?, last_seen_at = ?
              WHERE id = ?
            `).run(runId, failedAt, failedAt, existingItem.id)
          }
          counts.failed += 1
        }
      }

      const missingItems = existingItems.filter(
        (item) => item.state === 'present' && !seenIdentities.has(item.file_identity),
      )
      if (missingItems.length > 0) {
        const markMissing = this.database.prepare(`
          UPDATE source_items
          SET state = 'missing', sync_status = 'missing', previous_relative_path = NULL,
              last_change_run_id = ?, last_changed_at = ?
          WHERE id = ?
        `)
        const changedAt = new Date().toISOString()
        for (const item of missingItems) markMissing.run(runId, changedAt, item.id)
        counts.removed = missingItems.length
      }

      const finishedAt = new Date().toISOString()
      this.finishRun(runId, 'success', counts, finishedAt, null)
      const hasChanges = counts.added > 0 || counts.updated > 0 || counts.moved > 0 ||
        counts.removed > 0 || counts.failed > 0
      this.database.prepare(`
        UPDATE data_sources
        SET status = 'connected', last_synced_at = ?, last_error = NULL,
            last_change_run_id = CASE WHEN ? THEN ? ELSE last_change_run_id END,
            updated_at = ?
        WHERE id = ?
      `).run(finishedAt, hasChanges ? 1 : 0, runId, finishedAt, id)

      return { source: this.getSummary(id), ...counts }
    } catch (error) {
      const message = error instanceof Error ? error.message : '同步失败'
      const finishedAt = new Date().toISOString()
      this.finishRun(runId, 'failed', counts, finishedAt, message)
      this.database.prepare(`
        UPDATE data_sources SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?
      `).run(message, finishedAt, id)
      throw new Error(message)
    }
  }

  private startWatching(source: SourceRow): void {
    if (!this.verificationTimers.has(source.id)) {
      this.verificationTimers.set(source.id, setInterval(() => {
        if (!this.activeScans.has(source.id)) void this.sync(source.id).catch(() => undefined)
      }, 5_000))
    }
    if (this.watchers.has(source.id)) return

    try {
      const watcher = watch(source.root_path, { recursive: true }, () => {
        const existingTimer = this.watchTimers.get(source.id)
        if (existingTimer) clearTimeout(existingTimer)
        this.watchTimers.set(source.id, setTimeout(() => {
          this.watchTimers.delete(source.id)
          void this.sync(source.id).catch(() => undefined)
        }, 750))
      })
      watcher.on('error', () => {
        watcher.close()
        this.watchers.delete(source.id)
      })
      this.watchers.set(source.id, watcher)
    } catch {
      // Periodic verification remains active when native watching is unavailable.
    }
  }

  private stopWatching(id: string): void {
    const timer = this.watchTimers.get(id)
    if (timer) clearTimeout(timer)
    this.watchTimers.delete(id)
    this.watchers.get(id)?.close()
    this.watchers.delete(id)
    const verificationTimer = this.verificationTimers.get(id)
    if (verificationTimer) clearInterval(verificationTimer)
    this.verificationTimers.delete(id)
  }

  private async collectFiles(
    rootPath: string,
    counts: Pick<SyncResult, 'failed'>,
  ): Promise<ScannedFile[]> {
    const files: ScannedFile[] = []
    const visit = async (directory: string, isRoot = false): Promise<void> => {
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        if (isRoot) throw error
        counts.failed += 1
        return
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const absolutePath = join(directory, entry.name)
        if (entry.isDirectory()) {
          await visit(absolutePath)
          continue
        }
        if (!entry.isFile()) continue

        const extension = extname(entry.name).toLowerCase()
        if (!SUPPORTED_EXTENSIONS.has(extension)) continue

        try {
          const info = await stat(absolutePath)
          files.push({
            absolutePath,
            relativePath: relative(rootPath, absolutePath),
            identity: info.ino > 0 ? `${info.dev}:${info.ino}` : relative(rootPath, absolutePath),
            extension,
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
          })
        } catch {
          counts.failed += 1
        }
      }
    }

    await visit(rootPath, true)
    return files
  }

  private hashFile(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256')
      const stream = createReadStream(path)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(hash.digest('hex')))
    })
  }

  private async storeObject(sourcePath: string, hash: string): Promise<void> {
    const destination = this.objectPath(hash)
    try {
      await stat(destination)
      return
    } catch {
      // Capture and verify below.
    }

    const destinationDirectory = join(this.objectsDirectory, hash.slice(0, 2))
    const temporaryPath = join(destinationDirectory, `.${hash}.${randomUUID()}.tmp`)
    await mkdir(destinationDirectory, { recursive: true })
    try {
      await copyFile(sourcePath, temporaryPath)
      const capturedHash = await this.hashFile(temporaryPath)
      if (capturedHash !== hash) throw new Error('文件在扫描过程中发生变化，请重新扫描。')
      await rename(temporaryPath, destination)
    } finally {
      await unlink(temporaryPath).catch(() => undefined)
    }
  }

  private objectPath(hash: string): string {
    return join(this.objectsDirectory, hash.slice(0, 2), hash)
  }

  private insertItemAndVersion(
    dataSourceId: string,
    runId: string,
    file: ScannedFile,
    hash: string,
  ): void {
    const itemId = randomUUID()
    const now = new Date().toISOString()
    this.database.prepare(`
      INSERT INTO source_items (
        id, data_source_id, file_identity, relative_path, extension, size, modified_at,
        content_hash, state, sync_status, previous_relative_path, last_change_run_id, last_changed_at,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'present', 'added', NULL, ?, ?, ?, ?)
    `).run(
      itemId,
      dataSourceId,
      file.identity,
      file.relativePath,
      file.extension,
      file.size,
      file.modifiedAt,
      hash,
      runId,
      now,
      now,
      now,
    )
    this.insertVersion(itemId, file, hash)
  }

  private recordItemChange(
    existingItem: ItemRow,
    runId: string,
    file: ScannedFile,
    hash: string,
    status: Exclude<SourceFileStatus, 'added' | 'unchanged' | 'missing' | 'error'>,
  ): void {
    const previousPath = existingItem.relative_path === file.relativePath
      ? null
      : existingItem.relative_path
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE source_items
      SET file_identity = ?, relative_path = ?, extension = ?, size = ?, modified_at = ?, content_hash = ?,
          state = 'present', sync_status = ?, previous_relative_path = ?,
          last_change_run_id = ?, last_changed_at = ?, last_seen_at = ?
      WHERE id = ?
    `).run(
      file.identity,
      file.relativePath,
      file.extension,
      file.size,
      file.modifiedAt,
      hash,
      status,
      previousPath,
      runId,
      now,
      now,
      existingItem.id,
    )
  }

  private markItemSeen(itemId: string, file: ScannedFile, hash: string): void {
    this.database.prepare(`
      UPDATE source_items
      SET file_identity = ?, relative_path = ?, extension = ?, size = ?, modified_at = ?,
          content_hash = ?, state = 'present', last_seen_at = ?
      WHERE id = ?
    `).run(
      file.identity,
      file.relativePath,
      file.extension,
      file.size,
      file.modifiedAt,
      hash,
      new Date().toISOString(),
      itemId,
    )
  }

  private insertVersion(itemId: string, file: ScannedFile, hash: string): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO source_versions (
        id, source_item_id, content_hash, object_hash, size, source_modified_at, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), itemId, hash, hash, file.size, file.modifiedAt, new Date().toISOString())
  }

  private finishRun(
    runId: string,
    status: 'success' | 'failed',
    counts: Omit<SyncResult, 'source'>,
    finishedAt: string,
    errorMessage: string | null,
  ): void {
    this.database.prepare(`
      UPDATE sync_runs SET
        status = ?, discovered = ?, added = ?, updated = ?, moved = ?, unchanged = ?,
        removed = ?, failed = ?, error_message = ?, finished_at = ?
      WHERE id = ?
    `).run(
      status,
      counts.discovered,
      counts.added,
      counts.updated,
      counts.moved,
      counts.unchanged,
      counts.removed,
      counts.failed,
      errorMessage,
      finishedAt,
      runId,
    )
  }

  private requireSource(id: string): SourceRow {
    const source = this.database
      .prepare('SELECT * FROM data_sources WHERE id = ?')
      .get(id) as unknown as SourceRow | undefined
    if (!source) throw new Error('数据源不存在或已断开。')
    return source
  }

  private getSummary(id: string): DataSourceSummary {
    return this.toSummary(this.requireSource(id))
  }

  private toSummary(source: SourceRow): DataSourceSummary {
    const counts = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM source_items
          WHERE data_source_id = ? AND state = 'present') AS file_count,
        (SELECT COUNT(*) FROM source_versions
          JOIN source_items ON source_items.id = source_versions.source_item_id
          WHERE source_items.data_source_id = ?) AS version_count,
        (SELECT COALESCE(SUM(size), 0) FROM source_items
          WHERE data_source_id = ? AND state = 'present') AS total_bytes
    `).get(source.id, source.id, source.id) as unknown as CountRow

    return {
      id: source.id,
      kind: source.kind,
      name: source.name,
      rootPath: source.root_path,
      status: source.disconnected_at ? 'disconnected' : source.status,
      fileCount: Number(counts.file_count ?? 0),
      versionCount: Number(counts.version_count ?? 0),
      totalBytes: Number(counts.total_bytes ?? 0),
      lastSyncedAt: source.last_synced_at,
      lastError: source.last_error,
      createdAt: source.created_at,
    }
  }
}
