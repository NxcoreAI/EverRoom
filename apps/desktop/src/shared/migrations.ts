import type {
  ExternalConversationPage,
  ExternalConversationPreview,
  MigrationProgressEvent,
  MigrationRun,
  MigrationSource,
} from '@nxcore/agent-contract'

export interface DiscoveredMigrationSource {
  provider: 'openclaw' | 'codex' | 'claude' | 'cherry' | 'hermes'
  id: string
  displayName: string
  transport: 'local-sqlite' | 'local-jsonl' | 'directory'
  standard: boolean
}

export type LocalAgentMigrationProvider = Extract<DiscoveredMigrationSource['provider'], 'codex' | 'claude'>

export interface MigrationApi {
  discover(): Promise<DiscoveredMigrationSource[]>
  chooseOpenClaw(): Promise<MigrationRun | null>
  importOpenClaw(discoveredId?: string): Promise<MigrationRun>
  importLocalAgentMigration(provider: LocalAgentMigrationProvider, discoveredId?: string): Promise<MigrationRun>
  chooseLocalAgentDirectory(provider: LocalAgentMigrationProvider): Promise<MigrationRun | null>
  localAgentSources(provider: LocalAgentMigrationProvider): Promise<DiscoveredMigrationSource[]>
  importNotionZip(): Promise<MigrationRun | null>
  importCherry(discoveredId?: string): Promise<MigrationRun>
  setCherrySync(sourceId: string, active: boolean): Promise<void>
  exportCherry(sourceId: string): Promise<string | null>
  sources(): Promise<MigrationSource[]>
  runs(sourceId?: string): Promise<MigrationRun[]>
  cancel(runId: string): Promise<MigrationRun>
  retry(runId: string): Promise<MigrationRun>
  reimport(sourceId: string): Promise<MigrationRun>
  clear(sourceId: string): Promise<void>
  conversations(query?: { query?: string; cursor?: string; limit?: number }): Promise<ExternalConversationPage>
  preview(conversationId: string): Promise<ExternalConversationPreview>
  onProgress(listener: (event: MigrationProgressEvent) => void): () => void
}
