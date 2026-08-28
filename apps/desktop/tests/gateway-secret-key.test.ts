import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const storageState = vi.hoisted(() => ({ available: false, backend: 'gnome', availabilityChecks: 0, decryptions: 0 }))
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => {
      storageState.availabilityChecks += 1
      return storageState.available
    },
    getSelectedStorageBackend: () => storageState.backend,
    decryptString: () => {
      storageState.decryptions += 1
      return Buffer.alloc(32).toString('base64url')
    },
  },
}))

import { loadOrCreateGatewaySecretKey } from '../src/main/security/gateway-secret-key'

const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  storageState.available = false
  storageState.backend = 'gnome'
  storageState.availabilityChecks = 0
  storageState.decryptions = 0
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

  it('does not access macOS Keychain during startup', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const root = await mkdtemp(join(tmpdir(), 'everroom-gateway-key-test-'))
    directories.push(root)
    const path = join(root, 'gateway-master-key.json')
    await writeFile(path, JSON.stringify({ version: 1, encrypted: 'encrypted' }))

    await expect(loadOrCreateGatewaySecretKey(path)).resolves.toBeNull()
    expect(storageState.availabilityChecks).toBe(0)
    expect(storageState.decryptions).toBe(0)

    await expect(loadOrCreateGatewaySecretKey(path, true)).resolves.toBe(Buffer.alloc(32).toString('base64url'))
    expect(storageState.availabilityChecks).toBe(0)
    expect(storageState.decryptions).toBe(1)
  })
})
