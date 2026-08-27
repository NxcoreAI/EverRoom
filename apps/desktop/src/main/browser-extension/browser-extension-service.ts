import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { app, shell } from 'electron'
import { getDesktopLocale } from '../desktop-locale'

import type {
  BrowserExtensionCapture,
  BrowserExtensionClipperCapture,
  BrowserExtensionCaptureResult,
  BrowserExtensionMessage,
  BrowserExtensionStatus,
} from '../../shared/browser-extension'

const DEFAULT_PORT = 47831
const PAIRING_TTL_MS = 5 * 60 * 1000
const MAX_BODY_BYTES = 30 * 1024 * 1024
const STORE_URL = process.env.NXCORE_BROWSER_EXTENSION_STORE_URL?.trim()
  || 'https://chromewebstore.google.com/'
const EXPECTED_EXTENSION_ID = process.env.NXCORE_BROWSER_EXTENSION_ID?.trim() || null

interface PersistedState {
  appInstanceId: string
  pairing: {
    id: string
    expiresAt: string
    extensionId: string | null
    extensionName: string | null
    status: 'pending' | 'paired'
  } | null
  pairedExtensionId: string | null
  pairedAt: string | null
  accessToken: string | null
  lastMessage: BrowserExtensionMessage | null
}

type StatusListener = (status: BrowserExtensionStatus) => void
type MessageListener = (message: BrowserExtensionMessage) => void
type CaptureHandler = (capture: BrowserExtensionCapture) => Promise<BrowserExtensionCaptureResult>
type CaptureAssetHandler = (captureId: string, assetId: string, data: string) => Promise<BrowserExtensionClipperCapture['assets'][number]>
type CaptureFinalizeHandler = (captureId: string, failures: Array<{ assetId: string; code?: string }>) => Promise<BrowserExtensionClipperCapture>
type CaptureRetryHandler = (captureId: string) => Promise<{ capture: BrowserExtensionClipperCapture; pendingAssetIds: string[] }>

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', Buffer.byteLength(body))
  response.end(body)
}

function setCors(response: ServerResponse, origin: string | undefined): void {
  if (origin?.startsWith('chrome-extension://') || origin?.startsWith('moz-extension://')) {
    response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Vary', 'Origin')
  }
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > MAX_BODY_BYTES) throw new Error('request_too_large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_json_body')
  return parsed as Record<string, unknown>
}

function safeString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const result = value.trim()
  return result.length > 0 && result.length <= maxLength ? result : null
}

export class BrowserExtensionService {
  private readonly statePath: string
  private readonly port: number
  private readonly extensionDirectory: string | null = app.isPackaged
    ? null
    : resolve(app.getAppPath(), '..', 'browser-extension')
  private server: Server | null = null
  private startError: string | null = null
  private state: PersistedState = {
    appInstanceId: randomUUID(),
    pairing: null,
    pairedExtensionId: null,
    pairedAt: null,
    accessToken: null,
    lastMessage: null,
  }
  private readonly statusListeners = new Set<StatusListener>()
  private readonly messageListeners = new Set<MessageListener>()
  private captureHandler: CaptureHandler | null = null
  private captureAssetHandler: CaptureAssetHandler | null = null
  private captureFinalizeHandler: CaptureFinalizeHandler | null = null
  private captureRetryHandler: CaptureRetryHandler | null = null

  constructor(dataDirectory: string) {
    this.statePath = join(dataDirectory, 'browser-extension-state.json')
    const configured = Number(process.env.NXCORE_BROWSER_EXTENSION_PORT ?? DEFAULT_PORT)
    this.port = Number.isInteger(configured) && configured >= 1024 && configured <= 65535
      ? configured
      : DEFAULT_PORT
  }

