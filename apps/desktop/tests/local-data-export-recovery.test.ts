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

describe('LocalDataService export recovery', () => {
  // 回归背景：missing 条目的残留 pending/exporting 导出行永远不可达
  // （processExports 只取 present 条目），曾与 hasPendingExports 的旧判定
  // 形成微任务死循环打满主进程。启动自愈必须把这类脏行落成 failed。
  it('fails pending and exporting exports of missing source items at startup', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'everroom-export-recovery-'))
    temporaryDirectories.push(fixtureRoot)
    const dataDirectory = join(fixtureRoot, 'data')

    const first = new LocalDataService(dataDirectory, new ConnectorRegistry())
    await first.initialize()
    await first.shutdown()

    const databasePath = join(dataDirectory, 'database', 'nxcore.db')
    const seed = new DatabaseSync(databasePath)
    seed.exec(`
      INSERT INTO data_sources (id, kind, name, root_path, connection_key, status, created_at, updated_at)
      VALUES ('src-1', 'local-folder', 'Docs', NULL, 'local-folder:/tmp/docs', 'paused', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

      INSERT INTO source_items (
        id, data_source_id, file_identity, relative_path, extension, size, modified_at,
        state, last_changed_at, first_seen_at, last_seen_at
      )
      VALUES
        ('item-gone', 'src-1', 'gone.md', 'gone.md', '.md', 10, '2026-01-01T00:00:00.000Z', 'missing', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('item-here', 'src-1', 'here.md', 'here.md', '.md', 10, '2026-01-01T00:00:00.000Z', 'present', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

      INSERT INTO source_versions (id, source_item_id, content_hash, object_hash, size, source_modified_at, captured_at)
      VALUES
        ('ver-gone', 'item-gone', 'hash-gone', 'hash-gone', 10, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('ver-here', 'item-here', 'hash-here', 'hash-here', 10, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

      INSERT INTO source_exports (source_version_id, status, updated_at)
      VALUES
        ('ver-gone', 'pending', '2026-01-01T00:00:00.000Z'),
        ('ver-here', 'exporting', '2026-01-01T00:00:00.000Z');
    `)
    seed.close()

    const second = new LocalDataService(dataDirectory, new ConnectorRegistry())
    try {
      await second.initialize()
      const check = new DatabaseSync(databasePath, { readOnly: true })
      const statuses = Object.fromEntries(check
        .prepare('SELECT source_version_id, status FROM source_exports')
        .all()
        .map((row) => [row.source_version_id, row.status]))
      check.close()
      // missing 条目的脏行 → failed；present 条目的 exporting → 既有恢复路径转回 pending。
      expect(statuses['ver-gone']).toBe('failed')
      expect(statuses['ver-here']).toBe('pending')
    } finally {
      await second.shutdown()
    }
  })
})
