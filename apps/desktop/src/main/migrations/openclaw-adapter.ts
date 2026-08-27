import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { createGunzip } from 'node:zlib'
import Database from 'better-sqlite3'
import tar from 'tar-stream'
import type { DiscoveredMigrationSource } from '../../shared/migrations'
import type { NormalizedMigrationThread } from './types'

const MAX_ARCHIVE_FILES = 10_000
const MAX_ARCHIVE_FILE_BYTES = 256 * 1024 * 1024
const MAX_ARCHIVE_TOTAL_BYTES = 1024 * 1024 * 1024
const SQLITE_SCHEMA_MIN = 4
const SQLITE_SCHEMA_MAX = 17
const VISIBLE_ROLES = new Set(['user', 'assistant'])
const TRANSCRIPT_TABLE_HINT = /(?:message|transcript|event)/iu
const SESSION_TABLE_HINT = /session/iu

export interface ResolvedOpenClawSource extends DiscoveredMigrationSource { path: string }

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const safeIso = (value: unknown, fallback = Date.now()): string => {
  if (typeof value === 'number') return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString()
  if (typeof value === 'string') { const timestamp = Date.parse(value); if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString() }
  return new Date(fallback).toISOString()
}
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export async function discoverOpenClawSources(root = join(homedir(), '.openclaw')): Promise<ResolvedOpenClawSource[]> {
  if (!existsSync(root)) return []
  const files = await collectAllowedFiles(root)
  if (!files.some((path) => path.endsWith('.jsonl') || path.endsWith('.sqlite'))) return []
  // A standard OpenClaw installation is one logical source. Its internal global and
  // per-Agent stores must not make the user choose an implementation directory.
  return [{ provider: 'openclaw', id: hash(resolve(root)), displayName: 'OpenClaw', transport: 'directory', standard: true, path: root }]
}

function unsafeArchivePath(name: string): boolean {
  const normalized = name.replace(/\\/gu, '/')
  return normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized) || normalized.split('/').some((part) => part === '..')
}

export async function extractOpenClawArchive(archivePath: string): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'everroom-openclaw-'))
  const extract = tar.extract(); let files = 0; let total = 0
  const completed = new Promise<void>((resolvePromise, rejectPromise) => {
    extract.on('entry', (header, stream, next) => {
      const name = header.name
      const allowed = /(?:\.sqlite|sessions\.json|\.jsonl)$/iu.test(name)
      if (unsafeArchivePath(name) || header.type === 'symlink' || header.type === 'link') return rejectPromise(new Error('OpenClaw archive contains an unsafe path or link'))
      if (!allowed || header.type !== 'file') { stream.resume(); stream.once('end', next); return }
      files += 1; total += header.size
      if (files > MAX_ARCHIVE_FILES || header.size > MAX_ARCHIVE_FILE_BYTES || total > MAX_ARCHIVE_TOTAL_BYTES) return rejectPromise(new Error('OpenClaw archive exceeds migration limits'))
      const chunks: Buffer[] = []
      stream.on('data', (chunk: unknown) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer)) })
      stream.on('end', async () => {
        try {
          const target = join(directory, hash(name) + extname(name).toLowerCase())
          await import('node:fs/promises').then(({ writeFile }) => writeFile(target, Buffer.concat(chunks)))
          next()
        } catch (error) { rejectPromise(error) }
      })
    })
    extract.once('finish', resolvePromise); extract.once('error', rejectPromise)
  })
  createReadStream(archivePath).pipe(createGunzip()).pipe(extract)
  try { await completed } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

