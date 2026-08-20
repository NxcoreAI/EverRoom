import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  assertNoEmbeddedDocumentImages,
  DocumentAssetStore,
} from '../src/main/document-asset-store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function createStore(): Promise<{ directory: string; store: DocumentAssetStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'nxcore-document-assets-'))
  temporaryDirectories.push(directory)
  const store = new DocumentAssetStore(directory)
  await store.initialize()
  return { directory, store }
}

describe('DocumentAssetStore', () => {
  it('rejects embedded image data before a document reaches the database', () => {
    expect(() => assertNoEmbeddedDocumentImages({
      input: {
        proposedContentJson: {
          type: 'doc',
          content: [{ type: 'image', attrs: { src: 'data:image/png;base64,iVBORw0KGgo=' } }],
        },
      },
    })).toThrow('不能嵌入文档数据库')
    expect(() => assertNoEmbeddedDocumentImages({
      type: 'doc',
      content: [{ type: 'image', attrs: { src: 'nxcore-document-asset://local/key/image.png' } }],
    })).not.toThrow()
  })

  it('stores verified image bytes and serves them only through an opaque local URL', async () => {
    const { directory, store } = await createStore()
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer
    const stored = await store.storeImage('doc-1', {
      fileName: 'photo.png',
      mimeType: 'image/png',
      bytes: png,
    })

    expect(stored.src).toMatch(/^nxcore-document-asset:\/\/local\/[a-f0-9]{64}\/[a-f0-9-]{36}\.png$/)
    expect(await readdir(directory)).toHaveLength(1)
    const response = await store.response(stored.src)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(png))
    await expect(store.response('nxcore-document-asset://local/../../credentials.json'))
      .resolves.toMatchObject({ status: 404 })
  })

  it('rejects mislabeled content and removes a document asset directory', async () => {
    const { directory, store } = await createStore()
    await expect(store.storeImage('doc-1', {
      fileName: 'fake.png',
      mimeType: 'image/png',
      bytes: new TextEncoder().encode('not a png').buffer,
    })).rejects.toThrow('图片内容与文件格式不匹配')

    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer
    await store.storeImage('doc-1', { fileName: 'photo.png', mimeType: 'image/png', bytes: png })
    await store.deleteDocument('doc-1')
    expect(await readdir(directory)).toEqual([])
  })
})
