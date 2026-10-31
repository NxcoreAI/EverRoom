import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

/**
 * 原型的 mock 文件内容 → 真实 Office 文件。GenOffice 编辑器只吃磁盘上的
 * 真实 docx/xlsx/pptx/pdf，这里为每个 mock 文件生成一份落到 userData 沙箱，
 * 每次启动重建（演示态：跨会话不保留编辑）。
 */

export type NativeFileSpec =
  | { kind: 'docx'; blocks: Array<{ type: 'h1' | 'h2' | 'p' | 'quote'; text: string; cite?: { label: string; source: string } }> }
  | { kind: 'xlsx'; columns: string[]; rows: string[][] }
  | { kind: 'pptx'; slides: Array<{ title: string; bullets: string[] }> }
  | { kind: 'pdf'; paragraphs: string[] }

const execFileAsync = promisify(execFile)

/* ───────────── 极简 ZIP（store，不压缩）：docx/xlsx/pptx 容器 ───────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function buildZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  // DOS 时间戳取固定值 2026-01-01 00:00，原型产物不需要真实时间。
  const dosTime = 0
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x0800, 6) // 文件名 UTF-8
    lh.writeUInt16LE(0, 8) // store
    lh.writeUInt16LE(dosTime, 10)
    lh.writeUInt16LE(dosDate, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(entry.data.length, 18)
    lh.writeUInt32LE(entry.data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    locals.push(lh, name, entry.data)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(0, 10)
    ch.writeUInt16LE(dosTime, 12)
    ch.writeUInt16LE(dosDate, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(entry.data.length, 20)
    ch.writeUInt32LE(entry.data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)

    offset += lh.length + name.length + entry.data.length
  }
  const central = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, eocd])
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/* ───────────── DOCX ───────────── */

function docxParagraph(style: string | null, text: string): string {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''
  const run = text
    ? `<w:r><w:rPr>${style === 'Quote' ? '<w:i/><w:color w:val="5A6270"/>' : ''}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`
    : ''
  return `<w:p>${pPr}${run}</w:p>`
}

function buildDocx(title: string, spec: Extract<NativeFileSpec, { kind: 'docx' }>): Buffer {
  const body = spec.blocks
    .map((b) => {
      if (b.type === 'h1') return docxParagraph('Heading1', b.text)
      if (b.type === 'h2') return docxParagraph('Heading2', b.text)
      if (b.type === 'quote') {
        const cite = b.cite
          ? docxParagraph(null, `${b.cite.label} · ${b.cite.source}`)
              .replace('<w:p>', '<w:p><w:pPr><w:ind w:left="360"/><w:rPr><w:color w:val="8490A0"/><w:sz w:val="18"/></w:rPr></w:pPr>')
          : ''
        return docxParagraph('Quote', b.text) + cite
      }
      return docxParagraph(null, b.text)
    })
    .join('')

  const document = `${XML_HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`

  const styles = `${XML_HEAD}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="PingFang SC"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/></w:pPr><w:rPr><w:i/><w:color w:val="5A6270"/></w:rPr></w:style></w:styles>`

  const contentTypes = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`

  const rootRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`

  const docRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`

  const core = `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title)}</dc:title></cp:coreProperties>`

  const app = `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>EverRoom Office Prototype</Application></Properties>`

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
    { name: '_rels/.rels', data: Buffer.from(rootRels) },
    { name: 'docProps/core.xml', data: Buffer.from(core) },
    { name: 'docProps/app.xml', data: Buffer.from(app) },
    { name: 'word/document.xml', data: Buffer.from(document) },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(docRels) },
    { name: 'word/styles.xml', data: Buffer.from(styles) },
  ])
}

/* ───────────── XLSX ───────────── */

const colName = (i: number): string => {
  let s = ''
  let n = i
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

function buildXlsx(spec: Extract<NativeFileSpec, { kind: 'xlsx' }>): Buffer {
  const rows = [spec.columns, ...spec.rows]
  const sheetData = rows
    .map((row, ri) => {
      const cells = row
        .map((cell, ci) => {
          if (!cell) return ''
          const ref = `${colName(ci)}${ri + 1}`
          return `<c r="${ref}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t>${esc(cell)}</t></is></c>`
        })
        .join('')
      return `<row r="${ri + 1}">${cells}</row>`
    })
    .join('')

  const sheet = `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`
  const workbook = `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet 1" sheetId="1" r:id="rId1"/></sheets></workbook>`
  const workbookRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
  const styles = `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" applyFont="1"/></cellXfs></styleSheet>`
  const contentTypes = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
  const rootRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
    { name: '_rels/.rels', data: Buffer.from(rootRels) },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels) },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet) },
    { name: 'xl/styles.xml', data: Buffer.from(styles) },
  ])
}

/* ───────────── PPTX ───────────── */

const P_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

const EMPTY_SPTREE =
  '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>'

