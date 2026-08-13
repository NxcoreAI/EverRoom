import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'

import type {
  EvidenceBlock,
  EvidenceDocument,
  EvidenceParseStatus,
  EvidenceSearchResult,
} from '../../shared/sources'
import { parseMarkdown, parsePlainText, type ParsedEvidenceBlock } from './text-parser'

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx'])
const TEXT_EXTENSIONS = new Set(['.text', '.txt'])
const SUPPORTED_EXTENSIONS = new Set([...MARKDOWN_EXTENSIONS, ...TEXT_EXTENSIONS])

interface PendingJobRow {
  source_version_id: string
  object_hash: string
  extension: string
  data_source_id: string
}

interface EvidenceDocumentRow {
  version_id: string
  file_name: string
  relative_path: string
  extension: string
  modified_at: string
  content_hash: string
  state: 'present' | 'missing'
  status: EvidenceParseStatus | null
  parser: string | null
  error_message: string | null
  parsed_at: string | null
}

interface EvidenceBlockRow {
  id: string
  kind: EvidenceBlock['kind']
  ordinal: number
  parent_id: string | null
  heading_level: number | null
  heading_path_json: string
  page_number: number | null
  start_line: number
  end_line: number
  start_offset: number
  end_offset: number
  text: string
  content_hash: string
}

interface SearchRow extends EvidenceBlockRow {
  source_id: string
  source_name: string
  file_id: string
  file_name: string
  relative_path: string
  version_id: string
  modified_at: string
}

