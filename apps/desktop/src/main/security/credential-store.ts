import { randomUUID } from 'node:crypto'

import { VersionedJsonStore } from '@nxcore/migration-kit'

import { decryptLocalSecret, encryptLocalSecret } from './local-secret-cipher'

interface StoredCredential {
  value: string
}

/** 加密值前缀（同 ER2 思路）：带前缀走解密，不带视为旧明文。 */
const SECURE_PREFIX = 'enc:v1:'


export class CredentialStore {
  private readonly credentials = new Map<string, StoredCredential>()
  private loaded = false
  private readonly store: VersionedJsonStore<Record<string, StoredCredential>>

  constructor(filePath: string, backupDir?: string) {
    // failHard：凭据文件损坏时宁可停机报错，也不静默清空导致全员重新登录。
    this.store = new VersionedJsonStore<Record<string, StoredCredential>>({
      filePath,
      migrations: [],
      adoptBaseline: (raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('credentials file is not an object')
        const output: Record<string, StoredCredential> = {}
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          const item = value as Partial<StoredCredential> | null
          if (item && typeof item.value === 'string') output[key] = { value: item.value }
        }
        return output
      },
      fallback: {},
      failHard: true,
      ...(backupDir !== undefined ? { backupDir } : {}),
    })
  }

  async initialize(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    for (const [key, value] of Object.entries(this.store.read())) {
      this.credentials.set(key, value)
    }
  }

  /** 丢弃内存缓存重读磁盘：多进程共享同一凭据文件时，取另一进程刚落盘的值
   * （initialize 的缓存对本进程是启动时刻的快照，看不到外部写入）。 */
  async reload(): Promise<void> {
    await this.initialize()
    this.credentials.clear()
    for (const [key, value] of Object.entries(this.store.read())) {
      this.credentials.set(key, value)
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
    this.store.write(output)
  }
}
