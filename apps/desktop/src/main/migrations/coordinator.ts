import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { statSync } from 'node:fs'
import { VersionedJsonStore } from '@nxcore/migration-kit'
import type { BrowserWindow } from 'electron'
import { dialog } from 'electron'
import type {
  LocalAgentHistoryImportResult,
  LocalAgentInstallation,
  MigrationProgressEvent,
  MigrationProvider,
  MigrationRun,
  MigrationSource,
} from '@nxcore/agent-contract'
import type { DiscoveredMigrationSource, LocalAgentMigrationProvider } from '../../shared/migrations'
import type { FilesGatewayBridge } from '../gateway/files-gateway-bridge'
import type { ExportedMigrationThread, MigrationsGatewayBridge } from '../gateway/migrations-gateway-bridge'
import { discoverOpenClawSources, readOpenClawSource, type ResolvedOpenClawSource } from './openclaw-adapter'
import { extractNotionZip } from './notion-zip-adapter'
import { streamLocalAgentHistory } from '../local-agents/history'
import { cherryDataRoot, detectCherryStore, discoverCherrySources, markMissingAttachments, readCherrySource, type ResolvedCherrySource } from './cherry-adapter'
import { CherryWatcher, type CherrySyncCheckpoint } from './cherry-watcher'
import type { MigrationAttachmentRef, MigrationThreadUpload, NormalizedMigrationAttachment, NormalizedMigrationThread } from './types'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

const LOCAL_AGENT_LABELS: Record<LocalAgentMigrationProvider, string> = { codex: 'Codex', claude: 'Claude Code' }
const LOCAL_AGENT_DIRECTORIES: Record<LocalAgentMigrationProvider, string[]> = { codex: ['.codex'], claude: ['.claude'] }

const THREADS_BATCH_LIMIT = 20
const THREADS_BATCH_BYTES = 64 * 1024 * 1024

function chunkThreads<T extends { messages: Array<{ content: string }> }>(threads: T[]): T[][] {
  const batches: T[][] = []
  for (let offset = 0; offset < threads.length; ) {
    const batch: T[] = []
    let bytes = 0
    while (offset < threads.length && batch.length < THREADS_BATCH_LIMIT) {
      const thread = threads[offset]!
      const size = thread.messages.reduce((sum, message) => sum + message.content.length, 0)
      if (batch.length && bytes + size > THREADS_BATCH_BYTES) break
      batch.push(thread); bytes += size; offset += 1
    }
    batches.push(batch)
  }
  return batches
}

export interface ResolvedLocalAgentSource extends DiscoveredMigrationSource { path: string }

export function discoverLocalAgentSources(provider: LocalAgentMigrationProvider, home = homedir()): ResolvedLocalAgentSource[] {
  return LOCAL_AGENT_DIRECTORIES[provider]
    .map((directory) => join(home, directory))
    .filter((path) => {
      try { return statSync(path).isDirectory() } catch { return false }
    })
    .map((path) => ({ provider, id: hash(resolve(path)), displayName: LOCAL_AGENT_LABELS[provider], transport: 'local-jsonl' as const, standard: true, path }))
}

export class MigrationCoordinator {
  private discovered = new Map<string, ResolvedOpenClawSource | ResolvedLocalAgentSource | ResolvedCherrySource>()
  private readonly sourcePaths = new Map<string, string>()
  private readonly runPaths = new Map<string, string>()
  private listener: ((event: MigrationProgressEvent) => void) | null = null
  private cherryWatcher: CherryWatcher | null = null
  private cherrySourceId: string | null = null

