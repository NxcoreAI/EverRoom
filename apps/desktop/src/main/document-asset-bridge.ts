import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'

import { DOCUMENT_ASSET_SCHEME, type DocumentAssetStore } from './document-asset-store'

/**
 * 文档资产本地桥：给网关（及 lark-cli 导出链路）一个 loopback HTTP 入口，
 * 把 nxcore-document-asset:// 资产以 http URL 暴露，飞书 markdown 导入会自动
 * 下载并上传这些图片。仅绑定 127.0.0.1，路径带随机 token 段鉴权；字节仍由
 * DocumentAssetStore 提供，token 不进入渲染层。
 */
export interface DocumentAssetBridge {
  baseUrl: string
  port: number
  stop(): Promise<void>
}

export async function startDocumentAssetBridge(assets: DocumentAssetStore): Promise<DocumentAssetBridge> {
  const token = randomBytes(24).toString('base64url')
  const server: Server = createServer((request, response) => {
    void handle(assets, token, request, response)
  })
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/t/${token}`,
    port,
    stop: () => new Promise<void>((resolveStop) => {
      server.close(() => resolveStop())
    }),
  }
}

const PUT_MAX_BYTES = 6 * 1024 * 1024

async function handle(
  assets: DocumentAssetStore,
  token: string,
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
): Promise<void> {
  const marker = `/t/${token}/`
  const bare = `/t/${token}`
  const url = request.url ?? ''
  const path = url.split('?')[0] ?? url
  if (path !== bare && !url.startsWith(marker)) {
    response.writeHead(404, { 'Content-Type': 'text/plain' })
    response.end('Not found')
    return
  }
  // 写入口（导入物化用）：PUT /t/<token>/?doc=<documentId>，body 为图片字节。
  if (request.method === 'PUT') {
    await handlePut(assets, url, request, response)
    return
  }
  // 读口：还原成 nxcore-document-asset://local/<...> 交给资产存储解析（含 404 兜底）。
  const assetUrl = `${DOCUMENT_ASSET_SCHEME}://local${url.slice(marker.length - 1)}`
  try {
    const asset = await assets.response(assetUrl)
    response.writeHead(asset.status, {
      'Content-Type': asset.headers.get('content-type') ?? 'application/octet-stream',
      'Cache-Control': asset.headers.get('cache-control') ?? 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(Buffer.from(await asset.arrayBuffer()))
  } catch {
    response.writeHead(500, { 'Content-Type': 'text/plain' })
    response.end('Asset read failed')
  }
}

async function handlePut(
  assets: DocumentAssetStore,
  url: string,
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
): Promise<void> {
  const json = (status: number, body: unknown): void => {
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  const documentId = new URL(url, 'http://127.0.0.1').searchParams.get('doc')?.trim() ?? ''
  if (!documentId || documentId.length > 128) {
    json(400, { error: 'invalid document id' })
    return
  }
  const chunks: Buffer[] = []
  let size = 0
  let aborted = false
  for await (const chunk of request) {
    size += (chunk as Buffer).byteLength
    if (size > PUT_MAX_BYTES) {
      aborted = true
      request.destroy()
      break
    }
    chunks.push(chunk as Buffer)
  }
  if (aborted) {
    json(413, { error: 'payload too large' })
    return
  }
  const mime = (request.headers['content-type'] ?? '').split(';')[0]?.trim() ?? ''
  try {
    const bytes = Buffer.concat(chunks)
    const stored = await assets.storeImage(documentId, {
      fileName: `import-${Date.now()}`,
      mimeType: mime as never,
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    })
    json(200, { src: stored.src })
  } catch (error) {
    json(400, { error: error instanceof Error ? error.message : 'store failed' })
  }
}
