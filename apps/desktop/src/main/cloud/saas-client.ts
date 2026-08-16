import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'

import type { AxiosRequestConfig, AxiosResponse } from 'axios'
import type { App } from 'electron'

import type {
  AsrJob,
  AsrResult,
  CloudAccountStatus,
  CloudOidcProvider,
  CreateAsrJobInput,
} from '../../shared/sources'
import type { CredentialStore } from '../security/credential-store'
import { createLoggedHttpClient } from '../network/http-client'

const REFRESH_TOKEN_KEY = 'everroom:saas:refresh-token'
const DEVICE_KEY_KEY = 'everroom:saas:device-key'
const ACCOUNT_PROFILE_KEY = 'everroom:saas:account-profile'
const REQUEST_TIMEOUT_MS = 15_000
const UPLOAD_TIMEOUT_MS = 5 * 60_000
const OIDC_LOGIN_TIMEOUT_MS = 3 * 60_000
const http = createLoggedHttpClient('saas', { timeout: REQUEST_TIMEOUT_MS })

export const OIDC_CALLBACK_URL = 'everroom://auth/callback'

interface LoginResult {
  accessToken: string
  refreshToken: string
  user: { id: string; tenantId: string; email?: string | null; phone?: string | null; name?: string }
  device: { id: string; name?: string; platform?: string }
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
  resolve: (status: CloudAccountStatus) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

class SaasRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'SaasRequestError'
  }
}

function env(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback
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

export class SaasClient {
  private accessToken: string | null = null
  private account: LoginResult | null = null
  private subscription: CloudAccountStatus['subscription'] | null = null
  private initializePromise: Promise<void> | null = null
  private pendingOidcLogin: PendingOidcLogin | null = null

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
    this.baseUrl = env('NXCORE_SAAS_API_URL', 'http://127.0.0.1:4100/api/v1').replace(/\/+$/, '')
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

  async status(): Promise<CloudAccountStatus> {
    await this.initialize()
    if (this.account) await this.loadSubscription()
    return this.currentStatus()
  }

  async login(identifier: string, password: string): Promise<CloudAccountStatus> {
    await this.initialize()
    if (!identifier.trim() || !password) throw new Error('请输入账号和密码。')
    const data = await this.publicRequest<LoginResult>('/app/auth/password-login', {
      method: 'POST',
      data: {
        identifier: identifier.trim(),
        password,
        ...(await this.deviceDetails()),
      },
    })
    await this.acceptSession(data)
    await this.loadSubscription()
    return this.currentStatus()
  }

  async loginWithOidc(provider: CloudOidcProvider): Promise<CloudAccountStatus> {
    await this.initialize()
    this.cancelOidcLogin('新的登录请求已开始。')

    const state = randomBase64Url()
    const nonce = randomBase64Url()
    const codeVerifier = randomBase64Url(64)
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
    const authorizationUrl = new URL(`${this.logtoIssuer}/auth`)
    authorizationUrl.searchParams.set('client_id', this.logtoAppId)
    authorizationUrl.searchParams.set('redirect_uri', OIDC_CALLBACK_URL)
    authorizationUrl.searchParams.set('response_type', 'code')
    authorizationUrl.searchParams.set('scope', 'openid email name')
    authorizationUrl.searchParams.set('code_challenge', codeChallenge)
    authorizationUrl.searchParams.set('code_challenge_method', 'S256')
    authorizationUrl.searchParams.set('state', state)
    authorizationUrl.searchParams.set('nonce', nonce)
    authorizationUrl.searchParams.set('direct_sign_in', `social:${this.connectorIds[provider]}`)

    const result = new Promise<CloudAccountStatus>((resolveLogin, rejectLogin) => {
      const timeout = setTimeout(() => {
        if (this.pendingOidcLogin?.state !== state) return
        this.pendingOidcLogin = null
        rejectLogin(new Error('浏览器登录等待超时，请重试。'))
      }, OIDC_LOGIN_TIMEOUT_MS)
      this.pendingOidcLogin = {
        state,
        nonce,
        codeVerifier,
        resolve: resolveLogin,
        reject: rejectLogin,
        timeout,
      }
    })

    try {
      await this.openExternal(authorizationUrl.toString())
    } catch (error) {
      this.cancelOidcLogin('无法打开系统浏览器。')
      throw error
    }
    return result
  }

  handleOidcCallback(rawUrl: string): boolean {
    let callback: URL
    try {
      callback = new URL(rawUrl)
    } catch {
      return false
    }
    if (callback.protocol !== 'everroom:' || callback.hostname !== 'auth' || callback.pathname !== '/callback') {
      return false
    }

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
      await this.upload(filePath, info.size, authorization)
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
        redirect_uri: OIDC_CALLBACK_URL,
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
      const data = await this.publicRequest<LoginResult>('/app/auth/oidc/logto', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.id_token}` },
        data: await this.deviceDetails(),
      })
      if (this.pendingOidcLogin !== pending) return
      if (claims.email_verified === true && typeof claims.email === 'string') {
        data.user.email = claims.email
      }
      if (typeof claims.name === 'string' && claims.name.trim()) data.user.name = claims.name.trim()
      await this.acceptSession(data)
      await this.loadSubscription()
      this.resolveOidcLogin(pending, this.currentStatus())
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
    pending.resolve(status)
  }

  private rejectOidcLogin(pending: PendingOidcLogin, error: Error): void {
    if (this.pendingOidcLogin !== pending) return
    clearTimeout(pending.timeout)
    this.pendingOidcLogin = null
    pending.reject(error)
  }

  private currentStatus(): CloudAccountStatus {
    return {
      authenticated: Boolean(this.accessToken && this.account),
      apiBaseUrl: this.baseUrl,
      ...(this.account ? { user: this.account.user, device: this.account.device } : {}),
      ...(this.subscription ? { subscription: this.subscription } : {}),
    }
  }

  private async upload(
    filePath: string,
    size: number,
    authorization: UploadAuthorization,
  ): Promise<void> {
    const response = await http.put(authorization.uploadUrl, createReadStream(filePath), {
      headers: { ...authorization.headers, 'Content-Length': String(size) },
      timeout: UPLOAD_TIMEOUT_MS,
      maxBodyLength: Number.POSITIVE_INFINITY,
      validateStatus: () => true,
    })
    if (response.status >= 400) throw new Error(`OSS 上传失败（${response.status}）`)
  }

  private async refresh(refreshToken: string): Promise<void> {
    const data = await this.publicRequest<LoginResult>('/app/auth/refresh', {
      method: 'POST',
      data: { refreshToken },
    })
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
    await this.credentials.setPlainText(REFRESH_TOKEN_KEY, data.refreshToken)
    await this.credentials.setPlainText(ACCOUNT_PROFILE_KEY, JSON.stringify({
      userId: data.user.id,
      email: data.user.email,
      phone: data.user.phone,
      name: data.user.name,
    } satisfies StoredAccountProfile))
  }

  private async loadSubscription(): Promise<void> {
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
    const existing = await this.credentials.getPlainText(DEVICE_KEY_KEY)
    if (existing) return existing
    const value = randomUUID()
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
    const body = response.data as {
      data?: T
      detail?: string
      message?: string
    } | null
    if (response.status >= 400) {
      throw new SaasRequestError(
        body?.detail ?? body?.message ?? `SaaS 请求失败（${response.status}）`,
        response.status,
      )
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