  constructor(
    private readonly gateway: MigrationsGatewayBridge,
    private readonly files: FilesGatewayBridge,
    private readonly window: () => BrowserWindow | null,
    locatorPath: string,
    backupDir?: string,
  ) {
    this.store = new VersionedJsonStore<Record<string, string>>({
      filePath: locatorPath,
      migrations: [],
      adoptBaseline: (raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
        return Object.fromEntries(
          Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        )
      },
      fallback: {},
      ...(backupDir !== undefined ? { backupDir } : {}),
    })
    this.cherryStore = new VersionedJsonStore<CherrySyncCheckpoint | null>({
      filePath: join(dirname(locatorPath), 'cherry-sync.json'),
      migrations: [],
      adoptBaseline: (raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
        const candidate = raw as Record<string, unknown>
        if (typeof candidate.fingerprint !== 'string' || typeof candidate.dbMtimeMs !== 'number' || typeof candidate.dbSize !== 'number') return null
        return { fingerprint: candidate.fingerprint, dbMtimeMs: candidate.dbMtimeMs, dbSize: candidate.dbSize, confirmedAt: typeof candidate.confirmedAt === 'number' ? candidate.confirmedAt : Date.now() }
      },
      fallback: null,
      ...(backupDir !== undefined ? { backupDir } : {}),
    })
  }
  private readonly store: VersionedJsonStore<Record<string, string>>
  private readonly cherryStore: VersionedJsonStore<CherrySyncCheckpoint | null>
  async initialize(): Promise<void> {
    Object.entries(this.store.read()).forEach(([id, path]) => this.sourcePaths.set(id, path))
  }
  private persistLocators(): void { this.store.write(Object.fromEntries(this.sourcePaths)) }
  onProgress(listener: ((event: MigrationProgressEvent) => void) | null): void { this.listener = listener }
  private emit(run: MigrationRun): MigrationRun { this.listener?.({ run }); return run }
  async discover(): Promise<DiscoveredMigrationSource[]> { const items = await discoverOpenClawSources(); this.discovered = new Map(items.map((item) => [item.id, item])); return items.map(({ path: _path, ...item }) => item) }
  localAgentSources(provider: LocalAgentMigrationProvider): DiscoveredMigrationSource[] {
    const items = discoverLocalAgentSources(provider)
    for (const item of items) this.discovered.set(item.id, item)
    return items.map(({ path: _path, ...item }) => item)
  }
  sources(): Promise<MigrationSource[]> { return this.gateway.sources() }
  runs(sourceId?: string): Promise<MigrationRun[]> { return this.gateway.runs(sourceId) }
  cancel(runId: string): Promise<MigrationRun> { return this.gateway.cancel(runId).then((run) => this.emit(run)) }
  async clear(sourceId: string): Promise<void> {
    if (this.cherrySourceId === sourceId) { this.cherryWatcher?.stop(); this.cherryWatcher = null; this.cherrySourceId = null; this.cherryStore.write(null) }
    this.sourcePaths.delete(sourceId); this.persistLocators(); return this.gateway.clear(sourceId)
  }