async function collectAllowedFiles(directory: string): Promise<string[]> {
  const root = resolve(directory); const files: string[] = []
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const path = resolve(current, entry.name)
      if (!path.startsWith(`${root}${sep}`) && path !== root) throw new Error('Unsafe OpenClaw source path')
      const relativePath = relative(root, path).replace(/\\/gu, '/')
      const segments = relativePath.split('/')
      if (entry.isDirectory() && !segments.some((part) => ['audit', 'logs', 'log', 'config', 'credentials', 'service-env', 'skills', 'memory'].includes(part.toLowerCase()))) await visit(path)
      else if (entry.isFile() && entry.name === 'sessions.json') files.push(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.endsWith('.trajectory.jsonl')) files.push(path)
      else if (entry.isFile() && entry.name.endsWith('.sqlite') && !['state/openclaw.sqlite'].includes(relativePath) && !relativePath.endsWith('/agent/openclaw-agent.sqlite')) files.push(path)
      if (files.length > MAX_ARCHIVE_FILES) throw new Error('OpenClaw source contains too many files')
    }
  }
  const standardAgentRoot = join(root, 'agents')
  if (basename(root) === '.openclaw' && existsSync(standardAgentRoot)) {
    for (const agent of await readdir(standardAgentRoot, { withFileTypes: true }).catch(() => [])) {
      if (!agent.isDirectory()) continue
      const sessionsDirectory = join(standardAgentRoot, agent.name, 'sessions')
      if (existsSync(sessionsDirectory)) await visit(sessionsDirectory)
    }
  } else {
    await visit(root)
  }
  return files.sort()
}

function parseVisibleContent(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value)) return ''
  return value.flatMap((part) => {
    const item = record(part)
    const type = text(item.type).toLowerCase()
    if (type && !['text', 'input_text', 'output_text'].includes(type)) return []
    const content = text(item.text) || text(item.content)
    return content ? [content] : []
  }).join('\n').trim()
}

function normalizedMessage(value: unknown, ordinal: number): NormalizedMigrationThread['messages'][number] | null {
  const item = record(value); const nested = record(item.message)
  const role = (text(item.role) || text(nested.role)).toLowerCase()
  if (!VISIBLE_ROLES.has(role)) return null
  if (item.tool_call || item.toolCall || item.thinking || item.reasoning || nested.tool_call || nested.toolCall || nested.tool_calls || nested.thinking || nested.reasoning) return null
  const content = parseVisibleContent(item.content ?? nested.content ?? item.text ?? nested.text)
  if (!content) return null
  const occurredAt = safeIso(item.timestamp ?? item.created_at ?? item.createdAt ?? nested.timestamp, ordinal)
  return { stableKey: text(item.id) || text(item.event_id) || hash(`${role}\0${occurredAt}\0${content}`).slice(0, 48), role: role as 'user' | 'assistant', content, occurredAt }
}

function threadsFromJsonl(content: string, filePath: string, sessions: Record<string, Record<string, unknown>>): NormalizedMigrationThread[] {
  const grouped = new Map<string, NormalizedMigrationThread['messages']>()
  content.split(/\r?\n/u).forEach((line, ordinal) => {
    if (!line.trim()) return
    let item: Record<string, unknown>; try { item = record(JSON.parse(line)) } catch { throw new Error(`Damaged OpenClaw JSONL: ${basename(filePath)}`) }
    const message = normalizedMessage(item, ordinal); if (!message) return
    const sessionId = text(item.session_id) || text(item.sessionId) || text(record(item.message).session_id) || basename(filePath, extname(filePath))
    const messages = grouped.get(sessionId) ?? []; messages.push(message); grouped.set(sessionId, messages)
  })
  const parts = resolve(filePath).split(sep); const agentMarker = parts.lastIndexOf('agents')
  const agentId = agentMarker >= 0 ? parts[agentMarker + 1] : undefined
  return [...grouped].map(([sessionId, messages]) => ({ stableKey: `${agentId ?? 'legacy'}:${sessionId}`, ...(agentId ? { agentId } : {}), externalSessionId: sessionId,
    title: text(sessions[sessionId]?.title) || text(sessions[sessionId]?.label) || `OpenClaw ${sessionId.slice(0, 8)}`, messages }))
}

