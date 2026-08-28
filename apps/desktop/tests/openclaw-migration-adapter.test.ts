import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import Database from 'better-sqlite3'
import tar from 'tar-stream'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverOpenClawSources, extractOpenClawArchive, readOpenClawSource } from '../src/main/migrations/openclaw-adapter'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

describe('OpenClaw migration adapter', () => {
  it('discovers a standard multi-agent installation as one aggregated source', async () => {
    const directory = await mkdtemp(join(tmpdir(), '.openclaw')); dirs.push(directory)
    await mkdir(join(directory, 'agents', 'main', 'sessions'), { recursive: true })
    await mkdir(join(directory, 'agents', 'research', 'sessions'), { recursive: true })
    await mkdir(join(directory, 'state'), { recursive: true })
    await writeFile(join(directory, 'agents', 'main', 'sessions', 'one.jsonl'), JSON.stringify({ role: 'user', content: 'hello' }))
    await writeFile(join(directory, 'agents', 'research', 'sessions', 'two.jsonl'), JSON.stringify({ role: 'user', content: 'world' }))
    await writeFile(join(directory, 'state', 'openclaw.sqlite'), 'not a conversation database')

    const sources = await discoverOpenClawSources(directory)
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ path: directory, transport: 'directory', standard: true })
  })

  it('aggregates standard Agent sessions and ignores trajectory, audit, and config data', async () => {
    const directory = await mkdtemp(join(tmpdir(), '.openclaw')); dirs.push(directory)
    const sessionsDirectory = join(directory, 'agents', 'main', 'sessions')
    await mkdir(sessionsDirectory, { recursive: true })
    await mkdir(join(directory, 'audit'), { recursive: true })
    await writeFile(join(sessionsDirectory, 'sessions.json'), JSON.stringify({
      'agent:main:main': { sessionId: 's1', label: 'Main conversation', skillsSnapshot: { secret: true } },
    }))
    await writeFile(join(sessionsDirectory, 's1.jsonl'), [
      JSON.stringify({ type: 'session', id: 's1' }),
      JSON.stringify({ type: 'message', id: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hello' } }),
      JSON.stringify({ type: 'message', id: 'a1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } }),
    ].join('\n'))
    await writeFile(join(sessionsDirectory, 's1.trajectory.jsonl'), JSON.stringify({ role: 'assistant', content: 'private trace' }))
    await writeFile(join(directory, 'audit', 'events.jsonl'), JSON.stringify({ role: 'user', content: 'audit secret' }))

    const threads = await readOpenClawSource(directory)
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({ agentId: 'main', externalSessionId: 's1', title: 'Main conversation' })
    expect(threads[0]?.messages.map((message) => message.content)).toEqual(['hello', 'answer'])
    expect(JSON.stringify(threads)).not.toContain('private trace')
    expect(JSON.stringify(threads)).not.toContain('audit secret')
    expect(JSON.stringify(threads)).not.toContain('skillsSnapshot')
  })

  it('keeps only visible user and assistant text from legacy JSONL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openclaw-jsonl-')); dirs.push(directory)
    await mkdir(join(directory, 'sessions'))
    await writeFile(join(directory, 'sessions.json'), JSON.stringify({ s1: { title: 'Imported chat' } }))
    await writeFile(join(directory, 'sessions', 's1.jsonl'), [
      JSON.stringify({ id: 'u1', sessionId: 's1', role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ id: 'sys', sessionId: 's1', role: 'system', content: 'secret system prompt' }),
      JSON.stringify({ id: 'think', sessionId: 's1', role: 'assistant', thinking: 'private', content: 'do not retain' }),
      JSON.stringify({ id: 'tool', sessionId: 's1', role: 'tool', content: 'credential output' }),
      JSON.stringify({ id: 'a1', sessionId: 's1', role: 'assistant', content: [{ type: 'text', text: 'visible answer' }, { type: 'tool_call', content: 'hidden tool' }], timestamp: '2026-01-01T00:00:01Z' }),
    ].join('\n'))
    const threads = await readOpenClawSource(directory)
    expect(threads).toHaveLength(1)
    expect(threads[0]?.messages.map((message) => message.content)).toEqual(['hello', 'visible answer'])
    expect(JSON.stringify(threads)).not.toContain('secret system prompt')
    expect(JSON.stringify(threads)).not.toContain('credential output')
  })

  it('rejects damaged JSONL instead of silently truncating', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openclaw-bad-')); dirs.push(directory)
    await writeFile(join(directory, 'broken.jsonl'), '{not-json}\n')
    await expect(readOpenClawSource(directory)).rejects.toThrow(/Damaged OpenClaw JSONL/u)
  })

  it('rejects unsupported SQLite schema versions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openclaw-sqlite-')); dirs.push(directory)
    const path = join(directory, 'openclaw.sqlite'); const database = new Database(path)
    database.exec('PRAGMA user_version=18; CREATE TABLE messages(session_id TEXT, role TEXT, content TEXT, timestamp TEXT);')
    database.close()
    await expect(readOpenClawSource(path)).rejects.toThrow(/Unsupported OpenClaw schema version/u)
  })

  it('rejects archive path traversal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openclaw-tar-')); dirs.push(directory)
    const path = join(directory, 'bad.tar.gz'); const pack = tar.pack()
    const pending = pipeline(pack, createGzip(), createWriteStream(path))
    pack.entry({ name: '../conversation.jsonl' }, '{}\n'); pack.finalize(); await pending
    await expect(extractOpenClawArchive(path)).rejects.toThrow(/unsafe path/u)
  })
})
