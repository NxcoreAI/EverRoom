import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverLocalAgentSources } from '../src/main/migrations/coordinator'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

describe('discoverLocalAgentSources', () => {
  it('discovers standard codex and claude home directories', async () => {
    const home = await mkdtemp(join(tmpdir(), 'everroom-home-')); dirs.push(home)
    await mkdir(join(home, '.codex', 'sessions'), { recursive: true })
    await mkdir(join(home, '.claude', 'projects'), { recursive: true })

    const codex = discoverLocalAgentSources('codex', home)
    expect(codex).toHaveLength(1)
    expect(codex[0]).toMatchObject({ path: join(home, '.codex'), provider: 'codex', displayName: 'Codex', transport: 'local-jsonl', standard: true })

    const claude = discoverLocalAgentSources('claude', home)
    expect(claude).toHaveLength(1)
    expect(claude[0]).toMatchObject({ path: join(home, '.claude'), provider: 'claude', displayName: 'Claude Code', transport: 'local-jsonl', standard: true })
  })

  it('returns no sources when the agent home directory is absent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'everroom-home-')); dirs.push(home)
    expect(discoverLocalAgentSources('codex', home)).toEqual([])
    expect(discoverLocalAgentSources('claude', home)).toEqual([])
  })

  it('ignores files that are not directories', async () => {
    const home = await mkdtemp(join(tmpdir(), 'everroom-home-')); dirs.push(home)
    await writeFile(join(home, '.codex'), 'not a directory')
    expect(discoverLocalAgentSources('codex', home)).toEqual([])
  })
})
