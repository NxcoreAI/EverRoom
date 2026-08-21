import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConnectorRegistry } from '../src/main/connectors/connector-registry'
import { LocalFolderConnector } from '../src/main/connectors/local-folder-connector'
import { LocalDataService } from '../src/main/core/local-data-service'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

describe('default local folders', () => {
  it('connects standard folders once and keeps a cleared folder available for rescanning', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'everroom-default-folders-'))
    temporaryDirectories.push(fixtureRoot)
    const dataDirectory = join(fixtureRoot, 'data')
    const desktop = join(fixtureRoot, 'Desktop')
    const documents = join(fixtureRoot, 'Documents')
    const downloads = join(fixtureRoot, 'Downloads')
    await Promise.all([desktop, documents, downloads].map((directory) => mkdir(directory)))
    await mkdir(join(documents, 'node_modules', 'dependency'), { recursive: true })
    await writeFile(join(documents, 'notes.md'), '# Notes')
    await writeFile(join(documents, 'manual.pdf'), 'unsupported')
    await writeFile(join(documents, 'node_modules', 'dependency', 'README.md'), '# Dependency')

    const service = new LocalDataService(
      dataDirectory,
      new ConnectorRegistry().register(new LocalFolderConnector()),
    )
    await service.initialize()

    try {
      await service.bootstrapDefaultLocalFolders([desktop, documents, downloads])
      const initialSources = service.listSources()
      expect(initialSources.map((source) => source.rootPath).sort()).toEqual(
        [desktop, documents, downloads].sort(),
      )
      const documentsSource = initialSources.find((source) => source.rootPath === documents)!
      expect(service.listFiles(documentsSource.id).map((file) => file.relativePath)).toEqual(['notes.md'])

      await service.disconnect(documentsSource.id, true)
      await service.bootstrapDefaultLocalFolders([desktop, documents, downloads])
      expect(service.listSources().map((source) => source.rootPath).sort()).toEqual(
        [desktop, documents, downloads].sort(),
      )
      expect(service.listSources().find((source) => source.rootPath === documents)).toMatchObject({
        id: documentsSource.id,
        status: 'paused',
        fileCount: 0,
        versionCount: 0,
        totalBytes: 0,
        lastSyncedAt: null,
      })
      expect(service.listFiles(documentsSource.id)).toEqual([])
    } finally {
      await service.shutdown()
    }
  })

  it('uses Gateway capabilities and exports supported files through the durable outbox', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'everroom-default-export-'))
    temporaryDirectories.push(fixtureRoot)
    const dataDirectory = join(fixtureRoot, 'data')
    const documents = join(fixtureRoot, 'Documents')
    await mkdir(documents)
    await writeFile(join(documents, 'proposal.docx'), 'office bytes')
    await writeFile(join(documents, 'ignored.pdf'), 'pdf bytes')
    const importLocalFile = vi.fn(async () => ({
      fileEntryId: 'file-entry-1', fileVersionId: 'file-version-1', jobId: 'job-1',
      contentHash: 'a'.repeat(64), blobDeduped: false, versionDeduped: false,
    }))
    const extensions = new Set(['.docx'])
    const service = new LocalDataService(
      dataDirectory,
      new ConnectorRegistry().register(new LocalFolderConnector(extensions)),
      { capabilities: async () => ({ items: [] }), importLocalFile, importConnectorFile: vi.fn() },
      extensions,
    )
    await service.initialize()

    try {
      await service.bootstrapDefaultLocalFolders([documents])
      for (let attempt = 0; attempt < 100 && importLocalFile.mock.calls.length === 0; attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5))
      }
      expect(service.listFiles(service.listSources()[0]!.id).map((file) => file.relativePath))
        .toEqual(['proposal.docx'])
      expect(importLocalFile).toHaveBeenCalledWith(expect.objectContaining({
        originalName: 'proposal.docx', relativePath: 'proposal.docx',
      }))
      await service.sync(service.listSources()[0]!.id)
      expect(importLocalFile).toHaveBeenCalledTimes(1)
      expect(await readdir(join(dataDirectory, 'objects', 'sha256'))).toEqual([])
    } finally {
      await service.shutdown()
    }
  })

  it('exports cloud-native connector documents while keeping the provider identity', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'everroom-connector-export-'))
    temporaryDirectories.push(fixtureRoot)
    const importConnectorFile = vi.fn(async () => ({
      fileEntryId: 'connector-entry', fileVersionId: 'connector-version', jobId: 'connector-job',
      contentHash: 'b'.repeat(64), blobDeduped: false, versionDeduped: false,
    }))
    const connector = {
      kind: 'google-docs' as const,
      capabilities: ['pull'] as const,
      getConnectionKey: () => 'doc-1',
      scan: async () => ({ items: [{
        remoteId: 'doc-1', title: 'Roadmap', uri: 'https://docs.google.com/document/d/doc-1',
        path: 'Roadmap.md', extension: '.md', byteSize: 9, modifiedAt: '2026-08-21T00:00:00.000Z',
        openContent: () => Readable.from(['# Roadmap']),
      }], failed: 0 }),
    }
    const service = new LocalDataService(
      join(fixtureRoot, 'data'),
      new ConnectorRegistry().register(connector),
      {
        capabilities: async () => ({ items: [] }),
        importLocalFile: vi.fn(),
        importConnectorFile,
      },
      new Set(['.md']),
      new Set(['.md']),
    )
    await service.initialize()
    try {
      await service.addConnection('google-docs', 'Roadmap', { documentIds: ['doc-1'] })
      for (let attempt = 0; attempt < 100 && importConnectorFile.mock.calls.length === 0; attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5))
      }
      expect(importConnectorFile).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'google-docs', originalName: 'Roadmap.md', relativePath: 'Roadmap.md',
        sourceKey: expect.stringMatching(/^connector:google-docs:/),
      }))
    } finally {
      await service.shutdown()
    }
  })
})
