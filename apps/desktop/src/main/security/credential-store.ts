import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

interface StoredCredential {
  value: string
}

export class CredentialStore {
  private readonly credentials = new Map<string, StoredCredential>()
  private loaded = false

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as Record<string, StoredCredential>
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value?.value === 'string') this.credentials.set(key, value)
      }
    } catch {
      // The file is optional on first launch.
    }
  }

  async set(value: string): Promise<string> {
    await this.initialize()
    const key = randomUUID()
    this.credentials.set(key, { value })
    await this.persist()
    return key
  }

  async get(key: string | undefined): Promise<string | undefined> {
    await this.initialize()
    return key ? this.credentials.get(key)?.value : undefined
  }

  async setNamed(key: string, value: string): Promise<void> {
    await this.initialize()
    this.credentials.set(key, { value })
    await this.persist()
  }

  async getPlainText(key: string): Promise<string | undefined> {
    await this.initialize()
    return this.credentials.get(key)?.value
  }

  async setPlainText(key: string, value: string): Promise<void> {
    await this.setNamed(key, value)
  }

  async delete(key: string): Promise<void> {
    await this.initialize()
    if (!this.credentials.delete(key)) return
    await this.persist()
  }

  private async persist(): Promise<void> {
    const output: Record<string, StoredCredential> = {}
    for (const [key, value] of this.credentials) output[key] = value
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(output), { mode: 0o600 })
  }
}
