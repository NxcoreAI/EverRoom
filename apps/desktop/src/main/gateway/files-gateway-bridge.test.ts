import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { collectImportCandidates, collectImportPlan, FilesGatewayBridge } from './files-gateway-bridge'
import type { GatewaySupervisor } from './gateway-supervisor'
import type {
  HighRiskImportQueue,
  PendingManualImportBatch,
} from '../high-risk-import-coordinator'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('collectImportCandidates', () => {
  it('recursively collects supported files while ignoring hidden and unsupported entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-import-'))
    temporaryDirectories.push(directory)
    await mkdir(join(directory, 'nested'))
    await mkdir(join(directory, '.hidden'))
    await writeFile(join(directory, 'root.md'), '# root')
    await writeFile(join(directory, 'nested', 'notes.txt'), 'notes')
    await writeFile(join(directory, 'nested', 'report.pdf'), 'pdf')
    await writeFile(join(directory, 'nested', 'ignored.json'), '{}')
    await writeFile(join(directory, '.hidden', 'secret.md'), 'secret')

    await expect(collectImportCandidates([directory])).resolves.toEqual([
      { filePath: join(directory, 'nested', 'notes.txt'), filename: 'nested/notes.txt' },
      { filePath: join(directory, 'nested', 'report.pdf'), filename: 'nested/report.pdf' },
      { filePath: join(directory, 'root.md'), filename: 'root.md' },
    ])
  })

  it('drops a directly selected JSON file before upload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-import-json-'))
    temporaryDirectories.push(directory)
    const jsonPath = join(directory, 'package.json')
    await writeFile(jsonPath, '{}')

    await expect(collectImportCandidates([jsonPath])).resolves.toEqual([])
  })

  it('ignores dependency and build directories during a one-time directory scan', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-import-ignored-'))
    temporaryDirectories.push(directory)
    await mkdir(join(directory, 'node_modules', 'dependency'), { recursive: true })
    await mkdir(join(directory, 'build'), { recursive: true })
    await mkdir(join(directory, 'notes'), { recursive: true })
    await writeFile(join(directory, 'node_modules', 'dependency', 'README.md'), '# dependency')
    await writeFile(join(directory, 'build', 'generated.txt'), 'generated')
    await writeFile(join(directory, 'notes', 'kept.md'), '# kept')

    await expect(collectImportCandidates([directory])).resolves.toEqual([
      { filePath: join(directory, 'notes', 'kept.md'), filename: 'notes/kept.md' },
    ])
  })

  it('deduplicates overlapping and missing selections', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-import-duplicate-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'notes.md')
    await writeFile(filePath, '# notes')

    await expect(collectImportCandidates([
      directory,
      filePath,
      filePath,
      join(directory, 'missing.md'),
    ])).resolves.toEqual([
      { filePath, filename: 'notes.md' },
    ])
  })

  it('counts supported non-Office/PDF files as high risk', async () => {
    const directory = await mkdtemp(join('/tmp', 'everroom-import-risk-'))
    temporaryDirectories.push(directory)
    await writeFile(join(directory, 'proposal.docx'), 'office')
    await Promise.all(Array.from({ length: 101 }, (_, index) =>
      writeFile(join(directory, `note-${index}.md`), '# note')))

    await expect(collectImportPlan([directory])).resolves.toMatchObject({
      highRiskFileCount: 101,
      candidates: expect.arrayContaining([
        { filePath: join(directory, 'proposal.docx'), filename: 'proposal.docx' },
        { filePath: join(directory, 'note-0.md'), filename: 'note-0.md' },
      ]),
    })
  })
})

