// http-client 路由适配器回归：mock electron 的 net.fetch（用 undici 顶替），
// 目标用本机 LAN 地址（非回环）强制走 chromiumFetchAdapter 分支——回环地址
// 会落到 Node http 适配器，测不到 net.fetch 的参数/响应映射。
// 曾在这里抓到真实回归：axios 1.19 的 AxiosHeaders 实例没有 forEach。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isReady: () => true, whenReady: async () => undefined },
  net: { fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init) },
}))

import { createLoggedHttpClient } from '../src/main/network/http-client'

function lanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return null
}

const lan = lanAddress()

const servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe.skipIf(lan === null)('chromium fetch adapter（经 mock net.fetch）', () => {
  it('映射 method/headers/params/body 并解析 JSON 响应', async () => {
    const seen: Array<{ method: string; url: string; body: string; auth?: string; ct?: string }> = []
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = ''
      request.on('data', (chunk) => { body += String(chunk) })
      request.on('end', () => {
        seen.push({ method: request.method ?? '', url: request.url ?? '', body, auth: request.headers.authorization, ct: request.headers['content-type'] })
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ ok: true, echo: body }))
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
    const { port } = server.address() as AddressInfo
    const http = createLoggedHttpClient('adapter-test')

    const response = await http.post(`http://${lan}:${String(port)}/v1/thing`, { hello: '世界' }, {
      params: { page: 2, tag: 'a b' },
      headers: { Authorization: 'Bearer tok' },
    })
    expect(response.status).toBe(200)
    expect(response.data).toEqual({ ok: true, echo: '{"hello":"世界"}' })
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.url).toBe('/v1/thing?page=2&tag=a+b')
    expect(seen[0]?.auth).toBe('Bearer tok')
    expect(seen[0]?.ct).toContain('application/json')
  })

  it('非 2xx 按 validateStatus reject，AxiosError 携带 response', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 409
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ message: '冲突' }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
    const { port } = server.address() as AddressInfo
    const http = createLoggedHttpClient('adapter-test')
    await expect(http.get(`http://${lan}:${String(port)}/v1/conflict`)).rejects.toMatchObject({
      isAxiosError: true,
      response: { status: 409, data: { message: '冲突' } },
    })
  })

  it('arraybuffer 响应类型返回 Buffer', async () => {
    const payload = Buffer.from([1, 2, 3, 255])
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/octet-stream')
      response.end(payload)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
    const { port } = server.address() as AddressInfo
    const http = createLoggedHttpClient('adapter-test')
    const response = await http.get(`http://${lan}:${String(port)}/v1/blob`, { responseType: 'arraybuffer' })
    expect(Buffer.from(response.data as ArrayBuffer)).toEqual(payload)
  })
})
