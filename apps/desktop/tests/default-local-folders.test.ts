import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ConnectorRegistry } from '../src/main/connectors/connector-registry'
import { LocalFolderConnector } from '../src/main/connectors/local-folder-connector'
import { LocalDataService } from '../src/main/core/local-data-service'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

describe('default local folders', () => {
  it('connects standard folders once and respects a later user deletion', async () => {
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
        [desktop, downloads].sort(),
      )
    } finally {
      await service.shutdown()
    }
  })
})
