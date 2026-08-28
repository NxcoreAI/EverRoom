import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConnectorRegistry } from '../src/main/connectors/connector-registry'
import { LocalFolderConnector } from '../src/main/connectors/local-folder-connector'
import { LocalDataService } from '../src/main/core/local-data-service'
import type {
  HighRiskImportQueue,
  PendingAutoScanBatch,
} from '../src/main/high-risk-import-coordinator'
import type { HighRiskImportResolution } from '../src/shared/ingest'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

describe('default local folders', () => {
  it('reports each explicit folder result without stopping after a failure', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'everroom-explicit-folders-'))
    temporaryDirectories.push(fixtureRoot)
    const dataDirectory = join(fixtureRoot, 'data')
    const documents = join(fixtureRoot, 'Documents')
    const unavailable = join(fixtureRoot, 'Unavailable')
    await mkdir(documents)
    await writeFile(join(documents, 'notes.md'), '# Notes')

    const service = new LocalDataService(
      dataDirectory,
      new ConnectorRegistry().register(new LocalFolderConnector()),
    )
    await service.initialize()

    try {
      const results = await service.connectLocalFolders([unavailable, documents])
      expect(results).toEqual([
        expect.objectContaining({ rootPath: unavailable, connected: false }),
        { rootPath: documents, connected: true },
      ])
      expect(service.listSources()).toHaveLength(1)
      expect(service.listSources()[0]?.rootPath).toBe(documents)
    } finally {
      await service.shutdown()
    }
  })

  it('does not rescan a cleared folder on restart without explicit consent', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'everroom-default-folders-'))
    temporaryDirectories.push(fixtureRoot)
    const dataDirectory = join(fixtureRoot, 'data')
    const desktop = join(fixtureRoot, 'Desktop')
    const documents = join(fixtureRoot, 'Documents')
    const downloads = join(fixtureRoot, 'Downloads')
    await Promise.all([desktop, documents, downloads].map((directory) => mkdir(directory)))
    await mkdir(join(documents, 'node_modules', 'dependency'), { recursive: true })
    await writeFile(join(documents, 'proposal.docx'), 'office bytes')
    await writeFile(join(documents, 'notes.md'), '# Notes')
    await writeFile(join(documents, 'manual.pdf'), 'pdf bytes')
    await writeFile(join(documents, 'node_modules', 'dependency', 'README.md'), '# Dependency')

    // User consented (e.g. through the folder onboarding dialog), then cleared
    // the Documents source from settings.
    const service = new LocalDataService(
      dataDirectory,
      new ConnectorRegistry().register(new LocalFolderConnector()),
    )
    await service.initialize()
    let documentsSourceId = ''
    try {
      await service.connectLocalFolders([desktop, documents, downloads])
      const initialSources = service.listSources()
      expect(initialSources.map((source) => source.rootPath).sort()).toEqual(
        [desktop, documents, downloads].sort(),
      )
      const documentsSource = initialSources.find((source) => source.rootPath === documents)!
      documentsSourceId = documentsSource.id
      expect(service.listFiles(documentsSource.id).map((file) => file.relativePath).sort()).toEqual([
        'manual.pdf',
        'notes.md',
        'proposal.docx',
      ])
      await service.disconnect(documentsSource.id, true)
    } finally {
      await service.shutdown()
    }

    // A restart must not force the cleared folder back online: startup no
    // longer auto-connects anything, and only connected sources resync.
    const restarted = new LocalDataService(
      dataDirectory,
      new ConnectorRegistry().register(new LocalFolderConnector()),
    )
    try {
      await restarted.initialize()
      expect(restarted.listSources().map((source) => source.rootPath).sort()).toEqual(
        [desktop, documents, downloads].sort(),
      )
      expect(restarted.listSources().find((source) => source.rootPath === documents)).toMatchObject({
        id: documentsSourceId,
        status: 'paused',
        fileCount: 0,
        versionCount: 0,
        totalBytes: 0,
        lastSyncedAt: null,
      })
      expect(restarted.listFiles(documentsSourceId)).toEqual([])
    } finally {
      await restarted.shutdown()
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
      await service.connectLocalFolders([documents])
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

  it('keeps scanning safe files while a large high-risk batch waits for approval', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'everroom-high-risk-scan-'))
    temporaryDirectories.push(fixtureRoot)
    const dataDirectory = join(fixtureRoot, 'data')
    const documents = join(fixtureRoot, 'Documents')
    await mkdir(documents)
    await writeFile(join(documents, 'proposal.pdf'), 'pdf bytes')
    await Promise.all(Array.from({ length: 101 }, (_, index) =>
      writeFile(join(documents, `note-${index}.md`), `# Note ${index}`)))

    const importedNames: string[] = []
    const importLocalFile = vi.fn(async (input: { originalName: string }) => {
      importedNames.push(input.originalName)
      return {
        fileEntryId: `file-${importedNames.length}`, fileVersionId: `version-${importedNames.length}`,
        jobId: `job-${importedNames.length}`, contentHash: 'a'.repeat(64),
        blobDeduped: false, versionDeduped: false,
      }
    })
    let autoResolver: ((batch: PendingAutoScanBatch, accepted: boolean) => Promise<HighRiskImportResolution>) | null = null
    let pendingBatch: PendingAutoScanBatch | null = null
    const enqueueAuto = vi.fn(async (batch: PendingAutoScanBatch) => {
      pendingBatch = batch
      return {
        id: 'auto-review-1', origin: 'auto-scan' as const, sourceLabel: 'Documents',
        fileCount: batch.versionIds.length, createdAt: new Date().toISOString(),
      }
    })
    const highRiskImports = {
      enqueueManual: vi.fn(),
      enqueueAuto,
      setManualResolver: vi.fn(),
      setAutoResolver: (resolver) => { autoResolver = resolver },
      discardAutoSource: vi.fn(),
    } satisfies HighRiskImportQueue
    const extensions = new Set(['.pdf', '.docx', '.md'])
    const service = new LocalDataService(
      dataDirectory,
      new ConnectorRegistry().register(new LocalFolderConnector(extensions)),
      { capabilities: async () => ({ items: [] }), importLocalFile, importConnectorFile: vi.fn() },
      extensions,
      new Set(),
      highRiskImports,
    )
    await service.initialize()

    try {
      await service.addLocalFolder(documents)
      for (let attempt = 0; attempt < 100 && !importedNames.includes('proposal.pdf'); attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5))
      }
      expect(importedNames).toEqual(['proposal.pdf'])
      expect(enqueueAuto).toHaveBeenCalledTimes(1)
      expect(pendingBatch?.versionIds).toHaveLength(101)

      await writeFile(join(documents, 'follow-up.docx'), 'office bytes')
      await service.sync(service.listSources()[0]!.id)
      for (let attempt = 0; attempt < 100 && !importedNames.includes('follow-up.docx'); attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5))
      }
      expect(importedNames).toEqual(expect.arrayContaining(['proposal.pdf', 'follow-up.docx']))
      expect(enqueueAuto).toHaveBeenCalledTimes(1)

      expect(autoResolver).not.toBeNull()
      await autoResolver!(pendingBatch!, true)
      for (let attempt = 0; attempt < 200 && importedNames.length < 103; attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5))
      }
      expect(importedNames.filter((name) => name.endsWith('.md'))).toHaveLength(101)
    } finally {
      await service.shutdown()
    }
  })

  it('marks an existing ordinary-file projection missing when its directory becomes a special app workspace', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'everroom-special-folder-cleanup-'))
    temporaryDirectories.push(fixtureRoot)
    const documents = join(fixtureRoot, 'Documents')
    const vault = join(documents, 'Product Vault')
    await mkdir(vault, { recursive: true })
    await writeFile(join(vault, 'brief.md'), '# Brief')
    const excluded = new Set<string>()
    const markLocalFileMissing = vi.fn(async () => ({ updated: true }))
    const importLocalFile = vi.fn(async () => ({
      fileEntryId: 'file-vault-brief', fileVersionId: 'version-vault-brief', jobId: 'job-1',
      contentHash: 'a'.repeat(64), blobDeduped: false, versionDeduped: false,
    }))
    const extensions = new Set(['.md'])
    const service = new LocalDataService(
      join(fixtureRoot, 'data'),
      new ConnectorRegistry().register(new LocalFolderConnector(extensions, (path) => excluded.has(vault) && (path === vault || path.startsWith(`${vault}/`)))),
      { capabilities: async () => ({ items: [] }), importLocalFile, importConnectorFile: vi.fn(), markLocalFileMissing },
      extensions,
    )
    await service.initialize()
    try {
      await service.addLocalFolder(documents)
      for (let attempt = 0; attempt < 100 && importLocalFile.mock.calls.length === 0; attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5))
      }
      expect(service.listFiles(service.listSources()[0]!.id)[0]).toMatchObject({ relativePath: 'Product Vault/brief.md', exists: true })

      excluded.add(vault)
      await service.rescanLocalFolders()

      expect(service.listFiles(service.listSources()[0]!.id)[0]).toMatchObject({ relativePath: 'Product Vault/brief.md', exists: false })
      expect(markLocalFileMissing).toHaveBeenCalledWith(expect.objectContaining({
        localSourceId: service.listSources()[0]!.id,
      }))
    } finally {
      await service.shutdown()
    }
  })

  it('hides and permanently skips high-risk files rejected from auto-scan', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'everroom-high-risk-reject-'))
    temporaryDirectories.push(fixtureRoot)
    const dataDirectory = join(fixtureRoot, 'data')
    const documents = join(fixtureRoot, 'Documents')
    await mkdir(documents)
    await Promise.all(Array.from({ length: 101 }, (_, index) =>
      writeFile(join(documents, `note-${index}.md`), `# Note ${index}`)))

    const importLocalFile = vi.fn(async () => ({
      fileEntryId: 'file-entry', fileVersionId: 'file-version', jobId: 'job-1',
      contentHash: 'a'.repeat(64), blobDeduped: false, versionDeduped: false,
    }))
    let autoResolver: ((batch: PendingAutoScanBatch, accepted: boolean) => Promise<HighRiskImportResolution>) | null = null
    let pendingBatch: PendingAutoScanBatch | null = null
    const highRiskImports = {
      enqueueManual: vi.fn(),
      enqueueAuto: vi.fn(async (batch: PendingAutoScanBatch) => {
        pendingBatch = batch
        return { id: 'review-1', origin: 'auto-scan' as const, sourceLabel: 'Documents', fileCount: batch.versionIds.length, createdAt: new Date().toISOString() }
      }),
      setManualResolver: vi.fn(),
      setAutoResolver: (resolver) => { autoResolver = resolver },
      discardAutoSource: vi.fn(),
    } satisfies HighRiskImportQueue
    const extensions = new Set(['.md'])
    const service = new LocalDataService(
      dataDirectory,
      new ConnectorRegistry().register(new LocalFolderConnector(extensions)),
      { capabilities: async () => ({ items: [] }), importLocalFile, importConnectorFile: vi.fn() },
      extensions,
      new Set(),
      highRiskImports,
    )
    await service.initialize()

    try {
      await service.addLocalFolder(documents)
      const source = service.listSources()[0]!
      expect(service.listFiles(source.id)).toEqual([])
      expect(source.fileCount).toBe(0)
      expect(autoResolver).not.toBeNull()
      expect(pendingBatch?.versionIds).toHaveLength(101)

      await autoResolver!(pendingBatch!, false)
      expect(service.listFiles(source.id)).toEqual([])
      expect(service.listSources()[0]!.fileCount).toBe(0)
      await expect(service.sync(source.id)).resolves.toMatchObject({ discovered: 0, added: 0, updated: 0 })
      expect(highRiskImports.enqueueAuto).toHaveBeenCalledTimes(1)
      expect(importLocalFile).not.toHaveBeenCalled()
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
