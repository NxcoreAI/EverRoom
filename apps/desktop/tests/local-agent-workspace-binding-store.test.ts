import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { LocalAgentWorkspaceBindingStore } from '../src/main/local-agents/workspace-binding-store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'everroom-agent-workspace-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const storePath = join(root, 'state', 'bindings.json')
  await mkdir(workspace)
  return { root, workspace, storePath }
}

describe('LocalAgentWorkspaceBindingStore', () => {
  it('persists canonical bindings without persisting invocation tokens', async () => {
    const { workspace, storePath } = await harness()
    const first = new LocalAgentWorkspaceBindingStore(storePath)
    await first.save({
      agentId: 'codex:test',
      sessionId: 'session-1',
      rootPath: workspace,
      permissionProfile: 'workspace_write',
    })

    const restored = await new LocalAgentWorkspaceBindingStore(storePath).find('codex:test', 'session-1')
    expect(restored).toMatchObject({ rootPath: await realpath(workspace), permissionProfile: 'workspace_write' })
    expect(await readFile(storePath, 'utf8')).not.toContain('token')
  })

  it('revokes a persisted binding when its directory disappears', async () => {
    const { workspace, storePath } = await harness()
    const store = new LocalAgentWorkspaceBindingStore(storePath)
    await store.save({ agentId: 'codex:test', sessionId: 'session-1', rootPath: workspace, permissionProfile: 'workspace_write' })
    await rm(workspace, { recursive: true })

    await expect(new LocalAgentWorkspaceBindingStore(storePath).find('codex:test', 'session-1')).resolves.toBeNull()
  })

  it('rejects files as Agent workspaces', async () => {
    const { root, storePath } = await harness()
    const filePath = join(root, 'not-a-directory')
    await writeFile(filePath, 'content')

    await expect(new LocalAgentWorkspaceBindingStore(storePath).save({
      agentId: 'codex:test', sessionId: 'session-1', rootPath: filePath, permissionProfile: 'workspace_write',
    })).rejects.toThrow('local_agent_workspace_not_directory')
  })

  it('removes all workspace grants owned by a deleted conversation', async () => {
    const { workspace, storePath } = await harness()
    const store = new LocalAgentWorkspaceBindingStore(storePath)
    await store.save({ agentId: 'codex:first', sessionId: 'session-1', rootPath: workspace, permissionProfile: 'workspace_write' })
    await store.save({ agentId: 'codex:second', sessionId: 'session-1', rootPath: workspace, permissionProfile: 'workspace_write' })

    await store.removeSession('session-1')

    await expect(new LocalAgentWorkspaceBindingStore(storePath).find('codex:first', 'session-1')).resolves.toBeNull()
    await expect(new LocalAgentWorkspaceBindingStore(storePath).find('codex:second', 'session-1')).resolves.toBeNull()
  })
})
