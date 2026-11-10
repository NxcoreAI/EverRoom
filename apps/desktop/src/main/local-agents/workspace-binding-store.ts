import { constants as fsConstants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'

import { VersionedJsonStore } from '@nxcore/migration-kit'

export interface StoredLocalAgentWorkspaceBinding {
  agentId: string
  sessionId: string
  rootPath: string
  permissionProfile: 'workspace_write'
}

function bindingKey(agentId: string, sessionId: string): string {
  return `${sessionId}\0${agentId}`
}

export class LocalAgentWorkspaceBindingStore {
  private loaded = false
  private readonly bindings = new Map<string, StoredLocalAgentWorkspaceBinding>()
  private readonly store: VersionedJsonStore<StoredLocalAgentWorkspaceBinding[]>

  constructor(storePath: string, backupDir?: string) {
    this.store = new VersionedJsonStore<StoredLocalAgentWorkspaceBinding[]>({
      filePath: storePath,
      migrations: [],
      adoptBaseline: (raw) => {
        const parsed = raw as Partial<{ version: unknown; bindings: unknown }>
        if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !Array.isArray(parsed.bindings)) return []
        return parsed.bindings.filter((binding): binding is StoredLocalAgentWorkspaceBinding =>
          Boolean(binding?.agentId) && Boolean(binding.sessionId) && Boolean(binding.rootPath) && binding.permissionProfile === 'workspace_write')
      },
      fallback: [],
      ...(backupDir !== undefined ? { backupDir } : {}),
    })
  }

  async find(agentId: string, sessionId: string): Promise<StoredLocalAgentWorkspaceBinding | null> {
    await this.load()
    const binding = this.bindings.get(bindingKey(agentId, sessionId))
    if (!binding) return null
    try {
      const rootPath = await this.validateRoot(binding.rootPath)
      return { ...binding, rootPath }
    } catch {
      this.bindings.delete(bindingKey(agentId, sessionId))
      await this.persist()
      return null
    }
  }

  async save(input: StoredLocalAgentWorkspaceBinding): Promise<StoredLocalAgentWorkspaceBinding> {
    await this.load()
    const binding = { ...input, rootPath: await this.validateRoot(input.rootPath) }
    this.bindings.set(bindingKey(binding.agentId, binding.sessionId), binding)
    await this.persist()
    return binding
  }

  async validate(binding: StoredLocalAgentWorkspaceBinding): Promise<StoredLocalAgentWorkspaceBinding> {
    return { ...binding, rootPath: await this.validateRoot(binding.rootPath) }
  }

  async removeSession(sessionId: string): Promise<void> {
    await this.load()
    let changed = false
    for (const [key, binding] of this.bindings) {
      if (binding.sessionId !== sessionId) continue
      this.bindings.delete(key)
      changed = true
    }
    if (changed) await this.persist()
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    for (const binding of this.store.read()) {
      this.bindings.set(bindingKey(binding.agentId, binding.sessionId), binding)
    }
  }

  private async validateRoot(rootPath: string): Promise<string> {
    const canonical = await realpath(rootPath)
    const info = await stat(canonical)
    if (!info.isDirectory()) throw new Error('local_agent_workspace_not_directory')
    await access(canonical, fsConstants.R_OK | fsConstants.W_OK)
    return canonical
  }

  private async persist(): Promise<void> {
    this.store.write([...this.bindings.values()])
  }
}
