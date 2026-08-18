import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { safeStorage } from 'electron'

export interface OpenConnectorSecrets {
  encryptionKey: string
  adminToken: string
  runtimeToken: string
}

interface StoredSecrets {
  encrypted: string
}

function newSecret(): string {
  return randomBytes(32).toString('base64url')
}

function isBasicTextStorage(): boolean {
  return process.platform === 'linux'
    && safeStorage.getSelectedStorageBackend?.() === 'basic_text'
}

export class OpenConnectorSecretStore {
  private value: OpenConnectorSecrets | null = null

  constructor(private readonly filePath: string) {}

  async getOrCreate(): Promise<OpenConnectorSecrets> {
    if (this.value) return this.value
    if (!safeStorage.isEncryptionAvailable() || isBasicTextStorage()) {
      throw new Error('系统密钥环不可用，无法安全启动 OpenConnector。')
    }

    try {
      const stored = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<StoredSecrets>
      if (typeof stored.encrypted === 'string') {
        const plaintext = safeStorage.decryptString(Buffer.from(stored.encrypted, 'base64'))
        const parsed = JSON.parse(plaintext) as Partial<OpenConnectorSecrets>
        if (
          typeof parsed.encryptionKey === 'string'
          && typeof parsed.adminToken === 'string'
          && typeof parsed.runtimeToken === 'string'
        ) {
          this.value = parsed as OpenConnectorSecrets
          return this.value
        }
      }
    } catch {
      // First launch or an unreadable secret file creates a fresh local runtime identity.
    }

    this.value = {
      encryptionKey: newSecret(),
      adminToken: newSecret(),
      runtimeToken: newSecret(),
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(this.value)).toString('base64')
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify({ encrypted } satisfies StoredSecrets), { mode: 0o600 })
    await chmod(this.filePath, 0o600)
    return this.value
  }
}