describe('FilesGatewayBridge.importPathsOnce', () => {
  it('filters with gateway capabilities and imports through the unified manual path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-import-once-'))
    temporaryDirectories.push(directory)
    await mkdir(join(directory, 'notes'))
    await writeFile(join(directory, 'notes', 'kept.md'), '# kept')
    await writeFile(join(directory, 'ignored.pdf'), 'pdf')

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/files/capabilities')) {
        return new Response(JSON.stringify({
          items: [{ extension: '.md', manualImport: true }],
        }), { headers: { 'Content-Type': 'application/json' } })
      }
      expect(url).toBe('http://gateway.test/v1/file-imports')
      expect(init?.method).toBe('POST')
      const metadata = JSON.parse(String((init?.body as FormData).get('metadata'))) as Record<string, unknown>
      expect(metadata).toMatchObject({
        sourceKind: 'manual-upload',
        originalName: 'kept.md',
        relativePath: 'notes/kept.md',
      })
      expect(metadata.sourceKey).toMatch(/^manual:/)
      return new Response(JSON.stringify({
        fileEntryId: 'file-entry-1',
        versionDeduped: false,
        jobId: 'job-1',
      }), { headers: { 'Content-Type': 'application/json' } })
    })
    const supervisor = {
      getConnection: () => ({ baseUrl: 'http://gateway.test', token: 'token' }),
    } as unknown as GatewaySupervisor

    await expect(new FilesGatewayBridge(supervisor).importPathsOnce([directory])).resolves.toEqual([
      expect.objectContaining({
        filename: 'notes/kept.md',
        fileId: 'file-entry-1',
        routeJobId: 'job-1',
        error: null,
      }),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('queues a large high-risk batch without delaying low-risk files', async () => {
    const directory = await mkdtemp(join('/tmp', 'everroom-import-high-risk-'))
    temporaryDirectories.push(directory)
    await writeFile(join(directory, 'proposal.pdf'), 'pdf')
    await Promise.all(Array.from({ length: 101 }, (_, index) =>
      writeFile(join(directory, `note-${index}.md`), '# note')))

    let manualResolver: ((batch: PendingManualImportBatch, accepted: boolean) => Promise<unknown>) | null = null
    const enqueueManual = vi.fn(async (batch: PendingManualImportBatch) => ({
      id: 'review-1', origin: 'manual-import' as const, sourceLabel: directory,
      fileCount: batch.files.length, createdAt: new Date().toISOString(),
    }))
    const highRiskImports = {
      enqueueManual,
      enqueueAuto: vi.fn(),
      setManualResolver: (resolver) => { manualResolver = resolver },
      setAutoResolver: vi.fn(),
      discardAutoSource: vi.fn(),
    } satisfies HighRiskImportQueue
    const importedNames: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/files/capabilities')) {
        return new Response(JSON.stringify({ items: [
          { extension: '.md', manualImport: true },
          { extension: '.pdf', manualImport: true },
        ] }), { headers: { 'Content-Type': 'application/json' } })
      }
      const metadata = JSON.parse(String((init?.body as FormData).get('metadata'))) as { originalName: string }
      importedNames.push(metadata.originalName)
      return new Response(JSON.stringify({
        fileEntryId: `file-${importedNames.length}`, fileVersionId: `version-${importedNames.length}`,
        versionDeduped: false, blobDeduped: false, contentHash: 'a'.repeat(64), jobId: `job-${importedNames.length}`,
      }), { headers: { 'Content-Type': 'application/json' } })
    })
    const supervisor = {
      getConnection: () => ({ baseUrl: 'http://gateway.test', token: 'token' }),
    } as unknown as GatewaySupervisor

    const outcomes = await new FilesGatewayBridge(supervisor, highRiskImports).importPathsOnce([directory])
    expect(outcomes.map((outcome) => outcome.filename)).toEqual(['proposal.pdf'])
    expect(importedNames).toEqual(['proposal.pdf'])
    expect(enqueueManual).toHaveBeenCalledWith(
      expect.objectContaining({ files: expect.arrayContaining([
        expect.objectContaining({ filename: 'note-0.md' }),
      ]) }),
      expect.any(String),
    )
    expect(manualResolver).not.toBeNull()
  })
})
