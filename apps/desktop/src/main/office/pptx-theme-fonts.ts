import JSZip from 'jszip'

/**
 * pptxgenjs writes `pres.theme` into `<a:latin>` only and leaves `<a:ea typeface=""/>`, plus
 * the Office template's `<a:font script="Hans" typeface="等线">`. PowerPoint/WPS then draw
 * Chinese with the Hans face (等线) while GenOffice falls back to the latin face — the same deck
 * shows two different Chinese fonts. Mirror each font block's latin face into its empty
 * `<a:ea>` and its Hans entry so every renderer reads one face.
 *
 * The agent is told to call `applyTheme` (which does the same), but it may skip that call when
 * all colors are hex; this runs on the produced bytes so the theme is complete either way.
 * A block carrying `panose=` is pptxgenjs's stock theme — `pres.theme` was never set, and no
 * face was declared for CJK, so it is left alone.
 */
const THEME_PART = 'ppt/theme/theme1.xml'

const escapeAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function mirrorThemeFonts(xml: string): string {
  return xml.replace(
    /<a:(majorFont|minorFont)>([\s\S]*?)<\/a:\1>/g,
    (block: string, tag: string, body: string) => {
      if (/<a:latin[^>]*\bpanose=/.test(body)) return block
      const latin = /<a:latin typeface="([^"]+)"/.exec(body)
      if (!latin) return block
      const face = escapeAttr(latin[1]!)
      return (
        `<a:${tag}>` +
        body
          .replace(/<a:ea typeface=""/, `<a:ea typeface="${face}"`)
          .replace(/<a:font script="Hans" typeface="[^"]*"/, `<a:font script="Hans" typeface="${face}"`) +
        `</a:${tag}>`
      )
    },
  )
}

/** Rewrite the deck's theme part in place (in memory); returns the original bytes when untouched. */
export async function completeThemeFonts(bytes: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes)
  const part = zip.file(THEME_PART)
  if (!part) return bytes
  const xml = await part.async('string')
  const patched = mirrorThemeFonts(xml)
  if (patched === xml) return bytes
  zip.file(THEME_PART, patched)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