  async chooseOpenClaw(): Promise<MigrationRun | null> {
    const options = { title: '选择 OpenClaw 数据目录或官方归档', properties: ['openFile', 'openDirectory'] as Array<'openFile' | 'openDirectory'>, filters: [{ name: 'OpenClaw archive', extensions: ['gz'] }] }
    const parent = this.window(); const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return this.importOpenClawPath(result.filePaths[0])
  }
  async importOpenClaw(discoveredId?: string): Promise<MigrationRun> {
    if (!this.discovered.size) await this.discover()
    const source = discoveredId ? this.discovered.get(discoveredId) : this.discovered.size === 1 ? [...this.discovered.values()][0] : undefined
    if (!source) throw new Error('需要选择一个 OpenClaw 数据来源')
    return this.importOpenClawPath(source.path, source.transport, source.displayName)
  }
  async chooseLocalAgentDirectory(provider: LocalAgentMigrationProvider): Promise<MigrationRun | null> {
    const label = LOCAL_AGENT_LABELS[provider]
    const options = { title: `选择 ${label} 数据目录`, properties: ['openDirectory'] as Array<'openDirectory'> }
    const parent = this.window(); const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return (await this.importLocalAgentHistoryPath(provider, result.filePaths[0])).run
  }
  async importLocalAgentMigration(provider: LocalAgentMigrationProvider, discoveredId?: string): Promise<MigrationRun> {
    const sources = this.localAgentSources(provider)
    const source = discoveredId ? this.discovered.get(discoveredId) : this.discovered.get(sources[0]?.id ?? '')
    if (!source || source.provider !== provider) throw new Error(`未找到本机 ${LOCAL_AGENT_LABELS[provider]} 的聊天记录目录。`)
    return (await this.importLocalAgentHistoryPath(provider, source.path, source.displayName)).run
  }
  async retry(runId: string): Promise<MigrationRun> {
    const prior = (await this.gateway.runs()).find((run) => run.id === runId)
    if (!prior) throw new Error('Migration run not found')
    const path = this.runPaths.get(runId) ?? this.sourcePaths.get(prior.sourceId)
    if (!path) throw new Error('原始路径不可用，请重新选择来源')
    if (prior.provider === 'openclaw') return this.importOpenClawPath(path, prior.transport)
    if (prior.provider === 'codex' || prior.provider === 'claude') {
      return (await this.importLocalAgentHistoryPath(prior.provider, path)).run
    }
    if (prior.provider === 'cherry') return this.importCherryPath(path)
    return this.importNotionZipPath(path)
  }
  async reimport(sourceId: string): Promise<MigrationRun> {
    const source = (await this.gateway.sources()).find((item) => item.id === sourceId)
    const path = this.sourcePaths.get(sourceId)
    if (!source || !path) throw new Error('原始路径不可用，请重新选择来源')
    if (source.provider === 'openclaw') return this.importOpenClawPath(path, source.transport, source.displayName)
    if (source.provider === 'codex' || source.provider === 'claude') {
      return (await this.importLocalAgentHistoryPath(source.provider, path, source.displayName)).run
    }
    if (source.provider === 'cherry') return this.importCherryPath(path, source.displayName)
    return this.importNotionZipPath(path)
  }

  async importLocalAgentHistory(agent: LocalAgentInstallation): Promise<LocalAgentHistoryImportResult> {
    if (agent.provider !== 'codex' && agent.provider !== 'claude') {
      throw new Error('local_agent_history_adapter_unavailable')
    }
    const root = agent.historyPaths[0]
    if (!root) throw new Error('未找到该本机 Agent 的聊天记录。')
    const imported = await this.importLocalAgentHistoryPath(
      agent.provider,
      root,
      agent.displayName,
      agent.id,
    )
    return {
      sessionsFound: imported.sessionsFound,
      sessionsImported: imported.run.threadsCompleted,
      messagesImported: imported.run.messagesCompleted,
      skippedFiles: imported.skippedFiles,
    }
  }

  async importNotionZip(): Promise<MigrationRun | null> {
    const options = { title: '选择 Notion 官方导出 ZIP', properties: ['openFile'] as Array<'openFile'>, filters: [{ name: 'Notion ZIP', extensions: ['zip'] }] }
    const parent = this.window(); const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return this.importNotionZipPath(result.filePaths[0])
  }

  private async importOpenClawPath(path: string, transport: MigrationRun['transport'] = path.endsWith('.tar.gz') ? 'archive' : 'directory', displayName = 'OpenClaw'): Promise<MigrationRun> {
    const stableSourceKey = hash(resolve(path)); const started = await this.gateway.begin({ provider: 'openclaw', transport, stableSourceKey, displayName });
    this.sourcePaths.set(started.source.id, path); this.runPaths.set(started.run.id, path); this.persistLocators(); this.emit(started.run)
    try {
      const threads = await readOpenClawSource(path); const messages = threads.reduce((sum, thread) => sum + thread.messages.length, 0)
      let run = await this.gateway.progress(started.run.id, { phase: 'normalizing', threadsTotal: threads.length, messagesTotal: messages }); this.emit(run)
      for (const batch of chunkThreads(threads)) { run = await this.gateway.threads(run.id, batch); this.emit(run) }
      return this.emit(await this.gateway.finish(run.id, true))
    } catch (error) { const message = error instanceof Error ? error.message : String(error); await this.gateway.fail(started.run.id, message).then((run) => this.emit(run)); throw error }
  }

