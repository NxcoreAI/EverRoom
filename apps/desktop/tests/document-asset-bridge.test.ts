import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DocumentAssetStore } from '../src/main/document-asset-store'
import { startDocumentAssetBridge } from '../src/main/document-asset-bridge'

// 1x1 透明 PNG（通过 DocumentAssetStore 的魔数签名校验）
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const disposables: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposables) dispose()
  disposables.length = 0
})

describe('document asset bridge', () => {
  it('serves stored assets over loopback with token and rejects wrong token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nxcore-asset-bridge-'))
    const assets = new DocumentAssetStore(root)
    await assets.initialize()
    const stored = await assets.storeImage('doc-1', {
      fileName: 'shot.png',
      mimeType: 'image/png',
      bytes: PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength) as ArrayBuffer,
    })

    const bridge = await startDocumentAssetBridge(assets)
    disposables.push(() => void bridge.stop())

    // 从 src（nxcore-document-asset://local/<key>/<file>）还原桥 URL 并取字节
    const assetPath = stored.src.replace('nxcore-document-asset://local/', '')
    const response = await fetch(`${bridge.baseUrl}/${assetPath}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(bytes.equals(PNG_BYTES)).toBe(true)

    // 错误 token → 404，不泄露资产
    const bad = await fetch(bridge.baseUrl.replace(/\/t\/[^/]+\//, '/t/wrong-token/'))
    expect(bad.status).toBe(404)
  })

  it('accepts authenticated PUT to store import assets and serves them back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nxcore-asset-bridge-'))
    const assets = new DocumentAssetStore(root)
    await assets.initialize()
    const bridge = await startDocumentAssetBridge(assets)
    disposables.push(() => void bridge.stop())

    const put = await fetch(`${bridge.baseUrl}?doc=doc-put-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: PNG_BYTES,
    })
    expect(put.status).toBe(200)
    const stored = await put.json() as { src?: string }
    expect(stored.src).toMatch(/^nxcore-document-asset:\/\/local\//)

    // 写入的资产可经读口取回
    const assetPath = (stored.src ?? '').replace('nxcore-document-asset://local/', '')
    const response = await fetch(`${bridge.baseUrl}/${assetPath}`)
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG_BYTES)).toBe(true)

    // 错误 token 的 PUT 与超限 body 被拒
    const badPut = await fetch(`${bridge.baseUrl.replace(/\/t\/[^/]+$/, '/t/wrong-token')}?doc=x`, {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: PNG_BYTES,
    })
    expect(badPut.status).toBe(404)
    const badMime = await fetch(`${bridge.baseUrl}?doc=doc-put-1`, {
      method: 'PUT', headers: { 'Content-Type': 'text/html' }, body: '<html></html>',
    })
    expect(badMime.status).toBe(400)
  })
})
