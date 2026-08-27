import { createHash, randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

import type {
  ObsidianVaultBinding,
  ObsidianVaultCandidate,
  ObsidianVaultChangedEvent,
  ObsidianDiscoveryChangedEvent,
  ObsidianVaultMountMode,
  ObsidianVaultResource,
  ObsidianVaultTree,
  VaultNoteSaveResult,
  VaultNoteSnapshot,
} from '../../shared/obsidian'

const NOTE_EXTENSIONS = new Set(['.md', '.markdown'])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const ATTACHMENT_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, '.pdf'])
const MAX_NOTE_BYTES = 20 * 1024 * 1024
const MAX_ASSET_BYTES = 100 * 1024 * 1024

interface StoredResource extends ObsidianVaultResource {
  fileIdentity: string
  projectionFileId?: string
  projectionDocumentId?: string
  memoryProjectionFileId?: string
}

interface StoredVault extends ObsidianVaultBinding {
  rootPath: string
  registryId?: string
  resources: StoredResource[]
}

interface StoreFile {
  version: 1
  vaults: StoredVault[]
  knownVaultRoots?: string[]
}

interface DiscoveredVault {
  rootPath: string
  registryId: string | null
  discoveredFrom: ObsidianVaultCandidate['discoveredFrom']
  lastOpenedAt: string | null
}

export interface ObsidianRegistryDiscoveryOptions {
  platform?: NodeJS.Platform
  homeDirectory?: string
  appDataDirectory?: string
}

const DISCOVERY_IGNORED_DIRECTORIES = new Set([
  'node_modules', 'Library', 'Applications', 'Movies', 'Music', 'Pictures',
  '.git', '.cache', '.Trash', 'dist', 'build', 'coverage',
])
const DISCOVERY_MAX_DEPTH = 4
const DISCOVERY_MAX_DIRECTORIES = 5_000

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function slashPath(value: string): string {
  return value.split(sep).join('/')
}

function normalizedRelativePath(value: string): string {
  const normalized = slashPath(normalize(value)).replace(/^\.\//, '')
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../') || normalized.startsWith('/')) {
    throw new Error('文件位置必须位于 Obsidian Vault 内。')
  }
  return normalized
}

function notePath(value: string): string {
  const normalized = normalizedRelativePath(value)
  return NOTE_EXTENSIONS.has(extname(normalized).toLowerCase()) ? normalized : `${normalized}.md`
}

function fileIdentity(info: Awaited<ReturnType<typeof stat>>): string {
  return info.ino > 0 ? `${info.dev}:${info.ino}` : `${info.size}:${info.mtimeMs}`
}

function mimeForExtension(extension: string): string {
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.gif') return 'image/gif'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.pdf') return 'application/pdf'
  return 'application/octet-stream'
}

export function obsidianRegistryPath(options: ObsidianRegistryDiscoveryOptions = {}): string {
  const platform = options.platform ?? process.platform
  const homeDirectory = options.homeDirectory ?? homedir()
  return platform === 'darwin'
    ? join(homeDirectory, 'Library', 'Application Support', 'obsidian', 'obsidian.json')
    : platform === 'win32'
      ? join(options.appDataDirectory ?? process.env.APPDATA ?? join(homeDirectory, 'AppData', 'Roaming'), 'obsidian', 'obsidian.json')
      : join(homeDirectory, '.config', 'obsidian', 'obsidian.json')
}

function comparablePath(value: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = resolve(value).replace(/[\\/]+$/, '')
  return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized
}

export function isPathInsideRoots(path: string, roots: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
  const candidate = comparablePath(path, platform)
  return roots.some((root) => {
    const boundary = comparablePath(root, platform)
    return candidate === boundary || candidate.startsWith(`${boundary}${sep}`)
  })
}

export async function discoverRegisteredObsidianVaultPaths(
  options: ObsidianRegistryDiscoveryOptions = {},
): Promise<DiscoveredVault[]> {
  const registryPath = obsidianRegistryPath(options)
  try {
    const parsed = JSON.parse(await readFile(registryPath, 'utf8')) as {
      vaults?: Record<string, { path?: unknown; ts?: unknown }>
    }
    if (!parsed.vaults || typeof parsed.vaults !== 'object') return []
    return Object.entries(parsed.vaults).flatMap(([registryId, vault]) => {
      if (typeof vault.path !== 'string' || !vault.path.trim()) return []
      const timestamp = typeof vault.ts === 'number' && Number.isFinite(vault.ts) ? new Date(vault.ts).toISOString() : null
      return [{ rootPath: vault.path, registryId, discoveredFrom: 'registry' as const, lastOpenedAt: timestamp }]
    })
  } catch {
    return []
  }
}

