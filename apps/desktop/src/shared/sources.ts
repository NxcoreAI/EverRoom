export type DataSourceStatus = 'connected' | 'syncing' | 'paused' | 'disconnected' | 'error'
export type SourceFileStatus = 'added' | 'updated' | 'moved' | 'unchanged' | 'missing' | 'error'

export interface SourceFileSummary {
  id: string
  name: string
  relativePath: string
  originalPath: string
  extension: string
  size: number
  modifiedAt: string
  exists: boolean
  status: SourceFileStatus
  versionCount: number
  contentHash: string | null
  lastSeenAt: string
}

export interface DataSourceSummary {
  id: string
  kind: 'local-folder'
  name: string
  rootPath: string
  status: DataSourceStatus
  fileCount: number
  versionCount: number
  totalBytes: number
  lastSyncedAt: string | null
  lastError: string | null
  createdAt: string
}

export interface SyncResult {
  source: DataSourceSummary
  discovered: number
  added: number
  updated: number
  moved: number
  unchanged: number
  removed: number
  failed: number
}

export interface NexcoreDesktopApi {
  platform: string
  sources: {
    list(): Promise<DataSourceSummary[]>
    listFiles(id: string): Promise<SourceFileSummary[]>
    showFile(id: string, fileId: string): Promise<void>
    addLocalFolder(): Promise<SyncResult | null>
    sync(id: string): Promise<SyncResult>
    setPaused(id: string, paused: boolean): Promise<DataSourceSummary>
    disconnect(id: string, deleteLocalData: boolean): Promise<void>
  }
}
