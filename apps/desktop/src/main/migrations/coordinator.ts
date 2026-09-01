import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { dirname } from 'node:path'
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
import type { MigrationsGatewayBridge } from '../gateway/migrations-gateway-bridge'
import { discoverOpenClawSources, readOpenClawSource, type ResolvedOpenClawSource } from './openclaw-adapter'
import { extractNotionZip } from './notion-zip-adapter'
import { streamLocalAgentHistory } from '../local-agents/history'

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
  private discovered = new Map<string, ResolvedOpenClawSource | ResolvedLocalAgentSource>()
  private readonly sourcePaths = new Map<string, string>()
  private readonly runPaths = new Map<string, string>()
  private listener: ((event: MigrationProgressEvent) => void) | null = null

  constructor(private readonly gateway: MigrationsGatewayBridge, private readonly files: FilesGatewayBridge, private readonly window: () => BrowserWindow | null, private readonly locatorPath: string) {}
  async initialize(): Promise<void> {
    try { const values = JSON.parse(await readFile(this.locatorPath, 'utf8')) as Record<string, string>; Object.entries(values).forEach(([id, path]) => { if (typeof path === 'string') this.sourcePaths.set(id, path) }) } catch { /* first run */ }
  }
  private async persistLocators(): Promise<void> { await mkdir(dirname(this.locatorPath), { recursive: true }); await writeFile(this.locatorPath, JSON.stringify(Object.fromEntries(this.sourcePaths), null, 2), { mode: 0o600 }) }
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
  async clear(sourceId: string): Promise<void> { this.sourcePaths.delete(sourceId); await this.persistLocators(); return this.gateway.clear(sourceId) }

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
    this.sourcePaths.set(started.source.id, path); this.runPaths.set(started.run.id, path); await this.persistLocators(); this.emit(started.run)
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
    await this.persistLocators()
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

  private async importNotionZipPath(path: string): Promise<MigrationRun> {
    const started = await this.gateway.begin({ provider: 'notion', transport: 'zip', stableSourceKey: hash(resolve(path)), displayName: basename(path) })
    this.sourcePaths.set(started.source.id, path); this.runPaths.set(started.run.id, path); await this.persistLocators(); this.emit(started.run)
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
