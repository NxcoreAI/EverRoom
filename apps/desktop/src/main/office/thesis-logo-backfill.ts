/**
 * 装订版 docx 的页眉 logo 回填（后处理）。
 *
 * 背景：论文装订走「提取规则 → 重新排版」，格式卡里的版式规则会被重新渲染，
 * 模版文件本身不参与输出。正文的表格/图片走 original 块字节保真，但页眉部件
 * 由引擎全新生成——模版页眉里的校徽 logo 因此丢失。
 *
 * 解析管线已把模版页眉图片（data:URL + 版位事实）抽进格式卡 header.images；
 * 这里在 buildThesisDocx 产出后，把图片按原版位写回输出的页眉部件：
 * media part + 页眉 rels + inline/anchor drawing 注入 + Content-Types 默认项。
 * 纯 zip/字符串手术，不动 genoffice submodule。
 */

import JSZip from 'jszip'

/** genoffice 同款 EMU 换算：14400 EMU/px @96dpi。 */
const EMU_PER_PX = 9525

interface LogoImage {
  dataUrl: string
  widthPx?: number
  heightPx?: number
  floating?: boolean
  behind?: boolean
  posH?: string
  posV?: string
  posXPx?: number
  posYPx?: number
  posHRel?: string
  posVRel?: string
}

function dataUrlToPart(dataUrl: string): { base64: string; ext: string } | null {
  const m = /^data:image\/(png|jpeg|gif|bmp|x-emf|x-wmf);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!m) return null
  const ext = m[1] === 'jpeg' ? 'jpeg' : m[1] === 'x-emf' ? 'emf' : m[1] === 'x-wmf' ? 'wmf' : m[1]
  return { base64: m[2], ext }
}

function logoExtentEmu(image: LogoImage): { cx: number; cy: number } {
  // 缺尺寸时给保守默认（2cm × 2cm @96dpi ≈ 76px），Word 里仍可手动调
  const widthPx = image.widthPx && image.widthPx > 0 ? image.widthPx : 76
  const heightPx = image.heightPx && image.heightPx > 0 ? image.heightPx : 76
  return { cx: Math.round(widthPx * EMU_PER_PX), cy: Math.round(heightPx * EMU_PER_PX) }
}

/** 内联图片的 w:drawing 片段（随文，跟随段落对齐）。 */
function inlineDrawingXml(rId: number, image: LogoImage): string {
  const { cx, cy } = logoExtentEmu(image)
  const docPr = 9500 + rId
  return (
    '<w:drawing>'
    + `<wp:inline distT="0" distB="0" distL="0" distR="0">`
    + `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
    + `<wp:docPr id="${docPr}" name="thesis-logo-${rId}"/>`
    + `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>`
    + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">`
    + `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:nvPicPr><pic:cNvPr id="${docPr}" name="thesis-logo-${rId}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="rId${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`
  )
}

