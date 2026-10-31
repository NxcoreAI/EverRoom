import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { backfillThesisCoverLogo, backfillThesisHeaderLogos } from '../src/main/office/thesis-logo-backfill'

/** 最小可用 docx：三节结构（封面/前置/正文），正文节带默认页眉引用。 */
async function boundDocxWithHeader(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>'
    + '</Types>',
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  )
  zip.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>',
  )
  // 封面 sectPr（无页眉）+ 正文尾 sectPr（默认页眉 rId7）
  const sectCover = '<w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr></w:p>'
  const body = '<w:p><w:r><w:t>正文</w:t></w:r></w:p>'
  const sectTrailing = '<w:sectPr><w:headerReference w:type="default" r:id="rId7"/><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>'
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<w:body>${sectCover}${body}${sectTrailing}</w:body></w:document>`,
  )
  zip.file(
    'word/header1.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>论文标题</w:t></w:r></w:p></w:hdr>',
  )
  return zip.generateAsync({ type: 'uint8array' })
}

const LOGO_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('backfillThesisHeaderLogos', () => {
  it('把格式卡页眉图片写进输出页眉部件（media + rels + drawing）', async () => {
    const bytes = await backfillThesisHeaderLogos(await boundDocxWithHeader(), [
      { dataUrl: LOGO_PNG, widthPx: 40, heightPx: 40, floating: true, posH: 'center', posV: 'top', posHRel: 'margin', posVRel: 'margin' },
    ])
    const zip = await JSZip.loadAsync(bytes)
    const header = await zip.file('word/header1.xml')!.async('string')
    expect(header).toContain('<w:drawing>')
    expect(header).toContain('r:embed="rId1"')
    expect(header).toContain('wp:anchor')
    expect(header).toContain('behindDoc="0"')
    // media part 与页眉 rels 落盘
    expect(zip.file('word/media/thesislogo1.png')).not.toBeNull()
    const headerRels = await zip.file('word/_rels/header1.xml.rels')!.async('string')
    expect(headerRels).toContain('Target="../media/thesislogo1.png"')
    // Content-Types 补 png 默认项
    const contentTypes = await zip.file('[Content_Types].xml')!.async('string')
    expect(contentTypes).toContain('Extension="png"')
  })

  it('同字节多图去重共用一个 media part', async () => {
    const bytes = await backfillThesisHeaderLogos(await boundDocxWithHeader(), [
      { dataUrl: LOGO_PNG },
      { dataUrl: LOGO_PNG },
    ])
    const zip = await JSZip.loadAsync(bytes)
    expect(zip.file('word/media/thesislogo1.png')).not.toBeNull()
    expect(zip.file('word/media/thesislogo2.png')).toBeNull()
  })

  it('无图片或结构不符时原样返回，不产出损坏包', async () => {
    const original = await boundDocxWithHeader()
    expect(await backfillThesisHeaderLogos(original, [])).toBe(original)
    expect(await backfillThesisHeaderLogos(original, [{ dataUrl: 'not-a-data-url' }])).toBe(original)
  })
})

describe('backfillThesisCoverLogo', () => {
  it('把封面校徽插到正文最前，并注册 media 与文档 rels', async () => {
    const bytes = await backfillThesisCoverLogo(await boundDocxWithHeader(), {
      dataUrl: LOGO_PNG,
      widthPx: 626,
      heightPx: 89,
      posH: 'center',
    })
    const zip = await JSZip.loadAsync(bytes)
    const document = await zip.file('word/document.xml')!.async('string')
    const drawingAt = document.indexOf('<w:drawing>')
    const firstPara = document.search(/<w:p[\s>]/)
    // 插在最前面（封面顶部）且居中
    expect(drawingAt).toBeGreaterThan(0)
    expect(drawingAt).toBeLessThan(document.indexOf('正文'))
    expect(document.slice(firstPara, drawingAt)).toContain('<w:jc w:val="center"/>')
    // 尺寸按模版事实换算（626px * 9525 = 5962650 EMU，容差 ±1px）
    expect(document).toMatch(new RegExp(`<wp:extent cx="${626 * 9525}" cy="${89 * 9525}"/>`))

    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string')
    expect(rels).toContain('thesiscover')
    expect(Object.keys(zip.files).some((name) => /^word\/media\/thesiscover\d+\.png$/.test(name))).toBe(true)
  })

  it('没有封面图时原样返回', async () => {
    const original = await boundDocxWithHeader()
    expect(await backfillThesisCoverLogo(original, undefined)).toBe(original)
    expect(await backfillThesisCoverLogo(original, { dataUrl: 'bad' })).toBe(original)
  })
})