  private async importLocalAgentHistoryPath(
    provider: Extract<MigrationProvider, 'codex' | 'claude'>,
    path: string,
    displayName = provider === 'codex' ? 'Codex' : 'Claude Code',
    agentId?: string,
  ): Promise<{ run: MigrationRun; sessionsFound: number; skippedFiles: number }> {
    const started = await this.gateway.begin({
      provider,
      transport: 'local-jsonl',
      stableSourceKey: hash(resolve(path)),
      displayName,
    })
    this.sourcePaths.set(started.source.id, path)
    this.runPaths.set(started.run.id, path)
    this.persistLocators()
    this.emit(started.run)
    type StreamingThread = { stableKey: string; agentId?: string; externalSessionId: string; title: string; messages: Array<{ stableKey: string; role: 'user' | 'assistant'; content: string; occurredAt: string }> }
    let run = started.run
    let sessionsFound = 0
    let skippedFiles = 0
    try {
      run = await this.gateway.progress(started.run.id, { phase: 'normalizing' })
      this.emit(run)
      const stream = streamLocalAgentHistory({ provider, historyPaths: [path] })
      let batch: StreamingThread[] = []
      let batchBytes = 0
      const flush = async (): Promise<void> => {
        if (!batch.length) return
        run = await this.gateway.threads(run.id, batch)
        this.emit(run)
        batch = []
        batchBytes = 0
      }
      for await (const item of stream) {
        if (item.kind !== 'conversation') { skippedFiles += 1; continue }
        sessionsFound += 1
        const thread: StreamingThread = {
          stableKey: item.conversation.sessionId,
          ...(agentId ? { agentId } : {}),
          externalSessionId: item.conversation.sessionId,
          title: item.conversation.title,
          messages: item.conversation.messages.map((message, index) => ({
            stableKey: hash(`${index}\0${message.role}\0${message.timestamp}\0${message.content}`),
            role: message.role,
            content: message.content,
            occurredAt: message.timestamp,
          })),
        }
        const size = thread.messages.reduce((sum, message) => sum + message.content.length, 0)
        if (batch.length && (batch.length >= THREADS_BATCH_LIMIT || batchBytes + size > THREADS_BATCH_BYTES)) await flush()
        batch.push(thread)
        batchBytes += size
      }
      await flush()
      run = await this.gateway.finish(run.id, true)
      return { run: this.emit(run), sessionsFound, skippedFiles }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.gateway.fail(started.run.id, message).then((run) => this.emit(run))
      throw error
    }
  }

  async importCherry(discoveredId?: string): Promise<MigrationRun> {
    const items = await discoverCherrySources()
    for (const item of items) this.discovered.set(item.id, item)
    const source = discoveredId ? this.discovered.get(discoveredId) : items[0]
    if (!source) throw new Error('cherry_source_not_found')
    return this.importCherryPath(source.path, source.displayName)
  }

  private async importCherryPath(root = cherryDataRoot(), displayName = 'Cherry Studio', options: { incremental?: boolean } = {}): Promise<MigrationRun> {
    const info = detectCherryStore(root)
    if (!info) throw new Error('cherry_source_not_found')
    const stableSourceKey = hash(resolve(root))
    const started = await this.gateway.begin({ provider: 'cherry', transport: 'directory', stableSourceKey, displayName })
    this.sourcePaths.set(started.source.id, root); this.runPaths.set(started.run.id, root); this.persistLocators(); this.emit(started.run)
    this.cherrySourceId = started.source.id
    try {
      const { threads, fingerprint } = await readCherrySource(root)
      await markMissingAttachments(threads)
      const messages = threads.reduce((sum, thread) => sum + thread.messages.length, 0)
      let run = await this.gateway.progress(started.run.id, { phase: 'normalizing', threadsTotal: threads.length, messagesTotal: messages }); this.emit(run)
      const uploaded = await this.uploadCherryAttachments(threads, started.source.id)
      for (const batch of chunkThreads(uploaded)) { run = await this.gateway.threads(run.id, batch); this.emit(run) }
      this.lastCherryFingerprint = fingerprint
      const finished = this.emit(await this.gateway.finish(run.id, !options.incremental))
      // 首次导入成功即开启自动同步（用户选择的接入路线即目录监听）；再次导入不重复置位。
      const refreshed = (await this.gateway.sources()).find((item) => item.id === started.source.id)
      if (refreshed?.capabilities && refreshed.capabilities.syncState === 'available') {
        await this.setCherrySync(started.source.id, true).catch(() => undefined)
      }
      return finished
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.gateway.fail(started.run.id, message).then((run) => this.emit(run)).catch(() => undefined)
      throw error
    }
  }

