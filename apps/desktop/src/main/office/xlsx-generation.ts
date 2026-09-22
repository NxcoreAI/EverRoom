import JSZip from 'jszip'

/**
 * Agent 生成 Excel（第一期）：网关 LLM 输出 sheets→rows 的 JSON，主进程用
 * jszip 直接拼一份标准 OOXML .xlsx（inline string，无 sharedStrings 依赖）。
 * GenOffice sheets 预览经 calamine 读取（0.36 支持 t="inlineStr"），Excel/
 * LibreOffice/WPS 同样直开。首行按表头处理：加粗 + 冻结 + 列宽自适应。
 */

const MAX_SHEETS = 20
const MAX_ROWS = 5000
const MAX_COLS = 50
const MAX_CELL_TEXT = 3000
/** Excel 列宽以「默认字号字符数」计；CJK 全角按 2 计。 */
const MAX_COL_WIDTH = 60
const MIN_COL_WIDTH = 8

export type AgentSheetCell = string | number | boolean | null

export interface AgentSheetInput {
  name: string | null
  rows: AgentSheetCell[][]
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    // XML 1.0 非法控制字符直接丢弃（LLM 偶发输出）。
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F]/g, (c) => (c === '\t' || c === '\n' || c === '\r' ? c : ''))
}

function colName(index: number): string {
  let name = ''
  let n = index
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name
    n = Math.floor(n / 26) - 1
  }
  return name
}

function cellRef(row: number, col: number): string {
  return `${colName(col)}${row + 1}`
}

function displayWidth(cell: AgentSheetCell): number {
  if (cell == null) return 0
  if (typeof cell === 'number') return String(cell).length
  if (typeof cell === 'boolean') return cell ? 4 : 5
  let width = 0
  for (const ch of cell) width += ch.charCodeAt(0) > 0x2e7f ? 2 : 1
  return width
}

/** 合法化 sheet 名（Excel 禁止 []:*?/\ 且 ≤31 字符），保证非空且互不重名。 */
function sanitizeSheetNames(sheets: AgentSheetInput[]): string[] {
  const used = new Set<string>()
  return sheets.map((sheet, index) => {
    let name = (sheet.name ?? '').replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31)
    if (!name) name = `Sheet${index + 1}`
    let unique = name
    for (let suffix = 2; used.has(unique); suffix += 1) {
      unique = `${name.slice(0, 28)}-${suffix}`
    }
    used.add(unique)
    return unique
  })
}

function sheetXml(sheet: AgentSheetInput): string {
  const rows = sheet.rows
  const colCount = rows.reduce((max, row) => Math.max(max, row?.length ?? 0), 0)
  const widths: number[] = []
  for (let col = 0; col < colCount; col += 1) {
    let widest = 0
    for (const row of rows) {
      widest = Math.max(widest, displayWidth(row?.[col] ?? null))
    }
    widths.push(Math.min(Math.max(widest + 2, MIN_COL_WIDTH), MAX_COL_WIDTH))
  }

  const parts: string[] = []
  parts.push(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
  )
  parts.push(
    '<sheetViews><sheetView workbookViewId="0"'
    + (rows.length > 1 ? '><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView>' : '/>'),
    '</sheetViews>',
  )
  if (widths.length > 0) {
    parts.push(
      '<cols>'
      + widths.map((width, col) => `<col min="${col + 1}" max="${col + 1}" width="${width.toFixed(2)}" customWidth="1"/>`).join('')
      + '</cols>',
    )
  }
  parts.push('<sheetData>')
  rows.forEach((row, rowIndex) => {
    const header = rowIndex === 0
    const cells: string[] = []
    ;(row ?? []).forEach((cell, colIndex) => {
      if (cell == null || cell === '') return
      const ref = cellRef(rowIndex, colIndex)
      if (typeof cell === 'number') {
        if (!Number.isFinite(cell)) return
        cells.push(`<c r="${ref}"${header ? ' s="1"' : ''}><v>${cell}</v></c>`)
      } else if (typeof cell === 'boolean') {
        cells.push(`<c r="${ref}" t="b"${header ? ' s="1"' : ''}><v>${cell ? 1 : 0}</v></c>`)
      } else {
        cells.push(`<c r="${ref}" t="inlineStr"${header ? ' s="1"' : ''}><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`)
      }
    })
    parts.push(`<row r="${rowIndex + 1}">${cells.join('')}</row>`)
  })
  parts.push('</sheetData></worksheet>')
  return parts.join('')
}

const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
+ '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
+ '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
+ '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
+ '<fills count="2"><fill><patternFill patternType="none"/></fill>'
+ '<fill><patternFill patternType="gray125"/></fill></fills>'
+ '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
+ '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
+ '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
+ '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
+ '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
+ '</styleSheet>'

/** 校验并规整 LLM 输出的 sheets 结构；越限直接抛错（工具层已先做一层校验）。 */
export function normalizeAgentSheets(sheets: AgentSheetInput[]): AgentSheetInput[] {
  if (!Array.isArray(sheets) || sheets.length === 0) throw new Error('至少需要一个工作表')
  if (sheets.length > MAX_SHEETS) throw new Error(`工作表数量超过上限（${MAX_SHEETS}）`)
  return sheets.map((sheet) => {
    if (!sheet || typeof sheet !== 'object' || !Array.isArray(sheet.rows) || sheet.rows.length === 0) {
      throw new Error('每个工作表需要非空的 rows 二维数组')
    }
    if (sheet.rows.length > MAX_ROWS) throw new Error(`行数超过上限（${MAX_ROWS}）`)
    const rows = sheet.rows.map((row) => {
      if (!Array.isArray(row)) throw new Error('rows 的每一行必须是数组')
      if (row.length > MAX_COLS) throw new Error(`列数超过上限（${MAX_COLS}）`)
      return row.map((cell) => {
        if (cell == null) return null
        if (typeof cell === 'string') return cell.slice(0, MAX_CELL_TEXT)
        if (typeof cell === 'number' || typeof cell === 'boolean') return cell
        return String(cell).slice(0, MAX_CELL_TEXT)
      })
    })
    const name = typeof sheet.name === 'string' ? sheet.name : null
    return { name, rows }
  })
}

export async function buildAgentXlsxBytes(sheets: AgentSheetInput[]): Promise<Buffer> {
  const normalized = normalizeAgentSheets(sheets)
  const names = sanitizeSheetNames(normalized)

  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + normalized.map((_, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    ).join('')
    + '</Types>',
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>',
  )
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets>${names.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets>`
    + '</workbook>',
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + normalized.map((_, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    ).join('')
    + `<Relationship Id="rId${normalized.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + '</Relationships>',
  )
  zip.file('xl/styles.xml', STYLES_XML)
  normalized.forEach((sheet, index) => {
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet))
  })
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
