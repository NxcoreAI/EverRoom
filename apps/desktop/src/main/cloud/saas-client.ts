import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { execSync } from 'node:child_process'
import { hostname } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'

import type { AxiosRequestConfig, AxiosResponse } from 'axios'
import type { App } from 'electron'

import type {
  AsrJob,
  AsrResult,
  CloudAccountStatus,
  CloudDevice,
  CloudOidcProvider,
  CreateAsrJobInput,
  QrLoginPresentation,
  QrLoginStatusPayload,
} from '../../shared/sources'
import type { RealityTag } from '@nxcore/reality-contract'
import type { AgentSession, AgentSessionSnapshot } from '@nxcore/agent-contract'
import type {
  AgentNotificationRequest,
  AgentNotificationResult,
  CloudAgentMessagePage,
  CloudAgentSessionSummary,
  NotificationPreferences,
} from '../../shared/notifications'
import type { CredentialStore } from '../security/credential-store'
import { createLoggedHttpClient } from '../network/http-client'
import everroomFullLogo from '../../renderer/src/assets/everroom-full.png'

const REFRESH_TOKEN_KEY = 'everroom:saas:refresh-token'
const DEVICE_KEY_KEY = 'everroom:saas:device-key'

// 读取硬件级设备标识：macOS 用 IOPlatformUUID（主板固件决定），Windows 用
// 注册表 MachineGuid（系统安装时生成）。两者都由系统保证：重装应用、清空
// 应用数据、系统大版本升级都不会变化，只有更换整机/重装系统才会变。
let cachedHardwareKey: string | null | undefined
function hardwareDeviceKey(): string | null {
  if (cachedHardwareKey !== undefined) return cachedHardwareKey
  try {
    if (process.platform === 'win32') {
      const output = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
        { encoding: 'utf8', timeout: 5_000 },
      )
      const match = output.match(/MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]+)/)
      cachedHardwareKey = match ? `win-${match[1].toLowerCase()}` : null
    } else {
      const output = execSync('ioreg -d 2 -l', { encoding: 'utf8', timeout: 5_000 })
      const match = output.match(/"IOPlatformUUID" = "([0-9A-Fa-f-]+)"/)
      cachedHardwareKey = match ? `mac-${match[1].toLowerCase()}` : null
    }
  } catch {
    cachedHardwareKey = null
  }
  return cachedHardwareKey
}
const ACCOUNT_PROFILE_KEY = 'everroom:saas:account-profile'
const REQUEST_TIMEOUT_MS = 15_000
const UPLOAD_TIMEOUT_MS = 5 * 60_000
const OIDC_LOGIN_TIMEOUT_MS = 3 * 60_000
const SUBSCRIPTION_CACHE_TTL_MS = 60_000
const SUBSCRIPTION_RETRY_DELAY_MS = 30_000
const http = createLoggedHttpClient('saas', { timeout: REQUEST_TIMEOUT_MS })

export const OIDC_CALLBACK_URL = 'everroom://auth/callback'

/**
 * RFC 8252 本地回环回调:浏览器授权后直接 HTTP 302 到 127.0.0.1,不依赖自定义协议跳转。
 * Chrome 会静默拦截无用户手势的自定义协议跳转(OAuth 重定向链内没有手势),
 * 导致授权完成后无法自动跳回应用;回环 HTTP 回调是原生应用的标准解法。
 * Logto 不支持通配端口,因此使用固定端口(env 可覆盖)。
 */
const OIDC_LOOPBACK_PORT = Number.parseInt(env('NXCORE_LOGTO_LOOPBACK_PORT', '53837'), 10) || 53837
const OIDC_LOOPBACK_HOST = '127.0.0.1'
const OIDC_LOOPBACK_PATH = '/auth/callback'
const OIDC_LOOPBACK_REDIRECT_URI = `http://${OIDC_LOOPBACK_HOST}:${OIDC_LOOPBACK_PORT}${OIDC_LOOPBACK_PATH}`

interface LoginResult {
  accessToken: string
  refreshToken: string
  user: { id: string; tenantId: string; email?: string | null; phone?: string | null; name?: string }
  device: { id: string; name?: string; platform?: string }
  session?: { id: string; leaseExpiresAt?: string }
  registration?: { accountCreated: boolean; invitationApplied: boolean }
}

/** 设备额度已满时服务端返回的准入挑战：桌面需展示设备列表并让用户选择替换。 */
export interface AdmissionRequired {
  admissionRequired: true
  reason: 'DEVICE_LIMIT_REACHED'
  maxDevices: number
  admissionToken: string
  expiresAt: string
  devices: CloudDevice[]
}

export type LoginOutcome = LoginResult | AdmissionRequired

/** 扫码登录 pending 会话：桌面交换凭证只存在于主进程内存。 */
interface PendingQrLogin {
  sessionId: string
  desktopExchangeToken: string
  expiresAt: string
  inFlight: boolean
}

/** createSession 响应（主进程消费后剥掉 desktopExchangeToken 才给 renderer）。 */
interface QrLoginSessionCreated {
  qrLoginSessionId: string
  qrScanToken: string
  desktopExchangeToken: string
  confirmationCode: string
  expiresAt: string
  status: 'pending_scan'
}

export function isAdmissionRequired(outcome: LoginOutcome | null | undefined): outcome is AdmissionRequired {
  return outcome !== null && outcome !== undefined && typeof outcome === 'object'
    && (outcome as AdmissionRequired).admissionRequired === true
}

interface CloudJob {
  id: string
  status: string
  provider: string
  fileName: string
  transcript?: string | null
  segments?: Array<{ text: string; beginTime: number; endTime: number; speakerId: number | null }>
  insights?: AsrResult['insights']
  errorCode?: string | null
  errorMessage?: string | null
  createdAt: string
  updatedAt: string
}

interface UploadAuthorization {
  uploadUrl: string
  objectKey: string
  headers: Record<string, string>
}

interface CloudSubscription {
  status: string
  planCode: string
  planName: string
  periodStart: string
  periodEnd: string
  usedSeconds: number
  entitlements?: { asrSecondsPerPeriod?: number }
}

export interface KeyringDevicePackage {
  algorithm: 'X25519-HKDF-SHA256-AES-256-GCM'
  ephemeralPublicKey: string
  salt: string
  ciphertext: string
  umkId: string
  umkVersion: number
  createdAt?: string
}

export interface AgentStreamCredentials {
  url: string
  accessToken: string
  deviceId: string
}

export interface SaasRuntimeConfig {
  schemaVersion: number
  configVersion: number
  source: 'global' | 'plan' | 'tenant' | 'user'
  planCode: string
  planName: string
  updatedAt: string
  config: Record<string, unknown>
}

export interface KeyringResponse {
  userId: string
  initialized: boolean
  umkId: string | null
  activeVersion: number | null
  currentDevice: {
    deviceId: string
    status: 'unregistered' | 'pending' | 'ready'
    publicKey: string
    keyPackage: KeyringDevicePackage | null
  }
  pendingDevices: Array<{
    deviceId: string
    name?: string
    platform?: string
    publicKey: string
    requestedAt?: string
  }>
}

