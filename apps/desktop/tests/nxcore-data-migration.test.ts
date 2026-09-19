import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { ConnectorRegistry } from '../src/main/connectors/connector-registry'
import { LocalDataService } from '../src/main/core/local-data-service'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

function claimRows(databasePath: string): Array<{ version: number; via: string }> {
  const database = new DatabaseSync(databasePath)
  const rows = database
    .prepare('SELECT version, via FROM data_migrations ORDER BY version')
    .all() as unknown as Array<{ version: number; via: string }>
  database.close()
  return rows
}

describe('nxcore.db 迁移框架接入', () => {
  it('全新库：initialize 建表 + 探测层 + 认领基线 v1', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'everroom-nxcore-migration-'))
    temporaryDirectories.push(fixtureRoot)
    const dataDirectory = join(fixtureRoot, 'data')

    const service = new LocalDataService(dataDirectory, new ConnectorRegistry())
    await service.initialize()
    await service.shutdown()

    expect(claimRows(join(dataDirectory, 'database', 'nxcore.db'))).toEqual([
      { version: 1, via: 'fresh-claim' },
    ])
  })

  it('存量库（无版本记录）：再次启动认领基线，不重复执行历史修复', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'everroom-nxcore-migration-'))
    temporaryDirectories.push(fixtureRoot)
    const dataDirectory = join(fixtureRoot, 'data')
    const databasePath = join(dataDirectory, 'database', 'nxcore.db')

    const first = new LocalDataService(dataDirectory, new ConnectorRegistry())
    await first.initialize()
    await first.shutdown()

    // 模拟框架接管前的老库：清掉版本记录。
    const raw = new DatabaseSync(databasePath)
    raw.exec('DELETE FROM data_migrations')
    raw.close()

    const second = new LocalDataService(dataDirectory, new ConnectorRegistry())
    await second.initialize()
    await second.shutdown()

    expect(claimRows(databasePath)).toEqual([
      { version: 1, via: 'baseline-claim' },
    ])
  })
})
