import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { selfCheckThesisDocx } from '../src/main/office/thesis-selfcheck'

const LOGO_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

async function docxWith(options: { media?: boolean; header?: boolean; unmatched?: boolean } = {}): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
  zip.file(
    'word/document.xml',
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:rFonts w:eastAsia="黑体"/></w:rPr><w:t>一、项目任务</w:t></w:r></w:p>'
    + (options.unmatched ? '<w:p><w:r><w:t>未归类内容（模板无对应槽位，请人工归位）</w:t></w:r></w:p>' : '')
    + '</w:body></w:document>',
  )
  if (options.header) zip.file('word/header1.xml', '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>')
  if (options.media) zip.file('word/media/image1.png', LOGO_PNG, { base64: true })
  return zip.generateAsync({ type: 'uint8array' })
}

describe('论文排版生成后自检', () => {
  it('logo 字节一致 + 页眉存在 + 未归类小节如预期 → ok', async () => {
    const result = await selfCheckThesisDocx(await docxWith({ media: true, header: true, unmatched: true }), {
      expectLogos: [{ role: 'cover', dataUrl: `data:image/png;base64,${LOGO_PNG}` }],
      headerEnabled: true,
      expectUnmatchedSection: true,
      expectHeadingFont: '黑体',
    })
    expect(result.ok).toBe(true)
    expect(result.failures).toEqual([])
  })

  it('logo 被重编码/丢失 → 硬伤', async () => {
    const result = await selfCheckThesisDocx(await docxWith({ media: false }), {
      expectLogos: [{ role: 'cover', dataUrl: `data:image/png;base64,${LOGO_PNG}` }],
    })
    expect(result.ok).toBe(false)
    expect(result.failures[0]).toContain('字节与模版不一致')
  })

  it('声明启用页眉但没有部件 → 硬伤', async () => {
    const result = await selfCheckThesisDocx(await docxWith({}), { expectLogos: [], headerEnabled: true })
    expect(result.failures.join()).toContain('没有页眉部件')
  })

  it('有未匹配块却没出小节 → 硬伤；反之只提示', async () => {
    const missing = await selfCheckThesisDocx(await docxWith({}), { expectLogos: [], expectUnmatchedSection: true })
    expect(missing.ok).toBe(false)
    const extra = await selfCheckThesisDocx(await docxWith({ unmatched: true }), { expectLogos: [], expectUnmatchedSection: false })
    expect(extra.ok).toBe(true)
    expect(extra.warnings.join()).toContain('没有未匹配块')
  })

  it('标题字体与模板锁不一致 → 软伤提示', async () => {
    const result = await selfCheckThesisDocx(await docxWith({}), { expectLogos: [], expectHeadingFont: '宋体' })
    expect(result.ok).toBe(true)
    expect(result.warnings.join()).toContain('与模板锁 宋体 不一致')
  })
})
