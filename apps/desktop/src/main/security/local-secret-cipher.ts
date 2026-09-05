import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * 本地静态加密（替代 safeStorage/OS 钥匙串）：与 gateway secret-store 同一思路，
 * 固定内置主密钥 + AES-256-GCM。不再触碰用户钥匙串，开发与打包环境零交互、
 * 无钥匙串授权弹窗。落盘文件本身仍以 0600 权限保护。
 */
const MASTER_KEY = Buffer.from('a7778350862f66137ade6feaaf9527ad5bf4ed720f8d051c5840bf68d251de5a', 'hex')
const DEFAULT_AAD = 'everroom-desktop-local-secret:v1'

export function encryptLocalSecret(plaintext: Buffer, aad: string = DEFAULT_AAD): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', MASTER_KEY, nonce)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64')
}

export function decryptLocalSecret(encoded: string, aad: string = DEFAULT_AAD): Buffer {
  const combined = Buffer.from(encoded, 'base64')
  if (combined.length < 28) throw new Error('本地密文格式无效。')
  const decipher = createDecipheriv('aes-256-gcm', MASTER_KEY, combined.subarray(0, 12))
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(combined.subarray(-16))
  return Buffer.concat([decipher.update(combined.subarray(12, -16)), decipher.final()])
}
