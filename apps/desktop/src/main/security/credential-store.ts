import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'

interface StoredCredential {
  encrypted: string
}

export class CredentialStore {
  private readonly credentials = new Map<string, string>()
  private loaded = false

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as Record<string, StoredCredential>
      for (const [key, value] of Object.entries(raw)) {
        if (!value?.encrypted || !safeStorage.isEncryptionAvailable()) continue
        try {
          this.credentials.set(key, safeStorage.decryptString(Buffer.from(value.encrypted, 'base64')))
        } catch {
          // Ignore credentials that cannot be decrypted on this machine.
        }
      }
    } catch {
      // The file is optional on first launch.
    }
  }

  async set(value: string): Promise<string> {
    await this.initialize()
    if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统不支持安全保存 GitHub 凭证。')
    const key = randomUUID()
    this.credentials.set(key, value)
    await this.persist()
    return key
  }

  async get(key: string | undefined): Promise<string | undefined> {
    await this.initialize()
    return key ? this.credentials.get(key) : undefined
  }

  private async persist(): Promise<void> {
    const output: Record<string, StoredCredential> = {}
    for (const [key, value] of this.credentials) {
      output[key] = { encrypted: safeStorage.encryptString(value).toString('base64') }
    }
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(output), { mode: 0o600 })
  }
}
