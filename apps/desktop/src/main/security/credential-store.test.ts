import { readFile } from 'node:fs/promises'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CredentialStore } from './credential-store'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createStore(): Promise<{ store: CredentialStore; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'everroom-credential-store-'))
  directories.push(directory)
  const path = join(directory, 'credentials.json')
  return { store: new CredentialStore(path), path }
}

describe('CredentialStore secure text', () => {
  it('round-trips values through encrypted storage', async () => {
    const { store, path } = await createStore()
    await store.setSecureText('everroom:saas:refresh-token', 'rt-secret-51')
    expect(await store.getSecureText('everroom:saas:refresh-token')).toBe('rt-secret-51')

    // 落盘为密文（enc:v1: 前缀），文件里看不到明文。
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, { value: string }>
    expect(raw['everroom:saas:refresh-token']?.value).toMatch(/^enc:v1:/)
    expect(await readFile(path, 'utf8')).not.toContain('rt-secret-51')
  })

  it('migrates legacy plaintext values on first secure read', async () => {
    const { store, path } = await createStore()
    await store.setPlainText('everroom:saas:refresh-token', 'rt-legacy-51')
    expect(await store.getSecureText('everroom:saas:refresh-token')).toBe('rt-legacy-51')

    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, { value: string }>
    expect(raw['everroom:saas:refresh-token']?.value).toMatch(/^enc:v1:/)

    // 迁移后再读仍是原值（且不再重复迁移）。
    expect(await store.getSecureText('everroom:saas:refresh-token')).toBe('rt-legacy-51')
  })

  it('treats a corrupted ciphertext as missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'everroom-credential-store-'))
    directories.push(directory)
    const path = join(directory, 'credentials.json')
    await writeFile(path, JSON.stringify({
      'everroom:saas:refresh-token': { value: 'enc:v1:not-a-valid-ciphertext' },
    }), 'utf8')
    const store = new CredentialStore(path)
    expect(await store.getSecureText('everroom:saas:refresh-token')).toBeUndefined()
  })

  it('keeps plaintext stores untouched for non-secure keys', async () => {
    const { store } = await createStore()
    await store.setPlainText('everroom:device-key', 'mac-1234')
    expect(await store.getPlainText('everroom:device-key')).toBe('mac-1234')
    expect(await store.getSecureText('everroom:device-key')).toBe('mac-1234')
  })
})
