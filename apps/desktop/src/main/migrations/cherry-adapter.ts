import { createHash, randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { DiscoveredMigrationSource } from '../../shared/migrations'
import type { NormalizedMigrationAttachment, NormalizedMigrationThread } from './types'

/** Cherry Studio 新版（SQLite 世代）数据目录；旧 IndexedDB 世代不支持。 */
const CHERRY_DIRECTORY_NAME = 'CherryStudio'
const CHERRY_DB_RELATIVE = ['Data', 'cherrystudio.sqlite']
const CHERRY_FILES_RELATIVE = ['Data', 'Files']
const LEGACY_INDEXEDDB_RELATIVE = ['Data', 'IndexedDB']
const MAX_TOPICS = 50_000
const MAX_MESSAGES = 200_000
const TEXT_PART_TYPES = new Set(['text', 'input_text', 'output_text'])
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu

export interface ResolvedCherrySource extends DiscoveredMigrationSource { path: string }

export interface CherryStoreInfo {
  kind: 'sqlite'
  dbPath: string
  filesRoot: string
  fingerprint: string
  version: number
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const safeIso = (value: unknown, fallback = Date.now()): string => {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString()
  if (typeof value === 'string') { const timestamp = Date.parse(value); if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString() }
  return new Date(fallback).toISOString()
}

export function cherryDataRoot(home = homedir(), platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return join(home, 'AppData', 'Roaming', CHERRY_DIRECTORY_NAME)
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', CHERRY_DIRECTORY_NAME)
  return join(home, '.config', CHERRY_DIRECTORY_NAME)
}

/** 指纹=表/列结构签名：容忍小版本行数差异，拦住结构破裂。 */
function fingerprintDatabase(database: Database.Database): { fingerprint: string; version: number } {
  const version = database.pragma('user_version', { simple: true }) as number
  const objects = database.prepare(
    "SELECT type,name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY type,name",
  ).all() as Array<{ type: string; name: string }>
  const parts: string[] = [`v${version}`]
  for (const object of objects.filter((item) => item.type === 'table')) {
    const columns = (database.prepare(`PRAGMA table_info("${object.name.replace(/"/gu, '""')}")`).all() as Array<{ name: string }>).map((row) => row.name)
    parts.push(`${object.name}(${columns.join(',')})`)
  }
  return { fingerprint: hash(parts.join('|')), version }
}

function requireColumns(database: Database.Database, table: string, expected: string[]): boolean {
  const row = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
  if (!row) return false
  const columns = new Set((database.prepare(`PRAGMA table_info("${table.replace(/"/gu, '""')}")`).all() as Array<{ name: string }>).map((item) => item.name))
  return expected.every((column) => columns.has(column))
}

export function detectCherryStore(root = cherryDataRoot()): CherryStoreInfo | null {
  const dbPath = join(root, ...CHERRY_DB_RELATIVE)
  if (!existsSync(dbPath)) {
    if (existsSync(join(root, ...LEGACY_INDEXEDDB_RELATIVE))) {
      throw new Error('cherry_format_unsupported')
    }
    return null
  }
  let size = 0
  try { size = statSync(dbPath).size } catch { return null }
  if (size === 0) return null
  const source = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    if (!requireColumns(source, 'topic', ['id', 'name']) || !requireColumns(source, 'message', ['id', 'topic_id', 'role', 'data'])) {
      throw new Error('cherry_format_unsupported')
    }
    const { fingerprint, version } = fingerprintDatabase(source)
    return { kind: 'sqlite', dbPath, filesRoot: join(root, ...CHERRY_FILES_RELATIVE), fingerprint, version }
  } finally { source.close() }
}

export async function discoverCherrySources(home = homedir(), platform: NodeJS.Platform = process.platform): Promise<ResolvedCherrySource[]> {
  const root = cherryDataRoot(home, platform)
  let info: CherryStoreInfo | null = null
  try { info = detectCherryStore(root) } catch { return [] }
  if (!info) return []
  return [{ provider: 'cherry', id: hash(root), displayName: 'Cherry Studio', transport: 'directory', standard: true, path: root }]
}

interface CherryFileEntry { id: string; origin: string; name: string; ext: string | null; externalPath: string | null }

function loadFileEntries(database: Database.Database): Map<string, CherryFileEntry> {
  if (!requireColumns(database, 'file_entry', ['id', 'origin', 'name'])) return new Map()
  const hasDeletedAt = (database.prepare('PRAGMA table_info("file_entry")').all() as Array<{ name: string }>).some((column) => column.name === 'deleted_at')
  const rows = database.prepare(
    `SELECT id,origin,name,ext,external_path FROM file_entry${hasDeletedAt ? ' WHERE deleted_at IS NULL' : ''}`,
  ).all() as Array<{ id: string; origin: string; ext: string | null; name: string; external_path: string | null }>
  return new Map(rows.map((row) => [row.id, { id: row.id, origin: row.origin, name: row.name, ext: row.ext, externalPath: row.external_path }]))
}

function extractParts(data: unknown): Record<string, unknown>[] {
  if (typeof data === 'string') {
    try { return extractParts(JSON.parse(data)) } catch { return [] }
  }
  const wrapper = record(data)
  const direct = Array.isArray(wrapper.parts) ? wrapper.parts : undefined
  if (direct) return direct.filter(record)
  const nested = record(wrapper.content)
  if (Array.isArray(nested.parts)) return nested.parts.filter(record)
  return []
}

function resolveFileAttachment(part: Record<string, unknown>, files: Map<string, CherryFileEntry>, filesRoot: string, fallbackName: string): NormalizedMigrationAttachment | null {
  const candidate = [part.fileId, part.id, part.url, part.fileEntryId]
    .map((value) => text(value))
    .map((value) => value.match(UUID_PATTERN)?.[0] ?? '')
    .find((value) => value && files.has(value.toLowerCase()))
  if (!candidate) return null
  const entry = files.get(candidate.toLowerCase())!
  const name = entry.ext ? `${entry.name}.${entry.ext}` : entry.name
  const filePath = entry.origin === 'external' && entry.externalPath ? entry.externalPath
    : join(filesRoot, entry.ext ? `${entry.id}.${entry.ext}` : entry.id)
  return { stableKey: `file:${entry.id}`, name, ...(text(part.mediaType) ? { mimeType: text(part.mediaType) } : {}), filePath }
}

function cherryMessage(row: Record<string, unknown>, files: Map<string, CherryFileEntry>, filesRoot: string): { message: NormalizedMigrationThread['messages'][number] | null; pending: boolean } {
  const status = text(row.status).toLowerCase()
  const role = text(row.role).toLowerCase()
  if (role !== 'user' && role !== 'assistant') return { message: null, pending: false }
  if (status === 'pending') return { message: null, pending: true }
  const parts = extractParts(row.data)
  const textChunks: string[] = []
  const attachments: NormalizedMigrationAttachment[] = []
  for (const part of parts) {
    const type = text(part.type).toLowerCase()
    if (TEXT_PART_TYPES.has(type)) {
      const chunk = text(part.text)
      if (chunk) textChunks.push(chunk)
    } else if (type === 'file') {
      const attachment = resolveFileAttachment(part, files, filesRoot, 'attachment')
      if (attachment) attachments.push(attachment)
    }
  }
  const content = textChunks.join('\n').trim()
  if (!content) return { message: null, pending: false }
  const message: NormalizedMigrationThread['messages'][number] = {
    stableKey: text(row.id) || hash(`${role}\0${text(row.created_at)}\0${content}`).slice(0, 48),
    role: role as 'user' | 'assistant',
    content,
    occurredAt: safeIso(row.created_at ?? row.createdAt, Date.now()),
    ...(attachments.length ? { attachments } : {}),
  }
  return { message, pending: false }
}

/** 读 Cherry Studio SQLite 库。先 backup 到临时文件再只读打开，绝不碰活动库。
 * status=pending 的消息视为未完成记录：该话题停在已确认位置，后续消息不读。 */
export async function readCherrySource(root: string): Promise<{ threads: NormalizedMigrationThread[]; fingerprint: string }> {
  const info = detectCherryStore(root)
  if (!info) throw new Error('cherry_source_not_found')
  const temp = join(tmpdir(), `everroom-cherry-${randomUUID()}.sqlite`)
  const source = new Database(info.dbPath, { readonly: true, fileMustExist: true })
  try { await source.backup(temp) } finally { source.close() }
  const database = new Database(temp, { readonly: true, fileMustExist: true })
  try {
    if (!requireColumns(database, 'topic', ['id', 'name']) || !requireColumns(database, 'message', ['id', 'topic_id', 'role', 'data'])) {
      throw new Error('cherry_format_unsupported')
    }
    const fingerprint = fingerprintDatabase(database).fingerprint
    const files = loadFileEntries(database)
    const topicHasDeletedAt = (database.prepare('PRAGMA table_info("topic")').all() as Array<{ name: string }>).some((column) => column.name === 'deleted_at')
    const messageHasDeletedAt = (database.prepare('PRAGMA table_info("message")').all() as Array<{ name: string }>).some((column) => column.name === 'deleted_at')
    const topics = database.prepare(
      `SELECT id,name FROM topic${topicHasDeletedAt ? ' WHERE deleted_at IS NULL' : ''} ORDER BY created_at ASC`,
    ).all() as Array<{ id: string; name: string }>
    if (topics.length > MAX_TOPICS) throw new Error('Cherry Studio 数据量超出导入上限')
    const rows = database.prepare(
      `SELECT topic_id,id,role,status,data,created_at FROM message WHERE role IN ('user','assistant')${messageHasDeletedAt ? ' AND deleted_at IS NULL' : ''} ORDER BY topic_id, created_at ASC, id ASC`,
    ).all() as Array<Record<string, unknown>>
    if (rows.length > MAX_MESSAGES) throw new Error('Cherry Studio 数据量超出导入上限')
    const grouped = new Map<string, NormalizedMigrationThread['messages']>()
    const pendingTopics = new Set<string>()
    for (const row of rows) {
      const topicId = text(row.topic_id)
      if (!topicId || pendingTopics.has(topicId)) continue
      const { message, pending } = cherryMessage(row, files, info.filesRoot)
      if (pending) { pendingTopics.add(topicId); continue }
      if (!message) continue
      const list = grouped.get(topicId) ?? []
      list.push(message)
      grouped.set(topicId, list)
    }
    const threads: NormalizedMigrationThread[] = []
    for (const topic of topics) {
      const messages = grouped.get(topic.id)
      if (!messages?.length) continue
      threads.push({
        stableKey: `cherry:${topic.id}`,
        externalSessionId: topic.id,
        title: topic.name?.trim() || `Cherry Studio ${topic.id.slice(0, 8)}`,
        messages,
      })
    }
    return { threads, fingerprint }
  } finally {
    database.close()
    await rm(temp, { force: true })
  }
}

/** 附件缺失探测：文件本体不在磁盘上时标记 missing（消息照常导入）。 */
export async function markMissingAttachments(threads: NormalizedMigrationThread[]): Promise<number> {
  let missing = 0
  for (const thread of threads) {
    for (const message of thread.messages) {
      if (!message.attachments?.length) continue
      for (const attachment of message.attachments) {
        if (!attachment.filePath || !existsSync(attachment.filePath)) {
          attachment.missing = true
          delete attachment.filePath
          missing += 1
        }
      }
    }
  }
  return missing
}