  private lastCherryFingerprint: string | null = null

  private async uploadCherryAttachments(threads: NormalizedMigrationThread[], sourceId: string): Promise<MigrationThreadUpload[]> {
    const cache = new Map<string, MigrationAttachmentRef>()
    const resolveAttachment = async (attachment: NormalizedMigrationAttachment): Promise<MigrationAttachmentRef> => {
      const sourceKey = `migration:cherry:${sourceId}:${attachment.stableKey}`
      const cached = cache.get(sourceKey)
      if (cached) return cached
      if (!attachment.filePath || attachment.missing) {
        const ref: MigrationAttachmentRef = { sourceKey, name: attachment.name, missing: true }
        cache.set(sourceKey, ref)
        return ref
      }
      try {
        const accepted = await this.files.importMigrationFile({
          filePath: attachment.filePath,
          sourceKey,
          originalName: attachment.name,
          relativePath: attachment.name,
          provider: 'cherry',
          sourceId,
        })
        const ref: MigrationAttachmentRef = { sourceKey, name: attachment.name, ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}), fileId: accepted.fileEntryId }
        cache.set(sourceKey, ref)
        return ref
      } catch {
        const ref: MigrationAttachmentRef = { sourceKey, name: attachment.name, missing: true }
        cache.set(sourceKey, ref)
        return ref
      }
    }
    const results: MigrationThreadUpload[] = []
    for (const thread of threads) {
      const messages: MigrationThreadUpload['messages'] = []
      for (const message of thread.messages) {
        if (!message.attachments?.length) {
          messages.push({ stableKey: message.stableKey, role: message.role, content: message.content, occurredAt: message.occurredAt })
          continue
        }
        const attachments: MigrationAttachmentRef[] = []
        for (const attachment of message.attachments) attachments.push(await resolveAttachment(attachment))
        messages.push({ stableKey: message.stableKey, role: message.role, content: message.content, occurredAt: message.occurredAt, attachments })
      }
      results.push({ stableKey: thread.stableKey, ...(thread.agentId ? { agentId: thread.agentId } : {}), externalSessionId: thread.externalSessionId, title: thread.title, messages })
    }
    return results
  }

  async setCherrySync(sourceId: string, active: boolean): Promise<void> {
    await this.gateway.setCapabilities(sourceId, { syncState: active ? 'active' : 'paused' })
    if (active) {
      this.cherrySourceId = sourceId
      this.ensureCherryWatcher().start()
    } else {
      this.cherryWatcher?.stop()
    }
  }

  /** 应用启动/网关就绪后调用：能力为 active 且来源仍在时恢复监听。 */
  async restoreCherrySync(): Promise<void> {
    try {
      const sources = await this.gateway.sources()
      const cherry = sources.find((item) => item.provider === 'cherry')
      if (!cherry || cherry.capabilities?.syncState !== 'active') return
      this.cherrySourceId = cherry.id
      this.ensureCherryWatcher().start()
    } catch { /* 网关未就绪时静默跳过，下次启动再试 */ }
  }

  private ensureCherryWatcher(): CherryWatcher {
    if (this.cherryWatcher) return this.cherryWatcher
    this.cherryWatcher = new CherryWatcher(cherryDataRoot(), {
      runRound: async () => {
        const root = (this.cherrySourceId ? this.sourcePaths.get(this.cherrySourceId) : undefined) ?? cherryDataRoot()
        await this.importCherryPath(root, 'Cherry Studio', { incremental: true })
        return { fingerprint: this.lastCherryFingerprint ?? '' }
      },
      onFatal: (error) => {
        this.cherryWatcher?.stop()
        if (this.cherrySourceId) {
          void this.gateway.setCapabilities(this.cherrySourceId, { syncState: 'error' }).catch(() => undefined)
        }
        console.warn(`[cherry-watcher] fatal: ${error}`)
      },
      loadCheckpoint: () => this.cherryStore.read(),
      saveCheckpoint: (checkpoint) => { this.cherryStore.write(checkpoint) },
    })
    return this.cherryWatcher
  }

  /** 导出为 Cherry Studio 可导入的 ChatGPT conversations.json；返回保存路径（取消返回 null）。 */
  async exportCherryConversations(sourceId: string): Promise<string | null> {
    const threads = await this.gateway.exportThreads(sourceId)
    if (!threads.length) throw new Error('cherry_export_empty')
    const conversations = threads.map((thread) => toChatGptConversation(thread))
    const parent = this.window()
    const dialogOptions = { title: '导出对话（Cherry Studio 可导入）', defaultPath: 'conversations.json', filters: [{ name: 'JSON', extensions: ['json'] }] }
    const result = parent ? await dialog.showSaveDialog(parent, dialogOptions) : await dialog.showSaveDialog(dialogOptions)
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, JSON.stringify(conversations, null, 2), 'utf8')
    return result.filePath
  }

  private async importNotionZipPath(path: string): Promise<MigrationRun> {
    const started = await this.gateway.begin({ provider: 'notion', transport: 'zip', stableSourceKey: hash(resolve(path)), displayName: basename(path) })
    this.sourcePaths.set(started.source.id, path); this.runPaths.set(started.run.id, path); this.persistLocators(); this.emit(started.run)
    let extracted: Awaited<ReturnType<typeof extractNotionZip>> | null = null
    try {
      extracted = await extractNotionZip(path); let run = await this.gateway.progress(started.run.id, { phase: 'saving', pagesTotal: extracted.files.length }); this.emit(run)
      let completed = 0
      for (const file of extracted.files) {
        await this.files.importMigrationFile({ filePath: file.path, sourceKey: `migration:notion:${started.source.id}:${file.stableKey}`, originalName: basename(file.relativePath), relativePath: file.relativePath, provider: 'notion', sourceId: started.source.id })
        completed += 1; run = await this.gateway.progress(run.id, { pagesCompleted: completed }); this.emit(run)
      }
      return this.emit(await this.gateway.finish(run.id, true))
    } catch (error) { const message = error instanceof Error ? error.message : String(error); await this.gateway.fail(started.run.id, message).then((run) => this.emit(run)); throw error }
    finally { await extracted?.cleanup() }
  }
}

