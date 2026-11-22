import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { completeThemeFonts, mirrorThemeFonts } from '../src/main/office/pptx-theme-fonts'

/** pptxgenjs 的主题形状：两个字体块、ea 为空、Hans 是 Office 模板遗留的等线。 */
function themeXml(opts: {
  major: string
  minor: string
  majorEa?: string
  minorEa?: string
  panose?: boolean
}) {
  const panose = opts.panose ? ' panose="020F0302020204030204"' : ''
  const font = (latin: string, ea: string) =>
    `<a:latin typeface="${latin}"${panose}/><a:ea typeface="${ea}"/><a:cs typeface=""/>` +
    `<a:font script="Jpan" typeface="游ゴシック"/><a:font script="Hans" typeface="等线"/>`
  return (
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T">' +
    '<a:themeElements><a:fontScheme name="T">' +
    `<a:majorFont>${font(opts.major, opts.majorEa ?? '')}</a:majorFont>` +
    `<a:minorFont>${font(opts.minor, opts.minorEa ?? '')}</a:minorFont>` +
    '</a:fontScheme></a:themeElements></a:theme>'
  )
}

describe('mirrorThemeFonts', () => {
  it('把每个字体块的 latin 名字写进空的 ea 和 Hans 脚本表（中英文两套渲染才一致）', () => {
    const out = mirrorThemeFonts(themeXml({ major: '宋体', minor: '黑体' }))
    expect(out).toContain('<a:ea typeface="宋体"/>')
    expect(out).toContain('<a:font script="Hans" typeface="宋体"/>')
    expect(out).toContain('<a:ea typeface="黑体"/>')
    expect(out).toContain('<a:font script="Hans" typeface="黑体"/>')
    expect(out).not.toContain('<a:ea typeface=""/>')
  })

  it('pres.theme 没设过（latin 带 panose）时保持原样', () => {
    const xml = themeXml({ major: 'Calibri Light', minor: 'Calibri', panose: true })
    expect(mirrorThemeFonts(xml)).toBe(xml)
  })

  it('模板已填了 ea 时不覆盖它', () => {
    const out = mirrorThemeFonts(themeXml({ major: 'Arial', minor: 'Arial', majorEa: '宋体', minorEa: '宋体' }))
    expect(out.match(/<a:ea typeface="宋体"\/>/g)).toHaveLength(2)
  })
})

describe('completeThemeFonts', () => {
  it('改写主题部件并重新打包，其它部件不变', async () => {
    const zip = new JSZip()
    zip.file('ppt/theme/theme1.xml', themeXml({ major: '黑体', minor: '黑体' }))
    zip.file('ppt/slides/slide1.xml', '<p:sld/>')
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })

    const out = await completeThemeFonts(bytes)
    const patched = await JSZip.loadAsync(out)
    expect(await patched.file('ppt/theme/theme1.xml')!.async('string')).toContain(
      '<a:font script="Hans" typeface="黑体"/>',
    )
    expect(await patched.file('ppt/slides/slide1.xml')!.async('string')).toBe('<p:sld/>')
  })

  it('没有主题部件时原样返回', async () => {
    const zip = new JSZip()
    zip.file('ppt/slides/slide1.xml', '<p:sld/>')
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    expect(await completeThemeFonts(bytes)).toBe(bytes)
  })
})