import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const storageState = vi.hoisted(() => ({ available: false, backend: 'gnome' }))
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => storageState.available,
    getSelectedStorageBackend: () => storageState.backend,
  },
}))

import { loadOrCreateGatewaySecretKey } from '../src/main/security/gateway-secret-key'

const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  storageState.available = false
  storageState.backend = 'gnome'
})

describe('gateway secret key', () => {
  it('allows startup without creating a plaintext fallback when secure storage is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'everroom-gateway-key-test-'))
    directories.push(root)
    const path = join(root, 'gateway-master-key.json')

    await expect(loadOrCreateGatewaySecretKey(path)).resolves.toBeNull()
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('treats Linux basic_text storage as unavailable', async () => {
    storageState.available = true
    storageState.backend = 'basic_text'
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const root = await mkdtemp(join(tmpdir(), 'everroom-gateway-key-test-'))
    directories.push(root)

    await expect(loadOrCreateGatewaySecretKey(join(root, 'gateway-master-key.json'))).resolves.toBeNull()
  })
})