/** ChatGPT conversations.json 单条对话：线性 mapping 链（root → 逐条消息），
 * Cherry Studio 的 ChatGPT 导入器沿 parent→children 链重放。 */
function toChatGptConversation(thread: ExportedMigrationThread): Record<string, unknown> {
  type Node = { id: string; message: { id: string; author: { role: string }; create_time: number; content: { content_type: string; parts: string[] } } | null; parent: string | null; children: string[] }
  const mapping: Record<string, Node> = {}
  const root: Node = { id: 'root', message: null, parent: null, children: [] }
  mapping.root = root
  let parentId = 'root'
  let firstTime: number | null = null
  let lastTime: number | null = null
  thread.messages.forEach((message, index) => {
    const timestamp = Date.parse(message.occurredAt)
    const seconds = Math.floor((Number.isFinite(timestamp) ? timestamp : Date.now()) / 1000)
    if (firstTime === null) firstTime = seconds
    lastTime = seconds
    const parts = [message.content]
    for (const attachment of message.attachments ?? []) {
      parts.push(`[附件: ${attachment.name}${attachment.missing ? '（缺失）' : ''}]`)
    }
    const node: Node = {
      id: `m${index}`,
      message: { id: `m${index}`, author: { role: message.role }, create_time: seconds, content: { content_type: 'text', parts } },
      parent: parentId,
      children: [],
    }
    mapping[node.id] = node
    mapping[parentId]!.children.push(node.id)
    parentId = node.id
  })
  return {
    title: thread.title,
    create_time: firstTime ?? Math.floor(Date.now() / 1000),
    update_time: lastTime ?? Math.floor(Date.now() / 1000),
    mapping,
  }
}
