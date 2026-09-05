import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'

/**
 * 授权 challenge 非 token 状态的加密持久化（方案 §8.4）：safeStorage 加密、
 * 0600 原子写。verification URL / device code 一律不落盘；重启后只恢复为
 * 过期卡片（不复用旧流程），用户可一键重新发起。
 */
export function createAgentAuthPersistence(path: string): {
  save(state: string): void
  load(): string | null
  clear(): void
} {
  const write = async (buffer: Buffer): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, buffer, { mode: 0o600 })
    await rename(temporary, path)
  }
  return {
    save(state: string): void {
      void write(Buffer.concat([Buffer.from('ER1\n'), safeStorage.encryptString(state)])).catch(() => undefined)
    },
    load(): string | null {
      try {
        if (!existsSync(path)) return null
        const raw = readFileSync(path)
        if (!raw.subarray(0, 4).equals(Buffer.from('ER1\n'))) return null
        const decrypted = safeStorage.decryptString(raw.subarray(4))
        return decrypted || null
      } catch {
        return null
      }
    },
    clear(): void {
      unlink(path).catch(() => undefined)
    },
  }
}