function normalizeForFts(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu, ' $1 ')
    .replace(/[^\p{Letter}\p{Number}_]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function makeFtsQuery(query: string): string | null {
  const normalized = normalizeForFts(query)
  if (!normalized) return null
  return `"${normalized.replaceAll('"', '""')}"`
}

export class EvidenceService {
  private processor: Promise<void> | null = null
  private stopping = false

  constructor(
    private readonly database: DatabaseSync,
    private readonly objectPath: (hash: string) => string,
    private readonly onUpdated: (dataSourceId: string) => void,
  ) {}

  initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS evidence_parse_jobs (
        source_version_id TEXT PRIMARY KEY REFERENCES source_versions(id) ON DELETE CASCADE,
        parser TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        queued_at TEXT NOT NULL,
        started_at TEXT,
        parsed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS evidence_blocks (
        id TEXT PRIMARY KEY,
        source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES evidence_blocks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('heading', 'paragraph')),
        ordinal INTEGER NOT NULL,
        heading_level INTEGER,
        heading_path_json TEXT NOT NULL DEFAULT '[]',
        page_number INTEGER,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        search_text TEXT NOT NULL,
        search_heading_path TEXT NOT NULL,
        UNIQUE(source_version_id, ordinal)
      );

      CREATE INDEX IF NOT EXISTS idx_evidence_blocks_version_ordinal
        ON evidence_blocks(source_version_id, ordinal);

      CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
        search_text,
        search_heading_path,
        content = 'evidence_blocks',
        content_rowid = 'rowid',
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS evidence_blocks_ai AFTER INSERT ON evidence_blocks BEGIN
        INSERT INTO evidence_fts(rowid, search_text, search_heading_path)
        VALUES (new.rowid, new.search_text, new.search_heading_path);
      END;

      CREATE TRIGGER IF NOT EXISTS evidence_blocks_ad AFTER DELETE ON evidence_blocks BEGIN
        INSERT INTO evidence_fts(evidence_fts, rowid, search_text, search_heading_path)
        VALUES ('delete', old.rowid, old.search_text, old.search_heading_path);
      END;

      CREATE TRIGGER IF NOT EXISTS evidence_blocks_au AFTER UPDATE ON evidence_blocks BEGIN
        INSERT INTO evidence_fts(evidence_fts, rowid, search_text, search_heading_path)
        VALUES ('delete', old.rowid, old.search_text, old.search_heading_path);
        INSERT INTO evidence_fts(rowid, search_text, search_heading_path)
        VALUES (new.rowid, new.search_text, new.search_heading_path);
      END;
    `)

    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE evidence_parse_jobs
      SET status = 'pending', error_message = '应用在解析完成前退出', started_at = NULL
      WHERE status = 'running'
    `).run()
    this.database.prepare(`
      INSERT OR IGNORE INTO evidence_parse_jobs (
        source_version_id, parser, status, queued_at
      )
      SELECT source_versions.id,
        CASE WHEN LOWER(source_items.extension) IN ('.md', '.mdx') THEN 'markdown-v1' ELSE 'text-v1' END,
        'pending', ?
      FROM source_versions
      JOIN source_items ON source_items.id = source_versions.source_item_id
      WHERE LOWER(source_items.extension) IN ('.md', '.mdx', '.text', '.txt')
    `).run(now)
    const indexCounts = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM evidence_blocks) AS block_count,
        (SELECT COUNT(*) FROM evidence_fts) AS index_count
    `).get() as unknown as { block_count: number; index_count: number }
    if (Number(indexCounts.block_count) !== Number(indexCounts.index_count)) {
      this.database.exec("INSERT INTO evidence_fts(evidence_fts) VALUES ('rebuild')")
    }
    this.schedulePending()
  }

  enqueueVersion(sourceVersionId: string, extension: string): void {
    const normalizedExtension = extension.toLowerCase()
    if (!SUPPORTED_EXTENSIONS.has(normalizedExtension)) return
    this.database.prepare(`
      INSERT OR IGNORE INTO evidence_parse_jobs (
        source_version_id, parser, status, queued_at
      ) VALUES (?, ?, 'pending', ?)
    `).run(
      sourceVersionId,
      MARKDOWN_EXTENSIONS.has(normalizedExtension) ? 'markdown-v1' : 'text-v1',
      new Date().toISOString(),
    )
    this.schedulePending()
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    await this.processor
  }

  listDocument(dataSourceId: string, fileId: string): EvidenceDocument {
    const row = this.database.prepare(`
      SELECT
        source_versions.id AS version_id,
        source_items.relative_path AS file_name,
        source_items.relative_path,
        source_items.extension,
        source_versions.source_modified_at AS modified_at,
        source_versions.content_hash,
        source_items.state,
        evidence_parse_jobs.status,
        evidence_parse_jobs.parser,
        evidence_parse_jobs.error_message,
        evidence_parse_jobs.parsed_at
      FROM source_items
      JOIN source_versions ON source_versions.id = (
        SELECT latest.id FROM source_versions AS latest
        WHERE latest.source_item_id = source_items.id
        ORDER BY latest.captured_at DESC, latest.rowid DESC
        LIMIT 1
      )
      LEFT JOIN evidence_parse_jobs ON evidence_parse_jobs.source_version_id = source_versions.id
      WHERE source_items.id = ? AND source_items.data_source_id = ?
    `).get(fileId, dataSourceId) as unknown as EvidenceDocumentRow | undefined
    if (!row) throw new Error('文件或文件版本不存在。')

    const status: EvidenceParseStatus = row.status ?? 'unsupported'
    const blocks = status === 'success'
      ? this.database.prepare(`
          SELECT id, kind, ordinal, parent_id, heading_level, heading_path_json,
            page_number, start_line, end_line, start_offset, end_offset, text, content_hash
          FROM evidence_blocks
          WHERE source_version_id = ?
          ORDER BY ordinal
        `).all(row.version_id) as unknown as EvidenceBlockRow[]
      : []

    return {
      sourceId: dataSourceId,
      fileId,
      versionId: row.version_id,
      fileName: row.file_name.split('/').at(-1) ?? row.file_name,
      relativePath: row.relative_path,
      extension: row.extension,
      modifiedAt: row.modified_at,
      contentHash: row.content_hash,
      exists: row.state === 'present',
      status,
      parser: row.parser,
      error: row.error_message,
      parsedAt: row.parsed_at,
      blocks: blocks.map((block) => this.toBlock(block)),
    }
  }

  search(query: string, dataSourceId: string | null, limit = 50): EvidenceSearchResult[] {
    const ftsQuery = makeFtsQuery(query)
    if (!ftsQuery) return []
    const boundedLimit = Math.max(1, Math.min(limit, 100))
    const rows = this.database.prepare(`
      SELECT
        evidence_blocks.id,
        evidence_blocks.kind,
        evidence_blocks.ordinal,
        evidence_blocks.parent_id,
        evidence_blocks.heading_level,
        evidence_blocks.heading_path_json,
        evidence_blocks.page_number,
        evidence_blocks.start_line,
        evidence_blocks.end_line,
        evidence_blocks.start_offset,
        evidence_blocks.end_offset,
        evidence_blocks.text,
        evidence_blocks.content_hash,
        data_sources.id AS source_id,
        data_sources.name AS source_name,
        source_items.id AS file_id,
        source_items.relative_path AS file_name,
        source_items.relative_path,
        source_versions.id AS version_id,
        source_versions.source_modified_at AS modified_at
      FROM evidence_fts
      JOIN evidence_blocks ON evidence_blocks.rowid = evidence_fts.rowid
      JOIN source_versions ON source_versions.id = evidence_blocks.source_version_id
      JOIN source_items ON source_items.id = source_versions.source_item_id
      JOIN data_sources ON data_sources.id = source_items.data_source_id
      WHERE evidence_fts MATCH ?
        AND (? IS NULL OR data_sources.id = ?)
        AND source_versions.id = (
          SELECT latest.id FROM source_versions AS latest
          WHERE latest.source_item_id = source_items.id
          ORDER BY latest.captured_at DESC, latest.rowid DESC
          LIMIT 1
        )
      ORDER BY bm25(evidence_fts), source_items.relative_path, evidence_blocks.ordinal
      LIMIT ?
    `).all(ftsQuery, dataSourceId, dataSourceId, boundedLimit) as unknown as SearchRow[]

    return rows.map((row) => ({
      ...this.toBlock(row),
      sourceId: row.source_id,
      sourceName: row.source_name,
      fileId: row.file_id,
      fileName: row.file_name.split('/').at(-1) ?? row.file_name,
      relativePath: row.relative_path,
      versionId: row.version_id,
      modifiedAt: row.modified_at,
    }))
  }

  private schedulePending(): void {
    if (this.stopping || this.processor) return
    this.processor = this.processPending().finally(() => {
      this.processor = null
      if (!this.stopping && this.hasPending()) this.schedulePending()
    })
  }

  private hasPending(): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM evidence_parse_jobs WHERE status = 'pending' LIMIT 1
    `).get())
  }

  private async processPending(): Promise<void> {
    while (!this.stopping) {
      const job = this.database.prepare(`
        SELECT evidence_parse_jobs.source_version_id, source_versions.object_hash,
          source_items.extension, source_items.data_source_id
        FROM evidence_parse_jobs
        JOIN source_versions ON source_versions.id = evidence_parse_jobs.source_version_id
        JOIN source_items ON source_items.id = source_versions.source_item_id
        WHERE evidence_parse_jobs.status = 'pending'
        ORDER BY evidence_parse_jobs.queued_at
        LIMIT 1
      `).get() as unknown as PendingJobRow | undefined
      if (!job) return
      await this.parseJob(job)
    }
  }

  private async parseJob(job: PendingJobRow): Promise<void> {
    this.database.prepare(`
      UPDATE evidence_parse_jobs
      SET status = 'running', attempt_count = attempt_count + 1,
        error_message = NULL, started_at = ?, parsed_at = NULL
      WHERE source_version_id = ?
    `).run(new Date().toISOString(), job.source_version_id)

    try {
      const buffer = await readFile(this.objectPath(job.object_hash))
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '')
      const blocks = MARKDOWN_EXTENSIONS.has(job.extension.toLowerCase())
        ? parseMarkdown(text)
        : parsePlainText(text)
      this.replaceBlocks(job.source_version_id, blocks)
      this.database.prepare(`
        UPDATE evidence_parse_jobs
        SET status = 'success', error_message = NULL, parsed_at = ?
        WHERE source_version_id = ?
      `).run(new Date().toISOString(), job.source_version_id)
      this.onUpdated(job.data_source_id)
    } catch (error) {
      const message = error instanceof Error ? error.message : '文档解析失败'
      this.database.prepare(`
        UPDATE evidence_parse_jobs
        SET status = 'failed', error_message = ?, parsed_at = ?
        WHERE source_version_id = ?
      `).run(message.slice(0, 500), new Date().toISOString(), job.source_version_id)
      this.onUpdated(job.data_source_id)
    }
  }

  private replaceBlocks(sourceVersionId: string, blocks: ParsedEvidenceBlock[]): void {
    const ids = blocks.map(() => randomUUID())
    const insert = this.database.prepare(`
      INSERT INTO evidence_blocks (
        id, source_version_id, parent_id, kind, ordinal, heading_level,
        heading_path_json, page_number, start_line, end_line, start_offset,
        end_offset, text, content_hash, search_text, search_heading_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare('DELETE FROM evidence_blocks WHERE source_version_id = ?').run(sourceVersionId)
      for (const block of blocks) {
        const headingPath = block.headingPath.join(' / ')
        insert.run(
          ids[block.ordinal],
          sourceVersionId,
          block.parentOrdinal === null ? null : ids[block.parentOrdinal],
          block.kind,
          block.ordinal,
          block.headingLevel,
          JSON.stringify(block.headingPath),
          block.startLine,
          block.endLine,
          block.startOffset,
          block.endOffset,
          block.text,
          createHash('sha256').update(block.text).digest('hex'),
          normalizeForFts(block.text),
          normalizeForFts(headingPath),
        )
      }
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private toBlock(row: EvidenceBlockRow): EvidenceBlock {
    let headingPath: string[] = []
    try {
      const parsed = JSON.parse(row.heading_path_json) as unknown
      if (Array.isArray(parsed) && parsed.every((part) => typeof part === 'string')) {
        headingPath = parsed
      }
    } catch {
      // Malformed legacy metadata does not hide the evidence text.
    }
    return {
      id: row.id,
      kind: row.kind,
      ordinal: Number(row.ordinal),
      parentId: row.parent_id,
      headingLevel: row.heading_level === null ? null : Number(row.heading_level),
      headingPath,
      pageNumber: row.page_number === null ? null : Number(row.page_number),
      startLine: Number(row.start_line),
      endLine: Number(row.end_line),
      startOffset: Number(row.start_offset),
      endOffset: Number(row.end_offset),
      text: row.text,
      contentHash: row.content_hash,
    }
  }
}
