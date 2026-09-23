/** /v1/office-edit：Agent 编辑已打开 slides 产物的桥路由（活会话事务）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/office/office-generation', () => ({
  generateDocxFromHtml: vi.fn(),
  generatePptxFromPageSpecs: vi.fn(),
  generateXlsxFromSheets: vi.fn(),
}))

import { OfficeBridgeServer } from '../src/main/gateway/office-bridge'

let server: OfficeBridgeServer | null = null
let slidesEditImpl:
  | ((fileId: string, req: unknown) => Promise<unknown>)
  | null = vi.fn(async () => ({ ok: true, info: {} }))

beforeEach(() => {
  slidesEditImpl = vi.fn(async () => ({ ok: true, info: {} }))
})

afterEach(async () => {
  await server?.stop()
  server = null
})

async function startServer(): Promise<{ baseUrl: string; token: string }> {
  server = new OfficeBridgeServer(
    () => null,
    () => undefined,
    () => slidesEditImpl as never,
  )
  return server.start()
}

async function postEdit(
  baseUrl: string,
  token: string,
  body: unknown,
  authorization = `Bearer ${token}`,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/v1/office-edit`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

describe('OfficeBridgeServer /v1/office-edit', () => {
  it('read：转发 fileId（含 "active"），返回 info', async () => {
    const impl = vi.fn(async () => ({ ok: true, info: { outline: 'Page 1…', opVocabulary: 'text: …' } }))
    slidesEditImpl = impl
    const { baseUrl, token } = await startServer()

    const { status, json } = await postEdit(baseUrl, token, { mode: 'read', fileId: 'file-1' })
    expect(status).toBe(200)
    expect(json.data).toEqual({ outline: 'Page 1…', opVocabulary: 'text: …' })
    expect(impl).toHaveBeenCalledWith('file-1', { mode: 'read' })

    await postEdit(baseUrl, token, { mode: 'read', fileId: 'active' })
    expect(impl).toHaveBeenLastCalledWith('active', { mode: 'read' })
  })

  it('apply：透传 ops/dryRun/isolation，返回事务结果', async () => {
    const impl = vi.fn(async () => ({ ok: true, result: { ok: true, applied: true, saved: true, outline: '…' } }))
    slidesEditImpl = impl
    const { baseUrl, token } = await startServer()
    const ops = [{ op: 'setNotes', target: { slide: 0 }, text: 'x' }]

    const { status, json } = await postEdit(baseUrl, token, {
      mode: 'apply',
      fileId: 'file-2',
      ops,
      dryRun: true,
      isolation: 'per_op',
    })

    expect(status).toBe(200)
    expect(json.data).toMatchObject({ applied: true, saved: true })
    expect(impl).toHaveBeenCalledWith('file-2', { mode: 'apply', ops, dryRun: true, isolation: 'per_op' })
  })

  it('apply page：透传逐页填充载荷，返回填充结果', async () => {
    const impl = vi.fn(async () => ({ ok: true, result: { ok: true, applied: true, saved: true, outline: '…' } }))
    slidesEditImpl = impl
    const { baseUrl, token } = await startServer()
    const page = { slideIndex: 2, specJson: '{"elements":[{"type":"text","paragraphs":[{"runs":[{"text":"x"}]}]}]}' }

    const { status, json } = await postEdit(baseUrl, token, {
      mode: 'apply',
      fileId: 'file-2',
      page,
    })

    expect(status).toBe(200)
    expect(json.data).toMatchObject({ applied: true, saved: true })
    expect(impl).toHaveBeenCalledWith('file-2', { mode: 'apply', page })
  })

  it('page 与 ops 互斥（同时给/都缺/坏 page）→ 422', async () => {
    const impl = vi.fn(async () => ({ ok: true, result: { ok: true, applied: true } }))
    slidesEditImpl = impl
    const { baseUrl, token } = await startServer()
    const spec = { slideIndex: 0, specJson: '{"elements":[]}' }

    expect((await postEdit(baseUrl, token, { mode: 'apply', fileId: 'f', ops: [{ op: 'setFill' }], page: spec })).status).toBe(422)
    expect((await postEdit(baseUrl, token, { mode: 'apply', fileId: 'f' })).status).toBe(422)
    expect((await postEdit(baseUrl, token, { mode: 'apply', fileId: 'f', page: { slideIndex: -1, specJson: '{}' } })).status).toBe(422)
    expect((await postEdit(baseUrl, token, { mode: 'apply', fileId: 'f', page: { slideIndex: 0 } })).status).toBe(422)
    expect(impl).not.toHaveBeenCalled()
  })

  it('not_open → 422 + 引导先在产物库打开（附打开清单摘要）', async () => {
    slidesEditImpl = vi.fn(async () => ({
      ok: false,
      reason: 'not_open',
      open: [
        { fileId: 'f1', title: '本周工作总结.pptx', kind: 'slides', editable: true, active: true },
        { fileId: 'f2', title: '笔记.docx', kind: 'docx', editable: false, active: false },
      ],
    }))
    const { baseUrl, token } = await startServer()

    const { status, json } = await postEdit(baseUrl, token, { mode: 'read', fileId: 'file-3' })

    expect(status).toBe(422)
    expect(json.code).toBe('not_open')
    expect(String(json.message)).toContain('未在 Room 中打开')
    expect(String(json.message)).toContain('本周工作总结.pptx')
    expect(String(json.message)).toContain('当前焦点')
    expect(String(json.message)).toContain('笔记.docx')
    expect(json.open).toHaveLength(2)
  })

  it('not_open 无打开文件 → 摘要提示当前没有打开任何 Office 文件', async () => {
    slidesEditImpl = vi.fn(async () => ({ ok: false, reason: 'not_open' }))
    const { baseUrl, token } = await startServer()
    const { status, json } = await postEdit(baseUrl, token, { mode: 'read', fileId: 'f' })
    expect(status).toBe(422)
    expect(String(json.message)).toContain('当前没有打开任何 Office 文件')
    expect(json.open).toEqual([])
  })

  it('not_editable → 422 + 重新打开提示', async () => {
    slidesEditImpl = vi.fn(async () => ({ ok: false, reason: 'not_editable' }))
    const { baseUrl, token } = await startServer()

    const { status, json } = await postEdit(baseUrl, token, { mode: 'apply', fileId: 'file-4', ops: [{ op: 'setFill' }] })

    expect(status).toBe(422)
    expect(json.code).toBe('not_editable')
  })

  it('slidesEdit 依赖缺失 → 503；实现抛错 → 502', async () => {
    slidesEditImpl = null
    let ctx = await startServer()
    const unavailable = await postEdit(ctx.baseUrl, ctx.token, { mode: 'read', fileId: 'f' })
    expect(unavailable.status).toBe(503)
    await server?.stop()
    server = null

    slidesEditImpl = vi.fn(async () => {
      throw new Error('boom')
    })
    ctx = await startServer()
    const failed = await postEdit(ctx.baseUrl, ctx.token, { mode: 'read', fileId: 'f' })
    expect(failed.status).toBe(502)
  })

  it('非法载荷（缺 fileId / apply 无 ops / 坏 isolation）→ 422', async () => {
    const { baseUrl, token } = await startServer()

    expect((await postEdit(baseUrl, token, { mode: 'read' })).status).toBe(422)
    expect((await postEdit(baseUrl, token, { mode: 'apply', fileId: 'f' })).status).toBe(422)
    expect(
      (await postEdit(baseUrl, token, { mode: 'apply', fileId: 'f', ops: [{}], isolation: 'loose' })).status,
    ).toBe(422)
    expect((await postEdit(baseUrl, token, { mode: 'other', fileId: 'f' })).status).toBe(422)
  })

  it('鉴权与未知路径不受影响', async () => {
    const { baseUrl, token } = await startServer()

    expect((await postEdit(baseUrl, token, { mode: 'read', fileId: 'f' }, 'Bearer wrong')).status).toBe(401)
    const notFound = await fetch(`${baseUrl}/v1/other`, { method: 'POST' })
    expect(notFound.status).toBe(404)
    const getMethod = await fetch(`${baseUrl}/v1/office-edit`)
    expect(getMethod.status).toBe(404)
  })
})
