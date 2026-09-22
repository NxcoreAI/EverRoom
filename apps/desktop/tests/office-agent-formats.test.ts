import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/office/office-generation', () => ({
  generateDocxFromHtml: vi.fn(),
  generatePptxFromPageSpecs: vi.fn(),
  generateXlsxFromSheets: vi.fn(),
}))

import { OfficeBridgeServer } from '../src/main/gateway/office-bridge'
import {
  generatePptxFromPageSpecs,
  generateXlsxFromSheets,
} from '../src/main/office/office-generation'
import { buildAgentXlsxBytes, normalizeAgentSheets } from '../src/main/office/xlsx-generation'
import type { FileImportAcceptedDto } from '../src/shared/ingest'
import type { OfficeAgentFileEvent } from '../src/shared/office'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  vi.mocked(generatePptxFromPageSpecs).mockReset()
  vi.mocked(generateXlsxFromSheets).mockReset()
})

describe('Agent xlsx 生成（jszip 拼 OOXML）', () => {
  it('生成合法包结构：内容类型/关系/工作簿/样式/工作表齐全，非法字符与重名在落包时处理', async () => {
    const bytes = await buildAgentXlsxBytes([
      { name: '汇总/表', rows: [['列A', '列B'], [1, true]] },
      { name: '汇总/表', rows: [['only']] },
    ])
    const zip = await JSZip.loadAsync(bytes)
    for (const entry of [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]) {
      expect(zip.file(entry), entry).toBeDefined()
    }
    const workbook = await zip.file('xl/workbook.xml')!.async('string')
    expect(workbook).toContain('name="汇总 表"')
    expect(workbook).not.toContain('name="汇总/表"')
    expect(workbook).toContain('name="汇总 表-2"')
    const rels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string')
    expect(rels).toContain('Target="styles.xml"')
    expect(rels).toContain('Target="worksheets/sheet1.xml"')
  })

  it('单元格编码：表头加粗 inline string + 转义、数字 <v>、布尔 t="b"、null 跳过、冻结窗格、列宽', async () => {
    const bytes = await buildAgentXlsxBytes([{
      name: null,
      rows: [
        ['名称 & <用量>', '数量', '启用', null],
        ['咖啡"豆"', 12.5, true, null],
      ],
    }])
    const sheet = await (await JSZip.loadAsync(bytes)).file('xl/worksheets/sheet1.xml')!.async('string')
    expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>')
    expect(sheet).toContain('<cols>')
    expect(sheet).toContain('customWidth="1"')
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">名称 &amp; &lt;用量&gt;</t></is></c>')
    expect(sheet).toContain('咖啡&quot;豆&quot;')
    expect(sheet).toContain('<c r="B2"><v>12.5</v></c>')
    expect(sheet).toContain('<c r="C2" t="b"><v>1</v></c>')
    expect(sheet).not.toContain('r="D1"')
    expect(sheet).not.toContain('r="D2"')
  })

  it('normalizeAgentSheets：校验结构/上限、对象单元格转字符串、重名表去重', () => {
    expect(() => normalizeAgentSheets([])).toThrow('至少需要一个工作表')
    expect(() => normalizeAgentSheets([{ name: null, rows: [] }])).toThrow('非空的 rows')
    expect(() => normalizeAgentSheets([{ name: null, rows: [['x'], 'nope'] }])).toThrow('每一行必须是数组')
    const normalized = normalizeAgentSheets([
      { name: '预算/表', rows: [[{ toString: () => '对象' } as unknown as string]] },
      { name: null, rows: [['dup']] },
    ])
    expect(normalized[0]!.rows[0]![0]).toBe('对象')
    expect(normalized[1]!.name).toBeNull()
  })
})

