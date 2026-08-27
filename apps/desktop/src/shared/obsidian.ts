export const OBSIDIAN_VAULT_ASSET_SCHEME = 'nxcore-vault-asset'

export type ObsidianVaultResourceKind = 'note' | 'image' | 'pdf'

export type ObsidianVaultMountMode = 'dedicated' | 'embedded' | 'memory'

export interface ObsidianVaultCandidate {
  id: string
  name: string
  noteCount: number
  attachmentCount: number
  discoveredFrom: 'registry' | 'scan' | 'manual'
  lastOpenedAt: string | null
  mountedVaultId: string | null
  mountedRoomId: string | null
  memoryEnabled: boolean
}

export interface ObsidianVaultBinding {
  id: string
  roomId: string
  mountMode: ObsidianVaultMountMode
  memoryEnabled: boolean
  name: string
  attachmentFolderPath: string
  noteCount: number
  attachmentCount: number
  status: 'connected' | 'offline'
  updatedAt: string
}

export interface ObsidianNoteBinding {
  vaultId: string
  roomId: string
  resourceId: string
  documentId: string | null
  relativePath: string
  sourceHash: string
}

export interface ObsidianVaultResource {
  id: string
  vaultId: string
  relativePath: string
  name: string
  kind: ObsidianVaultResourceKind
  byteSize: number
  sourceHash: string
  modifiedAt: string
  assetUrl: string | null
}

export interface ObsidianVaultTree {
  vault: ObsidianVaultBinding
  resources: ObsidianVaultResource[]
}

export interface VaultNoteSnapshot {
  resource: ObsidianVaultResource
  markdown: string
  sourceHash: string
}

export type VaultNoteSaveResult =
  | { status: 'saved'; snapshot: VaultNoteSnapshot }
  | { status: 'conflict'; snapshot: VaultNoteSnapshot }

export interface ObsidianVaultChangedEvent {
  vaultId: string
  roomId: string
  updatedAt: string
}

export interface ObsidianDiscoveryChangedEvent {
  updatedAt: string
}

export interface ObsidianVaultApi {
  pickAndMount(): Promise<ObsidianVaultBinding | null>
  discover(): Promise<ObsidianVaultCandidate[]>
  pickCandidate(): Promise<ObsidianVaultCandidate | null>
  importCandidate(candidateId: string, target: { kind: 'memory'; enableRegistryAutoImport?: boolean } | { kind: 'room'; roomId: string }): Promise<
    | { kind: 'memory'; projectName: string; total: number; succeeded: number; failed: number }
    | { kind: 'room'; vault: ObsidianVaultBinding }
  >
  list(): Promise<ObsidianVaultBinding[]>
  tree(vaultId: string): Promise<ObsidianVaultTree>
  readNote(vaultId: string, resourceId: string): Promise<VaultNoteSnapshot>
  saveNote(vaultId: string, resourceId: string, markdown: string, expectedSourceHash: string): Promise<VaultNoteSaveResult>
  createNote(vaultId: string, relativePath: string, markdown?: string): Promise<VaultNoteSnapshot>
  moveNote(vaultId: string, resourceId: string, relativePath: string, expectedSourceHash: string): Promise<VaultNoteSnapshot>
  trashNote(vaultId: string, resourceId: string, expectedSourceHash: string): Promise<void>
  addAttachment(vaultId: string, noteRelativePath?: string): Promise<ObsidianVaultResource | null>
  disconnect(vaultId: string): Promise<void>
  rescan(vaultId: string): Promise<ObsidianVaultBinding>
  onChanged(listener: (event: ObsidianVaultChangedEvent) => void): () => void
  onDiscoveryChanged(listener: (event: ObsidianDiscoveryChangedEvent) => void): () => void
}
