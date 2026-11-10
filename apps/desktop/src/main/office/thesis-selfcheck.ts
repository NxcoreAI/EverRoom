/**
 * 论文排版 · 生成后自检（方案 §7.3）。
 *
 * 出稿前把结果拆开核对一遍：块是否都在、logo 字节有没有被重编码、页眉页脚在不在、
 * 标题样式是否真的套上了模板锁。硬伤直接抛错（宁可不给文件，也不给一个"看起来
 * 正常"的假货）；软伤进 warnings 供 UI 提示。
 */

import JSZip from 'jszip'

export interface ThesisSelfCheckInput {
  /** 格式卡的 logo 字节（data:URL）；用于逐字节比对。 */
  expectLogos: Array<{ role: string; dataUrl: string }>
  /** 卡片是否声明启用页眉/页脚。 */
  headerEnabled?: boolean
  footerEnabled?: boolean
  tocEnabled?: boolean
  /** 预期存在未归类小节（有未匹配块时为 true）。 */
  expectUnmatchedSection?: boolean
  /** 首级标题应有的中文字体（抽样比对）。 */
  expectHeadingFont?: string
}

export interface ThesisSelfCheckResult {
  ok: boolean
  /** 硬伤（抛错用）。 */
  failures: string[]
  /** 软伤（warnings）。 */
  warnings: string[]
}

/** data:URL → base64 载荷（去掉前缀）。 */
function base64Of(dataUrl: string): string | null {
  const match = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl)
  return match ? match[1]! : null
}

/**
 * 自检。抛错由调用方决定（本函数只报告）。
 */
export async function selfCheckThesisDocx(bytes: Uint8Array, input: ThesisSelfCheckInput): Promise<ThesisSelfCheckResult> {
  const failures: string[] = []
  const warnings: string[] = []
  const zip = await JSZip.loadAsync(bytes)

  const documentFile = zip.file('word/document.xml')
  if (!documentFile) return { ok: false, failures: ['输出缺少 word/document.xml'], warnings }
  const documentXml = await documentFile.async('string')

  // 1) logo 逐字节比对：渲染链路绝不能重编码图片
  for (const logo of input.expectLogos) {
    const base64 = base64Of(logo.dataUrl)
    if (!base64) continue
    const mediaFiles = Object.keys(zip.files).filter((name) => /^word\/media\/[^/]+\.(png|jpe?g|gif|bmp|emf|wmf)$/i.test(name))
    let found = false
    for (const name of mediaFiles) {
      const content = await zip.file(name)!.async('base64')
      if (content === base64) {
        found = true
        break
      }
    }
    if (!found) failures.push(`${logo.role} 图片字节与模版不一致（${mediaFiles.length} 个媒体文件里没有相同内容）`)
  }

  // 2) 页眉/页脚部件
  const headerParts = Object.keys(zip.files).filter((name) => /^word\/header\d*\.xml$/.test(name))
  const footerParts = Object.keys(zip.files).filter((name) => /^word\/footer\d*\.xml$/.test(name))
  if (input.headerEnabled && headerParts.length === 0) failures.push('声明启用页眉但输出没有页眉部件')
  if (input.footerEnabled && footerParts.length === 0) warnings.push('声明启用页脚但输出没有页脚部件')

  // 3) 目录域
  if (input.tocEnabled && !/TOC\s+\\o/.test(documentXml)) warnings.push('声明启用目录但未找到 TOC 域代码')

  // 4) 未归类小节的显隐一致性
  const hasUnmatchedMarker = documentXml.includes('未归类内容')
  if (input.expectUnmatchedSection === true && !hasUnmatchedMarker) failures.push('映射报告有未匹配块，但输出里没有「未归类内容」小节')
  if (input.expectUnmatchedSection === false && hasUnmatchedMarker) warnings.push('没有未匹配块，但输出出现了「未归类内容」小节')

  // 5) 标题样式抽样：抽第一个标题 run，核对中文字体是否来自模板锁
  if (input.expectHeadingFont) {
    const headingRun = /<w:pStyle w:val="Heading1"\/>[\s\S]{0,400}?<w:rFonts[^>]*w:eastAsia="([^"]+)"/.exec(documentXml)
      ?? /<w:pStyle w:val="Heading1"\/>[\s\S]{0,600}?<w:rFonts[^>]*w:eastAsia="([^"]+)"/.exec(documentXml)
    if (headingRun && headingRun[1] !== input.expectHeadingFont) {
      warnings.push(`一级标题中文字体为 ${headingRun[1]}，与模板锁 ${input.expectHeadingFont} 不一致`)
    }
    if (!headingRun) warnings.push('未从正文抽到一级标题的字体信息，样式抽样跳过')
  }

  return { ok: failures.length === 0, failures, warnings }
}