function sqliteTables(database: Database.Database): string[] {
  return (database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((row) => row.name)
}

function quoteIdentifier(value: string): string { return `"${value.replace(/"/gu, '""')}"` }

async function threadsFromSqlite(filePath: string): Promise<NormalizedMigrationThread[]> {
  const temp = join(tmpdir(), `everroom-openclaw-${randomUUID()}.sqlite`)
  const source = new Database(filePath, { readonly: true, fileMustExist: true })
  try { await source.backup(temp) } finally { source.close() }
  const database = new Database(temp, { readonly: true, fileMustExist: true })
  try {
    const version = database.pragma('user_version', { simple: true }) as number
    if (version !== 0 && (version < SQLITE_SCHEMA_MIN || version > SQLITE_SCHEMA_MAX)) throw new Error(`Unsupported OpenClaw schema version: ${version}`)
    const tables = sqliteTables(database); const messageTable = tables.find((name) => TRANSCRIPT_TABLE_HINT.test(name));
    if (!messageTable) throw new Error('OpenClaw transcript table was not found')
    const columns = (database.prepare(`PRAGMA table_info(${quoteIdentifier(messageTable)})`).all() as Array<{ name: string }>).map((row) => row.name)
    const jsonColumn = columns.find((name) => /(?:payload|data|json|message|event)/iu.test(name))
    const roleColumn = columns.find((name) => /^role$/iu.test(name)); const contentColumn = columns.find((name) => /^(?:content|text|body)$/iu.test(name))
    const sessionColumn = columns.find((name) => /(?:session_id|sessionId|thread_id)/iu.test(name))
    if (!sessionColumn || (!jsonColumn && !(roleColumn && contentColumn))) throw new Error('Unsupported OpenClaw transcript schema')
    const rows = database.prepare(`SELECT * FROM ${quoteIdentifier(messageTable)} ORDER BY rowid`).all() as Record<string, unknown>[]
    const sessions = new Map<string, NormalizedMigrationThread['messages']>()
    rows.forEach((row, ordinal) => {
      let value: unknown = row
      if (jsonColumn && typeof row[jsonColumn] === 'string') { try { value = JSON.parse(row[jsonColumn] as string) } catch { value = row } }
      const merged = { ...row, ...record(value) }; const message = normalizedMessage(merged, ordinal); if (!message) return
      const sessionId = text(merged[sessionColumn]) || text(row[sessionColumn]); if (!sessionId) return
      const list = sessions.get(sessionId) ?? []; list.push(message); sessions.set(sessionId, list)
    })
    const agentId = basename(filePath).includes('agent') ? basename(resolve(filePath, '../../..')) : undefined
    return [...sessions].map(([sessionId, messages]) => ({ stableKey: `${agentId ?? 'default'}:${sessionId}`, ...(agentId ? { agentId } : {}), externalSessionId: sessionId, title: `OpenClaw ${sessionId.slice(0, 8)}`, messages }))
  } finally { database.close(); await rm(temp, { force: true }) }
}

export async function readOpenClawSource(sourcePath: string): Promise<NormalizedMigrationThread[]> {
  const sourceStat = await stat(sourcePath); let directory = sourcePath; let cleanup: (() => Promise<void>) | null = null
  if (sourceStat.isFile() && sourcePath.endsWith('.tar.gz')) { const extracted = await extractOpenClawArchive(sourcePath); directory = extracted.directory; cleanup = extracted.cleanup }
  try {
    const files = sourceStat.isDirectory() || cleanup ? await collectAllowedFiles(directory) : [sourcePath]
    const sessionMetadata: Record<string, Record<string, unknown>> = {}
    for (const path of files.filter((item) => basename(item) === 'sessions.json')) {
      const parsed = record(JSON.parse(await readFile(path, 'utf8')))
      for (const value of Object.values(parsed)) {
        const metadata = record(value); const sessionId = text(metadata.sessionId) || text(metadata.session_id)
        if (sessionId) sessionMetadata[sessionId] = metadata
      }
      Object.assign(sessionMetadata, parsed)
    }
    const threads: NormalizedMigrationThread[] = []
    for (const path of files) {
      if (path.endsWith('.sqlite')) threads.push(...await threadsFromSqlite(path))
      else if (path.endsWith('.jsonl')) threads.push(...threadsFromJsonl(await readFile(path, 'utf8'), path, sessionMetadata))
    }
    if (!threads.length) throw new Error('No supported OpenClaw conversations were found')
    return [...new Map(threads.map((thread) => [thread.stableKey, thread])).values()]
  } finally { await cleanup?.() }
}
