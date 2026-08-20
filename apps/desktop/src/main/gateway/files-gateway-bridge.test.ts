import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { collectImportCandidates } from './files-gateway-bridge'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('collectImportCandidates', () => {
  it('recursively collects supported files while ignoring hidden and unsupported entries', async () => {
    const directory = await mkdtemp(join('/tmp', 'everroom-import-'))
    temporaryDirectories.push(directory)
    await mkdir(join(directory, 'nested'))
    await mkdir(join(directory, '.hidden'))
    await writeFile(join(directory, 'root.md'), '# root')
    await writeFile(join(directory, 'nested', 'notes.txt'), 'notes')
    await writeFile(join(directory, 'nested', 'ignored.pdf'), 'pdf')
    await writeFile(join(directory, '.hidden', 'secret.md'), 'secret')

    await expect(collectImportCandidates([directory])).resolves.toEqual([
      { filePath: join(directory, 'nested', 'notes.txt'), filename: 'nested/notes.txt' },
      { filePath: join(directory, 'root.md'), filename: 'root.md' },
    ])
  })
})
