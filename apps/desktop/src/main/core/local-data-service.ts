import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { DatabaseSync } from 'node:sqlite'

import { ConnectorRegistry } from '../connectors/connector-registry'
import type {
  ConnectorConnection,
  ConnectorItem,
  ConnectorKind,
  ConnectorSubscription,
} from '../connectors/types'
import { EvidenceService } from '../evidence/evidence-service'
import {
  isIgnoredLocalDirectory,
  isLocalParseableExtension,
} from '../file-format-policy'
import type {
  DataSourceSummary,
  SourceFileStatus,
  SourceFileSummary,
  MarkdownPreview,
  SourceChangeEvent,
  SyncResult,
} from '../../shared/sources'

interface SourceRow {
  id: string
  kind: ConnectorKind
  name: string
  root_path: string | null
  connection_key: string
  config_json: string
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
  remote_id: string
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
  parse_status: SourceFileSummary['parseStatus'] | null
  evidence_count: number
}

export class LocalDataService {
  private readonly database: DatabaseSync
  private readonly objectsDirectory: string
  private readonly evidence: EvidenceService
  private readonly activeScans = new Map<string, Promise<SyncResult>>()
  private readonly disconnectingSources = new Set<string>()
  private readonly pendingDisconnects = new Set<Promise<void>>()
  private readonly watchers = new Map<string, ConnectorSubscription>()
  private readonly watchTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly verificationTimers = new Map<string, ReturnType<typeof setInterval>>()
  private readonly changeListeners = new Set<(event: SourceChangeEvent) => void>()

  constructor(
    private readonly dataDirectory: string,
    private readonly connectors: ConnectorRegistry,
  ) {
    this.objectsDirectory = join(dataDirectory, 'objects', 'sha256')
    mkdirSync(join(dataDirectory, 'database'), { recursive: true })
    this.database = new DatabaseSync(join(dataDirectory, 'database', 'nxcore.db'))
    this.evidence = new EvidenceService(
      this.database,
      (hash) => this.objectPath(hash),
      (sourceId) => this.notifyChanged(sourceId, true),
    )
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
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        root_path TEXT UNIQUE,
        connection_key TEXT NOT NULL UNIQUE,
        config_json TEXT NOT NULL DEFAULT '{}',
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
        remote_id TEXT,
        title TEXT,
        uri TEXT,
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
        captured_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_source_versions_object_hash
        ON source_versions(object_hash);

      CREATE INDEX IF NOT EXISTS idx_source_versions_item_captured
        ON source_versions(source_item_id, captured_at);

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

      CREATE TABLE IF NOT EXISTS local_service_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)

