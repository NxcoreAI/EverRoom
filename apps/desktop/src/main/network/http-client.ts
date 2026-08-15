import { randomUUID } from 'node:crypto'

import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type CreateAxiosDefaults,
  type InternalAxiosRequestConfig,
} from 'axios'
import { logDesktop } from '../logging/desktop-logger'

interface RequestMetadata {
  requestId: string
  startedAt: number
  method: string
  url: string
  payload?: string
}

const metadata = new WeakMap<InternalAxiosRequestConfig, RequestMetadata>()
const SENSITIVE_QUERY_KEYS = /token|code|secret|signature|credential|password|key/i

function requestUrl(config: AxiosRequestConfig): string {
  const rawUrl = config.url ?? ''
  try {
    const url = new URL(rawUrl, config.baseURL)
    const queryKeys = [...new Set([...url.searchParams.keys()])]
    url.search = queryKeys.length > 0
      ? `?${queryKeys.map((key) => `${encodeURIComponent(key)}=<redacted>`).join('&')}`
      : ''
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return rawUrl.replace(/\?.*$/, '?<redacted>')
  }
}

function payloadSummary(data: unknown): string | undefined {
  if (data === undefined || data === null) return undefined
  if (typeof data === 'string') return `string:${Buffer.byteLength(data)}B`
  if (Buffer.isBuffer(data)) return `buffer:${data.byteLength}B`
  if (data instanceof URLSearchParams) {
    return `form:${[...new Set([...data.keys()])].join(',')}`
  }
  if (typeof data === 'object') {
    const value = data as Record<string, unknown>
    if (typeof value.pipe === 'function') return 'stream'
    const keys = Object.keys(value).map((key) => SENSITIVE_QUERY_KEYS.test(key) ? `${key}:redacted` : key)
    return `json:${keys.join(',')}`
  }
  return typeof data
}

function log(level: 'info' | 'warn' | 'error', event: Record<string, unknown>): void {
  logDesktop('axios', level, event)
}

function responseLog(
  level: 'info' | 'warn',
  client: string,
  response: AxiosResponse,
): void {
  const request = metadata.get(response.config)
  log(level, {
    event: 'http.response',
    client,
    requestId: request?.requestId,
    method: request?.method ?? response.config.method?.toUpperCase(),
    url: request?.url ?? requestUrl(response.config),
    status: response.status,
    durationMs: request ? Date.now() - request.startedAt : undefined,
  })
}

export function createLoggedHttpClient(
  client: string,
  defaults: CreateAxiosDefaults = {},
): AxiosInstance {
  const instance = axios.create(defaults)

  instance.interceptors.request.use((config) => {
    const request: RequestMetadata = {
      requestId: randomUUID(),
      startedAt: Date.now(),
      method: (config.method ?? 'GET').toUpperCase(),
      url: requestUrl(config),
      payload: payloadSummary(config.data),
    }
    metadata.set(config, request)
    log('info', {
      event: 'http.request',
      client,
      requestId: request.requestId,
      method: request.method,
      url: request.url,
      payload: request.payload,
    })
    return config
  })

  instance.interceptors.response.use(
    (response) => {
      responseLog(response.status >= 400 ? 'warn' : 'info', client, response)
      return response
    },
    (error: AxiosError) => {
      const request = error.config ? metadata.get(error.config) : undefined
      log('error', {
        event: 'http.error',
        client,
        requestId: request?.requestId,
        method: request?.method ?? error.config?.method?.toUpperCase(),
        url: request?.url ?? (error.config ? requestUrl(error.config) : undefined),
        status: error.response?.status,
        durationMs: request ? Date.now() - request.startedAt : undefined,
        code: error.code,
        message: error.message,
      })
      return Promise.reject(error)
    },
  )

  return instance
}
