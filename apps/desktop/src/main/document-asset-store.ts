import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  DocumentImageMimeType,
  StoreDocumentImageInput,
  StoredDocumentImage,
} from '../shared/sources'

export const DOCUMENT_ASSET_SCHEME = 'nxcore-document-asset'

const MIME_EXTENSIONS: Record<DocumentImageMimeType, string> = {
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

const EXTENSION_MIME_TYPES = Object.fromEntries(
  Object.entries(MIME_EXTENSIONS).map(([mimeType, extension]) => [extension, mimeType]),
) as Record<string, DocumentImageMimeType>

export function assertNoEmbeddedDocumentImages(content: unknown): void {
  if (!content || typeof content !== 'object') return
  if (Array.isArray(content)) {
    for (const item of content) assertNoEmbeddedDocumentImages(item)
    return
  }
  const node = content as { type?: unknown; attrs?: unknown; content?: unknown }
  if (node.type === 'image' && node.attrs && typeof node.attrs === 'object') {
    const src = (node.attrs as { src?: unknown }).src
    if (typeof src === 'string' && src.startsWith('data:image/')) {
      throw new Error('图片必须先保存到本地，不能嵌入文档数据库。')
    }
  }
  for (const value of Object.values(content)) assertNoEmbeddedDocumentImages(value)
}

function documentKey(documentId: string): string {
  const normalized = documentId.trim()
  if (!normalized || normalized.length > 128) throw new Error('无效的文档标识。')
  return createHash('sha256').update(normalized).digest('hex')
}

function imageBytes(value: unknown): Buffer {
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new Error('无效的图片数据。')
}

function hasExpectedSignature(mimeType: DocumentImageMimeType, bytes: Buffer): boolean {
  if (mimeType === 'image/png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  }
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  if (mimeType === 'image/gif') {
    const signature = bytes.subarray(0, 6).toString('ascii')
    return signature === 'GIF87a' || signature === 'GIF89a'
  }
  if (mimeType === 'image/webp') {
    return bytes.length >= 12
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  }
  if (bytes.length < 12 || bytes.subarray(4, 8).toString('ascii') !== 'ftyp') return false
  const brandLimit = Math.min(bytes.length, 32)
  for (let offset = 8; offset + 4 <= brandLimit; offset += 4) {
    if (['avif', 'avis'].includes(bytes.subarray(offset, offset + 4).toString('ascii'))) return true
  }
  return false
}

function assetRequest(urlValue: string): {
  documentKey: string
  fileName: string
  mimeType: DocumentImageMimeType
} | null {
  let url: URL
  try {
    url = new URL(urlValue)
  } catch {
    return null
  }
  if (url.protocol !== `${DOCUMENT_ASSET_SCHEME}:` || url.hostname !== 'local') return null
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2) return null
  const [key, fileName] = parts
  if (!/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9-]{36}\.(?:avif|gif|jpg|png|webp)$/.test(fileName)) {
    return null
  }
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1)
  const mimeType = EXTENSION_MIME_TYPES[extension]
  return mimeType ? { documentKey: key, fileName, mimeType } : null
}

export class DocumentAssetStore {
  constructor(private readonly rootDirectory: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true })
  }

  async storeImage(
    documentId: string,
    input: StoreDocumentImageInput,
  ): Promise<StoredDocumentImage> {
    const mimeType = input?.mimeType
    if (typeof mimeType !== 'string' || !Object.hasOwn(MIME_EXTENSIONS, mimeType)) {
      throw new Error('不支持这种图片格式。')
    }
    const bytes = imageBytes(input.bytes)
    if (!bytes.length) throw new Error('图片内容为空。')
    if (bytes.length > 20 * 1024 * 1024) throw new Error('图片不能超过 20 MB。')
    if (!hasExpectedSignature(mimeType, bytes)) throw new Error('图片内容与文件格式不匹配。')

    const key = documentKey(documentId)
    const assetId = randomUUID()
    const fileName = `${assetId}.${MIME_EXTENSIONS[mimeType]}`
    const directory = join(this.rootDirectory, key)
    const filePath = join(directory, fileName)
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`
    await mkdir(directory, { recursive: true })
    try {
      await writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o600 })
      await rename(temporaryPath, filePath)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
    return {
      assetId,
      src: `${DOCUMENT_ASSET_SCHEME}://local/${key}/${fileName}`,
      mimeType,
      bytes: bytes.length,
    }
  }

  async response(url: string): Promise<Response> {
    const request = assetRequest(url)
    if (!request) return new Response('Not found', { status: 404 })
    try {
      const bytes = await readFile(join(this.rootDirectory, request.documentKey, request.fileName))
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          'Cache-Control': 'private, max-age=31536000, immutable',
          'Cross-Origin-Resource-Policy': 'cross-origin',
          'Content-Type': request.mimeType,
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  }

  async deleteDocument(documentId: string): Promise<void> {
    await rm(join(this.rootDirectory, documentKey(documentId)), { recursive: true, force: true })
  }
}
