import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { decryptLocalSecret, encryptLocalSecret } from './local-secret-cipher'

interface StoredCredential {
  value: string
}

/** 加密值前缀（同 ER2 思路）：带前缀走解密，不带视为旧明文。 */
const SECURE_PREFIX = 'enc:v1:'


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

  /** 静态加密存储（local-secret-cipher，AES-256-GCM），用于刷新令牌等敏感值。 */
  async setSecureText(key: string, value: string): Promise<void> {
    await this.initialize()
    this.credentials.set(key, { value: SECURE_PREFIX + encryptLocalSecret(Buffer.from(value, 'utf8')) })
    await this.persist()
  }

  /**
   * 读取 setSecureText 写入的值。读到旧明文（历史版本落盘）时读取即迁移：
   * 以加密形式覆写同 key 后返回原值；密文损坏视同不存在（上层走重新登录）。
   */
  async getSecureText(key: string): Promise<string | undefined> {
    await this.initialize()
    const stored = this.credentials.get(key)?.value
    if (stored === undefined) return undefined
    if (!stored.startsWith(SECURE_PREFIX)) {
      await this.setSecureText(key, stored)
      return stored
    }
    try {
      const decrypted = decryptLocalSecret(stored.slice(SECURE_PREFIX.length)).toString('utf8')
      return decrypted || undefined
    } catch {
      return undefined
    }
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
