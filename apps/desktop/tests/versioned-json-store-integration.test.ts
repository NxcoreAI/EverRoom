import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VersionedJsonReadError } from '@nxcore/migration-kit'
import { HighRiskImportCoordinator } from '../src/main/high-risk-import-coordinator'
import { CredentialStore } from '../src/main/security/credential-store'
import { AccountKeyringService } from '../src/main/security/account-keyring-service'
import { LocalAgentWorkspaceBindingStore } from '../src/main/local-agents/workspace-binding-store'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'everroom-json-migration-'))
  directories.push(directory)
  return directory
}

describe('JSON 状态文件版本化迁移', () => {
  it('HighRiskImportCoordinator：旧 {version:1,batches} 文件被认领并重写为 envelope', async () => {
    const directory = await makeDirectory()
    const statePath = join(directory, 'high-risk-imports.json')
    await writeFile(statePath, JSON.stringify({
      version: 1,
      batches: [{
        id: 'batch-1',
        origin: 'manual-import',
        sourceLabel: '手动导入',
        createdAt: '2026-09-01T00:00:00.000Z',
        payload: { files: [{ filePath: '/tmp/a.pdf', filename: 'a.pdf' }] },
      }],
    }))

    const coordinator = new HighRiskImportCoordinator(statePath, join(directory, 'backups'))
    await coordinator.initialize()

    expect(coordinator.list()).toHaveLength(1)
    // 认领不触发写回；首次变更（新增批次）才落成 envelope 格式。
    await coordinator.enqueueManual({ files: [{ filePath: '/tmp/b.pdf', filename: 'b.pdf' }] }, '手动导入')
    expect(coordinator.list()).toHaveLength(2)
    const onDisk = JSON.parse(await readFile(statePath, 'utf8')) as { v: number; data: unknown }
    expect(onDisk.v).toBe(1)
    expect(Array.isArray(onDisk.data)).toBe(true)
  })

  it('CredentialStore：损坏文件 failHard 抛错，而不是静默清空登录态', async () => {
    const directory = await makeDirectory()
    const filePath = join(directory, 'credentials.json')
    await writeFile(filePath, '{not-json')

    const store = new CredentialStore(filePath, join(directory, 'backups'))
    await expect(store.initialize()).rejects.toBeInstanceOf(VersionedJsonReadError)
  })

  it('CredentialStore：旧明文格式被认领且值原样保留', async () => {
    const directory = await makeDirectory()
    const filePath = join(directory, 'credentials.json')
    await writeFile(filePath, JSON.stringify({ 'saas-refresh': { value: 'refresh-token' } }))

    const store = new CredentialStore(filePath, join(directory, 'backups'))
    await store.initialize()

    expect(await store.getPlainText('saas-refresh')).toBe('refresh-token')
    await store.setNamed('gateway-token', 'token-2')
    const onDisk = JSON.parse(await readFile(filePath, 'utf8')) as { v: number; data: Record<string, { value: string }> }
    expect(onDisk.v).toBe(1)
    expect(onDisk.data['saas-refresh']).toEqual({ value: 'refresh-token' })
  })

  it('AccountKeyringService：v1 钥匙串遗留文件按未初始化处理，不视为损坏', async () => {
    const directory = await makeDirectory()
    const filePath = join(directory, 'account-keyring.json')
    await writeFile(filePath, JSON.stringify({ version: 1, publicKey: 'legacy-ciphertext' }))

    const keyring = new AccountKeyringService(filePath, join(directory, 'backups'))
    await keyring.initialize()

    expect(await keyring.getVerificationCode()).toBeNull()
  })

  it('LocalAgentWorkspaceBindingStore：旧 {version:1,bindings} 文件被认领', async () => {
    const directory = await makeDirectory()
    const workspacePath = join(directory, 'workspace')
    await mkdir(workspacePath)
    const statePath = join(directory, 'local-agent-workspaces.json')
    await writeFile(statePath, JSON.stringify({
      version: 1,
      bindings: [{
        agentId: 'agent-1',
        sessionId: 'session-1',
        rootPath: workspacePath,
        permissionProfile: 'workspace_write',
      }],
    }))

    const store = new LocalAgentWorkspaceBindingStore(statePath, join(directory, 'backups'))
    const binding = await store.find('agent-1', 'session-1')

    expect(binding?.rootPath).toBe(await realpath(workspacePath))
  })
})
