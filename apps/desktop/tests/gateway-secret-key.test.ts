import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { cleanupLegacyGatewaySecretKey } from '../src/main/security/gateway-secret-key'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('cleanupLegacyGatewaySecretKey', () => {
  it('删除 wrapped key 文件并把旧密文挪走留档，目录清空后移除', async () => {
    const root = await mkdtemp(join(tmpdir(), 'everroom-gateway-key-test-'))
    directories.push(root)
    const security = join(root, 'security')
    await mkdir(security)
    await writeFile(join(security, 'gateway-master-key.json'), '{\"version\":1}')
    await writeFile(join(security, 'credentials.enc'), 'legacy-ciphertext')

    await cleanupLegacyGatewaySecretKey(security)

    await expect(readFile(join(security, 'gateway-master-key.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(root)).resolves.toEqual(['security'])
    const [archived] = await readdir(security)
    expect(archived).toMatch(/^credentials\.enc\.stale-\d+$/)
    await expect(readFile(join(security, archived), 'utf8')).resolves.toBe('legacy-ciphertext')
  })

  it('目录不存在或已清理过时静默无操作', async () => {
    const root = await mkdtemp(join(tmpdir(), 'everroom-gateway-key-test-'))
    directories.push(root)

    await expect(cleanupLegacyGatewaySecretKey(join(root, 'security'))).resolves.toBeUndefined()
    await expect(cleanupLegacyGatewaySecretKey(join(root, 'security'))).resolves.toBeUndefined()
    await expect(readFile(join(root, 'security'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('保留 security 目录里其他文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'everroom-gateway-key-test-'))
    directories.push(root)
    const security = join(root, 'security')
    await mkdir(security)
    await writeFile(join(security, 'gateway-master-key.json'), '{\"version\":1}')
    await writeFile(join(security, 'unrelated.bin'), 'keep-me')

    await cleanupLegacyGatewaySecretKey(security)

    await expect(readdir(security)).resolves.toEqual(['unrelated.bin'])
  })
})