export interface PairingSessionResponse {
  pairingSessionId: string
  pairingToken?: string
  status: 'waiting_for_scan' | 'waiting_for_approval' | 'approved' | 'completed' | 'expired' | 'cancelled'
  confirmationCode: string
  expiresAt: string
  targetDeviceId?: string | null
  targetDeviceName?: string | null
  targetPublicKey?: string | null
  targetAlgorithm?: 'X25519' | null
  umkId?: string | null
  umkVersion?: number | null
  packageAlgorithm?: 'X25519-HKDF-SHA256-AES-256-GCM'
  ephemeralPublicKey?: string
  salt?: string
  ciphertext?: string
  origin?: string
}

export interface PrivateRecordEnvelope {
  cursor: number
  operation: 'upsert' | 'delete'
  recordId: string
  recordType?: 'legacy_transcription' | 'transcription_source' | 'transcription_summary'
  schemaVersion?: number
  payload?: Record<string, unknown>
  algorithm?: 'AES-256-GCM'
  keyId?: string
  ciphertext?: string
  wrappingAlgorithm?: 'AES-256-GCM'
  wrappingKeyId?: string
  wrappingKeyVersion?: number
  wrappedKey?: string
  contentHash?: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface PutPrivateRecordInput {
  recordType: 'legacy_transcription' | 'transcription_source'
  schemaVersion: number
  payload: Record<string, unknown>
  expectedRevision?: number
}

export interface PrivateAudioAsset {
  cursor?: number
  operation?: 'upsert' | 'delete'
  id: string
  recordingId: string
  eventId?: string
  sequence?: number
  fileName: string
  mimeType: string
  durationMs: number | null
  fileSize: number
  contentHash: string
  chunkCount?: number
  chunkSize?: number
  objectKey?: string | null
  status: 'created' | 'uploaded' | 'deleted'
  revision: number
  createdAt: string
  updatedAt: string
}

export interface ProcessingJob {
  id: string
  workflow: 'transcription.summary.v1'
  workflowVersion: number
  sourceRecordId: string
  sourceRevision: number
  sourceContentHash: string
  status: 'pending' | 'leased' | 'running' | 'retry_wait' | 'succeeded' | 'superseded' | 'cancelled' | 'dead_letter'
  attemptCount: number
  maxAttempts: number
  leaseExpiresAt: string | null
  resultRecordId: string | null
  lastErrorCode: string | null
  lastErrorClass: 'retryable' | 'permanent' | 'user_action' | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface CompleteProcessingJobInput {
  leaseToken: string
  resultRecordId: string
  payload: Record<string, unknown>
}

interface StoredAccountProfile {
  userId: string
  email?: string | null
  phone?: string | null
  name?: string
}

interface LogtoTokenResponse {
  id_token?: string
  error?: string
  error_description?: string
}

interface PendingOidcLogin {
  state: string
  nonce: string
  codeVerifier: string
  redirectUri: string
  invitationCode?: string
  resolve: (status: CloudAccountStatus) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

/** 一次本地回环回调监听:accept 交给上层 resolve/reject,finish 时关闭服务。 */
interface LoopbackCallbackWaiter {
  accept(callback: URL): void
  finish(): void
}

function loopbackCallbackPage(request: IncomingMessage, response: ServerResponse, handler: (callback: URL) => void): void {
  const callback = new URL(request.url ?? '/', `http://${request.headers.host ?? OIDC_LOOPBACK_HOST}`)
  const failed = callback.searchParams.has('error') || !callback.searchParams.has('code')
  response.writeHead(failed ? 400 : 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:",
  })
  response.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>EverRoom · ${failed ? 'Sign-in incomplete' : 'Signed in'}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; min-height: 100vh; display: grid; place-items: center; background: #f7f8fa; color: #202124; }
    main { width: min(420px, calc(100vw - 40px)); padding: 36px 34px 32px; border: 1px solid #e5e7eb; border-radius: 14px; background: #fff; box-shadow: 0 18px 48px rgba(16, 24, 40, .08); text-align: center; }
    .brand { display: inline-flex; align-items: center; justify-content: center; }
    .brand img { display: block; width: 164px; height: auto; }
    .status { width: 52px; height: 52px; margin: 34px auto 20px; display: grid; place-items: center; border-radius: 50%; background: ${failed ? '#fff1f0' : '#edf8f1'}; color: ${failed ? '#d92d20' : '#15803d'}; font-size: 25px; font-weight: 700; }
    h1 { margin: 0; font-size: 22px; line-height: 1.3; letter-spacing: -.025em; }
    p { margin: 10px 0 0; color: #667085; font-size: 14px; line-height: 1.6; }
    .hint { margin-top: 24px; padding-top: 18px; border-top: 1px solid #f0f1f3; color: #98a2b3; font-size: 12px; }
  </style>
</head>
<body>
  <main>
    <div class="brand">
      <img src="${everroomFullLogo}" alt="EverRoom">
    </div>
    <div class="status" aria-hidden="true">${failed ? '!' : '&#10003;'}</div>
    <h1>${failed ? 'Sign-in incomplete' : 'You are signed in'}</h1>
    <p>${failed ? 'Return to EverRoom and try signing in again.' : 'Your account is connected. You can continue in EverRoom.'}</p>
    ${failed
      ? '<div class="hint">Return to EverRoom to try again</div>'
      : '<div class="hint">Redirecting to the EverRoom website in <span id="redirect-countdown">5</span> seconds</div>'}
  </main>
  ${failed ? '' : `<script>
    (() => {
      const target = 'https://r.nxcore.ai';
      let seconds = 5;
      const countdown = document.getElementById('redirect-countdown');
      const timer = setInterval(() => {
        seconds -= 1;
        if (countdown) countdown.textContent = String(seconds);
        if (seconds <= 0) {
          clearInterval(timer);
          window.location.replace(target);
        }
      }, 1000);
    })();
  </script>`}
</body>
</html>`)
  // 响应先落盘再交给上层处理,保证随后的连接清理不会截断浏览器收到的页面。
  setImmediate(() => handler(callback))
}

function startLoopbackCallbackServer(waiter: LoopbackCallbackWaiter): Promise<Server> {
  return new Promise((resolveStart, rejectStart) => {
    let settled = false
    const server = createServer((request, response) => {
      loopbackCallbackPage(request, response, (callback) => {
        if (settled) return
        settled = true
        waiter.accept(callback)
      })
    })
    server.once('error', rejectStart)
    // 监听句柄不阻止进程退出;已建立的连接交给 closeIdleConnections 清理。
    server.listen({ port: OIDC_LOOPBACK_PORT, host: OIDC_LOOPBACK_HOST, exclusive: true }, () => {
      server.off('error', rejectStart)
      server.on('error', () => undefined)
      server.unref()
      resolveStart(server)
    })
  })
}

export class SaasRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'SaasRequestError'
  }
}

export function isSaasRateLimitError(error: unknown): error is SaasRequestError {
  return error instanceof SaasRequestError && error.status === 429
}

function saasErrorMessage(response: AxiosResponse): string {
  if (response.status === 429) return '请求过于频繁，请稍后重试。'
  const body = response.data as { detail?: string; message?: string } | null
  return body?.detail ?? body?.message ?? `SaaS 请求失败（${response.status}）`
}

function env(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback
}

export function normalizeSaasApiUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/api/v1'
  return url.toString().replace(/\/+$/, '')
}

function randomBase64Url(size = 32): string {
  return randomBytes(size).toString('base64url')
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]
  if (!payload) throw new Error('Logto 返回了无效的 ID Token。')
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    throw new Error('Logto 返回了无效的 ID Token。')
  }
}

/** 心跳上行投影：剥掉 SaaS schema 尚不认识的多 Agent 字段，避免 strict 校验整包 422。 */
function saasCompatibleSession(
  session: AgentSession & Pick<AgentSessionSnapshot, 'messages' | 'activeRun' | 'lastEventSeq'>,
): AgentSession & Pick<AgentSessionSnapshot, 'messages' | 'activeRun' | 'lastEventSeq'> {
  const { activeAgentId: _activeAgentId, ...rest } = session
  return {
    ...rest,
    messages: session.messages.map(({ authorAgentId: _authorAgentId, ...message }) => message),
  }
}

export class SaasClient {
  private accessToken: string | null = null
  private account: LoginResult | null = null
  private pendingAdmission: AdmissionRequired | null = null
  private pendingQrLogin: PendingQrLogin | null = null
  private subscription: CloudAccountStatus['subscription'] | null = null
  private subscriptionLoadedAt = 0
  private subscriptionRetryAfter = 0
  private subscriptionPromise: Promise<void> | null = null
  private initializePromise: Promise<void> | null = null
  private pendingOidcLogin: PendingOidcLogin | null = null
  private loopbackRedirectSupported: boolean | null = null
  private loopbackServer: Server | null = null

  /** 当前登录会话绑定的本机设备 ID（未登录为 null）。 */
  get deviceId(): string | null {
    return this.account?.device?.id ?? null
  }

  readonly baseUrl: string
  readonly logtoIssuer: string
  readonly logtoAppId: string
  private readonly connectorIds: Record<CloudOidcProvider, string>

  constructor(
    private readonly credentials: CredentialStore,
    private readonly electronApp: App,
    private readonly recordingsDirectory: string,
    private readonly openExternal: (url: string) => Promise<void>,
  ) {
    // 开发默认与手机 App 的 dev 默认（http://192.168.1.99:4100）保持同一 origin，
    // 保证扫码登录的环境校验在两端默认配置下直接通过。
    this.baseUrl = normalizeSaasApiUrl(env('NXCORE_SAAS_API_URL', 'http://192.168.1.99:4100/api/v1'))
    this.logtoIssuer = env('NXCORE_LOGTO_ISSUER', 'https://auth.nxcore.ai/oidc').replace(/\/+$/, '')
    this.logtoAppId = env('NXCORE_LOGTO_APP_ID', 'typreqzzbz3anel9aq1z8')
    this.connectorIds = {
      google: env('NXCORE_LOGTO_GOOGLE_CONNECTOR_ID', 'ylj6cyoz9kqpgpqgh3st8'),
      apple: env('NXCORE_LOGTO_APPLE_CONNECTOR_ID', 'aei6v6kjlpauhod1r7f82'),
    }
  }

  initialize(): Promise<void> {
    this.initializePromise ??= this.restoreSession()
    return this.initializePromise
  }

  async status(refreshSubscription = false): Promise<CloudAccountStatus> {
    await this.initialize()
    if (this.account) {
      try {
        await this.loadSubscription(refreshSubscription)
      } catch (error) {
        if (refreshSubscription) throw error
      }
    }
    return this.currentStatus()
  }

  async listDevices(): Promise<CloudDevice[]> {
    await this.initialize()
    this.requireLogin()
    return this.request<CloudDevice[]>('/app/devices')
  }

  /** 当前待处理的设备准入挑战（额度已满时登录/刷新返回）。 */
  get admissionChallenge(): AdmissionRequired | null {
    return this.pendingAdmission
  }

  /** 放弃当前准入挑战（用户取消设备选择）。 */
  clearAdmissionChallenge(): void {
    this.pendingAdmission = null
  }

  /**
   * 设备替换：选择一个在线设备下线，为当前桌面腾出额度。成功后接受新会话。
   * admissionToken 短时效（默认 5 分钟），过期后需要重新登录获取。
   */
  async replaceDeviceAdmission(admissionToken: string, replaceDeviceId: string): Promise<CloudAccountStatus> {
    await this.initialize()
    const data = await this.publicRequest<LoginResult>('/app/auth/device-admission/replace', {
      method: 'POST',
      data: { admissionToken, replaceDeviceId },
    })
    this.pendingAdmission = null
    await this.acceptSession(data)
    await this.loadSubscription()
    return this.currentStatus()
  }

  // ---- 扫码登录（手机 App 扫码登录桌面端）----
  // 双凭证隔离：qrScanToken 进入二维码；desktopExchangeToken 只保留在主进程
  // 内存（PendingQrLogin），不进入 renderer、磁盘或日志。

  /** 当前 pending 扫码会话（含桌面交换凭证），仅主进程可见。 */
  get pendingQrLoginSession(): PendingQrLogin | null {
    return this.pendingQrLogin
  }

  async createQrLoginSession(): Promise<QrLoginPresentation> {
    await this.initialize()
    // 同一时间只允许一个 pending 会话；新建前 best-effort 取消旧会话。
    await this.cancelPendingQrLogin()
    const details = await this.deviceDetails()
    const data = await this.publicRequest<QrLoginSessionCreated>('/app/auth/qr-login/sessions', {
      method: 'POST',
      data: {
        deviceKey: details.deviceKey,
        deviceName: details.deviceName,
        platform: details.platform,
        appVersion: details.appVersion,
      },
    })
    this.pendingQrLogin = {
      sessionId: data.qrLoginSessionId,
      desktopExchangeToken: data.desktopExchangeToken,
      expiresAt: data.expiresAt,
      inFlight: false,
    }
    // origin 用主进程真实 SaaS 源（与手机 App 配置的环境一致）；由主进程统一组装，
    // renderer 不再自行拼接，避免未登录时拿到占位符或空 origin 生成必然失效的二维码。
    const qrPayload = JSON.stringify({
      version: 1,
      type: 'qr-login',
      origin: new URL(this.baseUrl).origin,
      qrLoginSessionId: data.qrLoginSessionId,
      qrScanToken: data.qrScanToken,
    })
    // renderer 只拿到二维码载荷与展示信息，绝不包含桌面交换凭证。
    return {
      qrLoginSessionId: data.qrLoginSessionId,
      qrScanToken: data.qrScanToken,
      qrPayload,
      confirmationCode: data.confirmationCode,
      expiresAt: data.expiresAt,
      status: 'pending_scan',
    }
  }

  async getQrLoginStatus(sessionId?: string): Promise<QrLoginStatusPayload> {
    await this.initialize()
    const pending = this.requirePendingQrLogin(sessionId)
    const payload = await this.publicRequest<QrLoginStatusPayload>(`/app/auth/qr-login/sessions/${encodeURIComponent(pending.sessionId)}/status`, {
      method: 'POST',
      data: { desktopExchangeToken: pending.desktopExchangeToken },
    })
    if (!['pending_scan', 'scanned', 'confirmed'].includes(payload.status)) {
      // 终态：清空内存凭证。
      this.pendingQrLogin = null
    }
    return payload
  }

  async exchangeQrLoginSession(sessionId?: string): Promise<CloudAccountStatus> {
    await this.initialize()
    const pending = this.requirePendingQrLogin(sessionId)
    const data = await this.publicRequest<{ status: 'exchanged'; login: LoginOutcome }>(`/app/auth/qr-login/sessions/${encodeURIComponent(pending.sessionId)}/exchange`, {
      method: 'POST',
      data: { desktopExchangeToken: pending.desktopExchangeToken },
    })
    this.pendingQrLogin = null
    return this.completeLoginOutcome(data.login)
  }

  async cancelQrLoginSession(sessionId?: string): Promise<void> {
    await this.initialize()
    const target = sessionId ? (this.pendingQrLogin?.sessionId === sessionId ? this.pendingQrLogin : null) : this.pendingQrLogin
    this.pendingQrLogin = null
    if (!target) return
    await this.publicRequest(`/app/auth/qr-login/sessions/${encodeURIComponent(target.sessionId)}/cancel`, {
      method: 'POST',
      data: { desktopExchangeToken: target.desktopExchangeToken },
    }).catch(() => undefined)
  }

  private cancelPendingQrLogin(): Promise<void> {
    return this.cancelQrLoginSession()
  }

  /** renderer 传来的 session id 必须与主进程内存中的 pending 会话一致。 */
  private requirePendingQrLogin(sessionId?: string): PendingQrLogin {
    const pending = this.pendingQrLogin
    if (!pending) throw new Error('当前没有进行中的扫码登录会话。')
    if (sessionId !== undefined && sessionId !== pending.sessionId) {
      throw new Error('扫码登录会话不匹配。')
    }
    return pending
  }

  async getRuntimeConfig(): Promise<SaasRuntimeConfig> {
    await this.initialize()
    return this.request<SaasRuntimeConfig>('/app/runtime-config')
  }

  async reportAgentStatus(input: {
    state: 'idle' | 'running' | 'error'
    sessionId?: string
    runId?: string
    taskTitle?: string
    activeSince?: string
    sessions?: Array<AgentSession & Pick<AgentSessionSnapshot, 'messages' | 'activeRun' | 'lastEventSeq'>>
  }): Promise<boolean> {
    await this.initialize()
    if (!this.account || !this.accessToken) return false
    await this.request('/app/agent/status', { method: 'PUT', data: {
      ...input,
      // SaaS 侧 schema 尚未跟上 agent-contract 的多 Agent 字段，strict 校验会把
      // 整包 422 拒掉（心跳持续失败）；上行前剥掉。
      ...(input.sessions ? { sessions: input.sessions.map(saasCompatibleSession) } : {}),
    } })
    return true
  }

  async notificationPreferences(): Promise<NotificationPreferences> {
    await this.initialize()
    return this.request('/app/notifications/preferences')
  }

  /** 在线租约续期（SessionLeaseKeeper 每 30 秒调用）。未登录时静默跳过。 */
  async renewSessionLease(): Promise<boolean> {
    await this.initialize()
    if (!this.account || !this.accessToken) return false
    await this.request('/app/session/lease', { method: 'PUT' })
    return true
  }

  async updateNotificationPreferences(input: Partial<NotificationPreferences>): Promise<NotificationPreferences> {
    await this.initialize()
    return this.request('/app/notifications/preferences', { method: 'PUT', data: input })
  }

  async registerPushToken(provider: 'fcm' | 'apns', token: string): Promise<void> {
    await this.initialize()
    await this.request('/app/notifications/device', { method: 'PUT', data: { provider, token } })
  }

  async removePushToken(provider: 'fcm' | 'apns'): Promise<void> {
    await this.initialize()
    if (!this.account || !this.accessToken) return
    await this.request('/app/notifications/device', { method: 'DELETE', data: { provider } })
  }

  async createAgentNotification(input: AgentNotificationRequest): Promise<AgentNotificationResult> {
    await this.initialize()
    return this.request('/app/notifications/agent', { method: 'PUT', data: input })
  }

  async listCloudAgentSessions(deviceId: string): Promise<CloudAgentSessionSummary[]> {
    await this.initialize()
    return this.request(`/app/agent/devices/${encodeURIComponent(deviceId)}/sessions?limit=200&offset=0`)
  }

  async listCloudAgentSessionMessages(deviceId: string, sessionId: string, before?: string): Promise<CloudAgentMessagePage> {
    await this.initialize()
    const query = new URLSearchParams({ limit: '500' })
    if (before) query.set('before', before)
    return this.request(`/app/agent/devices/${encodeURIComponent(deviceId)}/sessions/${encodeURIComponent(sessionId)}/messages?${query.toString()}`)
  }

  async agentStreamCredentials(): Promise<AgentStreamCredentials | null> {
    await this.initialize()
    if (!this.account || !this.accessToken) return null
    const url = new URL(this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = `${url.pathname.replace(/\/$/, '')}/app/agent/stream`
    return { url: url.toString(), accessToken: this.accessToken, deviceId: this.account.device.id }
  }

  async login(identifier: string, password: string): Promise<CloudAccountStatus> {
    await this.initialize()
    if (!identifier.trim() || !password) throw new Error('请输入账号和密码。')
    const data = await this.publicRequest<LoginOutcome>('/app/auth/password-login', {
      method: 'POST',
      data: {
        identifier: identifier.trim(),
        password,
        ...(await this.deviceDetails()),
      },
    })
    return this.completeLoginOutcome(data)
  }

  /** 登录结果归一：额度未满直接接受会话；已满保留挑战交给设备准入 UI。 */
  private async completeLoginOutcome(outcome: LoginOutcome): Promise<CloudAccountStatus> {
    if (isAdmissionRequired(outcome)) {
      this.pendingAdmission = outcome
      return this.currentStatus()
    }
    this.pendingAdmission = null
    await this.acceptSession(outcome)
    await this.loadSubscription()
    return this.currentStatus()
  }

  async validateInvitationCode(invitationCode: string): Promise<{ valid: true }> {
    await this.initialize()
    return this.publicRequest('/app/auth/invitation-code/validate', { method: 'POST', data: { invitationCode } })
  }

  async loginWithOidc(provider: CloudOidcProvider, invitationCode?: string): Promise<CloudAccountStatus> {
    await this.initialize()
    this.cancelOidcLogin('新的登录请求已开始。')

    const state = randomBase64Url()
    const nonce = randomBase64Url()
    const codeVerifier = randomBase64Url(64)
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
    const redirectUri = await this.resolveOidcRedirectUri()
    const authorizationUrl = new URL(`${this.logtoIssuer}/auth`)
    authorizationUrl.searchParams.set('client_id', this.logtoAppId)
    authorizationUrl.searchParams.set('redirect_uri', redirectUri)
    authorizationUrl.searchParams.set('response_type', 'code')
    authorizationUrl.searchParams.set('scope', 'openid email name')
    authorizationUrl.searchParams.set('code_challenge', codeChallenge)
    authorizationUrl.searchParams.set('code_challenge_method', 'S256')
    authorizationUrl.searchParams.set('state', state)
    authorizationUrl.searchParams.set('nonce', nonce)
    authorizationUrl.searchParams.set('prompt', 'login')
    authorizationUrl.searchParams.set('direct_sign_in', `social:${this.connectorIds[provider]}`)

    const result = new Promise<CloudAccountStatus>((resolveLogin, rejectLogin) => {
      const timeout = setTimeout(() => {
        if (this.pendingOidcLogin?.state !== state) return
        this.pendingOidcLogin = null
        this.stopLoopbackServer()
        rejectLogin(new Error('浏览器登录等待超时，请重试。'))
      }, OIDC_LOGIN_TIMEOUT_MS)
      this.pendingOidcLogin = {
        state,
        nonce,
        codeVerifier,
        redirectUri,
        ...(invitationCode ? { invitationCode } : {}),
        resolve: resolveLogin,
        reject: rejectLogin,
        timeout,
      }
    })

    // 只有回环回调才需要提前起 HTTP 监听;everroom:// 沿用系统协议跳转。
    if (redirectUri === OIDC_LOOPBACK_REDIRECT_URI) {
      try {
        await this.listenOidcLoopback()
      } catch (error) {
        this.cancelOidcLogin('无法启动本地回调监听。')
        throw error
      }
    }

    try {
      await this.openExternal(authorizationUrl.toString())
    } catch (error) {
      this.cancelOidcLogin('无法打开系统浏览器。')
      throw error
    }
    return result
  }

  /**
   * Logto 后台注册了固定端口回环 redirect_uri 才走 HTTP 回调(每次登录探测一次并缓存),
   * 否则回退到 everroom:// 自定义协议,保证未配置时登录流程不被破坏。
   */
  private async resolveOidcRedirectUri(): Promise<string> {
    if (this.loopbackRedirectSupported !== null) {
      return this.loopbackRedirectSupported ? OIDC_LOOPBACK_REDIRECT_URI : OIDC_CALLBACK_URL
    }
    try {
      const probe = await http.get(`${this.logtoIssuer}/auth`, {
        params: {
          client_id: this.logtoAppId,
          redirect_uri: OIDC_LOOPBACK_REDIRECT_URI,
          response_type: 'code',
          scope: 'openid email name',
          code_challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          code_challenge_method: 'S256',
          state: 'probe',
          nonce: 'probe',
        },
        validateStatus: () => true,
        maxRedirects: 0,
      })
      this.loopbackRedirectSupported = probe.status !== 400
    } catch {
      this.loopbackRedirectSupported = false
    }
    return this.loopbackRedirectSupported ? OIDC_LOOPBACK_REDIRECT_URI : OIDC_CALLBACK_URL
  }

  private async listenOidcLoopback(): Promise<void> {
    this.stopLoopbackServer()
    const server = await startLoopbackCallbackServer({
      accept: (callback) => this.handleOidcCallback(callback.toString()),
      finish: () => this.stopLoopbackServer(),
    })
    this.loopbackServer = server
  }

  private stopLoopbackServer(): void {
    const server = this.loopbackServer
    this.loopbackServer = null
    if (!server) return
    // 浏览器(Node 19+ 与 Chrome 同)默认 keep-alive,close 只停监听不断空闲连接,
    // closeIdleConnections 保证端口在登录结束后立即可复用。
    server.close(() => undefined)
    server.closeIdleConnections()
  }

  handleOidcCallback(rawUrl: string): boolean {
    let callback: URL
    try {
      callback = new URL(rawUrl)
    } catch {
      return false
    }
    const isLoopback = callback.protocol === 'http:' && callback.hostname === OIDC_LOOPBACK_HOST
    if (
      !isLoopback && (
        callback.protocol !== 'everroom:' || callback.hostname !== 'auth' || callback.pathname !== '/callback'
      )
    ) return false

    const pending = this.pendingOidcLogin
    if (!pending) return true
    if (callback.searchParams.get('state') !== pending.state) {
      this.rejectOidcLogin(pending, new Error('登录状态校验失败，请重新登录。'))
      return true
    }

    const oidcError = callback.searchParams.get('error')
    if (oidcError) {
      const description = callback.searchParams.get('error_description')
      const rejectedScope = callback.searchParams.get('scope')
      const message = description || `Logto 登录失败（${oidcError}）。`
      this.rejectOidcLogin(
        pending,
        new Error(rejectedScope ? `${message}（被拒绝的 scope: ${rejectedScope}）` : message),
      )
      return true
    }

    const code = callback.searchParams.get('code')
    if (!code) {
      this.rejectOidcLogin(pending, new Error('Logto 登录回调缺少授权码。'))
      return true
    }

    this.stopLoopbackServer()
    void this.completeOidcLogin(code, pending)
    return true
  }

  cancelOidcLogin(message = '登录已取消。'): void {
    const pending = this.pendingOidcLogin
    if (pending) this.rejectOidcLogin(pending, new Error(message))
  }

  async logout(): Promise<CloudAccountStatus> {
    await this.initialize()
    this.cancelOidcLogin()
    this.stopLoopbackServer()
    await this.cancelPendingQrLogin()
    this.pendingAdmission = null
    const refreshToken = await this.credentials.getPlainText(REFRESH_TOKEN_KEY)
    if (refreshToken) {
      await this.publicRequest('/app/auth/logout', {
        method: 'POST',
        data: { refreshToken },
      }).catch(() => undefined)
    }
    this.accessToken = null
    this.account = null
    this.subscription = null
    this.subscriptionLoadedAt = 0
    this.subscriptionRetryAfter = 0
    this.subscriptionPromise = null
    await this.credentials.delete(REFRESH_TOKEN_KEY)
    await this.credentials.delete(ACCOUNT_PROFILE_KEY)
    return this.currentStatus()
  }

  async createAsrJob(input: CreateAsrJobInput): Promise<AsrJob> {
    this.requireLogin()
    const filePath = this.resolveRecording(input.filePath)
    const info = await stat(filePath)
    if (!info.isFile() || info.size === 0) throw new Error('录音文件不存在或为空。')

    const contentHash = await this.hashFile(filePath)
    const recordingId = input.recordingId ?? randomUUID()
    const job = await this.request<CloudJob>('/app/asr-jobs', {
      method: 'POST',
      data: {
        deviceId: this.account!.device.id,
        recordingId,
        originPlatform: 'desktop',
        fileName: basename(filePath),
        mimeType: this.mimeType(filePath),
        fileSize: info.size,
        contentHash,
        estimatedDurationMs: Math.max(1000, input.durationMs ?? 1000),
        idempotencyKey: `recording:${recordingId}:asr:${input.retryToken ?? 'v1'}`,
        languageHints: input.languageHints ?? [],
        diarizationEnabled: input.diarizationEnabled,
        ...(input.contextPrompt ? { contextPrompt: input.contextPrompt } : {}),
      },
    })

    if (job.status === 'awaiting_upload') {
      const authorization = await this.request<UploadAuthorization>(
        `/app/asr-jobs/${this.requireCloudJobId(job.id)}/upload-authorization`,
        { method: 'POST' },
      )
      await this.upload(filePath, authorization)
      const queued = await this.request<CloudJob>(
        `/app/asr-jobs/${this.requireCloudJobId(job.id)}/upload-complete`,
        { method: 'POST', data: { objectKey: authorization.objectKey } },
      )
      return this.normalizeJob(queued)
    }
    return this.normalizeJob(job)
  }

  async getAsrJob(prefixedId: string): Promise<AsrJob> {
    const id = this.cloudId(prefixedId)
    const job = await this.request<CloudJob>(`/app/asr-jobs/${id}`)
    if (job.status === 'completed') {
      const result = await this.request<{
        rawTranscript: string
        segments: CloudJob['segments']
        insights?: AsrResult['insights']
      }>(
        `/app/asr-jobs/${id}/result`,
      )
      job.transcript = result.rawTranscript
      job.segments = result.segments
      job.insights = result.insights
    }
    return this.normalizeJob(job)
  }

  async registerKeyAgreement(publicKey: string): Promise<void> {
    await this.request('/app/keyring/device', {
      method: 'PUT',
      data: { algorithm: 'X25519', publicKey },
    })
  }

  async getKeyring(): Promise<KeyringResponse> {
    return this.request<KeyringResponse>('/app/keyring')
  }

  async bootstrapKeyring(input: {
    umkId: string
    umkVersion: number
    packageAlgorithm: 'X25519-HKDF-SHA256-AES-256-GCM'
    ephemeralPublicKey: string
    salt: string
    ciphertext: string
  }): Promise<void> {
    await this.request('/app/keyring/bootstrap', { method: 'POST', data: input })
  }

  async putDeviceKeyPackage(targetDeviceId: string, input: {
    umkId: string
    umkVersion: number
    packageAlgorithm: 'X25519-HKDF-SHA256-AES-256-GCM'
    ephemeralPublicKey: string
    salt: string
    ciphertext: string
  }): Promise<void> {
    await this.request(`/app/keyring/devices/${encodeURIComponent(targetDeviceId)}/package`, {
      method: 'PUT',
      data: input,
    })
  }

  async createPairingSession(): Promise<PairingSessionResponse> {
    const result = await this.request<PairingSessionResponse>('/app/keyring/pairing-sessions', { method: 'POST' })
    return { ...result, origin: new URL(this.baseUrl).origin }
  }

  async getPairingSession(id: string): Promise<PairingSessionResponse> {
    return this.request<PairingSessionResponse>(`/app/keyring/pairing-sessions/${encodeURIComponent(id)}`)
  }

  async approvePairingSession(id: string): Promise<PairingSessionResponse> {
    return this.request<PairingSessionResponse>(`/app/keyring/pairing-sessions/${encodeURIComponent(id)}/approve`, { method: 'POST' })
  }

  async packagePairingSession(id: string, input: {
    umkId: string
    umkVersion: number
    packageAlgorithm: 'X25519-HKDF-SHA256-AES-256-GCM'
    ephemeralPublicKey: string
    salt: string
    ciphertext: string
  }): Promise<PairingSessionResponse> {
    return this.request<PairingSessionResponse>(`/app/keyring/pairing-sessions/${encodeURIComponent(id)}/package`, { method: 'PUT', data: input })
  }

  async listPrivateRecords(cursor: number): Promise<{ records: PrivateRecordEnvelope[]; nextCursor: number }> {
    const result = await this.requestWithMeta<PrivateRecordEnvelope[]>(`/app/private-records?cursor=${Math.max(0, Math.floor(cursor))}`)
    return {
      records: result.data,
      nextCursor: typeof result.meta?.nextCursor === 'number' ? result.meta.nextCursor : cursor,
    }
  }

  async getPrivateRecord(recordId: string): Promise<PrivateRecordEnvelope> {
    return this.request(`/app/private-records/${encodeURIComponent(recordId)}`)
  }

  listSummaryTags(): Promise<RealityTag[]> {
    return this.request('/app/summary-tags')
  }

  async replaceSummaryTags(summaryRecordId: string, tags: RealityTag[]): Promise<void> {
    await this.request(`/app/summaries/${encodeURIComponent(summaryRecordId)}/tags`, {
      method: 'PUT',
      data: {
        tags: tags.map((tag) => ({
          ...(tag.id ? { id: tag.id } : {}),
          kind: tag.kind,
          label: tag.label,
          ...(tag.entityType ? { entityType: tag.entityType } : {}),
          ...(tag.subject ? { subject: tag.subject } : {}),
          ...(tag.predicate ? { predicate: tag.predicate } : {}),
          ...(tag.object ? { object: tag.object } : {}),
          ...(tag.confidence !== undefined ? { confidence: tag.confidence } : {}),
          ...(tag.evidence !== undefined ? { evidence: tag.evidence } : {}),
        })),
      },
    })
  }

  async renameSummaryTag(tagId: string, label: string): Promise<void> {
    await this.request(`/app/summary-tags/${encodeURIComponent(tagId)}`, { method: 'PUT', data: { label } })
  }

  async mergeSummaryTag(targetTagId: string, sourceTagId: string): Promise<void> {
    await this.request(`/app/summary-tags/${encodeURIComponent(targetTagId)}/merge`, { method: 'POST', data: { sourceTagId } })
  }

  async putPrivateRecord(recordId: string, input: PutPrivateRecordInput): Promise<PrivateRecordEnvelope> {
    return this.request(`/app/private-records/${encodeURIComponent(recordId)}`, {
      method: 'PUT',
      data: input,
    })
  }

  async createPrivateAudio(input: Omit<PrivateAudioAsset, 'id'|'status'|'revision'|'createdAt'|'updatedAt'|'objectKey'>): Promise<PrivateAudioAsset> {
    return this.request('/app/private-audio', { method: 'POST', data: input })
  }
  async authorizePrivateAudioUpload(id: string): Promise<PrivateAudioAsset & { uploadUrl: string; headers: Record<string,string>; expiresAt: string }> {
    return this.request(`/app/private-audio/${encodeURIComponent(id)}/upload-authorization`, { method: 'POST' })
  }
  async completePrivateAudioUpload(id: string): Promise<PrivateAudioAsset> {
    return this.request(`/app/private-audio/${encodeURIComponent(id)}/upload-complete`, { method: 'POST' })
  }
  async listPrivateAudio(cursor: number): Promise<{ assets: PrivateAudioAsset[]; nextCursor: number }> {
    const result = await this.requestWithMeta<PrivateAudioAsset[]>(`/app/private-audio?cursor=${Math.max(0, Math.floor(cursor))}`)
    return { assets: result.data, nextCursor: typeof result.meta?.nextCursor === 'number' ? result.meta.nextCursor : cursor }
  }
  async authorizePrivateAudioDownload(id: string): Promise<{ assetId: string; downloadUrl: string; expiresAt: string }> {
    return this.request(`/app/private-audio/${encodeURIComponent(id)}/download-authorization`, { method: 'POST' })
  }
  async deletePrivateAudio(id: string): Promise<void> {
    await this.request(`/app/private-audio/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }
  async authorizePrivateAudioChunk(id: string, index: number, input: { fileSize: number; contentHash: string }): Promise<{ uploadUrl: string; headers: Record<string,string>; expiresAt: string; objectKey: string }> { return this.request(`/app/private-audio/${encodeURIComponent(id)}/chunks/${index}/upload-authorization`, { method: 'POST', data: { chunkIndex: index, ...input } }) }
  async completePrivateAudioChunk(id: string, index: number): Promise<void> { await this.request(`/app/private-audio/${encodeURIComponent(id)}/chunks/${index}/upload-complete`, { method: 'POST' }) }
  async authorizePrivateAudioChunkDownload(id: string, index: number): Promise<{ downloadUrl: string; expiresAt: string }> { return this.request(`/app/private-audio/${encodeURIComponent(id)}/chunks/${index}/download-authorization`, { method: 'POST' }) }
  async completePrivateAudioChunks(id: string): Promise<PrivateAudioAsset> { return this.request(`/app/private-audio/${encodeURIComponent(id)}/chunks-complete`, { method: 'POST' }) }

  async registerProcessorDevice(): Promise<void> {
    await this.request('/app/processing/device', {
      method: 'PUT',
      data: { capabilities: ['transcription.summary.v1'], maxConcurrency: 1 },
    })
  }

  async claimProcessingJob(): Promise<{ job: ProcessingJob; leaseToken: string } | null> {
    return this.request('/app/processing/jobs/claim', { method: 'POST', data: {} })
  }

  async startProcessingJob(jobId: string, leaseToken: string): Promise<ProcessingJob> {
    return this.request(`/app/processing/jobs/${encodeURIComponent(jobId)}/start`, {
      method: 'POST',
      data: { leaseToken },
    })
  }

  async renewProcessingJob(jobId: string, leaseToken: string): Promise<ProcessingJob> {
    return this.request(`/app/processing/jobs/${encodeURIComponent(jobId)}/renew`, {
      method: 'POST',
      data: { leaseToken },
    })
  }

  async completeProcessingJob(jobId: string, input: CompleteProcessingJobInput): Promise<void> {
    await this.request(`/app/processing/jobs/${encodeURIComponent(jobId)}/complete`, {
      method: 'POST',
      data: input,
    })
  }

  async failProcessingJob(jobId: string, input: {
    leaseToken: string
    errorCode: string
    errorClass: 'retryable' | 'permanent' | 'user_action'
  }): Promise<void> {
    await this.request(`/app/processing/jobs/${encodeURIComponent(jobId)}/fail`, {
      method: 'POST',
      data: input,
    })
  }

  async reprocessTranscriptionSummary(input: {
    sourceRecordId: string
    sourceRevision: number
    sourceContentHash: string
    reason: 'invalid_summary'
  }): Promise<void> {
    await this.request('/app/processing/jobs/reprocess', { method: 'POST', data: input })
  }

  async acknowledgeSync(cursor: number): Promise<void> {
    await this.request('/app/sync/ack', {
      method: 'POST',
      data: { deviceId: this.account!.device.id, cursor: Math.max(0, Math.floor(cursor)) },
    })
  }

  private async restoreSession(): Promise<void> {
    const refreshToken = await this.credentials.getPlainText(REFRESH_TOKEN_KEY)
    if (!refreshToken) return
    try {
      await this.refresh(refreshToken)
      await this.loadSubscription()
    } catch (error) {
      if (error instanceof SaasRequestError && (error.status === 401 || error.status === 403)) {
        await this.credentials.delete(REFRESH_TOKEN_KEY)
      } else {
        console.warn('Unable to restore EverRoom SaaS session; keeping the refresh token for retry.')
      }
    }
  }

  private async completeOidcLogin(code: string, pending: PendingOidcLogin): Promise<void> {
    try {
      const tokenResponse = await http.post<LogtoTokenResponse>(`${this.logtoIssuer}/token`, new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.logtoAppId,
        code,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.codeVerifier,
      }), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: () => true,
      })
      const token = tokenResponse.data
      if (tokenResponse.status >= 400 || !token?.id_token) {
        throw new Error(token?.error_description || token?.error || 'Logto 未返回 ID Token。')
      }
      if (this.pendingOidcLogin !== pending) return
      const claims = this.validateIdToken(token.id_token, pending.nonce)
      const data = await this.publicRequest<LoginOutcome>('/app/auth/oidc/logto', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.id_token}` },
        data: { ...(await this.deviceDetails()), ...(pending.invitationCode ? { invitationCode: pending.invitationCode } : {}) },
      })
      if (this.pendingOidcLogin !== pending) return
      let status: CloudAccountStatus
      if (isAdmissionRequired(data)) {
        // 设备额度已满：不建立会话，保留挑战给设备准入 UI 处理。
        this.pendingAdmission = data
        status = this.currentStatus()
      } else {
        if (claims.email_verified === true && typeof claims.email === 'string') {
          data.user.email = claims.email
        }
        if (typeof claims.name === 'string' && claims.name.trim()) data.user.name = claims.name.trim()
        this.pendingAdmission = null
        await this.acceptSession(data)
        await this.loadSubscription()
        status = this.currentStatus()
      }
      this.resolveOidcLogin(pending, status)
    } catch (error) {
      this.rejectOidcLogin(
        pending,
        error instanceof Error ? error : new Error('OIDC 登录失败。'),
      )
    }
  }

  private validateIdToken(idToken: string, nonce: string): Record<string, unknown> {
    const claims = decodeJwtPayload(idToken)
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (claims.iss !== this.logtoIssuer || !audiences.includes(this.logtoAppId)) {
      throw new Error('Logto ID Token 的签发方或应用不匹配。')
    }
    if (claims.nonce !== nonce) throw new Error('Logto ID Token 的 nonce 校验失败。')
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) {
      throw new Error('Logto ID Token 已过期。')
    }
    return claims
  }

  private resolveOidcLogin(pending: PendingOidcLogin, status: CloudAccountStatus): void {
    if (this.pendingOidcLogin !== pending) return
    clearTimeout(pending.timeout)
    this.pendingOidcLogin = null
    this.stopLoopbackServer()
    pending.resolve(status)
  }

  private rejectOidcLogin(pending: PendingOidcLogin, error: Error): void {
    if (this.pendingOidcLogin !== pending) return
    clearTimeout(pending.timeout)
    this.pendingOidcLogin = null
    this.stopLoopbackServer()
    pending.reject(error)
  }

  private currentStatus(): CloudAccountStatus {
    return {
      authenticated: Boolean(this.accessToken && this.account),
      apiBaseUrl: this.baseUrl,
      ...(this.account ? { user: this.account.user, device: this.account.device } : {}),
      ...(this.subscription ? { subscription: this.subscription } : {}),
      ...(this.account?.registration ? { registration: this.account.registration } : {}),
      ...(this.pendingAdmission ? { admission: { ...this.pendingAdmission } } : {}),
    }
  }

  private async upload(
    filePath: string,
    authorization: UploadAuthorization,
  ): Promise<void> {
    const response = await http.put(authorization.uploadUrl, createReadStream(filePath), {
      headers: { ...authorization.headers },
      timeout: UPLOAD_TIMEOUT_MS,
      maxBodyLength: Number.POSITIVE_INFINITY,
      validateStatus: () => true,
    })
    if (response.status >= 400) throw new Error(`OSS 上传失败（${response.status}）`)
  }

  private async refresh(refreshToken: string): Promise<void> {
    const data = await this.publicRequest<LoginOutcome>('/app/auth/refresh', {
      method: 'POST',
      data: { refreshToken },
    })
    if (isAdmissionRequired(data)) {
      // 额度被其他设备占满：保留挑战并判定会话失效，由上层进入设备准入 UI。
      this.pendingAdmission = data
      throw new SaasRequestError('设备额度已被其他在线设备占满。', 409)
    }
    this.pendingAdmission = null
    await this.acceptSession(data)
  }

  private async acceptSession(data: LoginResult): Promise<void> {
    const storedProfile = await this.credentials.getPlainText(ACCOUNT_PROFILE_KEY)
    if (storedProfile) {
      try {
        const profile = JSON.parse(storedProfile) as StoredAccountProfile
        if (profile.userId === data.user.id) {
          const { userId: _, ...userProfile } = profile
          data.user = { ...userProfile, ...data.user }
        }
      } catch {
        // Invalid local profile data is replaced below.
      }
    }
    this.accessToken = data.accessToken
    this.account = data
    this.subscription = null
    this.subscriptionLoadedAt = 0
    this.subscriptionRetryAfter = 0
    this.subscriptionPromise = null
    await this.credentials.setPlainText(REFRESH_TOKEN_KEY, data.refreshToken)
    await this.credentials.setPlainText(ACCOUNT_PROFILE_KEY, JSON.stringify({
      userId: data.user.id,
      email: data.user.email,
      phone: data.user.phone,
      name: data.user.name,
    } satisfies StoredAccountProfile))
  }

  private async loadSubscription(force = false): Promise<void> {
    if (!force && this.subscription && Date.now() - this.subscriptionLoadedAt < SUBSCRIPTION_CACHE_TTL_MS) return
    if (!force && Date.now() < this.subscriptionRetryAfter) return
    if (this.subscriptionPromise) return this.subscriptionPromise
    this.subscriptionPromise = (async () => {
      try {
        const subscription = await this.request<CloudSubscription>('/app/subscription')
        const quotaSeconds = Math.max(0, subscription.entitlements?.asrSecondsPerPeriod ?? 0)
        const usedSeconds = Math.max(0, subscription.usedSeconds)
        this.subscription = {
          status: subscription.status,
          planCode: subscription.planCode,
          planName: subscription.planName,
          periodStart: subscription.periodStart,
          periodEnd: subscription.periodEnd,
          quotaSeconds,
          usedSeconds,
          remainingSeconds: Math.max(0, quotaSeconds - usedSeconds),
        }
        this.subscriptionLoadedAt = Date.now()
        this.subscriptionRetryAfter = 0
      } catch (error) {
        this.subscriptionRetryAfter = Date.now() + SUBSCRIPTION_RETRY_DELAY_MS
        throw error
      }
    })().finally(() => { this.subscriptionPromise = null })
    return this.subscriptionPromise
  }

  private async deviceDetails(): Promise<{
    deviceKey: string
    deviceName: string
    platform: 'macOS' | 'Windows'
    appVersion: string
  }> {
    return {
      deviceKey: await this.deviceKey(),
      deviceName: hostname() || 'EverRoom Desktop',
      platform: process.platform === 'win32' ? 'Windows' : 'macOS',
      appVersion: this.electronApp.getVersion(),
    }
  }

  private async deviceKey(): Promise<string> {
    // 设备标识锚定到硬件（macOS: IOPlatformUUID / Windows: MachineGuid）：
    // 重装应用、清空应用数据后仍是同一台设备，避免同一台机器在服务端裂变
    // 成多行设备记录。凭据存储里的旧随机 key 会被硬件锚定值取代（下一次
    // 登录 UPSERT 到新 key，旧设备行由服务端清理任务归档）。
    const stable = hardwareDeviceKey()
    if (stable) {
      const existing = await this.credentials.getPlainText(DEVICE_KEY_KEY)
      if (existing !== stable) await this.credentials.setPlainText(DEVICE_KEY_KEY, stable)
      return stable
    }
    // 兜底：读不到硬件标识（异常系统）时退回随机 key，前缀跟随当前平台。
    const prefix = process.platform === 'win32' ? 'win-' : 'mac-'
    const existing = await this.credentials.getPlainText(DEVICE_KEY_KEY)
    if (existing && existing.startsWith(prefix)) return existing
    const value = `${prefix}${randomUUID()}`
    await this.credentials.setPlainText(DEVICE_KEY_KEY, value)
    return value
  }

  private async request<T>(path: string, config: AxiosRequestConfig = {}): Promise<T> {
    this.requireLogin()
    let response = await this.send(path, config, this.accessToken!)
    if (response.status === 401) {
      const refreshToken = await this.credentials.getPlainText(REFRESH_TOKEN_KEY)
      if (!refreshToken) throw new Error('登录已过期，请重新登录。')
      await this.refresh(refreshToken)
      response = await this.send(path, config, this.accessToken!)
    }
    return this.unwrap<T>(response)
  }

  private async requestWithMeta<T>(path: string, config: AxiosRequestConfig = {}): Promise<{ data: T; meta?: { nextCursor?: number } }> {
    this.requireLogin()
    let response = await this.send(path, config, this.accessToken!)
    if (response.status === 401) {
      const refreshToken = await this.credentials.getPlainText(REFRESH_TOKEN_KEY)
      if (!refreshToken) throw new Error('登录已过期，请重新登录。')
      await this.refresh(refreshToken)
      response = await this.send(path, config, this.accessToken!)
    }
    const body = response.data as { data?: T; meta?: { nextCursor?: number } } | null
    if (response.status >= 400) {
      throw new SaasRequestError(saasErrorMessage(response), response.status)
    }
    if (!body || typeof body !== 'object' || !('data' in body)) throw new Error('SaaS 返回了无效响应。')
    return { data: body.data as T, meta: body.meta }
  }

  private async publicRequest<T>(path: string, config: AxiosRequestConfig): Promise<T> {
    return this.unwrap<T>(await this.send(path, config))
  }

  private send(path: string, config: AxiosRequestConfig, token?: string): Promise<AxiosResponse> {
    return http.request({
      url: `${this.baseUrl}${path}`,
      ...config,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...config.headers,
      },
      validateStatus: () => true,
    })
  }

  private unwrap<T>(response: AxiosResponse): T {
    const body = response.data as { data?: T } | null
    if (response.status >= 400) {
      throw new SaasRequestError(saasErrorMessage(response), response.status)
    }
    if (!body || typeof body !== 'object' || !('data' in body)) {
      throw new Error('SaaS 返回了无效响应。')
    }
    return body.data as T
  }

  private requireLogin(): void {
    if (!this.accessToken || !this.account) {
      throw new Error('请先登录 EverRoom，或切换为本地自有配置。')
    }
  }

  private resolveRecording(fileName: string): string {
    const candidate = isAbsolute(fileName) ? fileName : join(this.recordingsDirectory, fileName)
    const resolved = resolve(candidate)
    const fromRoot = relative(resolve(this.recordingsDirectory), resolved)
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      throw new Error('录音文件不在允许的目录中。')
    }
    return resolved
  }

  private hashFile(filePath: string): Promise<string> {
    return new Promise((resolveHash, reject) => {
      const hash = createHash('sha256')
      const stream = createReadStream(filePath)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolveHash(hash.digest('hex')))
    })
  }

  private mimeType(filePath: string): string {
    const types: Record<string, string> = {
      '.m4a': 'audio/mp4',
      '.mp4': 'video/mp4',
      '.webm': 'audio/webm',
      '.ogg': 'audio/ogg',
      '.wav': 'audio/wav',
      '.mp3': 'audio/mpeg',
      '.flac': 'audio/flac',
      '.aac': 'audio/aac',
    }
    return types[extname(filePath).toLowerCase()] ?? 'audio/webm'
  }

  private cloudId(value: string): string {
    if (!value.startsWith('saas:')) throw new Error('无效的云端转写任务标识。')
    return this.requireCloudJobId(value.slice(5))
  }

  private requireCloudJobId(value: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      throw new Error('无效的云端转写任务标识。')
    }
    return encodeURIComponent(value)
  }

  private normalizeJob(job: CloudJob): AsrJob {
    const terminal = new Set(['completed', 'failed', 'cancelled'])
    return {
      id: `saas:${job.id}`,
      source: 'saas',
      provider: job.provider,
      status: job.status === 'completed'
        ? 'completed'
        : job.status === 'failed'
          ? 'failed'
          : job.status === 'cancelled' || job.status === 'expired'
            ? 'cancelled'
            : terminal.has(job.status)
              ? 'failed'
              : 'running',
      fileName: job.fileName,
      languageHints: [],
      diarizationEnabled: true,
      contextPrompt: '',
      result: job.status === 'completed' && job.transcript
        ? {
            transcript: job.transcript,
            segments: job.segments ?? [],
            ...(job.insights ? { insights: job.insights } : {}),
          }
        : null,
      error: job.errorMessage ?? job.errorCode ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    }
  }
}
