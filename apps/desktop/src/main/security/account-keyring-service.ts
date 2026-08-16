import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'

import type { AccountKeyringStatus } from '../../shared/sources'
import type { KeyringResponse, SaasClient } from '../cloud/saas-client'

const PACKAGE_ALGORITHM = 'X25519-HKDF-SHA256-AES-256-GCM' as const
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

interface StoredKeyringFile {
  publicKey: string
  privateKey: string
  umks: Record<string, { umkId: string; version: number; value: string }>
}

interface KeyringMaterial {
  privateKey: Buffer
  publicKey: string
}

function rawPublicKey(publicKey: KeyObject): string {
  const der = publicKey.export({ format: 'der', type: 'spki' })
  return der.subarray(-32).toString('base64')
}

function publicKeyObject(raw: string) {
  const bytes = Buffer.from(raw, 'base64')
  if (bytes.length !== 32) throw new Error('设备公钥格式无效。')
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, bytes]), format: 'der', type: 'spki' })
}

function combinedEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64')
}

function combinedDecrypt(key: Buffer, encoded: string, aad: Buffer): Buffer {
  const combined = Buffer.from(encoded, 'base64')
  if (combined.length < 28) throw new Error('密钥包密文格式无效。')
  const decipher = createDecipheriv('aes-256-gcm', key, combined.subarray(0, 12))
  decipher.setAAD(aad)
  decipher.setAuthTag(combined.subarray(-16))
  return Buffer.concat([decipher.update(combined.subarray(12, -16)), decipher.final()])
}

