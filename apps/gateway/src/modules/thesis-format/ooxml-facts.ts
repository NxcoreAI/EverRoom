/**
 * docx 版式事实抽取：styles.xml / document.xml sectPr / 页眉页脚 → 粗粒度 JSON，
 * 供解析代理与条文规则相互印证。单位换算：w:sz 半磅→pt；twips→mm（/56.6929）。
 * 抽取失败抛错由上层容忍（单成员失败不阻断整包）。
 */

import JSZip from "jszip";

const TWIPS_PER_MM = 56.6929;

export interface OoxmlStyleFact {
  id: string;
  name: string;
  fontEastAsia?: string;
  fontAscii?: string;
  sizePt?: number;
  bold?: boolean;
  lineSpacingMultiple?: number;
  lineSpacingExactPt?: number;
  align?: string;
  firstLineIndentChars?: number;
}

export interface OoxmlSectionFact {
  widthMm?: number;
  heightMm?: number;
  marginTopMm?: number;
  marginBottomMm?: number;
  marginLeftMm?: number;
  marginRightMm?: number;
  gutterMm?: number;
  pageFormat?: string;
}

export interface OoxmlFacts {
  styles: OoxmlStyleFact[];
  sections: OoxmlSectionFact[];
  headers: Array<{ file: string; text: string }>;
  footers: Array<{ file: string; text: string }>;
}

function attr(xml: string, name: string): number | undefined {
  const m = xml.match(new RegExp(`\\bw:${name}="(-?\\d+)"`));
  if (!m) return undefined;
  const value = Number(m[1]);
  return Number.isFinite(value) ? value : undefined;
}

function stripTags(xml: string): string {
  return (xml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("");
}

function paragraphFact(pPr: string): Pick<OoxmlStyleFact, "lineSpacingMultiple" | "lineSpacingExactPt" | "align" | "firstLineIndentChars"> {
  const fact: Pick<OoxmlStyleFact, "lineSpacingMultiple" | "lineSpacingExactPt" | "align" | "firstLineIndentChars"> = {};
  const spacing = pPr.match(/<w:spacing[^>]*\/>/)?.[0];
  if (spacing) {
    const line = attr(spacing, "line");
    const rule = spacing.match(/\bw:lineRule="(\w+)"/)?.[1];
    if (line !== undefined) {
      if (rule === "exact" || rule === "atLeast") fact.lineSpacingExactPt = Math.round((line / 20) * 10) / 10;
      else fact.lineSpacingMultiple = Math.round((line / 240) * 100) / 100;
    }
  }
  const align = pPr.match(/<w:jc[^>]*\bw:val="(\w+)"/)?.[1];
  if (align) fact.align = align;
  const ind = pPr.match(/<w:ind[^>]*\/>/)?.[0];
  if (ind) {
    const chars = ind.match(/\bw:firstLineChars="(\d+)"/);
    if (chars) fact.firstLineIndentChars = Number(chars[1]) / 100;
  }
  return fact;
}

function runFact(rPr: string): Pick<OoxmlStyleFact, "fontEastAsia" | "fontAscii" | "sizePt" | "bold"> {
  const fact: Pick<OoxmlStyleFact, "fontEastAsia" | "fontAscii" | "sizePt" | "bold"> = {};
  const fonts = rPr.match(/<w:rFonts[^>]*\/>/)?.[0];
  if (fonts) {
    const eastAsia = fonts.match(/\bw:eastAsia="([^"]+)"/)?.[1];
    if (eastAsia) fact.fontEastAsia = eastAsia;
    const ascii = fonts.match(/\bw:ascii="([^"]+)"/)?.[1];
    if (ascii) fact.fontAscii = ascii;
  }
  const sz = attr(rPr, "sz");
  if (sz !== undefined) fact.sizePt = sz / 2;
  fact.bold = /<w:b\b/.test(rPr);
  return fact;
}

export async function extractOoxmlFactsAsync(bytes: Buffer): Promise<OoxmlFacts> {
  const zip = await JSZip.loadAsync(bytes);

  const styles: OoxmlStyleFact[] = [];
  const stylesXml = await zip.file("word/styles.xml")?.async("string").catch(() => undefined);
  if (stylesXml) {
    const styleBlocks = stylesXml.match(/<w:style [^>]*>[\s\S]*?<\/w:style>/g) ?? [];
    for (const block of styleBlocks) {
      const id = block.match(/\bw:styleId="([^"]+)"/)?.[1];
      if (!id) continue;
      const name = block.match(/<w:name[^>]*\bw:val="([^"]+)"/)?.[1] ?? id;
      const relevant = /^Heading/i.test(id) || id === "Normal" || /标题|正文/.test(name);
      if (!relevant && styles.length >= 40) continue;
      const rPr = block.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] ?? "";
      const pPr = block.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
      styles.push({ id, name, ...runFact(rPr), ...paragraphFact(pPr) });
    }
  }

  const sections: OoxmlSectionFact[] = [];
  const documentXml = await zip.file("word/document.xml")?.async("string").catch(() => undefined);
  if (documentXml) {
    const sectBlocks = documentXml.match(/<w:sectPr[^>]*>[\s\S]*?<\/w:sectPr>|<w:sectPr[^>]*\/>/g) ?? [];
    for (const sect of sectBlocks.slice(0, 10)) {
      const pgSz = sect.match(/<w:pgSz[^>]*\/>/)?.[0] ?? "";
      const pgMar = sect.match(/<w:pgMar[^>]*\/>/)?.[0] ?? "";
      const fact: OoxmlSectionFact = {};
      const w = attr(pgSz, "w");
      const h = attr(pgSz, "h");
      if (w) fact.widthMm = Math.round((w / TWIPS_PER_MM) * 10) / 10;
      if (h) fact.heightMm = Math.round((h / TWIPS_PER_MM) * 10) / 10;
      const top = attr(pgMar, "top");
      const bottom = attr(pgMar, "bottom");
      const left = attr(pgMar, "left");
      const right = attr(pgMar, "right");
      const gutter = attr(pgMar, "gutter");
      if (top !== undefined) fact.marginTopMm = Math.round((top / TWIPS_PER_MM) * 10) / 10;
      if (bottom !== undefined) fact.marginBottomMm = Math.round((bottom / TWIPS_PER_MM) * 10) / 10;
      if (left !== undefined) fact.marginLeftMm = Math.round((left / TWIPS_PER_MM) * 10) / 10;
      if (right !== undefined) fact.marginRightMm = Math.round((right / TWIPS_PER_MM) * 10) / 10;
      if (gutter !== undefined) fact.gutterMm = Math.round((gutter / TWIPS_PER_MM) * 10) / 10;
      const fmt = sect.match(/<w:pgNumType[^>]*\bw:fmt="(\w+)"/)?.[1];
      if (fmt) fact.pageFormat = fmt;
      sections.push(fact);
    }
  }

  const headers: Array<{ file: string; text: string }> = [];
  const footers: Array<{ file: string; text: string }> = [];
  for (const path of Object.keys(zip.files)) {
    if (!/^word\/(header|footer)\d*\.xml$/.test(path)) continue;
    const xml = await zip.file(path)!.async("string").catch(() => "");
    if (!xml) continue;
    const text = stripTags(xml).trim();
    const entry = { file: path.replace(/^word\//, ""), text: text.slice(0, 200) };
    if (path.includes("header")) headers.push(entry);
    else footers.push(entry);
  }

  return { styles, sections, headers, footers };
}