    const sourceColumns = this.database
      .prepare('PRAGMA table_info(data_sources)')
      .all() as unknown as Array<{ name: string }>
    const sourceSchema = this.database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'data_sources'
    `).get() as unknown as { sql: string }
    if (sourceSchema.sql.includes("CHECK (kind = 'local-folder')")) {
      this.migrateDataSourcesTable(sourceColumns)
    }
    const migratedSourceColumns = this.database
      .prepare('PRAGMA table_info(data_sources)')
      .all() as unknown as Array<{ name: string }>
    if (!migratedSourceColumns.some((column) => column.name === 'disconnected_at')) {
      this.database.exec('ALTER TABLE data_sources ADD COLUMN disconnected_at TEXT')
    }
    if (!migratedSourceColumns.some((column) => column.name === 'last_change_run_id')) {
      this.database.exec('ALTER TABLE data_sources ADD COLUMN last_change_run_id TEXT')
    }
    if (!migratedSourceColumns.some((column) => column.name === 'config_json')) {
      this.database.exec("ALTER TABLE data_sources ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'")
    }
    if (!migratedSourceColumns.some((column) => column.name === 'connection_key')) {
      this.database.exec('ALTER TABLE data_sources ADD COLUMN connection_key TEXT')
      this.database.exec(`
        UPDATE data_sources
        SET connection_key = kind || ':' || COALESCE(root_path, id)
        WHERE connection_key IS NULL
      `)
      this.database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_data_sources_connection_key
        ON data_sources(connection_key)
      `)
    }
    this.database.exec(`
      UPDATE data_sources
      SET config_json = json_object('rootPath', root_path)
      WHERE kind = 'local-folder' AND (config_json = '{}' OR config_json IS NULL)
    `)
    const itemColumns = this.database
      .prepare('PRAGMA table_info(source_items)')
      .all() as unknown as Array<{ name: string }>
    if (!itemColumns.some((column) => column.name === 'sync_status')) {
      this.database.exec("ALTER TABLE source_items ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'unchanged'")
    }
    if (!itemColumns.some((column) => column.name === 'remote_id')) {
      this.database.exec('ALTER TABLE source_items ADD COLUMN remote_id TEXT')
    }
    if (!itemColumns.some((column) => column.name === 'title')) {
      this.database.exec('ALTER TABLE source_items ADD COLUMN title TEXT')
    }
    if (!itemColumns.some((column) => column.name === 'uri')) {
      this.database.exec('ALTER TABLE source_items ADD COLUMN uri TEXT')
    }
    this.database.exec(`
      UPDATE source_items
      SET remote_id = COALESCE(remote_id, file_identity),
          title = COALESCE(title, relative_path),
          uri = COALESCE(uri, relative_path)
      WHERE remote_id IS NULL OR title IS NULL OR uri IS NULL
    `)
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
    this.database.exec(`
      UPDATE source_items
      SET sync_status = CASE
        WHEN state = 'missing' THEN 'missing'
        WHEN (
          SELECT COUNT(*) FROM source_versions
          WHERE source_versions.source_item_id = source_items.id
        ) > 1 THEN 'updated'
        WHEN (
          SELECT COUNT(*) FROM source_versions
          WHERE source_versions.source_item_id = source_items.id
        ) = 1 THEN 'added'
        ELSE sync_status
      END
      WHERE sync_status = 'unchanged'
    `)
    const versionSchema = this.database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'source_versions'
    `).get() as unknown as { sql: string }
    if (versionSchema.sql.includes('UNIQUE(source_item_id, content_hash)')) {
      this.migrateSourceVersionsTable()
    }
    this.backfillLatestChangeRuns()
    this.evidence.initialize()

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

  private migrateDataSourcesTable(columns: Array<{ name: string }>): void {
    const hasDisconnectedAt = columns.some((column) => column.name === 'disconnected_at')
    const hasLastChangeRunId = columns.some((column) => column.name === 'last_change_run_id')
    const disconnectedAt = hasDisconnectedAt ? 'disconnected_at' : 'NULL'
    const lastChangeRunId = hasLastChangeRunId ? 'last_change_run_id' : 'NULL'

    this.database.exec(`
      PRAGMA foreign_keys = OFF;
      PRAGMA legacy_alter_table = ON;
      BEGIN IMMEDIATE;

      ALTER TABLE data_sources RENAME TO data_sources_legacy;

      CREATE TABLE data_sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        root_path TEXT UNIQUE,
        connection_key TEXT NOT NULL UNIQUE,
        config_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        last_synced_at TEXT,
        last_error TEXT,
        last_change_run_id TEXT,
        disconnected_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO data_sources (
        id, kind, name, root_path, connection_key, config_json, status, last_synced_at, last_error,
        last_change_run_id, disconnected_at, created_at, updated_at
      )
      SELECT
        id, kind, name, root_path, kind || ':' || COALESCE(root_path, id),
        json_object('rootPath', root_path), status,
        last_synced_at, last_error, ${lastChangeRunId}, ${disconnectedAt}, created_at, updated_at
      FROM data_sources_legacy;

      DROP TABLE data_sources_legacy;
      COMMIT;
      PRAGMA legacy_alter_table = OFF;
      PRAGMA foreign_keys = ON;
    `)

    const foreignKeyIssues = this.database.prepare('PRAGMA foreign_key_check').all()
    if (foreignKeyIssues.length > 0) {
      throw new Error('数据源数据库迁移后外键检查失败。')
    }
  }

  private migrateSourceVersionsTable(): void {
    this.database.exec(`
      PRAGMA foreign_keys = OFF;
      PRAGMA legacy_alter_table = ON;
      BEGIN IMMEDIATE;

      ALTER TABLE source_versions RENAME TO source_versions_legacy;

      CREATE TABLE source_versions (
        id TEXT PRIMARY KEY,
        source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        object_hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        source_modified_at TEXT NOT NULL,
        captured_at TEXT NOT NULL
      );

      INSERT INTO source_versions (
        id, source_item_id, content_hash, object_hash, size, source_modified_at, captured_at
      )
      SELECT
        id, source_item_id, content_hash, object_hash, size, source_modified_at, captured_at
      FROM source_versions_legacy;

      DROP TABLE source_versions_legacy;
      CREATE INDEX IF NOT EXISTS idx_source_versions_object_hash
        ON source_versions(object_hash);
      CREATE INDEX IF NOT EXISTS idx_source_versions_item_captured
        ON source_versions(source_item_id, captured_at);

      COMMIT;
      PRAGMA legacy_alter_table = OFF;
      PRAGMA foreign_keys = ON;
    `)

    const foreignKeyIssues = this.database.prepare('PRAGMA foreign_key_check').all()
    if (foreignKeyIssues.length > 0) {
      throw new Error('文件版本数据库迁移后外键检查失败。')
    }
  }

  private backfillLatestChangeRuns(): void {
    this.database.exec(`
      UPDATE data_sources
      SET last_change_run_id = (
        SELECT sync_runs.id
        FROM sync_runs
        WHERE sync_runs.data_source_id = data_sources.id
          AND sync_runs.status = 'success'
          AND (
            sync_runs.added > 0 OR sync_runs.updated > 0 OR sync_runs.moved > 0 OR
            sync_runs.removed > 0 OR sync_runs.failed > 0
          )
        ORDER BY sync_runs.finished_at DESC, sync_runs.started_at DESC
        LIMIT 1
      )
      WHERE last_change_run_id IS NULL
    `)

    this.database.exec(`
      UPDATE source_items
      SET last_change_run_id = (
        SELECT sync_runs.id
        FROM sync_runs
        WHERE sync_runs.data_source_id = source_items.data_source_id
          AND sync_runs.status = 'success'
          AND (
            EXISTS (
              SELECT 1
              FROM source_versions
              WHERE source_versions.source_item_id = source_items.id
                AND source_versions.captured_at >= sync_runs.started_at
                AND source_versions.captured_at <= COALESCE(sync_runs.finished_at, sync_runs.started_at)
            )
            OR (
              source_items.sync_status IN ('renamed', 'moved', 'restored', 'error')
              AND source_items.last_changed_at >= sync_runs.started_at
              AND source_items.last_changed_at <= COALESCE(sync_runs.finished_at, sync_runs.started_at)
            )
          )
        ORDER BY sync_runs.finished_at DESC, sync_runs.started_at DESC
        LIMIT 1
      )
      WHERE last_change_run_id IS NULL
    `)
  }

  async shutdown(): Promise<void> {
    for (const timer of this.watchTimers.values()) clearTimeout(timer)
    this.watchTimers.clear()
    for (const timer of this.verificationTimers.values()) clearInterval(timer)
    this.verificationTimers.clear()
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    await Promise.allSettled(this.activeScans.values())
    await Promise.allSettled(this.pendingDisconnects)
    await this.evidence.shutdown()
    this.database.close()
  }

  listSources(): DataSourceSummary[] {
    const rows = this.database
      .prepare('SELECT * FROM data_sources ORDER BY created_at DESC')
      .all() as unknown as SourceRow[]

    return rows.map((row) => this.toSummary(row))
  }

  onChanged(listener: (event: SourceChangeEvent) => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
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
        COUNT(source_versions.id) AS version_count,
        (
          SELECT evidence_parse_jobs.status
          FROM source_versions AS latest_version
          LEFT JOIN evidence_parse_jobs
            ON evidence_parse_jobs.source_version_id = latest_version.id
          WHERE latest_version.source_item_id = source_items.id
          ORDER BY latest_version.captured_at DESC, latest_version.rowid DESC
          LIMIT 1
        ) AS parse_status,
        (
          SELECT COUNT(*)
          FROM evidence_blocks
          WHERE evidence_blocks.source_version_id = (
            SELECT latest_evidence_version.id
            FROM source_versions AS latest_evidence_version
            WHERE latest_evidence_version.source_item_id = source_items.id
            ORDER BY latest_evidence_version.captured_at DESC, latest_evidence_version.rowid DESC
            LIMIT 1
          )
        ) AS evidence_count
      FROM source_items
      LEFT JOIN source_versions ON source_versions.source_item_id = source_items.id
      WHERE source_items.data_source_id = ?
      GROUP BY source_items.id
      ORDER BY source_items.state = 'missing', source_items.relative_path COLLATE NOCASE
    `).all(dataSourceId) as unknown as FileSummaryRow[]

    const source = this.requireSource(dataSourceId)
    const connector = this.connectors.get(source.kind)
    const connection = this.toConnection(source)
    return rows.map((row) => ({
      id: row.id,
      name: basename(row.relative_path),
      relativePath: row.relative_path,
      previousRelativePath: row.previous_relative_path,
      originalPath: connector.resolveLocalPath
        ? connector.resolveLocalPath(connection, row.relative_path)
        : row.relative_path,
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
      parseStatus: row.parse_status ?? 'unsupported',
      evidenceCount: Number(row.evidence_count),
    }))
  }

  listEvidence(dataSourceId: string, fileId: string) {
    this.requireSource(dataSourceId)
    return this.evidence.listDocument(dataSourceId, fileId)
  }

  async previewFile(dataSourceId: string, fileId: string): Promise<MarkdownPreview> {
    this.requireSource(dataSourceId)
    const row = this.database.prepare(`
      SELECT relative_path, extension, modified_at, content_hash, state
      FROM source_items WHERE id = ? AND data_source_id = ?
    `).get(fileId, dataSourceId) as unknown as {
      relative_path: string
      extension: string
      modified_at: string
      content_hash: string | null
      state: 'present' | 'missing'
    } | undefined
    if (!row) throw new Error('文件记录不存在。')
    if (row.state !== 'present' || !row.content_hash) throw new Error('文件当前不可预览。')
    if (!['.md', '.mdx', '.markdown'].includes(row.extension.toLowerCase())) throw new Error('仅支持 Markdown 文件预览。')
    const content = await readFile(this.objectPath(row.content_hash), 'utf8')
    if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) throw new Error('Markdown 文件过大，无法预览。')
    return { fileName: basename(row.relative_path), relativePath: row.relative_path, modifiedAt: row.modified_at, content }
  }

  searchEvidence(query: string, dataSourceId: string | null) {
    if (dataSourceId) this.requireSource(dataSourceId)
    return this.evidence.search(query, dataSourceId)
  }

  getOriginalFilePath(dataSourceId: string, fileId: string): string {
    const source = this.requireSource(dataSourceId)
    const connector = this.connectors.get(source.kind)
    if (!connector.resolveLocalPath) throw new Error('该数据源没有可在本机打开的位置。')
    const item = this.database.prepare(`
      SELECT relative_path, state
      FROM source_items
      WHERE id = ? AND data_source_id = ?
    `).get(fileId, dataSourceId) as unknown as
      | { relative_path: string; state: 'present' | 'missing' }
      | undefined

    if (!item) throw new Error('文件记录不存在。')
    if (item.state !== 'present') throw new Error('原始文件当前不存在。')
    return connector.resolveLocalPath(this.toConnection(source), item.relative_path)
  }

  getSourceItemLocation(dataSourceId: string, fileId: string): { kind: 'local' | 'remote'; value: string } {
    const source = this.requireSource(dataSourceId)
    const item = this.database.prepare(`
      SELECT relative_path, uri, state
      FROM source_items
      WHERE id = ? AND data_source_id = ?
    `).get(fileId, dataSourceId) as unknown as
      | { relative_path: string; uri: string | null; state: 'present' | 'missing' }
      | undefined
    if (!item) throw new Error('文件记录不存在。')
    if (item.state !== 'present') throw new Error('原始文件当前不存在。')
    const connector = this.connectors.get(source.kind)
    if (connector.resolveLocalPath) {
      return { kind: 'local', value: connector.resolveLocalPath(this.toConnection(source), item.relative_path) }
    }
    if (!item.uri) throw new Error('该文件没有可打开的来源地址。')
    return { kind: 'remote', value: item.uri }
  }

  async addLocalFolder(rootPath: string): Promise<SyncResult> {
    return this.addConnection('local-folder', basename(rootPath), { rootPath }, rootPath)
  }

  /**
   * 首次启动时连接系统常用目录。标记先于扫描写入，确保用户后续删除或
   * 暂停默认数据源后，不会在下次启动时被应用强制恢复。
   */
  async bootstrapDefaultLocalFolders(rootPaths: string[]): Promise<void> {
    const now = new Date().toISOString()
    const claimed = this.database.prepare(`
      INSERT OR IGNORE INTO local_service_metadata (key, value, updated_at)
      VALUES ('default_local_folders_v1', 'started', ?)
    `).run(now).changes > 0
    if (!claimed) return

    const uniquePaths = [...new Set(rootPaths.map((rootPath) => rootPath.trim()).filter(Boolean))]
    await Promise.all(uniquePaths.map(async (rootPath) => {
      try {
        const info = await stat(rootPath)
        if (!info.isDirectory()) return
        await this.addLocalFolder(rootPath)
      } catch {
        // A denied or unavailable standard folder must not block the other defaults.
      }
    }))
  }

  async addConnection<TConfig>(
    kind: ConnectorKind,
    name: string,
    config: TConfig,
    compatibilityRootPath: string | null = null,
  ): Promise<SyncResult> {
    const connector = this.connectors.get(kind)
    const connectionKey = `${kind}:${connector.getConnectionKey(config)}`
    const existing = this.database
      .prepare('SELECT * FROM data_sources WHERE kind = ? AND connection_key = ?')
      .get(kind, connectionKey) as unknown as SourceRow | undefined

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
      INSERT INTO data_sources (
        id, kind, name, root_path, connection_key, config_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'connected', ?, ?)
    `).run(
      id,
      kind,
      name,
      compatibilityRootPath,
      connectionKey,
      JSON.stringify(config),
      now,
      now,
    )

    const result = await this.sync(id)
    this.startWatching(this.requireSource(id))
    return result
  }

  sync(id: string): Promise<SyncResult> {
    if (this.disconnectingSources.has(id)) {
      return Promise.reject(new Error('数据源正在清理，请稍候。'))
    }
    const running = this.activeScans.get(id)
    if (running) return running

    const scan = this.performSync(id).finally(() => this.activeScans.delete(id))
    this.activeScans.set(id, scan)
    return scan
  }

  setPaused(id: string, paused: boolean): DataSourceSummary {
    if (this.disconnectingSources.has(id)) throw new Error('数据源正在清理，请稍候。')
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

    this.notifyChanged(id, false)

    return this.toSummary({
      ...source,
      status: paused ? 'paused' : 'connected',
      disconnected_at: null,
      last_error: null,
    })
  }

  disconnect(id: string, deleteLocalData: boolean): Promise<void> {
    this.requireSource(id)
    this.stopWatching(id)
    if (!deleteLocalData) {
      this.database.prepare(`
        UPDATE data_sources SET status = 'paused', disconnected_at = ?, last_error = NULL, updated_at = ? WHERE id = ?
      `).run(new Date().toISOString(), new Date().toISOString(), id)
      this.notifyChanged(id, false)
      return Promise.resolve()
    }

    if (this.disconnectingSources.has(id)) return Promise.resolve()
    this.disconnectingSources.add(id)
    this.notifyDeletion(id, 'queued', 5, '已加入清理队列。')

    // The renderer must not wait for a large scan or object cleanup. Keep the
    // source unavailable to new work, then clear its data after the current pass.
    const activeScan = this.activeScans.get(id)
    if (!activeScan) {
      return this.clearSourceData(id).finally(() => this.disconnectingSources.delete(id))
    }

    this.notifyDeletion(id, 'waiting', 15, '正在等待当前扫描结束。')
    const cleanup = (activeScan ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(() => this.clearSourceData(id))
      .finally(() => this.disconnectingSources.delete(id))
    this.pendingDisconnects.add(cleanup)
    void cleanup.then(
      () => this.pendingDisconnects.delete(cleanup),
      () => this.pendingDisconnects.delete(cleanup),
    )
    void cleanup.catch((error) => {
      this.notifyDeletion(id, 'failed', 0, '清理失败，请重试。')
      console.error(`[local-data] failed to clear source ${id}`, error)
    })
    return Promise.resolve()
  }

  private async clearSourceData(id: string): Promise<void> {
    const objectHashes = this.database.prepare(`
      SELECT DISTINCT source_versions.object_hash AS object_hash
      FROM source_versions
      JOIN source_items ON source_items.id = source_versions.source_item_id
      WHERE source_items.data_source_id = ?
    `).all(id) as unknown as Array<{ object_hash: string }>

    this.notifyDeletion(id, 'database', 55, '正在清理数据库记录。')
    const now = new Date().toISOString()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare('DELETE FROM source_items WHERE data_source_id = ?').run(id)
      this.database.prepare('DELETE FROM sync_runs WHERE data_source_id = ?').run(id)
      this.database.prepare(`
        UPDATE data_sources
        SET status = 'paused', last_synced_at = NULL, last_error = NULL,
            last_change_run_id = NULL, disconnected_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(now, id)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    this.notifyDeletion(id, 'objects', 75, '正在删除本地文件副本。')

    let lastPercent = 75
    const totalObjects = Math.max(1, objectHashes.length)
    for (const [index, { object_hash: objectHash }] of objectHashes.entries()) {
      const reference = this.database
        .prepare('SELECT 1 FROM source_versions WHERE object_hash = ? LIMIT 1')
        .get(objectHash)
      if (!reference && /^[a-f0-9]{64}$/.test(objectHash)) {
        await unlink(this.objectPath(objectHash)).catch(() => undefined)
      }
      const percent = 75 + Math.round(((index + 1) / totalObjects) * 25)
      if (percent !== lastPercent) {
        this.notifyDeletion(id, 'objects', percent, '正在删除本地文件副本。')
        lastPercent = percent
      }
    }
    this.notifyDeletion(id, 'completed', 100, '文档数据已清理，目录已保留并暂停扫描。')
    this.notifyChanged(id, true)
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
      const connector = this.connectors.get(source.kind)
      const scan = await connector.scan(this.toConnection(source))
      if (this.disconnectingSources.has(id)) throw new Error('数据源正在清理。')
      // Keep the database boundary defensive: a connector must never be able
      // to reintroduce generated directories or formats without a parser.
      const items = source.kind === 'local-folder'
        ? scan.items.filter((item) => {
            const segments = item.path.split(/[\\/]/)
            const extension = extname(item.path).toLowerCase()
            return !segments.slice(0, -1).some(isIgnoredLocalDirectory) &&
              !item.title.startsWith('.') &&
              isLocalParseableExtension(extension)
          })
        : scan.items
      counts.failed = scan.failed
      counts.discovered = items.length
      const allExistingItems = this.database
        .prepare('SELECT id, remote_id, relative_path, content_hash, state FROM source_items WHERE data_source_id = ?')
        .all(id) as unknown as ItemRow[]
      const filteredItemIds = source.kind === 'local-folder'
        ? await this.pruneFilteredLocalItems(allExistingItems)
        : new Set<string>()
      const existingItems = allExistingItems.filter((item) => !filteredItemIds.has(item.id))
      counts.removed += filteredItemIds.size
      const itemsByRemoteId = new Map(existingItems.map((item) => [item.remote_id, item]))
      const itemsByPath = new Map(existingItems.map((item) => [item.relative_path, item]))
      const seenRemoteIds = new Set<string>()

      for (const item of items) {
        if (this.disconnectingSources.has(id)) throw new Error('数据源正在清理。')
        const existingItem = itemsByRemoteId.get(item.remoteId) ?? itemsByPath.get(item.path)
        seenRemoteIds.add(item.remoteId)
        if (existingItem) seenRemoteIds.add(existingItem.remote_id)

        try {
          const contentHash = await this.hashItem(item)

          if (!existingItem) {
            await this.storeObject(item, contentHash)
            this.insertItemAndVersion(id, runId, item, contentHash)
            counts.added += 1
            continue
          }

          const moved = existingItem.relative_path !== item.path
          const restored = existingItem.state === 'missing'
          if (existingItem.content_hash === contentHash) {
            if (moved) {
              const status = basename(existingItem.relative_path) === basename(item.path)
                ? 'moved'
                : 'renamed'
              this.recordItemChange(existingItem, runId, item, contentHash, status)
              counts.moved += 1
            } else if (restored) {
              this.recordItemChange(existingItem, runId, item, contentHash, 'restored')
              this.insertVersion(existingItem.id, item, contentHash)
              counts.added += 1
            } else {
              this.markItemSeen(existingItem.id, item, contentHash)
              counts.unchanged += 1
            }
            continue
          }

          await this.storeObject(item, contentHash)
          this.recordItemChange(existingItem, runId, item, contentHash, 'updated')
          this.insertVersion(existingItem.id, item, contentHash)
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
        (item) => item.state === 'present' && !seenRemoteIds.has(item.remote_id),
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

      this.notifyChanged(id, hasChanges)

      return { source: this.getSummary(id), ...counts }
    } catch (error) {
      if (this.disconnectingSources.has(id)) throw error
      const message = error instanceof Error ? error.message : '同步失败'
      const finishedAt = new Date().toISOString()
      this.finishRun(runId, 'failed', counts, finishedAt, message)
      this.database.prepare(`
        UPDATE data_sources SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?
      `).run(message, finishedAt, id)
      this.notifyChanged(id, false)
      throw new Error(message)
    }
  }

  private startWatching(source: SourceRow): void {
    if (!this.verificationTimers.has(source.id)) {
      this.verificationTimers.set(source.id, setInterval(() => {
        if (!this.activeScans.has(source.id)) void this.sync(source.id).catch(() => undefined)
      }, 60_000))
    }
    if (this.watchers.has(source.id)) return

    try {
      const connector = this.connectors.get(source.kind)
      if (!connector.watch) return
      const watcher = connector.watch(this.toConnection(source), () => {
        const existingTimer = this.watchTimers.get(source.id)
        if (existingTimer) clearTimeout(existingTimer)
        this.watchTimers.set(source.id, setTimeout(() => {
          this.watchTimers.delete(source.id)
          void this.sync(source.id).catch(() => undefined)
        }, 750))
      })
      if (watcher) this.watchers.set(source.id, watcher)
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

  private hashItem(item: ConnectorItem): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256')
      const stream = item.openContent()
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(hash.digest('hex')))
    })
  }

  private async storeObject(item: ConnectorItem, hash: string): Promise<void> {
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
      await pipeline(item.openContent(), createWriteStream(temporaryPath, { flags: 'wx' }))
      const temporaryHash = await this.hashStoredObject(temporaryPath)
      if (temporaryHash !== hash) {
        throw new Error('文件在扫描过程中发生变化，请重新扫描。')
      }
      await rename(temporaryPath, destination)
    } finally {
      await unlink(temporaryPath).catch(() => undefined)
    }
  }

  private hashStoredObject(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256')
      const stream = createReadStream(path)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(hash.digest('hex')))
    })
  }

  private async pruneFilteredLocalItems(items: ItemRow[]): Promise<Set<string>> {
    const filtered = items.filter((item) => {
      const segments = item.relative_path.split(/[\\/]/)
      const extension = extname(item.relative_path).toLowerCase()
      return segments.slice(0, -1).some(isIgnoredLocalDirectory) ||
      !isLocalParseableExtension(extension)
    })
    if (filtered.length === 0) return new Set()

    const objectHashes = new Set<string>()
    const findVersions = this.database.prepare(
      'SELECT object_hash FROM source_versions WHERE source_item_id = ?',
    )
    const deleteItem = this.database.prepare('DELETE FROM source_items WHERE id = ?')
    for (const item of filtered) {
      const versions = findVersions.all(item.id) as unknown as Array<{ object_hash: string }>
      for (const version of versions) objectHashes.add(version.object_hash)
      deleteItem.run(item.id)
    }

    for (const objectHash of objectHashes) {
      const reference = this.database.prepare(
        'SELECT 1 FROM source_versions WHERE object_hash = ? LIMIT 1',
      ).get(objectHash)
      if (!reference && /^[a-f0-9]{64}$/.test(objectHash)) {
        await unlink(this.objectPath(objectHash)).catch(() => undefined)
      }
    }
    return new Set(filtered.map((item) => item.id))
  }

  private objectPath(hash: string): string {
    return join(this.objectsDirectory, hash.slice(0, 2), hash)
  }

  private notifyChanged(sourceId: string, filesChanged: boolean): void {
    for (const listener of this.changeListeners) listener({ sourceId, filesChanged })
  }

  private notifyDeletion(
    sourceId: string,
    stage: NonNullable<SourceChangeEvent['deletion']>['stage'],
    percent: number,
    message: string,
  ): void {
    for (const listener of this.changeListeners) {
      listener({ sourceId, filesChanged: false, deletion: { stage, percent, message } })
    }
  }

  private insertItemAndVersion(
    dataSourceId: string,
    runId: string,
    item: ConnectorItem,
    hash: string,
  ): void {
    const itemId = randomUUID()
    const now = new Date().toISOString()
    this.database.prepare(`
      INSERT INTO source_items (
        id, data_source_id, file_identity, remote_id, title, uri,
        relative_path, extension, size, modified_at,
        content_hash, state, sync_status, previous_relative_path, last_change_run_id, last_changed_at,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'present', 'added', NULL, ?, ?, ?, ?)
    `).run(
      itemId,
      dataSourceId,
      item.remoteId,
      item.remoteId,
      item.title,
      item.uri,
      item.path,
      item.extension,
      item.byteSize,
      item.modifiedAt,
      hash,
      runId,
      now,
      now,
      now,
    )
    this.insertVersion(itemId, item, hash)
  }

  private recordItemChange(
    existingItem: ItemRow,
    runId: string,
    item: ConnectorItem,
    hash: string,
    status: Exclude<SourceFileStatus, 'added' | 'unchanged' | 'missing' | 'error'>,
  ): void {
    const previousPath = existingItem.relative_path === item.path
      ? null
      : existingItem.relative_path
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE source_items
      SET file_identity = ?, remote_id = ?, title = ?, uri = ?, relative_path = ?,
          extension = ?, size = ?, modified_at = ?, content_hash = ?,
          state = 'present', sync_status = ?, previous_relative_path = ?,
          last_change_run_id = ?, last_changed_at = ?, last_seen_at = ?
      WHERE id = ?
    `).run(
      item.remoteId,
      item.remoteId,
      item.title,
      item.uri,
      item.path,
      item.extension,
      item.byteSize,
      item.modifiedAt,
      hash,
      status,
      previousPath,
      runId,
      now,
      now,
      existingItem.id,
    )
  }

  private markItemSeen(itemId: string, item: ConnectorItem, hash: string): void {
    this.database.prepare(`
      UPDATE source_items
      SET file_identity = ?, remote_id = ?, title = ?, uri = ?, relative_path = ?,
          extension = ?, size = ?, modified_at = ?,
          content_hash = ?, state = 'present', last_seen_at = ?
      WHERE id = ?
    `).run(
      item.remoteId,
      item.remoteId,
      item.title,
      item.uri,
      item.path,
      item.extension,
      item.byteSize,
      item.modifiedAt,
      hash,
      new Date().toISOString(),
      itemId,
    )
  }

  private insertVersion(itemId: string, item: ConnectorItem, hash: string): void {
    const versionId = randomUUID()
    this.database.prepare(`
      INSERT INTO source_versions (
        id, source_item_id, content_hash, object_hash, size, source_modified_at, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(versionId, itemId, hash, hash, item.byteSize, item.modifiedAt, new Date().toISOString())
    this.evidence.enqueueVersion(versionId, item.extension)
  }

  private toConnection(source: SourceRow): ConnectorConnection<any> {
    let config: unknown
    try {
      config = JSON.parse(source.config_json)
    } catch {
      throw new Error(`数据源“${source.name}”的配置无效。`)
    }
    return {
      id: source.id,
      kind: source.kind,
      name: source.name,
      config,
    }
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
      rootPath: source.root_path ?? '',
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
