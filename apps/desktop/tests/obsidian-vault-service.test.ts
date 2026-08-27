import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ObsidianVaultService, discoverRegisteredObsidianVaultPaths, isPathInsideRoots } from '../src/main/obsidian/obsidian-vault-service'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'everroom-vault-'))
  temporaryDirectories.push(root)
  const dataDirectory = join(root, 'data')
  const vaultPath = join(root, 'Product Vault')
  await mkdir(join(vaultPath, '.obsidian'), { recursive: true })
  await mkdir(join(vaultPath, 'notes'), { recursive: true })
  await writeFile(join(vaultPath, '.obsidian', 'app.json'), JSON.stringify({ attachmentFolderPath: 'assets' }))
  await writeFile(join(vaultPath, 'notes', 'roadmap.md'), '---\ntags: [plan]\n---\n# Roadmap\n\nSee [[Research]].')
  await writeFile(join(vaultPath, 'cover.png'), Buffer.from('image'))
  const trashPath = vi.fn(async (path: string) => { await rm(path) })
  const service = new ObsidianVaultService(dataDirectory, trashPath)
  await service.initialize()
  return { root, dataDirectory, vaultPath, service, trashPath }
}

describe('ObsidianVaultService', () => {
  it.each([
    ['darwin', (home: string) => join(home, 'Library', 'Application Support', 'obsidian')],
    ['linux', (home: string) => join(home, '.config', 'obsidian')],
    ['win32', (_home: string, appData: string) => join(appData, 'obsidian')],
  ] as const)('reads the official %s Obsidian registry', async (platform, registryDirectory) => {
    const root = await mkdtemp(join(tmpdir(), `everroom-obsidian-${platform}-`))
    temporaryDirectories.push(root)
    const home = join(root, 'home')
    const appData = join(root, 'appdata')
    const vaultPath = join(root, 'Vault')
    const registry = registryDirectory(home, appData)
    await mkdir(registry, { recursive: true })
    await writeFile(join(registry, 'obsidian.json'), JSON.stringify({ vaults: { one: { path: vaultPath, ts: 1_700_000_000_000 } } }))

    await expect(discoverRegisteredObsidianVaultPaths({ platform, homeDirectory: home, appDataDirectory: appData })).resolves.toEqual([{
      rootPath: vaultPath,
      registryId: 'one',
      discoveredFrom: 'registry',
      lastOpenedAt: '2023-11-14T22:13:20.000Z',
    }])
  })

  it('returns no registered Vaults for missing or corrupt registries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'everroom-obsidian-registry-'))
    temporaryDirectories.push(root)
    await expect(discoverRegisteredObsidianVaultPaths({ platform: 'linux', homeDirectory: root })).resolves.toEqual([])
    const directory = join(root, '.config', 'obsidian')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'obsidian.json'), '{broken')
    await expect(discoverRegisteredObsidianVaultPaths({ platform: 'linux', homeDirectory: root })).resolves.toEqual([])
  })

  it('matches files inside known Vault roots without matching sibling names', () => {
    expect(isPathInsideRoots('/Users/test/Documents/Vault/note.md', ['/Users/test/Documents/Vault'], 'darwin')).toBe(true)
    expect(isPathInsideRoots('/users/test/documents/vault/note.md', ['/Users/Test/Documents/Vault'], 'darwin')).toBe(true)
    expect(isPathInsideRoots('/Users/test/Documents/Vault copy/note.md', ['/Users/test/Documents/Vault'], 'darwin')).toBe(false)
  })

  it('canonicalizes and deduplicates registry aliases and bounded-scan results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'everroom-obsidian-discovery-'))
    temporaryDirectories.push(root)
    const home = join(root, 'home')
    const vaultPath = join(home, 'Documents', 'Client Project')
    const aliasPath = join(root, 'project-alias')
    const registryDirectory = join(home, '.config', 'obsidian')
    await mkdir(join(vaultPath, '.obsidian'), { recursive: true })
    await writeFile(join(vaultPath, 'brief.md'), '# Brief')
    await symlink(vaultPath, aliasPath)
    await mkdir(registryDirectory, { recursive: true })
    await writeFile(join(registryDirectory, 'obsidian.json'), JSON.stringify({ vaults: {
      primary: { path: vaultPath, ts: 1_700_000_000_000 },
      alias: { path: aliasPath, ts: 1_699_000_000_000 },
    } }))
    const service = new ObsidianVaultService(join(root, 'data'), vi.fn(async () => undefined), {
      platform: 'linux',
      homeDirectory: home,
    })
    await service.initialize()

    const candidates = await service.discover()

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ name: 'Client Project', noteCount: 1, discoveredFrom: 'registry' })
    expect(candidates[0]).not.toHaveProperty('rootPath')
    await service.shutdown()
  })

  it('keeps old and new Vault paths excluded when the Obsidian registry changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'everroom-obsidian-registry-watch-'))
    temporaryDirectories.push(root)
    const home = join(root, 'home')
    const firstVault = join(root, 'First Vault')
    const secondVault = join(root, 'Second Vault')
    const registryDirectory = join(home, '.config', 'obsidian')
    await Promise.all([firstVault, secondVault].map((path) => mkdir(join(path, '.obsidian'), { recursive: true })))
    await mkdir(registryDirectory, { recursive: true })
    const registryPath = join(registryDirectory, 'obsidian.json')
    await writeFile(registryPath, JSON.stringify({ vaults: { first: { path: firstVault } } }))
    const service = new ObsidianVaultService(join(root, 'data'), vi.fn(async () => undefined), {
      platform: 'linux', homeDirectory: home,
    })
    await service.initialize()
    expect(service.isPathExcluded(join(firstVault, 'note.md'))).toBe(true)

    await writeFile(registryPath, JSON.stringify({ vaults: { second: { path: secondVault } } }))
    for (let attempt = 0; attempt < 30 && !service.isPathExcluded(join(secondVault, 'note.md')); attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    }

    expect(service.isPathExcluded(join(firstVault, 'old.md'))).toBe(true)
    expect(service.isPathExcluded(join(secondVault, 'new.md'))).toBe(true)
    await service.shutdown()
  })

  it('moves an imported binding to the new directory when its registry entry changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'everroom-obsidian-registry-rebind-'))
    temporaryDirectories.push(root)
    const home = join(root, 'home')
    const firstVault = join(root, 'First Vault')
    const secondVault = join(root, 'Moved Vault')
    const registryDirectory = join(home, '.config', 'obsidian')
    await Promise.all([firstVault, secondVault].map((path) => mkdir(join(path, '.obsidian'), { recursive: true })))
    await writeFile(join(firstVault, 'first.md'), '# First')
    await writeFile(join(secondVault, 'moved.md'), '# Moved')
    await mkdir(registryDirectory, { recursive: true })
    const registryPath = join(registryDirectory, 'obsidian.json')
    await writeFile(registryPath, JSON.stringify({ vaults: { stable: { path: firstVault } } }))
    const service = new ObsidianVaultService(join(root, 'data'), vi.fn(async () => undefined), {
      platform: 'linux', homeDirectory: home,
    })
    await service.initialize()
    const candidate = (await service.discover())[0]!
    const binding = await service.mount(service.candidatePath(candidate.id), undefined, 'memory', service.candidateRegistryId(candidate.id))

    await writeFile(registryPath, JSON.stringify({ vaults: { stable: { path: secondVault } } }))
    for (let attempt = 0; attempt < 30 && service.list()[0]?.name !== 'Moved Vault'; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    }

    expect(service.list()).toEqual([expect.objectContaining({ id: binding.id, name: 'Moved Vault', memoryEnabled: true })])
    expect(service.list()[0]).not.toHaveProperty('rootPath')
    expect(service.list()[0]).not.toHaveProperty('registryId')
    expect((await service.tree(binding.id)).resources.map((resource) => resource.relativePath)).toEqual(['moved.md'])
    expect(service.isPathExcluded(join(firstVault, 'first.md'))).toBe(true)
    expect(service.isPathExcluded(join(secondVault, 'moved.md'))).toBe(true)
    await service.shutdown()
  })

  it('requires a Vault root and scans notes and supported attachments without .obsidian data', async () => {
    const { root, vaultPath, service } = await fixture()
    await expect(service.mount(root)).rejects.toThrow('.obsidian')

    const binding = await service.mount(vaultPath)
    const tree = await service.tree(binding.id)

    expect(binding).toMatchObject({ name: 'Product Vault', noteCount: 1, attachmentCount: 1, attachmentFolderPath: 'assets' })
    expect(binding).not.toHaveProperty('rootPath')
    expect(tree.resources.map((resource) => resource.relativePath)).toEqual(['cover.png', 'notes/roadmap.md'])
    expect(tree.resources.some((resource) => resource.relativePath.includes('.obsidian'))).toBe(false)
    await service.shutdown()
  })

  it('restores the same Room when the same Vault is mounted again', async () => {
    const { vaultPath, service } = await fixture()
    const first = await service.mount(vaultPath)
    const second = await service.mount(vaultPath)

    expect(second.id).toBe(first.id)
    expect(second.roomId).toBe(first.roomId)
    expect(service.list()).toHaveLength(1)
    await service.shutdown()
  })

  it('can bind a Vault into an existing Room without exposing its absolute path', async () => {
    const { vaultPath, service } = await fixture()
    const candidate = await service.registerCandidate(vaultPath)
    const binding = await service.mount(service.candidatePath(candidate.id), 'existing-room', 'embedded')

    expect(candidate).toMatchObject({ name: 'Product Vault', noteCount: 1, attachmentCount: 1 })
    expect(candidate).not.toHaveProperty('rootPath')
    expect(binding).toMatchObject({ roomId: 'existing-room', mountMode: 'embedded' })
    expect(binding).not.toHaveProperty('rootPath')
    await service.shutdown()
  })

  it('persists a memory Vault binding and upgrades it for Room use without duplicating the source', async () => {
    const { dataDirectory, vaultPath, service, trashPath } = await fixture()
    const memoryBinding = await service.mount(vaultPath, undefined, 'memory')
    expect(memoryBinding).toMatchObject({ mountMode: 'memory', memoryEnabled: true })

    await service.shutdown()
    const restarted = new ObsidianVaultService(dataDirectory, trashPath)
    await restarted.initialize()
    expect(restarted.list()).toEqual([
      expect.objectContaining({ id: memoryBinding.id, mountMode: 'memory', memoryEnabled: true }),
    ])

    const roomBinding = await restarted.mount(vaultPath, 'project-room', 'embedded')
    expect(roomBinding).toMatchObject({
      id: memoryBinding.id,
      roomId: 'project-room',
      mountMode: 'embedded',
      memoryEnabled: true,
    })
    expect(restarted.list()).toHaveLength(1)
    await restarted.shutdown()
  })

  it('ignores symbolic links that escape the Vault', async () => {
    const { root, vaultPath, service } = await fixture()
    await writeFile(join(root, 'secret.md'), '# Secret')
    await symlink(join(root, 'secret.md'), join(vaultPath, 'linked.md'))

    const binding = await service.mount(vaultPath)
    const tree = await service.tree(binding.id)

    expect(tree.resources.some((resource) => resource.relativePath === 'linked.md')).toBe(false)
    await service.shutdown()
  })

  it('uses source hashes to prevent overwriting an external edit', async () => {
    const { vaultPath, service } = await fixture()
    const binding = await service.mount(vaultPath)
    const note = (await service.tree(binding.id)).resources.find((resource) => resource.kind === 'note')!
    const snapshot = await service.readNote(binding.id, note.id)
    await writeFile(join(vaultPath, note.relativePath), '# Changed in Obsidian')

    const result = await service.saveNote(binding.id, note.id, '# Changed in EverRoom', snapshot.sourceHash)

    expect(result.status).toBe('conflict')
    expect(result.snapshot.markdown).toBe('# Changed in Obsidian')
    expect(await readFile(join(vaultPath, note.relativePath), 'utf8')).toBe('# Changed in Obsidian')
    await service.shutdown()
  })

  it('rejects writes through a symbolic-link directory', async () => {
    const { root, vaultPath, service } = await fixture()
    const outside = join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, join(vaultPath, 'escape'))
    const binding = await service.mount(vaultPath)

    await expect(service.createNote(binding.id, 'escape/leak.md', '# Leak')).rejects.toThrow('符号链接')
    await expect(readFile(join(outside, 'leak.md'), 'utf8')).rejects.toThrow()
    await service.shutdown()
  })

  it('creates, moves, saves and trashes the same source note', async () => {
    const { vaultPath, service, trashPath } = await fixture()
    const binding = await service.mount(vaultPath)
    const created = await service.createNote(binding.id, 'ideas/New idea', '# New idea')
    await service.setProjectionFileId(binding.id, created.resource.id, 'projected-file-1')
    await service.setProjectionDocumentId(binding.id, created.resource.id, 'projected-document-1')
    const saved = await service.saveNote(binding.id, created.resource.id, '# Revised', created.sourceHash)
    expect(saved.status).toBe('saved')
    if (saved.status !== 'saved') throw new Error('expected save')

    const moved = await service.moveNote(binding.id, created.resource.id, 'archive/Revised', saved.snapshot.sourceHash)
    expect(moved.resource.relativePath).toBe('archive/Revised.md')
    expect(await readFile(join(vaultPath, 'archive', 'Revised.md'), 'utf8')).toBe('# Revised')
    expect(service.projectionNotes(binding.id).find((note) => note.resourceId === moved.resource.id)?.projectionFileId).toBe('projected-file-1')
    expect(service.projectionNotes(binding.id).find((note) => note.resourceId === moved.resource.id)?.projectionDocumentId).toBe('projected-document-1')
    expect(service.noteForDocument('projected-document-1')).toEqual({ vaultId: binding.id, resourceId: moved.resource.id })

    await service.trashNote(binding.id, moved.resource.id, moved.sourceHash)
    expect(trashPath).toHaveBeenCalledWith(join(await realpath(vaultPath), 'archive', 'Revised.md'))
    expect((await service.tree(binding.id)).resources.some((resource) => resource.id === moved.resource.id)).toBe(false)
    expect(service.takeRemovedProjectionFileIds(binding.id)).toEqual(['projected-file-1'])
    expect(service.takeRemovedProjectionDocumentIds(binding.id)).toEqual(['projected-document-1'])
    await service.shutdown()
  })

  it('uses the configured attachment folder and keeps duplicate names', async () => {
    const { root, vaultPath, service } = await fixture()
    const source = join(root, 'diagram.png')
    await writeFile(source, Buffer.from('first'))
    const binding = await service.mount(vaultPath)

    const first = await service.addAttachment(binding.id, source, 'notes/roadmap.md')
    await writeFile(source, Buffer.from('second'))
    const second = await service.addAttachment(binding.id, source, 'notes/roadmap.md')

    expect(first.relativePath).toBe('assets/diagram.png')
    expect(second.relativePath).toBe('assets/diagram 2.png')
    expect(await readFile(join(vaultPath, second.relativePath), 'utf8')).toBe('second')
    await service.shutdown()
  })

  it('disconnects without deleting source files', async () => {
    const { vaultPath, service } = await fixture()
    const binding = await service.mount(vaultPath)
    await service.disconnect(binding.id)

    expect(service.list()).toEqual([])
    expect(await readFile(join(vaultPath, 'notes', 'roadmap.md'), 'utf8')).toContain('# Roadmap')
    await service.shutdown()
  })
})