describe('OfficeBridgeServer 多格式分发', () => {
  let server: OfficeBridgeServer | null = null
  const events: OfficeAgentFileEvent[] = []
  const imports: Array<{ sourceKey: string; originalName: string; roomId?: string }> = []
  const accepted: FileImportAcceptedDto = {
    fileEntryId: 'fe-1',
    fileVersionId: 'fv-1',
    jobId: 'job-1',
    contentHash: 'hash-1',
    blobDeduped: false,
    versionDeduped: false,
  } as FileImportAcceptedDto

  beforeEach(() => {
    events.length = 0
    imports.length = 0
  })

  afterEach(async () => {
    await server?.stop()
    server = null
  })

  async function startServer(): Promise<{ baseUrl: string; token: string }> {
    server = new OfficeBridgeServer(
      () => ({
        importAgentGeneratedFile: async (input: { sourceKey: string; originalName: string; roomId?: string }) => {
          imports.push(input)
          return accepted
        },
      }) as never,
      (event) => events.push(event),
    )
    return server.start()
  }

  it('pptx：调用页 spec 生成器、sourceKey 用 pptx 段、事件带 format、导入后清理临时文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'office-bridge-pptx-'))
    temporaryDirectories.push(dir)
    const filePath = join(dir, 'deck.pptx')
    await writeFile(filePath, Buffer.from('PK-fake'))
    vi.mocked(generatePptxFromPageSpecs).mockImplementation(async (_input, onPhase) => {
      onPhase?.('rendering')
      onPhase?.('saved')
      return { filePath, bytes: Buffer.from('PK-fake'), title: '季度汇报', warnings: ['第 1 页：x'] }
    })

    const { baseUrl, token } = await startServer()
    const response = await fetch(`${baseUrl}/v1/office-generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '季度汇报',
        format: 'pptx',
        pages: ['{"elements":[]}', '{"elements":[]}'],
        roomId: 'room-9',
        fileName: null,
        idempotencyKey: 'agent-slides:abc12345',
      }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { data: { originalName: string } }
    expect(body.data.originalName).toBe('季度汇报.pptx')
    expect(generatePptxFromPageSpecs).toHaveBeenCalledWith(
      { title: '季度汇报', pages: ['{"elements":[]}', '{"elements":[]}'] },
      expect.any(Function),
    )
    expect(imports[0]).toMatchObject({ sourceKey: 'agent:pptx:agent-slides:abc12345', originalName: '季度汇报.pptx', roomId: 'room-9' })
    expect(events.filter((event) => event.type === 'phase').map((event) => event.phase)).toEqual(['rendering', 'saved', 'importing'])
    expect(events.at(-1)).toMatchObject({ type: 'done', format: 'pptx', fileId: 'fe-1' })
  })

  it('xlsx：缺 sheets 载荷 → 422；合法载荷走 xlsx 生成器', async () => {
    const { baseUrl, token } = await startServer()
    const bad = await fetch(`${baseUrl}/v1/office-generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '预算', format: 'xlsx', roomId: null, fileName: null, idempotencyKey: 'agent-xlsx:abc12345' }),
    })
    expect(bad.status).toBe(422)

    const dir = await mkdtemp(join(tmpdir(), 'office-bridge-xlsx-'))
    temporaryDirectories.push(dir)
    const filePath = join(dir, 'book.xlsx')
    await writeFile(filePath, Buffer.from('PK-xlsx'))
    vi.mocked(generateXlsxFromSheets).mockResolvedValue({ filePath, bytes: Buffer.from('PK-xlsx'), title: '预算' })
    const good = await fetch(`${baseUrl}/v1/office-generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '预算',
        format: 'xlsx',
        sheets: [{ name: null, rows: [['a']] }],
        roomId: null,
        fileName: '预算表.xlsx',
        idempotencyKey: 'agent-xlsx:abc12345',
      }),
    })
    expect(good.status).toBe(200)
    expect(generateXlsxFromSheets).toHaveBeenCalled()
    expect(imports[0]).toMatchObject({ sourceKey: 'agent:xlsx:agent-xlsx:abc12345', originalName: '预算表.xlsx' })
  })

  it('docx：无 format 字段缺省 docx（旧客户端兼容）', async () => {
    const { baseUrl, token } = await startServer()
    const response = await fetch(`${baseUrl}/v1/office-generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '报告', html: '<p>x</p>', roomId: null, fileName: null, idempotencyKey: 'agent-word:abc12345' }),
    })
    expect(response.status).toBe(502) // generateDocxFromHtml 未 mock → 生成失败，但请求本身通过校验
    const phaseEvents = events.filter((event) => event.type === 'error')
    expect(phaseEvents[0]).toMatchObject({ format: 'docx' })
  })
})
