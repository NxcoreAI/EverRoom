import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { LocalFolderConnector } from '../src/main/connectors/local-folder-connector'
import { isLocalParseableExtension } from '../src/main/file-format-policy'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

describe('LocalFolderConnector scan policy', () => {
  it('never treats external JSON as a local parseable format', () => {
    expect(isLocalParseableExtension('.json')).toBe(false)
    expect(isLocalParseableExtension('.JSON')).toBe(false)
  })

  it('prunes generated directories and unsupported formats before producing items', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'everroom-local-folder-'))
    temporaryDirectories.push(rootPath)
    await mkdir(join(rootPath, 'project', 'node_modules', 'dependency'), { recursive: true })
    await mkdir(join(rootPath, 'project', 'dist'), { recursive: true })
    await mkdir(join(rootPath, 'project', '.git'), { recursive: true })
    await writeFile(join(rootPath, 'project', 'proposal.docx'), 'office bytes')
    await writeFile(join(rootPath, 'project', 'notes.md'), '# Notes')
    await writeFile(join(rootPath, 'project', 'node_modules', 'dependency', 'README.docx'), 'office bytes')
    await writeFile(join(rootPath, 'project', 'dist', 'generated.txt'), 'generated')
    await writeFile(join(rootPath, 'project', 'document.pdf'), 'pdf bytes')
    await writeFile(join(rootPath, 'project', 'data.json'), '{}')

    const result = await new LocalFolderConnector().scan({
      id: 'source-1',
      kind: 'local-folder',
      name: 'fixture',
      config: { rootPath },
    })

    expect(result.items.map((item) => item.path)).toEqual([
      'project/document.pdf',
      'project/notes.md',
      'project/proposal.docx',
    ])
    expect(result.failed).toBe(0)
  })

  it('does not enter special-application work directories inside a scanned folder', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'everroom-local-special-folder-'))
    temporaryDirectories.push(rootPath)
    const vaultPath = join(rootPath, 'Obsidian Vault')
    await mkdir(join(vaultPath, '.obsidian'), { recursive: true })
    await writeFile(join(rootPath, 'ordinary.md'), '# Ordinary')
    await writeFile(join(vaultPath, 'private.md'), '# Vault note')

    const result = await new LocalFolderConnector(undefined, (path) => path === vaultPath || path.startsWith(`${vaultPath}/`)).scan({
      id: 'source-1',
      kind: 'local-folder',
      name: 'fixture',
      config: { rootPath },
    })

    expect(result.items.map((item) => item.path)).toEqual(['ordinary.md'])
  })
})