function pptxTextShape(id: number, name: string, placeholder: string, idx: number | null, offY: number, height: number, paragraphs: string[]): string {
  const ph = idx === null ? `<p:ph type="${placeholder}"/>` : `<p:ph type="${placeholder}" idx="${idx}"/>`
  const paras = paragraphs
    .map((t) => `<a:p><a:r><a:rPr lang="zh-CN" altLang="en-US"/><a:t>${esc(t)}</a:t></a:r></a:p>`)
    .join('')
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="838200" y="${offY}"/><a:ext cx="10515600" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>`
}

function buildPptx(spec: Extract<NativeFileSpec, { kind: 'pptx' }>): Buffer {
  const slideCount = spec.slides.length
  const slideEntries: Array<{ name: string; data: Buffer }> = []
  const slideOverrides: string[] = []
  const slideRels: string[] = []
  const slideIds: string[] = []
  for (let i = 0; i < slideCount; i++) {
    const n = i + 1
    const s = spec.slides[i]!
    const bullets = s.bullets.length > 0 ? s.bullets : ['']
    const xml = `${XML_HEAD}<p:sld ${P_NS}><p:cSld name="Slide ${n}"><p:spTree>${EMPTY_SPTREE}${pptxTextShape(2, 'Title', 'title', null, 1080000, 1150000, [s.title])}${pptxTextShape(3, 'Content', 'body', 1, 2400000, 4200000, bullets)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
    slideEntries.push({ name: `ppt/slides/slide${n}.xml`, data: Buffer.from(xml) })
    slideEntries.push({
      name: `ppt/slides/_rels/slide${n}.xml.rels`,
      data: Buffer.from(`${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`),
    })
    slideOverrides.push(`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
    slideRels.push(`<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/>`)
    slideIds.push(`<p:sldId id="${255 + n}" r:id="rId${n + 1}"/>`)
  }

  const presentation = `${XML_HEAD}<p:presentation ${P_NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds.join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
  const presentationRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slideRels.join('')}</Relationships>`
  const master = `${XML_HEAD}<p:sldMaster ${P_NS}><p:cSld name="Master"><p:spTree>${EMPTY_SPTREE}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`
  const masterRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`
  const layout = `${XML_HEAD}<p:sldLayout ${P_NS} type="blank"><p:cSld name="Blank"><p:spTree>${EMPTY_SPTREE}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
  const layoutRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`

  const contentTypes = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>${slideOverrides.join('')}</Types>`
  const rootRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
    { name: '_rels/.rels', data: Buffer.from(rootRels) },
    { name: 'ppt/presentation.xml', data: Buffer.from(presentation) },
    { name: 'ppt/_rels/presentation.xml.rels', data: Buffer.from(presentationRels) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: Buffer.from(master) },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: Buffer.from(masterRels) },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: Buffer.from(layout) },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: Buffer.from(layoutRels) },
    ...slideEntries,
  ])
}

/* ───────────── PDF（macOS cupsfilter：中文走系统字体；失败退回 ASCII 单页） ───────────── */

function buildAsciiPdfFallback(title: string): Buffer {
  const ascii = title.replace(/[^\x20-\x7e]/g, '?')
  const lines = [ascii, '', '(PDF preview generated without CUPS)']
  let content = ''
  let y = 700
  for (const line of lines) {
    content += `BT /F1 16 Tf 72 ${y} Td (${line.replaceAll('(', '').replaceAll(')', '')}) Tj ET\n`
    y -= 28
  }
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'))
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`
  const xrefAt = Buffer.byteLength(body, 'latin1')
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(body + xref + trailer, 'latin1')
}

async function buildPdf(title: string, spec: Extract<NativeFileSpec, { kind: 'pdf' }>, dir: string, id: string): Promise<Buffer> {
  const txtPath = join(dir, `${id}.txt`)
  writeFileSync(txtPath, [title, '', ...spec.paragraphs].join('\n\n'))
  try {
    const { stdout } = await execFileAsync('/usr/sbin/cupsfilter', ['-D', txtPath], {
      timeout: 15000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'buffer',
    })
    if (stdout.length > 0) return stdout
  } catch {
    // 落到 ASCII 兜底
  }
  return buildAsciiPdfFallback(title)
}

/* ───────────── 对外：按 mock 内容生成（或复用）沙箱里的真实文件 ───────────── */

export class OfficeFixtureStore {
  readonly dir: string

  constructor(root: string) {
    this.dir = join(root, 'fixtures')
    rmSync(this.dir, { recursive: true, force: true })
    mkdirSync(this.dir, { recursive: true })
  }

  /** 沙箱里残留的 .txt 中间文件也一并清掉（构造时整目录已重建，这里防御性兜底）。 */
  cleanup(): void {
    try {
      for (const name of readdirSync(this.dir)) {
        if (name.endsWith('.txt')) rmSync(join(this.dir, name))
      }
    } catch {
      // 目录不存在时静默
    }
  }

  async materialize(id: string, title: string, spec: NativeFileSpec): Promise<string> {
    const safeId = id.replaceAll(/[^a-zA-Z0-9_-]/g, '_')
    const fileBase = title.replace(/\.(docx|xlsx|pptx|pdf)$/i, '') || '未命名'
    // 落盘文件用真实标题命名（去掉路径非法字符），编辑器标题与渲染层文件标签
    // 拿到的就是展示名；重名再退回内部 ID。
    const prettyBase = fileBase.replaceAll(/[/\\:*?"<>|]/g, ' ').trim() || '未命名'
    let name = `${prettyBase}.${spec.kind}`
    let target = join(this.dir, name)
    if (existsSync(target)) {
      name = `${prettyBase} · ${safeId}.${spec.kind}`
      target = join(this.dir, name)
    }

    if (spec.kind === 'docx') writeFileSync(target, buildDocx(fileBase, spec))
    else if (spec.kind === 'xlsx') writeFileSync(target, buildXlsx(spec))
    else if (spec.kind === 'pptx') writeFileSync(target, buildPptx(spec))
    else writeFileSync(target, await buildPdf(title, spec, this.dir, `${safeId}-pdf`))
    return target
  }
}
