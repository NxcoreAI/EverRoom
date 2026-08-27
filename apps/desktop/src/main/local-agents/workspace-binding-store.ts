import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface StoredLocalAgentWorkspaceBinding {
  agentId: string
  sessionId: string
  rootPath: string
  permissionProfile: 'workspace_write'
}

interface WorkspaceBindingFile {
  version: 1
  bindings: StoredLocalAgentWorkspaceBinding[]
}

function bindingKey(agentId: string, sessionId: string): string {
  return `${sessionId}\0${agentId}`
}

export class LocalAgentWorkspaceBindingStore {
  private loaded = false
  private readonly bindings = new Map<string, StoredLocalAgentWorkspaceBinding>()

  constructor(private readonly storePath: string) {}

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
    try {
      const parsed = JSON.parse(await readFile(this.storePath, 'utf8')) as WorkspaceBindingFile
      if (parsed.version !== 1 || !Array.isArray(parsed.bindings)) return
      for (const binding of parsed.bindings) {
        if (!binding?.agentId || !binding.sessionId || !binding.rootPath || binding.permissionProfile !== 'workspace_write') continue
        this.bindings.set(bindingKey(binding.agentId, binding.sessionId), binding)
      }
    } catch {
      // Missing or invalid state is treated as an empty binding store.
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
    await mkdir(dirname(this.storePath), { recursive: true })
    const temporaryPath = `${this.storePath}.${randomUUID()}.tmp`
    const payload: WorkspaceBindingFile = { version: 1, bindings: [...this.bindings.values()] }
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, this.storePath)
  }
}
