import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { detectCherryStore, discoverCherrySources, markMissingAttachments, readCherrySource } from './cherry-adapter'
import { CherryWatcher, type CherrySyncCheckpoint } from './cherry-watcher'

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `everroom-${prefix}-`))
  dirs.push(directory)
  return directory
}

function createCherryDatabase(root: string): { db: Database.Database; fileId: string } {
  mkdirSync(join(root, 'Data'), { recursive: true })
  const db = new Database(join(root, 'Data', 'cherrystudio.sqlite'))
  db.exec(`
    CREATE TABLE topic (id text PRIMARY KEY, name text NOT NULL, assistant_id text, active_node_id text, created_at integer NOT NULL, updated_at integer NOT NULL, deleted_at integer);
    CREATE TABLE message (id text PRIMARY KEY, parent_id text, topic_id text NOT NULL, role text NOT NULL, data text NOT NULL, status text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, deleted_at integer);
    CREATE TABLE file_entry (id text PRIMARY KEY, origin text NOT NULL, name text NOT NULL, ext text, size integer, external_path text, deleted_at integer);
  `)
  const fileId = randomUUID()
  db.prepare('INSERT INTO topic(id,name,created_at,updated_at) VALUES(?,?,?,?)').run('topic-1', '发布计划', 1_700_000_000_000, 1_700_000_000_000)
  db.prepare('INSERT INTO message(id,topic_id,role,data,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('m1', 'topic-1', 'user', JSON.stringify({ parts: [{ type: 'text', text: '帮我排期' }] }), 'success', 1_700_000_000_001, 1_700_000_000_001)
  db.prepare('INSERT INTO message(id,topic_id,role,data,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('m2', 'topic-1', 'assistant', JSON.stringify({ parts: [
      { type: 'reasoning', text: '内部思考' },
      { type: 'text', text: '这是计划' },
      { type: 'file', fileId, mediaType: 'application/pdf' },
    ] }), 'success', 1_700_000_000_002, 1_700_000_000_002)
  db.prepare('INSERT INTO file_entry(id,origin,name,ext,size) VALUES(?,?,?,?,?)').run(fileId, 'internal', 'roadmap', 'pdf', 128)
  return { db, fileId }
}

afterEach(async () => { await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

describe('cherry adapter', () => {
  it('detects the sqlite store and rejects the legacy indexeddb layout', async () => {
    const root = await tempDir('cherry-detect')
    expect(detectCherryStore(root)).toBeNull()
    createCherryDatabase(root)
    const info = detectCherryStore(root)
    expect(info?.kind).toBe('sqlite')
    expect(info?.fingerprint.length).toBe(64)

    const legacy = await tempDir('cherry-legacy')
    mkdirSync(join(legacy, 'Data', 'IndexedDB'), { recursive: true })
    expect(() => detectCherryStore(legacy)).toThrow('cherry_format_unsupported')
    await expect(discoverCherrySources(legacy)).resolves.toEqual([])
  })

  it('reads topics and messages, skipping reasoning parts and unresolved files', async () => {
    const root = await tempDir('cherry-read')
    const { db, fileId } = createCherryDatabase(root)
    db.close()
    const { threads, fingerprint } = await readCherrySource(root)
    expect(threads).toHaveLength(1)
    const thread = threads[0]!
    expect(thread.stableKey).toBe('cherry:topic-1')
    expect(thread.title).toBe('发布计划')
    expect(thread.messages).toHaveLength(2)
    expect(thread.messages[0]).toMatchObject({ role: 'user', content: '帮我排期' })
    expect(thread.messages[1]!.content).toBe('这是计划')
    expect(thread.messages[1]!.attachments?.[0]).toMatchObject({ name: 'roadmap.pdf', mimeType: 'application/pdf', filePath: join(root, 'Data', 'Files', `${fileId}.pdf`) })
    expect(typeof fingerprint).toBe('string')
  })

  it('stops a topic at a pending message and keeps already confirmed messages', async () => {
    const root = await tempDir('cherry-pending')
    const { db } = createCherryDatabase(root)
    db.prepare('INSERT INTO message(id,topic_id,role,data,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('m3', 'topic-1', 'assistant', JSON.stringify({ parts: [{ type: 'text', text: '生成中' }] }), 'pending', 1_700_000_000_003, 1_700_000_000_003)
    db.prepare('INSERT INTO message(id,topic_id,role,data,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('m4', 'topic-1', 'assistant', JSON.stringify({ parts: [{ type: 'text', text: '收尾' }] }), 'success', 1_700_000_000_004, 1_700_000_000_004)
    db.close()
    const { threads } = await readCherrySource(root)
    expect(threads[0]!.messages.map((message) => message.stableKey)).toEqual(['m1', 'm2'])
  })

  it('marks attachments missing when the backing file is gone and keeps them when present', async () => {
    const root = await tempDir('cherry-missing')
    const { db, fileId } = createCherryDatabase(root)
    db.close()
    let { threads } = await readCherrySource(root)
    let missing = await markMissingAttachments(threads)
    expect(missing).toBe(1)
    expect(threads[0]!.messages[1]!.attachments?.[0]).toMatchObject({ missing: true })

    mkdirSync(join(root, 'Data', 'Files'), { recursive: true })
    writeFileSync(join(root, 'Data', 'Files', `${fileId}.pdf`), 'pdf-bytes')
    threads = (await readCherrySource(root)).threads
    missing = await markMissingAttachments(threads)
    expect(missing).toBe(0)
    const healthy = threads[0]!.messages[1]!.attachments![0]!
    expect(healthy.missing).toBeUndefined()
    expect(healthy.filePath).toBe(join(root, 'Data', 'Files', `${fileId}.pdf`))
  })
})

describe('cherry watcher', () => {
  it('skips a round entirely when fingerprint, mtime and size all match the checkpoint', async () => {
    const root = await tempDir('cherry-watch')
    const { db } = createCherryDatabase(root)
    db.close()
    const info = detectCherryStore(root)!
    let rounds = 0
    let saved: CherrySyncCheckpoint | null = null
    const watcher = new CherryWatcher(root, {
      runRound: async () => { rounds += 1; return { fingerprint: info.fingerprint } },
      onFatal: () => undefined,
      loadCheckpoint: () => saved,
      saveCheckpoint: (checkpoint) => { saved = checkpoint },
    }, 10, 1)
    watcher.start()
    await watcher.syncNow()
    expect(rounds).toBe(1)
    expect(saved).not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await watcher.syncNow()
    expect(rounds).toBe(1)
    watcher.stop()
  })
})