/** 浮动图片的 w:drawing 片段（按模版里的版位事实定位）。 */
function anchoredDrawingXml(rId: number, image: LogoImage): string {
  const { cx, cy } = logoExtentEmu(image)
  const docPr = 9500 + rId
  const posHRel = image.posHRel === 'page' ? 'page' : 'margin'
  const posVRel = image.posVRel === 'page' ? 'page' : image.posVRel === 'paragraph' ? 'paragraph' : 'margin'
  const behindAttr = image.behind ? ' behindDoc="1"' : ' behindDoc="0"'
  const posH = image.posXPx !== undefined && image.posXPx !== 0
    ? `<wp:posOffset>${Math.round(image.posXPx * EMU_PER_PX)}</wp:posOffset>`
    : `<wp:align>${image.posH ?? 'center'}</wp:align>`
  const posV = image.posYPx !== undefined && image.posYPx !== 0
    ? `<wp:posOffset>${Math.round(image.posYPx * EMU_PER_PX)}</wp:posOffset>`
    : `<wp:align>${image.posV ?? 'top'}</wp:align>`
  return (
    '<w:drawing>'
    + `<wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="0"${behindAttr} locked="0" layoutInCell="1" allowOverlap="1">`
    + `<wp:simplePos x="0" y="0"/>`
    + `<wp:positionH relativeFrom="${posHRel}">${posH}</wp:positionH>`
    + `<wp:positionV relativeFrom="${posVRel}">${posV}</wp:positionV>`
    + `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
    + `<wp:wrapNone/>`
    + `<wp:docPr id="${docPr}" name="thesis-logo-${rId}"/>`
    + `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>`
    + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">`
    + `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:nvPicPr><pic:cNvPr id="${docPr}" name="thesis-logo-${rId}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="rId${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + `</pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing>`
  )
}

/**
 * 把格式卡里的页眉图片回填进装订版 docx。
 * 返回原字节（无图片/找不到页眉部件时不动，由调用方决定是否提示）。
 */
/** 过滤出结构合法的图片事实（最多 limit 张）。 */
function pickImages(input: Array<Record<string, unknown>> | undefined, limit: number): LogoImage[] {
  const out: LogoImage[] = []
  for (const raw of (input ?? []).slice(0, limit)) {
    if (!raw || typeof raw !== 'object') continue
    const candidate = raw as { dataUrl?: unknown }
    if (typeof candidate.dataUrl !== 'string' || !candidate.dataUrl.startsWith('data:image/')) continue
    out.push(raw as unknown as LogoImage)
  }
  return out
}

/** 保证 [Content_Types].xml 里有这些图片扩展名的默认项。 */
async function ensureContentTypes(zip: JSZip, images: LogoImage[]): Promise<void> {
  const file = zip.file('[Content_Types].xml')
  if (!file) return
  let contentTypes = await file.async('string')
  for (const ext of new Set(images.map((image) => dataUrlToPart(image.dataUrl)?.ext).filter((value): value is string => Boolean(value)))) {
    if (new RegExp(`Extension="${ext}"`).test(contentTypes)) continue
    const mime = ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'bmp' ? 'image/bmp' : ext === 'emf' ? 'image/x-emf' : ext === 'wmf' ? 'image/x-wmf' : 'image/png'
    contentTypes = contentTypes.replace('</Types>', `<Default Extension="${ext}" ContentType="${mime}"/></Types>`)
  }
  zip.file('[Content_Types].xml', contentTypes)
}

/**
 * 把封面图片（校徽）插到输出正文最前——装订引擎重建封面时不会带原封面图，
 * 模版里的学校标识因此丢失（用户报「导入模版后 logo 不见了」）。
 */
async function injectCoverLogo(zip: JSZip, image: LogoImage): Promise<boolean> {
  const documentFile = zip.file('word/document.xml')
  const relsFile = zip.file('word/_rels/document.xml.rels')
  if (!documentFile || !relsFile) return false
  const part = dataUrlToPart(image.dataUrl)
  if (!part) return false

  let relsXml = await relsFile.async('string')
  const nextRel = (relsXml.match(/Id="rId(\d+)"/g) ?? [])
    .reduce((max, match) => Math.max(max, Number(match.match(/\d+/)?.[0] ?? 0)), 0) + 1
  const mediaPath = `word/media/thesiscover${nextRel}.${part.ext}`
  zip.file(mediaPath, part.base64, { base64: true })
  relsXml = relsXml.replace(
    '</Relationships>',
    `<Relationship Id="rId${nextRel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/thesiscover${nextRel}.${part.ext}"/></Relationships>`,
  )
  zip.file('word/_rels/document.xml.rels', relsXml)

  const documentXml = await documentFile.async('string')
  const bodyOpen = documentXml.indexOf('<w:body>')
  const firstParagraph = documentXml.search(/<w:p[\s>]/)
  if (firstParagraph < 0) return false
  const align = image.posH === 'left' || image.posH === 'right' ? image.posH : 'center'
  const drawing = inlineDrawingXml(nextRel, image)
  // 居中段落 + 内联图：与模版封面「校徽在上、校名在下」的版式一致。
  const paragraph = `<w:p><w:pPr><w:jc w:val="${align}"/></w:pPr><w:r>${drawing}</w:r></w:p>`
  const insertAt = firstParagraph > bodyOpen && bodyOpen >= 0 ? firstParagraph : documentXml.indexOf('>', bodyOpen) + 1
  zip.file('word/document.xml', documentXml.slice(0, insertAt) + paragraph + documentXml.slice(insertAt))
  await ensureContentTypes(zip, [image])
  return true
}

/** 从格式卡里取封面图（cover.logo）。 */
export async function backfillThesisCoverLogo(
  bytes: Uint8Array,
  logo: Record<string, unknown> | undefined,
): Promise<Uint8Array> {
  const [image] = pickImages(logo ? [logo] : [], 1)
  if (!image) return bytes
  const zip = await JSZip.loadAsync(bytes)
  const injected = await injectCoverLogo(zip, image)
  if (!injected) return bytes
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } })
}

export async function backfillThesisHeaderLogos(
  bytes: Uint8Array,
  images: Array<Record<string, unknown>>,
): Promise<Uint8Array> {
  const logos = pickImages(images, 6)
  if (logos.length === 0) return bytes

  const zip = await JSZip.loadAsync(bytes)
  const documentFile = zip.file('word/document.xml')
  const documentRelsFile = zip.file('word/_rels/document.xml.rels')
  if (!documentFile || !documentRelsFile) return bytes

  // 输出文档最后一个 sectPr（正文节）的默认页眉引用 → 页眉部件路径
  const documentXml = await documentFile.async('string')
  const sectBlocks = documentXml.match(/<w:sectPr[^>]*>[\s\S]*?<\/w:sectPr>/g) ?? []
  const trailingSect = sectBlocks[sectBlocks.length - 1]
  if (!trailingSect) return bytes
  const headerRef = trailingSect.match(/<w:headerReference[^>]*w:type="default"[^>]*\/>/)
    ?? trailingSect.match(/<w:headerReference[^>]*\/>/)
  const headerRId = headerRef?.[0]?.match(/r:id="([^"]+)"/)?.[1]
  if (!headerRId) return bytes

  const documentRelsXml = await documentRelsFile.async('string')
  const headerTarget = (documentRelsXml.match(new RegExp(`<Relationship [^>]*Id="${headerRId}"[^>]*>`))?.[0] ?? '')
    .match(/Target="([^"]+)"/)?.[1]
  if (!headerTarget) return bytes
  const headerPath = headerTarget.startsWith('/')
    ? headerTarget.slice(1)
    : `word/${headerTarget.replace(/^\.\//, '')}`
  const headerFile = zip.file(headerPath)
  if (!headerFile) return bytes

  const headerRelsPath = headerPath.replace(/([^/]+)$/, '_rels/$1.rels')
  const headerRelsFile = zip.file(headerRelsPath)
  let headerRelsXml = headerRelsFile
    ? await headerRelsFile.async('string')
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
  let nextRel = (headerRelsXml.match(/Id="rId(\d+)"/g) ?? [])
    .reduce((max, m) => Math.max(max, Number(m.match(/\d+/)?.[0] ?? 0)), 0) + 1

  // media 落盘（同字节去重）
  const mediaByContent = new Map<string, number>()
  const headerXml = await headerFile.async('string')
  let nextHeaderXml = headerXml
  for (const logo of logos) {
    const part = dataUrlToPart(logo.dataUrl)
    if (!part) continue
    let logoRId = mediaByContent.get(part.base64)
    if (logoRId === undefined) {
      logoRId = nextRel++
      const mediaPath = `word/media/thesislogo${logoRId}.${part.ext}`
      zip.file(mediaPath, part.base64, { base64: true })
      headerRelsXml = headerRelsXml.replace(
        '</Relationships>',
        `<Relationship Id="rId${logoRId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/thesislogo${logoRId}.${part.ext}"/></Relationships>`,
      )
      mediaByContent.set(part.base64, logoRId)
    }
    const drawing = logo.floating ? anchoredDrawingXml(logoRId, logo) : inlineDrawingXml(logoRId, logo)
    const run = `<w:r>${drawing}</w:r>`
    // 图片段落插在页眉最前（浮动图不占位；内联图在文字行上方，符合"校徽在上"惯例）
    const pOpen = nextHeaderXml.search(/<w:p[\s/>]/)
    if (pOpen >= 0) {
      const insertAt = logo.floating
        ? pOpen
        : nextHeaderXml.indexOf('>', nextHeaderXml.indexOf('<w:pPr', pOpen)) + 1 || pOpen
      nextHeaderXml = nextHeaderXml.slice(0, insertAt) + run + nextHeaderXml.slice(insertAt)
    } else {
      nextHeaderXml = nextHeaderXml.replace(/(<w:hdr[^>]*>)/, `$1<w:p>${run}</w:p>`)
    }
  }
  if (nextHeaderXml === headerXml) return bytes

  zip.file(headerPath, nextHeaderXml)
  zip.file(headerRelsPath, headerRelsXml)

  // [Content_Types].xml 补图片默认项
  await ensureContentTypes(zip, logos)

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } })
}
