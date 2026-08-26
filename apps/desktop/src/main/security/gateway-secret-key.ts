import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'

function isBasicTextStorage(): boolean {
  return process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text'
}

export async function loadOrCreateGatewaySecretKey(filePath: string): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable() || isBasicTextStorage()) {
    return null
  }
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { version?: unknown; encrypted?: unknown }
    if (parsed.version !== 1 || typeof parsed.encrypted !== 'string') throw new Error('invalid key envelope')
    const key = Buffer.from(safeStorage.decryptString(Buffer.from(parsed.encrypted, 'base64')), 'base64url')
    if (key.length !== 32) throw new Error('invalid key length')
    return key.toString('base64url')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Gateway credential master key could not be decrypted', { cause: error })
    }
  }

  const key = randomBytes(32)
  const envelope = JSON.stringify({
    version: 1,
    encrypted: safeStorage.encryptString(key.toString('base64url')).toString('base64'),
  })
  await mkdir(dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  try {
    await writeFile(temporary, envelope, { mode: 0o600 })
    await rename(temporary, filePath)
    await chmod(filePath, 0o600)
  } finally {
    await rm(temporary, { force: true })
  }
  return key.toString('base64url')
}