  async start(): Promise<void> {
    await this.load()
    await this.persist()
    if (this.server) return
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const server = this.server!
        const onError = (error: Error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(this.port, '127.0.0.1')
      })
      this.startError = null
    } catch (error) {
      this.server = null
      this.startError = error instanceof Error ? error.message : String(error)
      throw error
    }
    this.emitStatus()
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  setCaptureHandlers(handlers: {
    create: CaptureHandler
    uploadAsset: CaptureAssetHandler
    finalize: CaptureFinalizeHandler
    retry: CaptureRetryHandler
  }): void {
    this.captureHandler = handlers.create
    this.captureAssetHandler = handlers.uploadAsset
    this.captureFinalizeHandler = handlers.finalize
    this.captureRetryHandler = handlers.retry
  }

  getStatus(): BrowserExtensionStatus {
    const pairing = this.state.pairing && new Date(this.state.pairing.expiresAt).getTime() > Date.now()
      ? this.state.pairing
      : null
    const state: BrowserExtensionStatus['state'] = this.startError
      ? 'unavailable'
      : this.state.pairedExtensionId
      ? 'paired'
      : pairing
          ? 'waiting-for-extension'
          : 'idle'
    return {
      mode: this.extensionDirectory ? 'development' : 'production',
      state,
      bridgeUrl: this.server ? `http://127.0.0.1:${this.port}` : null,
      storeUrl: STORE_URL,
      extensionDirectory: this.extensionDirectory,
      pairing: pairing ? {
        id: pairing.id,
        status: pairing.status,
        expiresAt: pairing.expiresAt,
        extensionId: pairing.extensionId,
        extensionName: pairing.extensionName,
      } : null,
      pairedExtensionId: this.state.pairedExtensionId,
      pairedAt: this.state.pairedAt,
      lastMessage: this.state.lastMessage,
      error: this.startError,
    }
  }

  async install(): Promise<BrowserExtensionStatus> {
    await this.createPairing(false)
    if (this.extensionDirectory) {
      const launched = await this.launchDevelopmentBrowser()
      if (!launched) await this.openDevelopmentExtension()
      return this.getStatus()
    }
    await shell.openExternal(STORE_URL)
    return this.getStatus()
  }

  async openDevelopmentExtension(): Promise<void> {
    if (!this.extensionDirectory) throw new Error('当前是生产版本，请从浏览器扩展商店安装。')
    const error = await shell.openPath(this.extensionDirectory)
    if (error) throw new Error(`无法打开开发版扩展目录：${error}`)
  }

  async launchDevelopmentBrowser(): Promise<boolean> {
    if (!this.extensionDirectory) throw new Error('当前是生产版本，请从浏览器扩展商店安装。')
    const browser = this.findChromiumBrowser()
    if (!browser) return false
    const profileDirectory = join(dirname(this.statePath), 'browser-extension', 'dev-profile')
    await mkdir(profileDirectory, { recursive: true, mode: 0o700 })
    return await new Promise<boolean>((resolveLaunch) => {
      const child = spawn(browser, [
        `--user-data-dir=${profileDirectory}`,
        `--load-extension=${this.extensionDirectory}`,
        '--no-first-run',
        '--no-default-browser-check',
      ], { detached: true, stdio: 'ignore' })
      child.once('spawn', () => {
        child.unref()
        resolveLaunch(true)
      })
      child.once('error', () => resolveLaunch(false))
    })
  }

  private findChromiumBrowser(): string | null {
    const candidates = process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        ]
      : process.platform === 'win32'
        ? [
            join(process.env.ProgramFiles ?? '', 'Google/Chrome/Application/chrome.exe'),
            join(process.env['ProgramFiles(x86)'] ?? '', 'Google/Chrome/Application/chrome.exe'),
            join(process.env.ProgramFiles ?? '', 'Microsoft/Edge/Application/msedge.exe'),
          ]
        : ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'brave-browser']
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      const available = candidates.find((candidate) => spawnSync('which', [candidate], { stdio: 'ignore' }).status === 0)
      return available ?? null
    }
    return candidates.find((candidate) => existsSync(candidate)) ?? null
  }

  async openBrowserExtensionsPage(): Promise<void> {
    const target = this.extensionDirectory
      ? 'chrome://extensions'
      : STORE_URL
    await shell.openExternal(target)
  }

  async createPairing(openBrowser = true): Promise<BrowserExtensionStatus> {
    this.state.pairing = {
      id: randomUUID(),
      expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
      extensionId: null,
      extensionName: null,
      status: 'pending',
    }
    await this.persist()
    this.emitStatus()
    if (openBrowser && this.server) {
      await shell.openExternal(`http://127.0.0.1:${this.port}/v1/browser/pair/connect`)
    }
    return this.getStatus()
  }

  async revoke(): Promise<BrowserExtensionStatus> {
    this.state.pairing = null
    this.state.pairedExtensionId = null
    this.state.pairedAt = null
    this.state.accessToken = null
    await this.persist()
    this.emitStatus()
    return this.getStatus()
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<PersistedState>
      if (typeof parsed.appInstanceId === 'string') this.state.appInstanceId = parsed.appInstanceId
      if (parsed.pairing && typeof parsed.pairing === 'object') this.state.pairing = parsed.pairing as PersistedState['pairing']
      if (typeof parsed.pairedExtensionId === 'string' || parsed.pairedExtensionId === null) this.state.pairedExtensionId = parsed.pairedExtensionId
      if (typeof parsed.pairedAt === 'string' || parsed.pairedAt === null) this.state.pairedAt = parsed.pairedAt
      if (typeof parsed.accessToken === 'string' || parsed.accessToken === null) this.state.accessToken = parsed.accessToken
      if (parsed.lastMessage && typeof parsed.lastMessage === 'object') this.state.lastMessage = parsed.lastMessage as BrowserExtensionMessage
    } catch {
      await this.persist()
    }
  }

  private async persist(): Promise<void> {
    await writeFile(this.statePath, JSON.stringify(this.state, null, 2), 'utf8')
  }

  private emitStatus(): void {
    const status = this.getStatus()
    for (const listener of this.statusListeners) listener(status)
  }

  private emitMessage(message: BrowserExtensionMessage): void {
    for (const listener of this.messageListeners) listener(message)
  }

  private authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization
    return Boolean(
      this.state.accessToken
      && header === `Bearer ${this.state.accessToken}`
      && this.originAllowed(request.headers.origin),
    )
  }

  private originAllowed(origin: string | undefined): boolean {
    if (!origin) return true
    const match = origin.match(/^(?:chrome|moz)-extension:\/\/([^/]+)$/)
    if (!match) return false
    const expected = this.state.pairedExtensionId ?? this.state.pairing?.extensionId
    return !expected || match[1] === expected
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = request.headers.origin
    if (!this.originAllowed(origin)) {
      jsonResponse(response, 403, { code: 'extension_origin_not_allowed' })
      return
    }
    setCors(response, origin)
    if (request.method === 'OPTIONS') {
      response.statusCode = 204
      response.end()
      return
    }
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${this.port}`)
    try {
      if (request.method === 'GET' && url.pathname === '/v1/browser/health') {
        jsonResponse(response, 200, { ok: true, appInstanceId: this.state.appInstanceId })
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/browser/preferences') {
        jsonResponse(response, 200, { locale: getDesktopLocale() })
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/browser/pair/connect') {
        const locale = getDesktopLocale()
        const heading = locale === 'zh-CN' ? '正在连接 EverRoom' : 'Connecting to EverRoom'
        const message = locale === 'zh-CN'
          ? '请确保已安装并启用 EverRoom 浏览器扩展。'
          : 'Make sure the EverRoom browser extension is installed and enabled.'
        const body = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EverRoom</title><style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#1d2528;background:#f4f6f5}main{text-align:center;padding:32px}h1{font-size:22px;margin:0 0 8px}p{margin:0;color:#647074}</style></head><body><main><h1>${heading}</h1><p id="everroom-pairing-status">${message}</p></main></body></html>`
        response.statusCode = 200
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
        response.end(body)
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/browser/pair/pending') {
        const pairing = this.state.pairing
        if (!pairing || pairing.status === 'paired' || new Date(pairing.expiresAt).getTime() <= Date.now()) {
          jsonResponse(response, 404, { code: 'no_pending_pairing' })
          return
        }
        jsonResponse(response, 200, {
          pairingSessionId: pairing.id,
          appInstanceId: this.state.appInstanceId,
          expiresAt: pairing.expiresAt,
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/browser/pair/claim') {
        const body = await readJson(request)
        let pairing = this.state.pairing
        const pairingSessionId = safeString(body.pairingSessionId, 100)
        const extensionId = safeString(body.extensionId, 200)
        if (!extensionId) {
          jsonResponse(response, 400, { code: 'extension_id_required' })
          return
        }
        if (!pairing || (pairing.status !== 'paired' && new Date(pairing.expiresAt).getTime() <= Date.now())) {
          pairing = {
            id: randomUUID(),
            expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
            extensionId: null,
            extensionName: null,
            status: 'pending',
          }
          this.state.pairing = pairing
        }
        if (pairingSessionId && pairing.id !== pairingSessionId) {
          jsonResponse(response, 409, { code: 'pairing_expired' })
          return
        }
        if (EXPECTED_EXTENSION_ID && extensionId !== EXPECTED_EXTENSION_ID) {
          jsonResponse(response, 403, { code: 'extension_not_allowed' })
          return
        }
        pairing.extensionId = extensionId
        pairing.extensionName = safeString(body.extensionName, 200)
        pairing.status = 'paired'
        this.state.pairedExtensionId = extensionId
        this.state.pairedAt = new Date().toISOString()
        this.state.accessToken = randomBytes(32).toString('base64url')
        await this.persist()
        this.emitStatus()
        jsonResponse(response, 200, {
          status: pairing.status,
          pairingSessionId: pairing.id,
          accessToken: this.state.accessToken,
          appInstanceId: this.state.appInstanceId,
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/browser/pair/status') {
        const pairing = this.state.pairing
        const pairingSessionId = url.searchParams.get('pairingSessionId')
        if (!pairing || pairing.id !== pairingSessionId) {
          jsonResponse(response, 404, { code: 'pairing_not_found' })
          return
        }
        jsonResponse(response, 200, {
          status: pairing.status,
          pairingSessionId: pairing.id,
          ...(pairing.status === 'paired'
            ? {
                accessToken: this.state.accessToken,
                appInstanceId: this.state.appInstanceId,
              }
            : {}),
        })
        return
      }
      if (!this.authorized(request)) {
        jsonResponse(response, 401, { code: 'unauthorized' })
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/browser/session') {
        jsonResponse(response, 200, { ok: true, pairedAt: this.state.pairedAt })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/browser/messages') {
        const body = await readJson(request)
        const type = safeString(body.type, 100)
        if (!type) {
          jsonResponse(response, 400, { code: 'invalid_message_type' })
          return
        }
        const payload = body.payload
        const message: BrowserExtensionMessage = {
          type,
          payload: payload && typeof payload === 'object' && !Array.isArray(payload)
            ? payload as Record<string, unknown>
            : {},
          receivedAt: new Date().toISOString(),
        }
        this.state.lastMessage = message
        await this.persist()
        this.emitMessage(message)
        this.emitStatus()
        jsonResponse(response, 202, { accepted: true, receivedAt: message.receivedAt })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/browser/capture') {
        if (!this.captureHandler) {
          jsonResponse(response, 503, { code: 'capture_unavailable' })
          return
        }
        const capture = this.parseCapture(await readJson(request))
        const result = await this.captureHandler(capture)
        const message: BrowserExtensionMessage = {
          type: 'clipper.capture',
          payload: { captureId: capture.captureId, title: capture.title, canonicalUrl: capture.canonicalUrl, result },
          receivedAt: new Date().toISOString(),
        }
        this.state.lastMessage = message
        await this.persist()
        this.emitMessage(message)
        this.emitStatus()
        jsonResponse(response, 202, result)
        return
      }
      const assetMatch = url.pathname.match(/^\/v1\/browser\/captures\/([^/]+)\/assets\/([^/]+)$/)
      if (request.method === 'PUT' && assetMatch) {
        if (!this.captureAssetHandler) {
          jsonResponse(response, 503, { code: 'capture_unavailable' })
          return
        }
        const body = await readJson(request)
        const data = safeString(body.data, 27_962_028)
        if (!data) {
          jsonResponse(response, 400, { code: 'capture_asset_invalid' })
          return
        }
        const result = await this.captureAssetHandler(decodeURIComponent(assetMatch[1]!), decodeURIComponent(assetMatch[2]!), data)
        jsonResponse(response, 200, result)
        return
      }
      const finalizeMatch = url.pathname.match(/^\/v1\/browser\/captures\/([^/]+)\/finalize$/)
      if (request.method === 'POST' && finalizeMatch) {
        if (!this.captureFinalizeHandler) {
          jsonResponse(response, 503, { code: 'capture_unavailable' })
          return
        }
        const body = await readJson(request)
        const failures = Array.isArray(body.failures) ? body.failures.slice(0, 100).flatMap((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return []
          const assetId = safeString((item as Record<string, unknown>).assetId, 200)
          const code = safeString((item as Record<string, unknown>).code, 100)
          return assetId ? [{ assetId, ...(code ? { code } : {}) }] : []
        }) : []
        const result = await this.captureFinalizeHandler(decodeURIComponent(finalizeMatch[1]!), failures)
        jsonResponse(response, 200, result)
        return
      }
      const retryMatch = url.pathname.match(/^\/v1\/browser\/captures\/([^/]+)\/retry$/)
      if (request.method === 'POST' && retryMatch) {
        if (!this.captureRetryHandler) {
          jsonResponse(response, 503, { code: 'capture_unavailable' })
          return
        }
        const result = await this.captureRetryHandler(decodeURIComponent(retryMatch[1]!))
        jsonResponse(response, 200, result)
        return
      }
      jsonResponse(response, 404, { code: 'not_found' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      jsonResponse(response, 400, { code: message })
    }
  }

  private parseCapture(body: Record<string, unknown>): BrowserExtensionCapture {
    const text = (value: unknown, max: number): string => {
      if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('capture_field_invalid')
      return value.trim()
    }
    const mode = body.extractionMode
    if (mode !== 'selection' && mode !== 'article' && mode !== 'full-page') throw new Error('capture_mode_invalid')
    const url = text(body.url, 4_000)
    const canonicalUrl = text(body.canonicalUrl, 4_000)
    if (!/^https?:\/\//i.test(url) || !/^https?:\/\//i.test(canonicalUrl)) throw new Error('capture_url_invalid')
    if (Array.isArray(body.assets) && body.assets.length > 100) throw new Error('capture_too_many_assets')
    return {
      captureId: text(body.captureId, 200),
      url,
      canonicalUrl,
      title: text(body.title, 500),
      ...(typeof body.author === 'string' && body.author.trim() ? { author: body.author.trim().slice(0, 500) } : {}),
      ...(typeof body.publishedAt === 'string' && body.publishedAt.trim() ? { publishedAt: body.publishedAt.trim().slice(0, 100) } : {}),
      extractionMode: mode,
      markdown: text(body.markdown, 6 * 1024 * 1024),
      capturedAt: text(body.capturedAt, 100),
      extractorVersion: text(body.extractorVersion, 100),
      assets: Array.isArray(body.assets) ? body.assets.slice(0, 100).map((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('capture_asset_invalid')
        const asset = value as Record<string, unknown>
        const id = text(asset.id, 200)
        const referenceKey = text(asset.referenceKey, 100)
        const originalUrl = text(asset.originalUrl, 4_000)
        return {
          id,
          referenceKey,
          originalUrl,
          ...(typeof asset.altText === 'string' && asset.altText.trim() ? { altText: asset.altText.trim().slice(0, 1_000) } : {}),
          ...(typeof asset.width === 'number' && Number.isInteger(asset.width) && asset.width >= 0 ? { width: asset.width } : {}),
          ...(typeof asset.height === 'number' && Number.isInteger(asset.height) && asset.height >= 0 ? { height: asset.height } : {}),
        }
      }) : [],
    }
  }
}