export class ObsidianVaultService {
  private readonly storePath: string
  private readonly listeners = new Set<(event: ObsidianVaultChangedEvent) => void>()
  private readonly discoveryListeners = new Set<(event: ObsidianDiscoveryChangedEvent) => void>()
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly scanTimers = new Map<string, NodeJS.Timeout>()
  private readonly removedProjectionFileIds = new Map<string, Set<string>>()
  private readonly removedProjectionDocumentIds = new Map<string, Set<string>>()
  private readonly removedMemoryProjectionFileIds = new Map<string, Set<string>>()
  private vaults: StoredVault[] = []
  private readonly discoveredPaths = new Map<string, string>()
  private readonly discoveredRegistryIds = new Map<string, string>()
  private readonly knownVaultRoots = new Set<string>()
  private registryWatcher: FSWatcher | null = null
  private registryTimer: NodeJS.Timeout | null = null
  private registryRetryTimer: NodeJS.Timeout | null = null
  private shuttingDown = false

  constructor(
    dataDirectory: string,
    private readonly trashPath: (path: string) => Promise<void>,
    private readonly discoveryOptions: ObsidianRegistryDiscoveryOptions = {},
  ) {
    this.storePath = join(dataDirectory, 'obsidian-vaults.json')
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.storePath, 'utf8')) as StoreFile
      if (parsed.version === 1 && Array.isArray(parsed.vaults)) {
        this.vaults = parsed.vaults.map((vault) => {
          const mountMode = vault.mountMode ?? 'dedicated'
          return { ...vault, mountMode, memoryEnabled: vault.memoryEnabled ?? mountMode === 'memory' }
        })
        for (const root of parsed.knownVaultRoots ?? []) this.knownVaultRoots.add(root)
      }
    } catch {
      this.vaults = []
    }
    await this.refreshRegisteredVaultRoots(false)
    this.startRegistryWatcher()
    await Promise.all(this.vaults.map(async (vault) => {
      try {
        await access(vault.rootPath)
        vault.status = 'connected'
        await this.scan(vault.id, false)
        this.startWatching(vault.id)
      } catch {
        vault.status = 'offline'
      }
    }))
    await this.persist()
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    if (this.registryTimer) clearTimeout(this.registryTimer)
    this.registryTimer = null
    if (this.registryRetryTimer) clearTimeout(this.registryRetryTimer)
    this.registryRetryTimer = null
    this.registryWatcher?.close()
    this.registryWatcher = null
    for (const timer of this.scanTimers.values()) clearTimeout(timer)
    this.scanTimers.clear()
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    await this.persist()
  }

  onChanged(listener: (event: ObsidianVaultChangedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onDiscoveryChanged(listener: (event: ObsidianDiscoveryChangedEvent) => void): () => void {
    this.discoveryListeners.add(listener)
    return () => this.discoveryListeners.delete(listener)
  }

  excludedRootPaths(): string[] {
    return [...this.knownVaultRoots]
  }

  isPathExcluded(path: string): boolean {
    return isPathInsideRoots(path, this.excludedRootPaths(), this.discoveryOptions.platform ?? process.platform)
  }

  notifyChanged(vaultId: string): void {
    this.emit(this.requireVault(vaultId))
  }

  list(): ObsidianVaultBinding[] {
    return this.vaults.map((vault) => this.binding(vault))
  }

  async discover(): Promise<ObsidianVaultCandidate[]> {
    this.startRegistryWatcher()
    const registered = await discoverRegisteredObsidianVaultPaths(this.discoveryOptions)
    const scanned = await this.scanCommonVaultLocations()
    const byRoot = new Map<string, DiscoveredVault>()
    let rootsChanged = false
    for (const item of [...registered, ...scanned]) {
      const rootPath = await this.validateVaultRoot(item.rootPath).catch(() => null)
      if (!rootPath) continue
      if (await this.rememberVaultRoot(rootPath, false)) rootsChanged = true
      const current = byRoot.get(rootPath)
      if (!current || current.discoveredFrom === 'scan') byRoot.set(rootPath, { ...item, rootPath })
    }
    for (const vault of this.vaults) {
      const rootPath = await this.validateVaultRoot(vault.rootPath).catch(() => null)
      if (rootPath && !byRoot.has(rootPath)) byRoot.set(rootPath, { rootPath, registryId: vault.registryId ?? null, discoveredFrom: 'manual', lastOpenedAt: null })
    }
    const candidates = await Promise.all([...byRoot.values()].map((item) => this.candidate(item)))
    await this.persist()
    if (rootsChanged) this.emitDiscoveryChanged()
    return candidates.sort((left, right) => {
      if (left.mountedVaultId && !right.mountedVaultId) return -1
      if (!left.mountedVaultId && right.mountedVaultId) return 1
      return (right.lastOpenedAt ?? '').localeCompare(left.lastOpenedAt ?? '') || left.name.localeCompare(right.name)
    })
  }

  async registerCandidate(rootPath: string): Promise<ObsidianVaultCandidate> {
    const root = await this.validateVaultRoot(rootPath)
    await this.rememberVaultRoot(root)
    return this.candidate({ rootPath: root, registryId: null, discoveredFrom: 'manual', lastOpenedAt: null })
  }

  candidatePath(candidateId: string): string {
    const rootPath = this.discoveredPaths.get(candidateId)
    if (!rootPath) throw new Error('Obsidian Vault 候选已过期，请刷新列表后重试。')
    return rootPath
  }

  vaultRootPath(vaultId: string): string {
    return this.requireVault(vaultId).rootPath
  }

  candidateRegistryId(candidateId: string): string | null {
    return this.discoveredRegistryIds.get(candidateId) ?? null
  }

  async mount(rootPath: string, roomId?: string, mountMode: ObsidianVaultMountMode = 'dedicated', registryId?: string | null): Promise<ObsidianVaultBinding> {
    const root = await this.validateVaultRoot(rootPath)
    const effectiveRegistryId = registryId ?? await this.registeredVaultIdForRoot(root)
    await this.rememberVaultRoot(root)
    const existing = this.vaults.find((vault) => resolve(vault.rootPath) === resolve(root))
    if (existing) {
      if (mountMode === 'memory') {
        existing.memoryEnabled = true
      } else if (existing.mountMode === 'memory') {
        existing.mountMode = mountMode
        existing.roomId = roomId ?? `vault-room-${randomUUID().slice(0, 8)}`
      } else if (roomId && existing.roomId !== roomId) {
        throw new Error(`该 Vault 已导入到另一个 Room（${existing.name}）。`)
      }
      existing.status = 'connected'
      if (effectiveRegistryId) existing.registryId = effectiveRegistryId
      await this.scan(existing.id, false)
      this.startWatching(existing.id)
      await this.persist()
      return this.binding(existing)
    }
    const now = new Date().toISOString()
    const vault: StoredVault = {
      id: `vault-${randomUUID()}`,
      roomId: roomId ?? `vault-room-${randomUUID().slice(0, 8)}`,
      mountMode,
      memoryEnabled: mountMode === 'memory',
      ...(effectiveRegistryId ? { registryId: effectiveRegistryId } : {}),
      name: basename(root),
      rootPath: root,
      attachmentFolderPath: await this.readAttachmentFolder(root),
      noteCount: 0,
      attachmentCount: 0,
      status: 'connected',
      updatedAt: now,
      resources: [],
    }
    this.vaults.push(vault)
    await this.scan(vault.id, false)
    this.startWatching(vault.id)
    return this.binding(vault)
  }

  private async validateVaultRoot(rootPath: string): Promise<string> {
    const root = await realpath(rootPath)
    const rootInfo = await stat(root)
    if (!rootInfo.isDirectory()) throw new Error('所选位置不是文件夹。')
    const configInfo = await stat(join(root, '.obsidian')).catch(() => null)
    if (!configInfo?.isDirectory()) throw new Error('请选择包含 .obsidian 的 Vault 根目录。')
    return root
  }

  private async registeredVaultIdForRoot(rootPath: string): Promise<string | null> {
    const registered = await discoverRegisteredObsidianVaultPaths(this.discoveryOptions)
    const platform = this.discoveryOptions.platform ?? process.platform
    const expected = comparablePath(rootPath, platform)
    for (const item of registered) {
      const candidate = await realpath(item.rootPath).catch(() => resolve(item.rootPath))
      if (comparablePath(candidate, platform) === expected) return item.registryId
    }
    return null
  }

  private async rememberVaultRoot(rootPath: string, persist = true): Promise<boolean> {
    const platform = this.discoveryOptions.platform ?? process.platform
    const roots = [resolve(rootPath), await realpath(rootPath).catch(() => resolve(rootPath))]
    let changed = false
    for (const root of roots) {
      const key = comparablePath(root, platform)
      if ([...this.knownVaultRoots].some((known) => comparablePath(known, platform) === key)) continue
      this.knownVaultRoots.add(root)
      changed = true
    }
    if (changed && persist) await this.persist()
    return changed
  }

  private async refreshRegisteredVaultRoots(notify = true): Promise<void> {
    const registered = await discoverRegisteredObsidianVaultPaths(this.discoveryOptions)
    let changed = false
    const reboundVaults: StoredVault[] = []
    for (const item of registered) {
      const root = await this.validateVaultRoot(item.rootPath).catch(() => null)
      if (!root) continue
      if (await this.rememberVaultRoot(item.rootPath, false)) changed = true
      const boundByRegistry = this.vaults.find((vault) => vault.registryId === item.registryId)
      const boundByPath = this.vaults.find((vault) => comparablePath(vault.rootPath, this.discoveryOptions.platform ?? process.platform) === comparablePath(root, this.discoveryOptions.platform ?? process.platform))
      const bound = boundByRegistry ?? boundByPath
      if (!bound) continue
      if (!bound.registryId) {
        bound.registryId = item.registryId ?? undefined
        changed = true
      }
      if (resolve(bound.rootPath) === resolve(root)) continue
      this.watchers.get(bound.id)?.close()
      this.watchers.delete(bound.id)
      bound.rootPath = root
      bound.name = basename(root)
      bound.attachmentFolderPath = await this.readAttachmentFolder(root)
      bound.status = 'connected'
      await this.scan(bound.id, false)
      this.startWatching(bound.id)
      reboundVaults.push(bound)
      changed = true
    }
    if (changed) await this.persist()
    for (const vault of reboundVaults) this.emit(vault)
    if (notify) this.emitDiscoveryChanged()
  }

  private startRegistryWatcher(): void {
    if (this.registryWatcher || this.shuttingDown) return
    const registryPath = obsidianRegistryPath(this.discoveryOptions)
    try {
      this.registryWatcher = watch(dirname(registryPath), (_event, filename) => {
        if (filename && filename.toString() !== basename(registryPath)) return
        if (this.registryTimer) clearTimeout(this.registryTimer)
        this.registryTimer = setTimeout(() => {
          this.registryTimer = null
          void this.refreshRegisteredVaultRoots().catch(() => undefined)
        }, 250)
      })
      this.registryWatcher.on('error', () => {
        this.registryWatcher?.close()
        this.registryWatcher = null
        this.scheduleRegistryWatcherRetry()
      })
    } catch {
      this.registryWatcher = null
      this.scheduleRegistryWatcherRetry()
    }
  }

  private scheduleRegistryWatcherRetry(): void {
    if (this.registryRetryTimer || this.shuttingDown) return
    this.registryRetryTimer = setTimeout(() => {
      this.registryRetryTimer = null
      this.startRegistryWatcher()
    }, 5_000)
  }

  private async candidate(item: DiscoveredVault): Promise<ObsidianVaultCandidate> {
    let noteCount = 0
    let attachmentCount = 0
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (entry.name.startsWith('.')) continue
        const path = resolve(directory, entry.name)
        const info = await lstat(path).catch(() => null)
        if (!info || info.isSymbolicLink()) continue
        if (entry.isDirectory()) await visit(path)
        else if (entry.isFile()) {
          const extension = extname(entry.name).toLowerCase()
          if (NOTE_EXTENSIONS.has(extension)) noteCount += 1
          else if (ATTACHMENT_EXTENSIONS.has(extension)) attachmentCount += 1
        }
      }
    }
    await visit(item.rootPath)
    const id = `obsidian-candidate-${sha256(Buffer.from(item.rootPath)).slice(0, 24)}`
    this.discoveredPaths.set(id, item.rootPath)
    if (item.registryId) this.discoveredRegistryIds.set(id, item.registryId)
    const mounted = this.vaults.find((vault) => resolve(vault.rootPath) === resolve(item.rootPath))
    const roomMounted = mounted && mounted.mountMode !== 'memory' ? mounted : null
    return {
      id,
      name: basename(item.rootPath),
      noteCount,
      attachmentCount,
      discoveredFrom: item.discoveredFrom,
      lastOpenedAt: item.lastOpenedAt,
      mountedVaultId: mounted?.id ?? null,
      mountedRoomId: roomMounted?.roomId ?? null,
      memoryEnabled: mounted?.memoryEnabled ?? false,
    }
  }

  private async scanCommonVaultLocations(): Promise<DiscoveredVault[]> {
    const homeDirectory = this.discoveryOptions.homeDirectory ?? homedir()
    const roots = [join(homeDirectory, 'Documents'), join(homeDirectory, 'Desktop')]
    const found: DiscoveredVault[] = []
    let visited = 0
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > DISCOVERY_MAX_DEPTH || visited >= DISCOVERY_MAX_DIRECTORIES) return
      visited += 1
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
      if (entries.some((entry) => entry.name === '.obsidian' && entry.isDirectory())) {
        found.push({ rootPath: directory, registryId: null, discoveredFrom: 'scan', lastOpenedAt: null })
        return
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || DISCOVERY_IGNORED_DIRECTORIES.has(entry.name)) continue
        const path = resolve(directory, entry.name)
        const info = await lstat(path).catch(() => null)
        if (!info || info.isSymbolicLink()) continue
        await visit(path, depth + 1)
      }
    }
    for (const root of roots) await visit(root, 0)
    return found
  }

  async tree(vaultId: string): Promise<ObsidianVaultTree> {
    const vault = this.requireVault(vaultId)
    if (vault.status === 'connected') await this.scan(vault.id, false)
    return { vault: this.binding(vault), resources: vault.resources.map(this.resource) }
  }

  projectionNotes(vaultId: string): Array<{
    vaultId: string
    resourceId: string
    roomId: string
    filePath: string
    relativePath: string
    sourceHash: string
    sourceModifiedAt: string
    projectionFileId: string | null
    projectionDocumentId: string | null
  }> {
    const vault = this.requireVault(vaultId)
    return vault.resources.filter((resource) => resource.kind === 'note').map((resource) => ({
      vaultId: vault.id,
      resourceId: resource.id,
      roomId: vault.roomId,
      filePath: this.resolveInside(vault, resource.relativePath),
      relativePath: resource.relativePath,
      sourceHash: resource.sourceHash,
      sourceModifiedAt: resource.modifiedAt,
      projectionFileId: resource.projectionFileId ?? null,
      projectionDocumentId: resource.projectionDocumentId ?? null,
    }))
  }

  async setProjectionFileId(vaultId: string, resourceId: string, fileId: string): Promise<void> {
    const vault = this.requireVault(vaultId)
    this.requireResource(vault, resourceId, 'note').projectionFileId = fileId
    await this.persist()
  }

  async setProjectionDocumentId(vaultId: string, resourceId: string, documentId: string): Promise<void> {
    const vault = this.requireVault(vaultId)
    this.requireResource(vault, resourceId, 'note').projectionDocumentId = documentId
    await this.persist()
  }

  async setMemoryProjectionFileId(vaultId: string, relativePath: string, fileId: string): Promise<void> {
    const vault = this.requireVault(vaultId)
    const resource = vault.resources.find((item) => item.relativePath === relativePath)
    if (!resource) return
    resource.memoryProjectionFileId = fileId
    await this.persist()
  }

  noteForDocument(documentId: string): { vaultId: string; resourceId: string } | null {
    for (const vault of this.vaults) {
      const resource = vault.resources.find((item) => item.projectionDocumentId === documentId)
      if (resource) return { vaultId: vault.id, resourceId: resource.id }
    }
    return null
  }

  takeRemovedProjectionFileIds(vaultId: string): string[] {
    const ids = [...(this.removedProjectionFileIds.get(vaultId) ?? [])]
    this.removedProjectionFileIds.delete(vaultId)
    return ids
  }

  takeRemovedProjectionDocumentIds(vaultId: string): string[] {
    const ids = [...(this.removedProjectionDocumentIds.get(vaultId) ?? [])]
    this.removedProjectionDocumentIds.delete(vaultId)
    return ids
  }

  takeRemovedMemoryProjectionFileIds(vaultId: string): string[] {
    const ids = [...(this.removedMemoryProjectionFileIds.get(vaultId) ?? [])]
    this.removedMemoryProjectionFileIds.delete(vaultId)
    return ids
  }

  projectionFileIds(vaultId: string): string[] {
    return this.requireVault(vaultId).resources.flatMap((resource) => resource.projectionFileId ? [resource.projectionFileId] : [])
  }

  projectionDocumentIds(vaultId: string): string[] {
    return this.requireVault(vaultId).resources.flatMap((resource) => resource.projectionDocumentId ? [resource.projectionDocumentId] : [])
  }

  memoryProjectionFileIds(vaultId: string): string[] {
    return this.requireVault(vaultId).resources.flatMap((resource) => resource.memoryProjectionFileId ? [resource.memoryProjectionFileId] : [])
  }

  async rescan(vaultId: string): Promise<ObsidianVaultBinding> {
    await this.scan(vaultId)
    return this.binding(this.requireVault(vaultId))
  }

  async readNote(vaultId: string, resourceId: string): Promise<VaultNoteSnapshot> {
    const vault = this.requireVault(vaultId)
    const resource = this.requireResource(vault, resourceId, 'note')
    const path = this.resolveInside(vault, resource.relativePath)
    await this.assertSafeExistingPath(vault, path)
    const buffer = await readFile(path)
    if (buffer.byteLength > MAX_NOTE_BYTES) throw new Error('笔记超过 20 MB，无法在 EverRoom 中编辑。')
    const sourceHash = sha256(buffer)
    if (sourceHash !== resource.sourceHash) await this.scan(vault.id)
    return {
      resource: this.resource({ ...resource, sourceHash }),
      markdown: buffer.toString('utf8'),
      sourceHash,
    }
  }

  async saveNote(
    vaultId: string,
    resourceId: string,
    markdown: string,
    expectedSourceHash: string,
  ): Promise<VaultNoteSaveResult> {
    return this.saveNoteWithNotification(vaultId, resourceId, markdown, expectedSourceHash, true)
  }

  async saveNoteForAgent(
    vaultId: string,
    resourceId: string,
    markdown: string,
    expectedSourceHash: string,
  ): Promise<VaultNoteSaveResult> {
    return this.saveNoteWithNotification(vaultId, resourceId, markdown, expectedSourceHash, false)
  }

  private async saveNoteWithNotification(
    vaultId: string,
    resourceId: string,
    markdown: string,
    expectedSourceHash: string,
    notify: boolean,
  ): Promise<VaultNoteSaveResult> {
    if (Buffer.byteLength(markdown, 'utf8') > MAX_NOTE_BYTES) throw new Error('笔记超过 20 MB，无法保存。')
    const current = await this.readNote(vaultId, resourceId)
    if (current.sourceHash !== expectedSourceHash) return { status: 'conflict', snapshot: current }
    const vault = this.requireVault(vaultId)
    const path = this.resolveInside(vault, current.resource.relativePath)
    await this.assertSafeExistingPath(vault, path)
    await this.atomicWrite(path, Buffer.from(markdown, 'utf8'))
    await this.scan(vaultId, notify)
    return { status: 'saved', snapshot: await this.readNote(vaultId, resourceId) }
  }

  async createNote(vaultId: string, requestedPath: string, markdown = ''): Promise<VaultNoteSnapshot> {
    const vault = this.requireVault(vaultId)
    const relativePath = notePath(requestedPath)
    const path = this.resolveInside(vault, relativePath)
    await this.assertSafeWritePath(vault, path)
    await mkdir(dirname(path), { recursive: true })
    try {
      await access(path)
      throw new Error('同名笔记已经存在。')
    } catch (error) {
      if (error instanceof Error && error.message === '同名笔记已经存在。') throw error
    }
    const title = basename(relativePath, extname(relativePath))
    await this.atomicWrite(path, Buffer.from(markdown || `# ${title}\n`, 'utf8'))
    await this.scan(vaultId)
    const created = vault.resources.find((resource) => resource.relativePath === relativePath)
    if (!created) throw new Error('笔记已写入，但重新扫描时未找到。')
    return this.readNote(vaultId, created.id)
  }

  async moveNote(
    vaultId: string,
    resourceId: string,
    requestedPath: string,
    expectedSourceHash: string,
  ): Promise<VaultNoteSnapshot> {
    const current = await this.readNote(vaultId, resourceId)
    if (current.sourceHash !== expectedSourceHash) throw new Error('源文件已经变化，请刷新后再移动。')
    const vault = this.requireVault(vaultId)
    const destinationRelativePath = notePath(requestedPath)
    const source = this.resolveInside(vault, current.resource.relativePath)
    const destination = this.resolveInside(vault, destinationRelativePath)
    await this.assertSafeExistingPath(vault, source)
    await this.assertSafeWritePath(vault, destination)
    await mkdir(dirname(destination), { recursive: true })
    await access(destination).then(() => { throw new Error('目标位置已有同名笔记。') }).catch((error) => {
      if (error instanceof Error && error.message === '目标位置已有同名笔记。') throw error
    })
    await rename(source, destination)
    const stored = this.requireResource(vault, resourceId, 'note')
    stored.relativePath = destinationRelativePath
    stored.name = basename(destinationRelativePath)
    await this.scan(vaultId)
    return this.readNote(vaultId, resourceId)
  }

  async trashNote(vaultId: string, resourceId: string, expectedSourceHash: string): Promise<void> {
    const current = await this.readNote(vaultId, resourceId)
    if (current.sourceHash !== expectedSourceHash) throw new Error('源文件已经变化，请刷新后再删除。')
    const vault = this.requireVault(vaultId)
    const path = this.resolveInside(vault, current.resource.relativePath)
    await this.assertSafeExistingPath(vault, path)
    await this.trashPath(path)
    await this.scan(vaultId)
  }

  async addAttachment(vaultId: string, sourcePath: string, noteRelativePath?: string): Promise<ObsidianVaultResource> {
    const vault = this.requireVault(vaultId)
    const extension = extname(sourcePath).toLowerCase()
    if (!ATTACHMENT_EXTENSIONS.has(extension)) throw new Error('仅支持 PNG、JPEG、GIF、WebP 和 PDF 附件。')
    const sourceInfo = await stat(sourcePath)
    if (!sourceInfo.isFile() || sourceInfo.size > MAX_ASSET_BYTES) throw new Error('附件无效或超过 100 MB。')
    const configured = vault.attachmentFolderPath
    const folder = configured === './' && noteRelativePath ? dirname(noteRelativePath) : configured
    const safeFolder = folder === '/' || folder === '.' ? '' : normalizedRelativePath(folder)
    const original = basename(sourcePath)
    let relativePath = safeFolder ? `${safeFolder}/${original}` : original
    let sequence = 2
    while (await this.exists(this.resolveInside(vault, relativePath))) {
      relativePath = `${safeFolder ? `${safeFolder}/` : ''}${basename(original, extension)} ${sequence}${extension}`
      sequence += 1
    }
    const destination = this.resolveInside(vault, relativePath)
    await this.assertSafeWritePath(vault, destination)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(sourcePath, destination)
    await this.scan(vaultId)
    const resource = vault.resources.find((item) => item.relativePath === relativePath)
    if (!resource) throw new Error('附件已复制，但重新扫描时未找到。')
    return this.resource(resource)
  }

  async disconnect(vaultId: string): Promise<void> {
    this.watchers.get(vaultId)?.close()
    this.watchers.delete(vaultId)
    this.vaults = this.vaults.filter((vault) => vault.id !== vaultId)
    await this.persist()
  }

  async asset(vaultId: string, resourceId: string): Promise<{ buffer: Buffer; mime: string }> {
    const vault = this.requireVault(vaultId)
    const resource = this.requireResource(vault, resourceId)
    if (resource.kind === 'note') throw new Error('笔记不能作为附件读取。')
    const path = this.resolveInside(vault, resource.relativePath)
    await this.assertSafeExistingPath(vault, path)
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_ASSET_BYTES) throw new Error('附件不可用。')
    return { buffer: await readFile(path), mime: mimeForExtension(extname(path).toLowerCase()) }
  }

  private async scan(vaultId: string, notify = true): Promise<void> {
    const vault = this.requireVault(vaultId)
    const discovered: Array<Omit<StoredResource, 'id' | 'vaultId' | 'assetUrl'>> = []
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const path = resolve(directory, entry.name)
        const linkInfo = await lstat(path)
        if (linkInfo.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          await visit(path)
          continue
        }
        if (!entry.isFile()) continue
        const extension = extname(entry.name).toLowerCase()
        const kind = NOTE_EXTENSIONS.has(extension) ? 'note' : IMAGE_EXTENSIONS.has(extension) ? 'image' : extension === '.pdf' ? 'pdf' : null
        if (!kind) continue
        const info = await stat(path)
        const maximum = kind === 'note' ? MAX_NOTE_BYTES : MAX_ASSET_BYTES
        if (info.size > maximum) continue
        const buffer = await readFile(path)
        discovered.push({
          relativePath: slashPath(relative(vault.rootPath, path)),
          name: entry.name,
          kind,
          byteSize: info.size,
          sourceHash: sha256(buffer),
          modifiedAt: info.mtime.toISOString(),
          fileIdentity: fileIdentity(info),
        })
      }
    }
    try {
      await visit(vault.rootPath)
      vault.status = 'connected'
    } catch {
      vault.status = 'offline'
      return
    }
    const unmatched = new Set(vault.resources)
    const byPath = new Map(vault.resources.map((resource) => [resource.relativePath, resource]))
    const byIdentity = new Map(vault.resources.map((resource) => [resource.fileIdentity, resource]))
    const hashCounts = new Map<string, number>()
    for (const resource of vault.resources) hashCounts.set(resource.sourceHash, (hashCounts.get(resource.sourceHash) ?? 0) + 1)
    vault.resources = discovered.map((item) => {
      const previous = byPath.get(item.relativePath)
        ?? byIdentity.get(item.fileIdentity)
        ?? (hashCounts.get(item.sourceHash) === 1 ? [...unmatched].find((candidate) => candidate.sourceHash === item.sourceHash) : undefined)
      if (previous) unmatched.delete(previous)
      return {
        ...item,
        id: previous?.id ?? `vault-resource-${randomUUID()}`,
        vaultId: vault.id,
        ...(previous?.projectionFileId ? { projectionFileId: previous.projectionFileId } : {}),
        ...(previous?.projectionDocumentId ? { projectionDocumentId: previous.projectionDocumentId } : {}),
        ...(previous?.memoryProjectionFileId ? { memoryProjectionFileId: previous.memoryProjectionFileId } : {}),
        assetUrl: item.kind === 'note' ? null : this.assetUrl(vault.id, previous?.id ?? ''),
      }
    }).map((resource) => ({
      ...resource,
      assetUrl: resource.kind === 'note' ? null : this.assetUrl(vault.id, resource.id),
    })).sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    const removedIds = [...unmatched].flatMap((resource) => resource.projectionFileId ? [resource.projectionFileId] : [])
    if (removedIds.length) {
      const pending = this.removedProjectionFileIds.get(vault.id) ?? new Set<string>()
      removedIds.forEach((id) => pending.add(id))
      this.removedProjectionFileIds.set(vault.id, pending)
    }
    const removedDocumentIds = [...unmatched].flatMap((resource) => resource.projectionDocumentId ? [resource.projectionDocumentId] : [])
    if (removedDocumentIds.length) {
      const pending = this.removedProjectionDocumentIds.get(vault.id) ?? new Set<string>()
      removedDocumentIds.forEach((id) => pending.add(id))
      this.removedProjectionDocumentIds.set(vault.id, pending)
    }
    const removedMemoryIds = [...unmatched].flatMap((resource) => resource.memoryProjectionFileId ? [resource.memoryProjectionFileId] : [])
    if (removedMemoryIds.length) {
      const pending = this.removedMemoryProjectionFileIds.get(vault.id) ?? new Set<string>()
      removedMemoryIds.forEach((id) => pending.add(id))
      this.removedMemoryProjectionFileIds.set(vault.id, pending)
    }
    vault.noteCount = vault.resources.filter((resource) => resource.kind === 'note').length
    vault.attachmentCount = vault.resources.length - vault.noteCount
    vault.updatedAt = new Date().toISOString()
    await this.persist()
    if (notify) this.emit(vault)
  }

  private startWatching(vaultId: string): void {
    if (this.watchers.has(vaultId)) return
    const vault = this.requireVault(vaultId)
    try {
      const watcher = watch(vault.rootPath, { recursive: true }, () => {
        const previous = this.scanTimers.get(vaultId)
        if (previous) clearTimeout(previous)
        this.scanTimers.set(vaultId, setTimeout(() => {
          this.scanTimers.delete(vaultId)
          void this.scan(vaultId).catch(() => undefined)
        }, 250))
      })
      watcher.on('error', () => {
        vault.status = 'offline'
        watcher.close()
        this.watchers.delete(vaultId)
        this.emit(vault)
      })
      this.watchers.set(vaultId, watcher)
    } catch {
      vault.status = 'offline'
    }
  }

  private async atomicWrite(path: string, buffer: Buffer): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = join(dirname(path), `.${basename(path)}.everroom-${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(buffer)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
    try {
      const directory = await open(dirname(path), 'r')
      try { await directory.sync() } finally { await directory.close() }
    } catch { /* Directory fsync is not supported on every platform. */ }
  }

  private resolveInside(vault: StoredVault, relativePath: string): string {
    const root = resolve(vault.rootPath)
    const path = resolve(root, normalizedRelativePath(relativePath))
    if (path === root || !path.startsWith(`${root}${sep}`)) throw new Error('文件位置超出已授权 Vault。')
    return path
  }

  private async assertSafeExistingPath(vault: StoredVault, path: string): Promise<void> {
    const root = await realpath(vault.rootPath)
    const actual = await realpath(path)
    if (actual === root || !actual.startsWith(`${root}${sep}`)) throw new Error('文件位置超出已授权 Vault。')
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error('不允许通过符号链接访问 Vault 资源。')
  }

  private async assertSafeWritePath(vault: StoredVault, path: string): Promise<void> {
    const root = resolve(await realpath(vault.rootPath))
    const relativeDestination = relative(root, path)
    let current = root
    for (const segment of slashPath(relativeDestination).split('/').slice(0, -1)) {
      current = join(current, segment)
      try {
        const info = await lstat(current)
        if (info.isSymbolicLink()) throw new Error('不允许写入符号链接目录。')
        if (!info.isDirectory()) throw new Error('目标路径包含非目录项目。')
      } catch (error) {
        if (error instanceof Error && ('code' in error) && error.code === 'ENOENT') break
        throw error
      }
    }
  }

  private requireVault(vaultId: string): StoredVault {
    const vault = this.vaults.find((item) => item.id === vaultId)
    if (!vault) throw new Error('Obsidian Vault 不存在或已断开。')
    return vault
  }

  private requireResource(vault: StoredVault, resourceId: string, kind?: StoredResource['kind']): StoredResource {
    const resource = vault.resources.find((item) => item.id === resourceId)
    if (!resource || (kind && resource.kind !== kind)) throw new Error('Vault 资源不存在。')
    return resource
  }

  private resource = (resource: StoredResource): ObsidianVaultResource => {
    const {
      fileIdentity: _fileIdentity,
      projectionFileId: _projectionFileId,
      projectionDocumentId: _projectionDocumentId,
      memoryProjectionFileId: _memoryProjectionFileId,
      ...value
    } = resource
    return { ...value }
  }

  private binding(vault: StoredVault): ObsidianVaultBinding {
    const { resources: _resources, rootPath: _rootPath, registryId: _registryId, ...binding } = vault
    return { ...binding }
  }

  private emit(vault: StoredVault): void {
    const event = { vaultId: vault.id, roomId: vault.roomId, updatedAt: vault.updatedAt }
    for (const listener of this.listeners) listener(event)
  }

  private emitDiscoveryChanged(): void {
    const event = { updatedAt: new Date().toISOString() }
    for (const listener of this.discoveryListeners) listener(event)
  }

  private assetUrl(vaultId: string, resourceId: string): string {
    return `nxcore-vault-asset://local/${encodeURIComponent(vaultId)}/${encodeURIComponent(resourceId)}`
  }

  private async readAttachmentFolder(root: string): Promise<string> {
    try {
      const config = JSON.parse(await readFile(join(root, '.obsidian', 'app.json'), 'utf8')) as { attachmentFolderPath?: unknown }
      const value = typeof config.attachmentFolderPath === 'string' ? config.attachmentFolderPath.trim() : ''
      if (!value || value === '/') return ''
      if (value === './') return './'
      return normalizedRelativePath(value)
    } catch {
      return ''
    }
  }

  private async exists(path: string): Promise<boolean> {
    try { await access(path); return true } catch { return false }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true })
    await writeFile(this.storePath, JSON.stringify({
      version: 1,
      vaults: this.vaults,
      knownVaultRoots: [...this.knownVaultRoots],
    } satisfies StoreFile, null, 2), 'utf8')
  }
}

export const obsidianVaultInternals = {
  normalizedRelativePath,
  notePath,
  sha256,
}
