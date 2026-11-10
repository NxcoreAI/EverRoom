import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConnectorRegistry } from '../src/main/connectors/connector-registry'
import { LocalFolderConnector } from '../src/main/connectors/local-folder-connector'
import { LocalDataService } from '../src/main/core/local-data-service'
import type { LocalFileExportTarget } from '../src/main/core/local-data-service'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

function exportStub(): LocalFileExportTarget {
  return {
    capabilities: async () => ({ items: [] }),
    importLocalFile: vi.fn(async () => ({
      fileEntryId: 'file-entry-1', fileVersionId: 'file-version-1', jobId: 'job-1',
      contentHash: 'a'.repeat(64), blobDeduped: false, versionDeduped: false,
    })),
    importConnectorFile: vi.fn(),
  }
}

async function waitForParse(
  service: LocalDataService,
  dataSourceId: string,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const file = service.listFiles(dataSourceId).at(0)
    if (file && file.parseStatus !== 'pending' && file.parseStatus !== 'running') {
      return file.parseStatus
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
  }
  return service.listFiles(dataSourceId).at(0)?.parseStatus
}

describe('local-folder evidence parse', () => {
  // 回归背景：本地文件夹来源不往对象库写副本（导出走原路径），但解析器
  // 只认对象库路径，导致每个 md 文件必报 ENOENT“解析失败”。
  it('parses markdown evidence from the original folder path without storing objects', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'everroom-local-evidence-'))
    temporaryDirectories.push(fixtureRoot)
    const dataDirectory = join(fixtureRoot, 'data')
    const documents = join(fixtureRoot, 'Documents')
    await mkdir(documents)
    await writeFile(join(documents, 'notes.md'), '# 标题\n\n正文段落')

    const service = new LocalDataService(
      dataDirectory,
      new ConnectorRegistry().register(new LocalFolderConnector()),
      exportStub(),
    )
    await service.initialize()

    try {
      await service.connectLocalFolders([documents])
      const dataSourceId = service.listSources()[0]!.id
      expect(await waitForParse(service, dataSourceId)).toBe('success')
      const file = service.listFiles(dataSourceId).at(0)!
      expect(file.parseStatus).toBe('success')
      expect(file.evidenceCount).toBeGreaterThan(0)
      expect(await readdir(join(dataDirectory, 'objects', 'sha256'))).toEqual([])
      expect(service.listEvidence(dataSourceId, file.id).blocks.length).toBeGreaterThan(0)
      const preview = await service.previewFile(dataSourceId, file.id)
      expect(preview.content).toContain('正文段落')
    } finally {
      await service.shutdown()
    }
  })

  it('retries a previously failed parse job on restart', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'everroom-local-evidence-retry-'))
    temporaryDirectories.push(fixtureRoot)
    const dataDirectory = join(fixtureRoot, 'data')
    const documents = join(fixtureRoot, 'Documents')
    await mkdir(documents)
    await writeFile(join(documents, 'notes.md'), '# Notes')

    const first = new LocalDataService(
      dataDirectory,
      new ConnectorRegistry().register(new LocalFolderConnector()),
      exportStub(),
    )
    await first.initialize()
    let dataSourceId = ''
    try {
      await first.connectLocalFolders([documents])
      dataSourceId = first.listSources()[0]!.id
      expect(await waitForParse(first, dataSourceId)).toBe('success')
    } finally {
      await first.shutdown()
    }

    const seed = new DatabaseSync(join(dataDirectory, 'database', 'nxcore.db'))
    seed.exec("UPDATE evidence_parse_jobs SET status = 'failed', attempt_count = 1, error_message = 'ENOENT: no such file or directory'")
    seed.close()

    const second = new LocalDataService(
      dataDirectory,
      new ConnectorRegistry().register(new LocalFolderConnector()),
      exportStub(),
    )
    try {
      await second.initialize()
      expect(await waitForParse(second, dataSourceId)).toBe('success')
    } finally {
      await second.shutdown()
    }
  })
})
