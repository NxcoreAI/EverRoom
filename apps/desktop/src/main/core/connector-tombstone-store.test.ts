import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectorTombstoneStore } from './connector-tombstone-store'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function store(): Promise<ConnectorTombstoneStore> {
  const dir = await mkdtemp(join(tmpdir(), 'tombstone-'))
  dirs.push(dir)
  return new ConnectorTombstoneStore(join(dir, 'connector-tombstones.json'))
}

describe('ConnectorTombstoneStore', () => {
  it('add/has/remove 按 userId 隔离且幂等', async () => {
    const tombstones = await store()
    await tombstones.add('user-1', 'gmail')
    await tombstones.add('user-1', 'gmail')
    expect(await tombstones.has('user-1', 'gmail')).toBe(true)
    expect(await tombstones.has('user-2', 'gmail')).toBe(false)
    expect(await tombstones.has('user-1', 'notion')).toBe(false)

    await tombstones.remove('user-1', 'gmail')
    expect(await tombstones.has('user-1', 'gmail')).toBe(false)
    await tombstones.remove('user-1', 'gmail')
    expect(await tombstones.has('user-1', 'gmail')).toBe(false)
  })

  it('跨实例持久化；清空最后一个 provider 时回收 userId 键', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tombstone-'))
    dirs.push(dir)
    const file = join(dir, 'connector-tombstones.json')
    await new ConnectorTombstoneStore(file).add('user-1', 'gmail')

    const second = new ConnectorTombstoneStore(file)
    expect(await second.has('user-1', 'gmail')).toBe(true)

    await second.remove('user-1', 'gmail')
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    expect(raw['user-1']).toBeUndefined()
    expect(Object.keys(raw)).toHaveLength(0)
  })
})
