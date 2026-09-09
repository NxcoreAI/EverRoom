import { describe, expect, it } from 'vitest'

import { decryptLocalSecret, encryptLocalSecret } from '../src/main/security/local-secret-cipher'

describe('local-secret-cipher', () => {
  it('round-trips plaintext through encrypt/decrypt', () => {
    const plaintext = Buffer.from('everroom 本地静态加密 round-trip ✔', 'utf8')
    const encrypted = encryptLocalSecret(plaintext)
    expect(encrypted).not.toContain('everroom')
    expect(decryptLocalSecret(encrypted).equals(plaintext)).toBe(true)
  })

  it('rejects tampered ciphertext and malformed payloads', () => {
    const encrypted = encryptLocalSecret(Buffer.from('payload', 'utf8'))
    const decoded = Buffer.from(encrypted, 'base64')
    decoded[decoded.length - 1] ^= 0x01
    expect(() => decryptLocalSecret(decoded.toString('base64'))).toThrow()
    expect(() => decryptLocalSecret('not-a-ciphertext')).toThrow()
  })

  it('binds ciphertext to its purpose via AAD', () => {
    const encrypted = encryptLocalSecret(Buffer.from('secret', 'utf8'), 'purpose-a')
    expect(() => decryptLocalSecret(encrypted, 'purpose-b')).toThrow()
  })
})
