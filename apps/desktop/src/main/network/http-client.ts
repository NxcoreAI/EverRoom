import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import axios, {
  AxiosError,
  type AxiosAdapter,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type CreateAxiosDefaults,
  type InternalAxiosRequestConfig,
} from 'axios'
import { app, net } from 'electron'
import { desktopLogThreshold, logDesktop } from '../logging/desktop-logger'

interface RequestMetadata {
  requestId: string
  startedAt: number
  method: string
  url: string
  payload?: string
}

const metadata = new WeakMap<InternalAxiosRequestConfig, RequestMetadata>()
const SENSITIVE_QUERY_KEYS = /token|code|secret|signature|credential|password|key/i

// Node http/https 不读系统代理（渲染进程走 Chromium 网络栈所以没这个问题）。
// 策略：回环地址（本地网关桥接）继续走 Node http——不需要代理，且对 FormData/
// 流式请求兼容性最好；外网请求统一走 Electron 的 net.fetch（Chromium 网络栈），
// 系统代理、PAC、证书校验、代理故障回退全部与浏览器行为一致，不自己造轮子。
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
const nodeHttpAdapter: AxiosAdapter = axios.getAdapter('http')

function targetOf(config: AxiosRequestConfig): URL | null {
  try {
    const url = new URL(config.url ?? '', config.baseURL)
    return /^https?:$/.test(url.protocol) ? url : null
  } catch {
    return null
  }
}

/** Node 流式 body → fetch body。net.fetch 不收 Node Readable，且 OSS 直传需要
 *  确定的 Content-Length（分块上传签名会挂），这里整体读入内存（录音文件量级可接受）。 */
async function toFetchBody(data: unknown): Promise<BodyInit | undefined> {
  if (data === undefined || data === null) return undefined
  if (data instanceof Readable) {
    const chunks: Buffer[] = []
    for await (const chunk of data) chunks.push(Buffer.from(chunk as Buffer))
    return Buffer.concat(chunks)
  }
  // string / URLSearchParams / Blob / FormData / ArrayBuffer / TypedArray 均为合法 BodyInit。
  return data as BodyInit
}

function requestSignal(config: InternalAxiosRequestConfig): AbortSignal | undefined {
  const signals: AbortSignal[] = []
  if (config.timeout && config.timeout > 0) signals.push(AbortSignal.timeout(config.timeout))
  if (config.signal) signals.push(config.signal as AbortSignal)
  if (signals.length === 0) return undefined
  return signals.length === 1 ? signals[0]! : AbortSignal.any(signals)
}

function appendParams(url: URL, params: unknown): void {
  if (!params) return
  if (params instanceof URLSearchParams) {
    for (const [key, value] of params) url.searchParams.append(key, value)
    return
  }
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value === null || value === undefined) continue
    url.searchParams.append(key, Array.isArray(value) ? value.join(',') : String(value))
  }
}

const chromiumFetchAdapter: AxiosAdapter = async (config) => {
  // net.fetch 需要 app ready；ready 后 whenReady() 立即返回，正常请求无感。
  if (!app.isReady()) await app.whenReady()
  const target = new URL(config.url ?? '', config.baseURL)
  appendParams(target, config.params)

  // 适配器收到时 headers 已是 AxiosHeaders 实例：头名即自有可枚举键
  // （axios 1.19 的实例上没有 forEach，遍历自有键即可）。
  const headers = new Headers()
  for (const [key, value] of Object.entries(config.headers ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, String(item))
      continue
    }
    headers.set(key, String(value))
  }

  const response = await net.fetch(target.toString(), {
    method: (config.method ?? 'get').toUpperCase(),
    headers,
    body: config.data === undefined ? undefined : await toFetchBody(config.data),
    signal: requestSignal(config),
    redirect: 'follow',
  })

  const responseType = config.responseType ?? 'json'
  let data: unknown
  if (responseType === 'arraybuffer') data = Buffer.from(await response.arrayBuffer())
  else if (responseType === 'blob') data = await response.blob()
  else if (responseType === 'text') data = await response.text()
  else {
    const text = await response.text()
    if (!text) data = ''
    else {
      try { data = JSON.parse(text) } catch { data = text }
    }
  }

  const axiosResponse: AxiosResponse = {
    data,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    config,
    request: response,
  }
  const validateStatus = config.validateStatus ?? ((status: number) => status >= 200 && status < 300)
  if (!validateStatus(response.status)) {
    throw new AxiosError(
      `Request failed with status code ${String(response.status)}`,
      response.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
      config,
      response,
      axiosResponse,
    )
  }
  return axiosResponse
}

/** 回环 → Node http；外网 → Chromium net.fetch；解析不了的目标保守走 Node http。 */
const routingAdapter: AxiosAdapter = (config) => {
  const target = targetOf(config)
  if (!target || LOOPBACK_HOSTS.has(target.hostname)) return nodeHttpAdapter(config)
  return chromiumFetchAdapter(config)
}

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

function log(level: 'debug' | 'info' | 'warn' | 'error', event: Record<string, unknown>): void {
  const threshold = desktopLogThreshold('axios')
  if (threshold === 'off') return
  const order = { debug: 10, info: 20, warn: 30, error: 40 } as const
  if (order[level] < order[threshold]) return
  logDesktop('axios', level, event)
}

function responseLog(
  level: 'debug' | 'info' | 'warn',
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
  options: { quiet?: boolean } = {},
): AxiosInstance {
  const instance = axios.create({ adapter: routingAdapter, ...defaults })
  // quiet：轮询类客户端，常规请求/响应降到 debug，避免刷屏；错误仍按原级别上报。
  const routineLevel = options.quiet ? 'debug' : 'info'

  instance.interceptors.request.use((config) => {
    const request: RequestMetadata = {
      requestId: randomUUID(),
      startedAt: Date.now(),
      method: (config.method ?? 'GET').toUpperCase(),
      url: requestUrl(config),
      payload: payloadSummary(config.data),
    }
    metadata.set(config, request)
    log(routineLevel, {
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
      responseLog(response.status >= 400 ? 'warn' : routineLevel, client, response)
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
