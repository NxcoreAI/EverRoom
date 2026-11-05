/** /v1/office-generate：md 格式（markdown_create 链路）的桥路由。 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/office/office-generation', () => ({
  generateDocxFromHtml: vi.fn(),
  generatePptxFromPageSpecs: vi.fn(),
  generateXlsxFromSheets: vi.fn(),
  generateMarkdownFromText: vi.fn(async (input: { title: string; markdown: string }) => ({
    filePath: `/tmp/agent-office/test-${input.title}.md`,
    bytes: Buffer.from(input.markdown, 'utf8'),
    title: input.title,
  })),
}))

import { OfficeBridgeServer } from '../src/main/gateway/office-bridge'

let server: OfficeBridgeServer | null = null

afterEach(async () => {
  await server?.stop()
  server = null
})

interface Started {
  baseUrl: string
  token: string
  imports: Array<{ filePath: string; originalName: string; sourceKey: string; workspaceId?: string }>
  broadcasts: Array<Record<string, unknown>>
}

async function startServer(): Promise<Started> {
  const imports: Started['imports'] = []
  const broadcasts: Array<Record<string, unknown>> = []
  server = new OfficeBridgeServer(
    () => ({
      importAgentGeneratedFile: async (input: Started['imports'][number]) => {
        imports.push(input)
        return {
          fileEntryId: 'fe-1',
          fileVersionId: 'fv-1',
          jobId: 'job-1',
          contentHash: 'hash-1',
          blobDeduped: false,
          versionDeduped: false,
          roomRequested: false,
        }
      },
    }) as never,
    (event) => broadcasts.push(event as never),
    () => null,
  )
  const { baseUrl, token } = await server!.start()
  return { baseUrl, token, imports, broadcasts }
}

async function postGenerate(
  baseUrl: string,
  token: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/v1/office-generate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

describe('OfficeBridgeServer /v1/office-generate (md)', () => {
  it('format=md：markdown 正文落盘导入，sourceKey 用 markdown 段，广播 done format=md', async () => {
    const started = await startServer()
    const { status, json } = await postGenerate(started.baseUrl, started.token, {
      title: '会议纪要',
      format: 'md',
      markdown: '# 纪要\n\n- 第一项',
      roomId: null,
      workspaceId: 'ws-1',
      fileName: null,
      idempotencyKey: 'idem-md-0001',
    })
    expect(status).toBe(200)
    expect((json.data as Record<string, unknown>).fileEntryId).toBe('fe-1')
    expect(started.imports).toHaveLength(1)
    expect(started.imports[0]).toMatchObject({
      originalName: '会议纪要.md',
      sourceKey: 'agent:markdown:idem-md-0001',
      workspaceId: 'ws-1',
    })
    const done = started.broadcasts.find((event) => event.type === 'done')
    expect(done).toMatchObject({ format: 'md', fileId: 'fe-1', originalName: '会议纪要.md', workspaceId: 'ws-1' })
  })

  it('fileName 覆盖默认名（仍带 .md 后缀）', async () => {
    const started = await startServer()
    await postGenerate(started.baseUrl, started.token, {
      title: '会议纪要',
      format: 'md',
      markdown: '内容',
      roomId: null,
      fileName: '自定义名.md',
      idempotencyKey: 'idem-md-0002',
    })
    expect(started.imports[0]?.originalName).toBe('自定义名.md')
  })

  it('format=md 但 markdown 缺失/空白 → 422', async () => {
    const started = await startServer()
    const missing = await postGenerate(started.baseUrl, started.token, {
      title: '纪要',
      format: 'md',
      roomId: null,
      idempotencyKey: 'idem-md-0003',
    })
    expect(missing.status).toBe(422)
    const blank = await postGenerate(started.baseUrl, started.token, {
      title: '纪要',
      format: 'md',
      markdown: '   ',
      roomId: null,
      idempotencyKey: 'idem-md-0004',
    })
    expect(blank.status).toBe(422)
    expect(started.imports).toHaveLength(0)
  })
})