function keyId(value: Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function verificationCode(publicKey: string): string {
  const digest = createHash('sha256')
    .update(`everroom-device-verification-v1:${publicKey}`, 'utf8')
    .digest('hex')
    .slice(0, 12)
    .toUpperCase()
  return digest.match(/.{1,4}/g)!.join('-')
}

export class AccountKeyringService {
  private loaded = false
  private file: StoredKeyringFile | null = null

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend() === 'basic_text') return
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<StoredKeyringFile>
      if (typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') {
        this.file = { publicKey: parsed.publicKey, privateKey: parsed.privateKey, umks: parsed.umks ?? {} }
      }
    } catch {
      // First launch or an unreadable keyring file.
    }
  }

  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend() !== 'basic_text'
  }

  async status(client: SaasClient, userId: string): Promise<AccountKeyringStatus> {
    await this.initialize()
    if (!this.isAvailable()) {
      return { enabled: false, reason: '系统密钥环不可用，无法启用端到端同步。', initialized: false, umkId: null, activeVersion: null, deviceStatus: 'unregistered', verificationCode: null }
    }
    const material = await this.ensureMaterial()
    await client.registerKeyAgreement(material.publicKey)
    let keyring = await client.getKeyring()
    if (!keyring.initialized) {
      const existing = await this.getUmk(userId)
      const umk = existing?.value ?? randomBytes(32)
      const umkVersion = existing?.version ?? 1
      try {
        await client.bootstrapKeyring({ ...this.makePackage(material.publicKey, umk, keyId(umk), umkVersion, keyring.currentDevice.deviceId), packageAlgorithm: PACKAGE_ALGORITHM })
        keyring = await client.getKeyring()
      } catch (error) {
        // Another device may have initialized the account concurrently. Never keep/use this candidate UMK.
        if (!(error instanceof Error) || !/409|already initialized|冲突/i.test(error.message)) throw error
        keyring = await client.getKeyring()
      }
    }
    if (keyring.currentDevice.status === 'ready' && keyring.currentDevice.keyPackage) {
      const packageData = keyring.currentDevice.keyPackage
      const umk = this.openPackage(packageData, keyring.currentDevice.deviceId, material.privateKey)
      if (keyId(umk) !== keyring.umkId || packageData.umkId !== keyring.umkId || packageData.umkVersion !== keyring.activeVersion) {
        throw new Error('UMK 校验失败，请在 iPhone 上重新批准此设备。')
      }
      await this.saveUmk(userId, keyring.umkId!, keyring.activeVersion!, umk)
    }
    return {
      enabled: true,
      initialized: keyring.initialized,
      umkId: keyring.umkId,
      activeVersion: keyring.activeVersion,
      deviceStatus: keyring.currentDevice.status,
      verificationCode: verificationCode(material.publicKey),
    }
  }

  async getUmk(userId: string): Promise<{ value: Buffer; umkId: string; version: number } | null> {
    await this.initialize()
    if (!this.file) return null
    const entry = Object.entries(this.file.umks)
      .filter(([key]) => key.startsWith(`${userId}:`))
      .map(([, value]) => value)
      .sort((left, right) => right.version - left.version)[0]
    if (!entry) return null
    return { value: Buffer.from(safeStorage.decryptString(Buffer.from(entry.value, 'base64')), 'base64'), umkId: entry.umkId, version: entry.version }
  }

  async getVerificationCode(): Promise<string | null> {
    await this.initialize()
    return this.file?.publicKey ? verificationCode(this.file.publicKey) : null
  }

  private async ensureMaterial(): Promise<KeyringMaterial> {
    if (this.file?.privateKey && this.file.publicKey) {
      return { publicKey: this.file.publicKey, privateKey: Buffer.from(safeStorage.decryptString(Buffer.from(this.file.privateKey, 'base64')), 'base64') }
    }
    const pair = generateKeyPairSync('x25519')
    const publicKey = rawPublicKey(pair.publicKey)
    const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' })
    this.file = { publicKey, privateKey: safeStorage.encryptString(privateKey.toString('base64')).toString('base64'), umks: this.file?.umks ?? {} }
    await this.persist()
    return { publicKey, privateKey }
  }

  private makePackage(targetPublicKey: string, umk: Buffer, umkId: string, version: number, deviceId: string) {
    const pair = generateKeyPairSync('x25519')
    const ephemeralPublicKey = rawPublicKey(pair.publicKey)
    const salt = randomBytes(32)
    const context = Buffer.from(`everroom.umk-package.v1:${umkId}:${version}:${deviceId}`, 'utf8')
    const shared = diffieHellman({ privateKey: pair.privateKey, publicKey: publicKeyObject(targetPublicKey) })
    const wrappingKey = Buffer.from(hkdfSync('sha256', shared, salt, context, 32))
    return { umkId, umkVersion: version, ephemeralPublicKey, salt: salt.toString('base64'), ciphertext: combinedEncrypt(wrappingKey, umk, context) }
  }

  private openPackage(input: NonNullable<KeyringResponse['currentDevice']['keyPackage']>, deviceId: string, privateKeyBytes: Buffer): Buffer {
    const ephemeralPublicKey = publicKeyObject(input.ephemeralPublicKey)
    const privateKey = createPrivateKey({ key: privateKeyBytes, format: 'der', type: 'pkcs8' })
    const context = Buffer.from(`everroom.umk-package.v1:${input.umkId}:${input.umkVersion}:${deviceId}`, 'utf8')
    const shared = diffieHellman({ privateKey, publicKey: ephemeralPublicKey })
    const wrappingKey = Buffer.from(hkdfSync('sha256', shared, Buffer.from(input.salt, 'base64'), context, 32))
    const umk = combinedDecrypt(wrappingKey, input.ciphertext, context)
    if (umk.length !== 32) throw new Error('UMK 长度无效。')
    return umk
  }

  private async saveUmk(userId: string, umkId: string, version: number, value: Buffer): Promise<void> {
    await this.initialize()
    if (!this.file) return
    this.file.umks[`${userId}:${umkId}:${version}`] = { umkId, version, value: safeStorage.encryptString(value.toString('base64')).toString('base64') }
    await this.persist()
  }

  private async persist(): Promise<void> {
    if (!this.file) return
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(this.file), { mode: 0o600 })
    await chmod(this.filePath, 0o600)
  }
}

export { combinedDecrypt, combinedEncrypt, keyId, verificationCode }
