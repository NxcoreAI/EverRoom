/**
 * /v1/office-open：Agent 的 file_open 工具 → 桌面端在界面打开文件。
 *
 * 桌面端具体打开动作由 index.ts 注入（openFileInAppPreview + 预览通知）；
 * 这里锁桥的路由契约、载荷校验与失败码透传。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OfficeBridgeServer } from '../src/main/gateway/office-bridge'

let server: OfficeBridgeServer | null = null

type OpenImpl = (req: { fileId: string; editable?: boolean; roomId?: string | null }) => Promise<unknown>

let openImpl: OpenImpl | null = null

beforeEach(() => {
  openImpl = vi.fn(async () => ({
    ok: true,
    openedWith: 'office',
    fileId: 'file-1',
    originalName: '合同.docx',
    kind: 'docx',
  }))
})

afterEach(async () => {
  await server?.stop()
  server = null
})

async function startServer(): Promise<{ baseUrl: string; token: string }> {
  server = new OfficeBridgeServer(
    () => null as never, // filesBridge：本测试不经过它
    () => undefined,
    () => null,
    () => null,
    () => null,
    () => null,
    () => null, // exportPdfDoc：本测试不经过它
    () => openImpl as never,
  )
  return server.start()
}

async function postOpen(
  baseUrl: string,
  token: string,
  body: unknown,
  authorization = `Bearer ${token}`,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/v1/office-open`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

describe('OfficeBridgeServer /v1/office-open', () => {
  it('按 fileId 打开：透传 editable/roomId，返回打开形态', async () => {
    const impl = vi.fn(async () => ({
      ok: true,
      openedWith: 'office',
      fileId: 'file-1',
      originalName: '合同.docx',
      kind: 'docx',
    }))
    openImpl = impl
    const { baseUrl, token } = await startServer()

    const { status, json } = await postOpen(baseUrl, token, { fileId: 'file-1', editable: true, roomId: 'room-7' })

    expect(status).toBe(200)
    expect(json.data).toMatchObject({ openedWith: 'office', originalName: '合同.docx', kind: 'docx' })
    expect(impl).toHaveBeenCalledWith({ fileId: 'file-1', editable: true, roomId: 'room-7' })
  })

  it('非 Office 形态交给系统应用（external）原样返回', async () => {
    openImpl = vi.fn(async () => ({ ok: true, openedWith: 'external', fileId: 'file-2', originalName: '素材.zip' }))
    const { baseUrl, token } = await startServer()

    const { status, json } = await postOpen(baseUrl, token, { fileId: 'file-2' })

    expect(status).toBe(200)
    expect(json.data).toMatchObject({ openedWith: 'external', originalName: '素材.zip' })
  })

  it('文件不存在 → 422 + code=not_found（模型据此改搜别的名字）', async () => {
    openImpl = vi.fn(async () => ({ ok: false, code: 'not_found', message: '文件 file-404 不在文件库中（可能已删除）。' }))
    const { baseUrl, token } = await startServer()

    const { status, json } = await postOpen(baseUrl, token, { fileId: 'file-404' })

    expect(status).toBe(422)
    expect(json.code).toBe('not_found')
    expect(String(json.message)).toContain('不在文件库中')
  })

  it('打开实现报错 → 422 + code=error（不漏出内部堆栈）', async () => {
    openImpl = vi.fn(async () => ({ ok: false, code: 'error', message: '打开失败：预览实例创建失败' }))
    const { baseUrl, token } = await startServer()

    const { status, json } = await postOpen(baseUrl, token, { fileId: 'file-3' })

    expect(status).toBe(422)
    expect(json.code).toBe('error')
    expect(String(json.message)).toContain('预览实例创建失败')
    expect(String(json.message)).not.toContain('stack')
  })

  it('打开端口未注入 → 503（工具不可用时不误报成功）', async () => {
    openImpl = null
    const { baseUrl, token } = await startServer()

    expect((await postOpen(baseUrl, token, { fileId: 'file-1' })).status).toBe(503)
  })

  it('非法载荷（缺 fileId / editable 非布尔 / roomId 非字符串）→ 422', async () => {
    const { baseUrl, token } = await startServer()

    expect((await postOpen(baseUrl, token, {})).status).toBe(422)
    expect((await postOpen(baseUrl, token, { fileId: '   ' })).status).toBe(422)
    expect((await postOpen(baseUrl, token, { fileId: 'f', editable: 'yes' })).status).toBe(422)
    expect((await postOpen(baseUrl, token, { fileId: 'f', roomId: 7 })).status).toBe(422)
  })

  it('鉴权与未知路径不受影响', async () => {
    const { baseUrl, token } = await startServer()

    expect((await postOpen(baseUrl, token, { fileId: 'f' }, 'Bearer wrong')).status).toBe(401)
    const notFound = await fetch(`${baseUrl}/v1/office-unknown`, { method: 'POST' })
    expect(notFound.status).toBe(404)
  })
})
