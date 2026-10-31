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

/** 页眉/页脚里的展示图片（校徽 logo 等）：字节内联 + 版位事实，装订引擎回填用。 */
export interface OoxmlHfImageFact {
  /** data:image/...;base64 URL。 */
  dataUrl: string;
  widthPx?: number;
  heightPx?: number;
  /** 浮动（wp:anchor）；false/缺省 = 内联随文。 */
  floating?: boolean;
  /** 衬于文字下方（图片水印）。 */
  behind?: boolean;
  posH?: "left" | "center" | "right";
  posV?: "top" | "center" | "bottom";
  posXPx?: number;
  posYPx?: number;
  posHRel?: "page" | "margin";
  posVRel?: "page" | "margin" | "paragraph";
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

/** 模板正文大纲条目（模板自身的章节骨架——槽位识别的唯一来源）。 */
/** 模板固定表单块：placement=prelim（首个槽位之前，如评审表）| appendix（最后一个槽位之后）。 */
export interface OoxmlFixedBlockFact {
  placement: 'prelim' | 'appendix'
  /** 前置标题文本（作为回插时的小节标题；可空）。 */
  heading?: string
  /** 原样块 XML（w:tbl 或 w:p 序列拼接）。 */
  xml: string
}

export interface OoxmlOutlineEntry {
  /** 段落序号（正文段落顺序，含非标题段，用于定位插入点）。 */
  index: number;
  /** 1–4；来自样式或段落 pPr 的 outlineLvl。 */
  level: number;
  text: string;
  styleId?: string;
  /** 该段落自身的编号引用（numId/ilvl），用于反推编号方案。 */
  numId?: number;
  ilvl?: number;
  /** 是否落在封面区（首个分节/分页之前）。 */
  inCoverRegion: boolean;
  /** 标题段落首个 run 的版式事实：样式常留空，段落 run 才是模板真实观感。 */
  runFontEastAsia?: string;
  runSizePt?: number;
  runBold?: boolean;
}

/** 编号方案（numbering.xml + 标题样式的 numPr 反推）。 */
export interface OoxmlNumberingFact {
  scheme: "cn-upper" | "cn-lower" | "decimal-tree" | "decimal-dot" | "none";
  levels: Array<{ level: number; numFmt: string; lvlText: string; start: number; indentTwips?: number }>;
  /** 标题样式实际使用的 numId（可能缺省）。 */
  headingNumId?: number;
}

export interface OoxmlFacts {
  styles: OoxmlStyleFact[];
  sections: OoxmlSectionFact[];
  headers: Array<{ file: string; text: string; images: OoxmlHfImageFact[] }>;
  footers: Array<{ file: string; text: string; images: OoxmlHfImageFact[] }>;
  /** 封面区（首个分节/分页之前）的正文图片：校徽、校名标识等。
   *  这类图不在页眉页脚里，装订重建封面时必须显式回填，否则直接丢失。 */
  coverImages: OoxmlHfImageFact[];
  /** 封面区文本行（段落序，去空行）。代理据此填封面字段，网关也用它兜底。 */
  coverText: string[];
  /** 模板正文大纲（模板自身的章节骨架）：槽位识别的唯一来源。 */
  outline: OoxmlOutlineEntry[];
  /** 模板固定表单（评价表/任务书表格等）：原样 XML + 前置标题，装订时原样回插。
   *  只收不含图片引用（r:embed）的块——跨文档引用 rels 会断，宁可丢弃不产出坏图。 */
  fixedBlocks: OoxmlFixedBlockFact[];
  /** 编号方案（numbering.xml + 标题样式 numPr）。 */
  numbering: OoxmlNumberingFact;
}

function attr(xml: string, name: string): number | undefined {
  const m = xml.match(new RegExp(`\\bw:${name}="(-?\\d+)"`));
  if (!m) return undefined;
  const value = Number(m[1]);
  return Number.isFinite(value) ? value : undefined;
}

/** EMU → 像素（genoffice 同款换算：14400 EMU = 1px @96dpi）。 */
const EMU_PER_PX = 9525;

function numAttr(xml: string, tag: string, name: string): number | undefined {
  const m = xml.match(new RegExp(`<${tag}[^>]*\\s${name}="(\\d+)"`));
  if (!m) return undefined;
  const value = Number(m[1]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * 页眉/页脚部件里的展示图片（logo/水印位图）。抽取字节（data:URL）与版位事实，
 * 供解析代理识别「校徽」并让装订引擎在输出里原样回填。
 */
/** 部件的 rels → rId → data:URL 映射（页眉页脚与正文图片共用）。 */
async function partMediaByRid(zip: JSZip, partPath: string): Promise<Map<string, string>> {
  const relsPath = partPath.replace(/([^/]+)$/, "_rels/$1.rels");
  const relsXml = await zip.file(relsPath)?.async("string").catch(() => undefined);
  const mediaByRid = new Map<string, string>();
  if (!relsXml) return mediaByRid;
  for (const rel of relsXml.match(/<Relationship\s[^>]*>/g) ?? []) {
    const id = rel.match(/\bId="([^"]+)"/)?.[1];
    const target = rel.match(/\bTarget="([^"]+)"/)?.[1];
    if (!id || !target || /TargetMode="External"/i.test(rel)) continue;
    const dir = partPath.includes("/") ? partPath.slice(0, partPath.lastIndexOf("/") + 1) : "";
    const resolved = target.startsWith("/") ? target.slice(1) : dir + target.replace(/^\.\//, "");
    const normalized: string[] = [];
    for (const segment of resolved.split("/")) {
      if (segment === "." || segment === "") continue;
      if (segment === "..") normalized.pop();
      else normalized.push(segment);
    }
    const entry = zip.file(normalized.join("/"));
    if (!entry) continue;
    const bytes = await entry.async("nodebuffer");
    const ext = (normalized.join("/").split(".").pop() ?? "png").toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "gif" ? "image/gif"
      : ext === "bmp" ? "image/bmp"
      : ext === "emf" || ext === "wmf" ? "image/x-emf"
      : "image/png";
    mediaByRid.set(id, `data:${mime};base64,${bytes.toString("base64")}`);
  }
  return mediaByRid;
}

/** 单个绘图块 → 图片事实（字节 + 尺寸 + 浮动版位）。 */
function drawingFact(frag: string, mediaByRid: Map<string, string>): OoxmlHfImageFact | null {
  const rId = frag.match(/r:(?:embed|id)="([^"]+)"/)?.[1];
  const dataUrl = rId ? mediaByRid.get(rId) : undefined;
  if (!dataUrl) return null;
  const image: OoxmlHfImageFact = { dataUrl };
  const cx = numAttr(frag, "wp:extent", "cx");
  const cy = numAttr(frag, "wp:extent", "cy");
  if (cx !== undefined && cx > 0) image.widthPx = Math.round(cx / EMU_PER_PX);
  if (cy !== undefined && cy > 0) image.heightPx = Math.round(cy / EMU_PER_PX);
  if (/<wp:anchor[\s>]/.test(frag)) {
    image.floating = true;
    if (/behindDoc="(?:1|true)"/.test(frag)) image.behind = true;
    const posH = frag.match(/<wp:positionH[^>]*relativeFrom="(page|margin)"[^>]*>[\s\S]*?<wp:align>(\w+)<\/wp:align>/);
    const posV = frag.match(/<wp:positionV[^>]*relativeFrom="(page|margin|paragraph)"[^>]*>[\s\S]*?<wp:align>(\w+)<\/wp:align>/);
    if (posH) { image.posHRel = posH[1] as "page" | "margin"; image.posH = posH[2] as "left" | "center" | "right"; }
    if (posV) { image.posVRel = posV[1] as "page" | "margin" | "paragraph"; image.posV = posV[2] as "top" | "center" | "bottom"; }
    const offH = frag.match(/<wp:positionH[^>]*relativeFrom="(page|margin)"[^>]*>[\s\S]*?<wp:posOffset>(-?\d+)<\/wp:posOffset>/);
    const offV = frag.match(/<wp:positionV[^>]*relativeFrom="(page|margin|paragraph)"[^>]*>[\s\S]*?<wp:posOffset>(-?\d+)<\/wp:posOffset>/);
    if (offH) image.posXPx = Math.round(Number(offH[2]) / EMU_PER_PX);
    if (offV) image.posYPx = Math.round(Number(offV[2]) / EMU_PER_PX);
  }
  return image;
}

async function hfImages(zip: JSZip, partPath: string, partXml: string): Promise<OoxmlHfImageFact[]> {
  if (!partXml.includes("<a:blip") && !partXml.includes("<v:imagedata")) return [];
  const mediaByRid = await partMediaByRid(zip, partPath);
  if (mediaByRid.size === 0) return [];

  const out: OoxmlHfImageFact[] = [];
  for (const m of partXml.matchAll(/<w:drawing[\s\S]*?<\/w:drawing>|<v:imagedata[^>]*>/g)) {
    const image = drawingFact(m[0], mediaByRid);
    if (image) out.push(image);
  }
  return out;
}

/**
 * 封面区的正文图片（校徽、校名标识）。
 *
 * 装订是「提取规则 → 重建文档」：封面由格式卡字段重新生成，原封面里的图片不会
 * 自动带入（用户报「导入模版后 logo 不见了」即此）。这里抽出封面几张图，让装机
 * 时回填到重建后的封面顶部。
 *
 * 封面区 = 首个分节符/分页符之前的内容；最多 3 张（正常只有校徽/校名标识，
 * 避免把正文插图误当封面元素）。
 */
async function coverImages(zip: JSZip, documentXml: string): Promise<OoxmlHfImageFact[]> {
  if (!documentXml.includes("<a:blip") && !documentXml.includes("<v:imagedata")) return [];
  const boundaries = ["<w:sectPr", 'w:type="page"']
    .map((token) => documentXml.indexOf(token))
    .filter((index) => index > 0);
  const cut = boundaries.length > 0 ? Math.min(...boundaries) : documentXml.length;
  const head = documentXml.slice(0, cut);
  if (!head.includes("<a:blip") && !head.includes("<v:imagedata")) return [];
  const mediaByRid = await partMediaByRid(zip, "word/document.xml");
  if (mediaByRid.size === 0) return [];

  const out: OoxmlHfImageFact[] = [];
  for (const para of head.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) ?? []) {
    if (!/<w:drawing[\s>]|<w:pict[\s>]|<v:imagedata/.test(para)) continue;
    // 封面文字行普遍居中；取段落对齐作为图片对齐（inline 图跟随段落）。
    const align = para.match(/<w:jc[^>]*w:val="(left|center|right|both)"/)?.[1];
    for (const m of para.matchAll(/<w:drawing[\s\S]*?<\/w:drawing>|<v:imagedata[^>]*>/g)) {
      const image = drawingFact(m[0], mediaByRid);
      if (!image) continue;
      if (align === "center" || align === "right") image.posH = align;
      else if (align === "left") image.posH = "left";
      out.push(image);
      if (out.length >= 3) return out;
    }
  }
  return out;
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

/** 样式 id → 大纲级别（1–4）：样式自身的 outlineLvl 优先，其次标题样式名。 */
function outlineLevelsByStyle(stylesXml: string | undefined): Map<string, number> {
  const map = new Map<string, number>();
  if (!stylesXml) return map;
  for (const block of stylesXml.match(/<w:style [^>]*>[\s\S]*?<\/w:style>/g) ?? []) {
    const id = block.match(/\bw:styleId="([^"]+)"/)?.[1];
    if (!id) continue;
    const name = block.match(/<w:name[^>]*\bw:val="([^"]+)"/)?.[1] ?? id;
    const declared = block.match(/<w:outlineLvl[^>]*\bw:val="(\d)"/)?.[1];
    if (declared !== undefined) {
      map.set(id, Number(declared) + 1);
      continue;
    }
    const byName = /^heading\s*([1-9])$/i.exec(name.trim()) ?? /^标题\s*([1-9])$/.exec(name.trim());
    if (byName) map.set(id, Number(byName[1]));
  }
  return map;
}

/** 该段落是否有标题语义（样式大纲级 / 段落自带 outlineLvl）。 */
function paragraphOutlineLevel(
  pPr: string,
  styleId: string | undefined,
  levelsByStyle: Map<string, number>,
): number | undefined {
  const declared = pPr.match(/<w:outlineLvl[^>]*\bw:val="(\d)"/)?.[1];
  if (declared !== undefined) return Number(declared) + 1;
  if (styleId) {
    const byStyle = levelsByStyle.get(styleId);
    if (byStyle !== undefined) return byStyle;
    // 样式未登记 outlineLvl 时按名字兜底（中文模板常只有"标题 1"这类名字）
    const byName = /^heading\s*([1-9])$/i.exec(styleId) ?? /^标题\s*([1-9])$/.exec(styleId);
    if (byName) return Number(byName[1]);
  }
  return undefined;
}

/**
 * 普通段落标题的启发式识别。
 *
 * 中文论文模版大量用「普通段落 + 手工编号」排章节标题（根本不套 Heading 样式），
 * 只认 outlineLvl/样式会让大纲为空 —— 槽位骨架随之消失，排版只能回落成
 * 「照内容重建」，模版里的表格/评价表就会被搬离原位。
 *
 * 判据（同时满足才认，宁可漏判也不误判正文）：
 * 1. 文本短（标题不会是一整段话）；
 * 2. 段落没有首行缩进（正文段落的典型特征，标题一般顶格或居中）；
 * 3. 形如「一、」「（一）」「第一章」「1.」「1.1」的编号开头；
 * 4. 不是目录行、不在表格单元格里。
 */
function heuristicHeadingLevel(text: string, pPr: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 40) return undefined;
  // 正文段落的首行缩进：firstLine / firstLineChars 非零即视为正文
  if (/<w:ind[^>]*\bw:firstLine(?:Chars)?="[1-9]/.test(pPr)) return undefined;
  // 手工目录行（带引导点）：「一、项目任务……1」
  if (/[.．·…]{2,}\s*\d{1,4}$/.test(trimmed)) return undefined;
  // 手工目录行（无引导点）：标题后直接黏着页码——「一、项目任务1」「1.1 背景2」。
  // 真章节标题几乎不会以一个紧跟在汉字/字母后面的裸数字收尾；
  // 漏掉这条，目录里的每一行都会进大纲、槽位骨架被成倍污染。
  if (/[一-龥A-Za-z）)]\d{1,4}$/.test(trimmed)) return undefined;
  // 层级要区分：槽位只取顶层标题，把「（一）」当成一级会让二级标题挤进槽位骨架
  if (/^[（(][一二三四五六七八九十]{1,3}[）)]/.test(trimmed)) return 2;
  if (/^[一二三四五六七八九十]{1,3}\s*[、.．]/.test(trimmed)) return 1;
  if (/^第[一二三四五六七八九十百零0-9]{1,4}[章篇]/.test(trimmed)) return 1;
  if (/^第[一二三四五六七八九十百零0-9]{1,4}[节]/.test(trimmed)) return 2;
  // 数字编号：多级「1.1 背景」必须在数字后跟空白，否则「3.5万元预算」「1.5 倍」
  // 这类以小数开头的正文行会被当成标题（实测复现）。
  // 单级「1. 背景」「1.绪论」允许紧贴汉字——紧贴的是数字就说明是小数，不认。
  if (/^[0-9]{1,2}(\.[0-9]{1,2}){1,2}\s+\S/.test(trimmed)) return 2;
  if (/^[0-9]{1,2}\s*、\s*\S/.test(trimmed)) return 1;
  if (/^[0-9]{1,2}\.\s*[一-龥A-Za-z]/.test(trimmed)) return 1;
  return undefined;
}


/**
 * 目录派生大纲：模版正文几乎不用标题样式（手写编号、或整篇只有样式示范文字）时，
 * **模版自己的目录行**就是最可靠的章节骨架。
 *
 * 触发条件：真标题（样式/大纲级/启发式）识别出的正文标题少于 2 条。
 * 目录行特征：带引导点（……/.）或标题后直接黏着页码，例如
 *   「第一章 前言1」「1.1 课程设计的目标1」「2.1.1计算公式3」「2.2计算内容………」
 * 去掉尾部页码后按编号形态定级，与正文启发式同一套规则。
 */

/** 目录行用的是「去页码后的标题」，编号与中文之间常常没有空格，判定可以放宽。 */
function tocHeadingLevel(text: string): number | undefined {
  const strict = heuristicHeadingLevel(text, "");
  if (strict !== undefined) return strict;
  const flat = text.trim();
  if (/^第[一二三四五六七八九十百零0-9]{1,4}[章篇]/.test(flat)) return 1;
  if (/^第[一二三四五六七八九十百零0-9]{1,4}[节]/.test(flat)) return 2;
  if (/^[一二三四五六七八九十]{1,3}\s*[、.．]/.test(flat)) return 1;
  if (/^[（(][一二三四五六七八九十]{1,3}[）)]/.test(flat)) return 2;
  const numbered = /^(\d{1,2}(?:\.\d{1,2}){1,2})\s*[、.．]?\s*[\u4e00-\u9fa5A-Za-z]/.exec(flat);
  if (numbered) return Math.min(4, numbered[1]!.split(".").length);
  if (/^(参考文献|参考资料|附录|致谢|结论与展望)(\s|$|[：:、.．A-Za-z一二三四五六七八九十])/.test(flat)) return 1;
  return undefined;
}

function tocDerivedOutline(
  documentXml: string,
  existing: OoxmlOutlineEntry[],
): OoxmlOutlineEntry[] {
  const realBodyHeadings = existing.filter((entry) => !entry.inCoverRegion).length;
  if (realBodyHeadings >= 2) return [];
  const seen = new Set(existing.map((entry) => entry.text.replace(/\s+/g, "").slice(0, 40)));
  const out: OoxmlOutlineEntry[] = [];
  let paragraphIndex = 0;
  for (const paragraphMatch of documentXml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) {
    const index = paragraphIndex++;
    const paragraph = paragraphMatch[0];
    const text = [...paragraph.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("").trim();
    if (!text || text.length > 60) continue;
    // 目录行的两个特征：引导点 tab / 结尾黏着页码
    const leaderTab = /<w:tab[^>]*w:leader="(dot|hyphen|underscore|middleDot)"/.test(paragraph);
    const pageSuffix = /^(.*?[^\d\s])\s*(\d{1,4})$/.exec(text);
    const dotLeader = /[.．·…]{3,}/.test(text);
    if (!leaderTab && !pageSuffix && !dotLeader) continue;
    const base = pageSuffix?.[1] ?? text;
    const stripped = base.replace(/[.．·…\s]+$/g, "").trim();
    if (!stripped) continue;
    const key = stripped.replace(/\s+/g, "").slice(0, 40);
    if (seen.has(key)) continue;
    const level = tocHeadingLevel(stripped);
    if (level === undefined) continue;
    seen.add(key);
    out.push({
      index,
      level,
      text: stripped.slice(0, 200),
      // 目录可能排在封面之后、正文之前，但它描述的是正文章节：
      // 不能按「封面区」剔除，否则整份骨架又没了。
      inCoverRegion: false,
    });
  }
  return out;
}


/**
 * 模版里的「排版说明行」不是章节标题。
 *
 * 很多学校模版是"样式示范"写法：每个样式旁边跟一行
 * 「黑体三号，段前12磅，行距1.5倍」「宋体小四号，行距1.5倍，余同」。
 * 这些行常常套着标题样式，大纲抽取会把它们当成一级/二级标题，
 * 于是槽位变成「宋体小四号，行距1.5倍」——后面的内容归类全乱。
 */
export function isStyleSpecLine(text: string): boolean {
  const flat = text.replace(/\s+/g, "");
  if (!flat || flat.length > 40) return false;
  const markers = [
    "宋体", "黑体", "楷体", "仿宋", "微软雅黑", "Times", "Arial", "Cambria",
    "行距", "段前", "段后", "磅", "倍", "缩进", "居中", "左对齐", "右对齐", "页边距",
  ].filter((marker) => flat.includes(marker)).length;
  const sizeLike = /[一二三四五]号|小[一二三四五]/.test(flat);
  return markers >= 2 && (sizeLike || flat.includes("行距") || flat.includes("段前") || flat.includes("段后"));
}

/** 模板正文大纲：标题段落序列（槽位骨架）。 */
function outlineFacts(documentXml: string, stylesXml: string | undefined): OoxmlOutlineEntry[] {
  const levelsByStyle = outlineLevelsByStyle(stylesXml);
  const boundaries = ["<w:sectPr", 'w:type="page"']
    .map((token) => documentXml.indexOf(token))
    .filter((position) => position > 0);
  const coverCut = boundaries.length > 0 ? Math.min(...boundaries) : 0;

  // 表格区间：<w:tbl>…</w:tbl>（含嵌套，按最外层配对）。表格单元格里的「1.」「（一）」
  // 是表单行，不是章节标题——启发式会误认，把槽位骨架污染成表格行清单。
  const tableRanges: Array<[number, number]> = [];
  const tableOpen = /<w:tbl>/g;
  for (const match of documentXml.matchAll(tableOpen)) {
    const start = match.index;
    let depth = 0;
    const scanner = /<\/?w:tbl>/g;
    scanner.lastIndex = start;
    for (const tag of documentXml.matchAll(scanner)) {
      depth += tag[0] === "</w:tbl>" ? -1 : 1;
      if (depth === 0) {
        tableRanges.push([start, (tag.index ?? start) + tag[0].length]);
        break;
      }
    }
  }
  const inTable = (position: number): boolean =>
    tableRanges.some(([start, end]) => position >= start && position < end);

  const out: OoxmlOutlineEntry[] = [];
  const paragraphPattern = /<w:p[\s>][\s\S]*?<\/w:p>/g;
  // index 语义保持与旧实现一致：**段落**在全文段落序列里的序号（含非标题段落）。
  let paragraphIndex = 0;
  for (const paragraphMatch of documentXml.matchAll(paragraphPattern)) {
    const index = paragraphIndex++;
    const paragraph = paragraphMatch[0];
    const paragraphStart = paragraphMatch.index ?? 0;
    const pPr = paragraph.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
    const styleId = pPr.match(/<w:pStyle[^>]*\bw:val="([^"]+)"/)?.[1];
    const declaredLevel = paragraphOutlineLevel(pPr, styleId, levelsByStyle);
    const text = [...paragraph.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("").trim();
    if (!text) continue;
    // 样式/大纲级优先；没有标题语义时再走启发式（普通段落模拟的标题）。
    // 表格单元格里的段落不吃启发式——「1. xxx」「（一）xxx」在表单里是行不是标题。
    // 排版说明行（「黑体三号，段前12磅…」）再像标题也不是章节
    if (isStyleSpecLine(text)) continue;
    const level = declaredLevel ?? (inTable(paragraphStart) ? undefined : heuristicHeadingLevel(text, pPr));
    if (level === undefined || level > 4) continue;
    const numPr = pPr.match(/<w:numPr>[\s\S]*?<\/w:numPr>/)?.[0];
    const numId = numPr ? numAttr(numPr, "w:numId", "w:val") : undefined;
    const ilvl = numPr ? numAttr(numPr, "w:ilvl", "w:val") : undefined;
    // 优先 run 自带的 rPr；pPr 里的 rPr 是「段落标记」格式，仅作兜底
    const runRPr = paragraph.match(/<w:r>[\s\S]*?<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0];
    const firstRunRPr = runRPr?.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0]
      ?? paragraph.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0]
      ?? "";
    const runFactOfHeading = runFact(firstRunRPr);
    out.push({
      index,
      level,
      text: text.slice(0, 200),
      ...(styleId ? { styleId } : {}),
      ...(runFactOfHeading.fontEastAsia ? { runFontEastAsia: runFactOfHeading.fontEastAsia } : {}),
      ...(runFactOfHeading.sizePt !== undefined ? { runSizePt: runFactOfHeading.sizePt } : {}),
      ...(runFactOfHeading.bold !== undefined ? { runBold: runFactOfHeading.bold } : {}),
      ...(numId !== undefined ? { numId } : {}),
      ...(ilvl !== undefined ? { ilvl } : {}),
      inCoverRegion: coverCut > 0 && documentXml.indexOf(paragraph) < coverCut,
    });
  }
  // 模版几乎没用标题样式时，用模版自己的目录行补出骨架
  const derived = tocDerivedOutline(documentXml, out);
  if (derived.length > 0) out.push(...derived.filter((entry) => !out.some((item) => item.text === entry.text)));
  return out;
}

/** 编号方案：numFmt/lvlText 组合归类。 */
function numberingSchemeOf(levels: Array<{ numFmt: string; lvlText: string }>): OoxmlNumberingFact["scheme"] {
  if (levels.length === 0) return "none";
  const first = levels[0]!;
  if (/chineseCounting|chineseCountingThousand|chineseLegalSimplified|ideographTraditional/i.test(first.numFmt)) {
    return "cn-upper";
  }
  if (/lowerLetter|chineseLower/i.test(first.numFmt) && !/decimal/i.test(first.numFmt)) return "cn-lower";
  if (/decimal/i.test(first.numFmt)) {
    // "%1.%2" 这类多级占位 = 树形编号；"%1." 单级 = 点号编号
    return /%2|%3/.test(first.lvlText) || levels.length > 1 ? "decimal-tree" : "decimal-dot";
  }
  if (/none|bullet/i.test(first.numFmt)) return "none";
  return "none";
}

/** 编号方案：解析 word/numbering.xml 的 abstractNum/lvl + num 映射。 */
async function numberingFacts(zip: JSZip, stylesXml: string | undefined): Promise<OoxmlNumberingFact> {
  const numberingXml = await zip.file("word/numbering.xml")?.async("string").catch(() => undefined);
  if (!numberingXml) return { scheme: "none", levels: [] };

  // 标题样式引用的 numId（决定"用哪套编号"）
  let headingNumId: number | undefined;
  if (stylesXml) {
    for (const block of stylesXml.match(/<w:style [^>]*>[\s\S]*?<\/w:style>/g) ?? []) {
      const id = block.match(/\bw:styleId="([^"]+)"/)?.[1] ?? "";
      const name = block.match(/<w:name[^>]*\bw:val="([^"]+)"/)?.[1] ?? id;
      if (!/^heading\s*1$/i.test(name.trim()) && !/^标题\s*1$/.test(name.trim())) continue;
      const numId = block.match(/<w:numId[^>]*\bw:val="(\d+)"/)?.[1];
      if (numId) headingNumId = Number(numId);
      break;
    }
  }

  const numToAbstract = new Map<number, number>();
  for (const num of numberingXml.match(/<w:num [^>]*>[\s\S]*?<\/w:num>/g) ?? []) {
    const numId = Number(num.match(/\bw:numId="(\d+)"/)?.[1] ?? NaN);
    const abstractId = Number(num.match(/<w:abstractNumId[^>]*\bw:val="(\d+)"/)?.[1] ?? NaN);
    if (Number.isFinite(numId) && Number.isFinite(abstractId)) numToAbstract.set(numId, abstractId);
  }

  const abstractOf = (numId: number | undefined): string | undefined => {
    const blocks = numberingXml.match(/<w:abstractNum [^>]*>[\s\S]*?<\/w:abstractNum>/g) ?? [];
    const target = numId !== undefined ? numToAbstract.get(numId) : undefined;
    if (target !== undefined) {
      const hit = blocks.find((block) => Number(block.match(/\bw:abstractNumId="(\d+)"/)?.[1]) === target);
      if (hit) return hit;
    }
    return blocks[0];
  };

  const abstract = abstractOf(headingNumId);
  if (!abstract) return { scheme: "none", levels: [] };
  const levels: OoxmlNumberingFact["levels"] = [];
  for (const lvl of abstract.match(/<w:lvl [^>]*>[\s\S]*?<\/w:lvl>/g) ?? []) {
    const level = Number(lvl.match(/\bw:ilvl="(\d+)"/)?.[1] ?? NaN);
    if (!Number.isFinite(level) || level > 3) continue;
    const numFmt = lvl.match(/<w:numFmt[^>]*\bw:val="([^"]+)"/)?.[1] ?? "decimal";
    const lvlText = lvl.match(/<w:lvlText[^>]*\bw:val="([^"]*)"/)?.[1] ?? "";
    const start = Number(lvl.match(/<w:start[^>]*\bw:val="(\d+)"/)?.[1] ?? "1");
    const indent = numAttr(lvl, "w:ind", "w:firstLine");
    levels.push({ level: level + 1, numFmt, lvlText, start, ...(indent !== undefined ? { indentTwips: indent } : {}) });
  }
  return {
    scheme: numberingSchemeOf(levels),
    levels,
    ...(headingNumId !== undefined ? { headingNumId } : {}),
  };
}

/**
 * 模板固定表单抽取：正文顶层 w:tbl（评价表/任务书表）+ 紧邻其上的标题段。
 * 目标是「教师评价表」这类模板自有表单在排版产物里原样保留——当前管线只映射
 * 源文档内容，模板自身表格会丢。placement 按首个大纲槽位位置二分。
 */
function fixedBlockFacts(documentXml: string, outline: OoxmlOutlineEntry[]): OoxmlFixedBlockFact[] {
  if (outline.length === 0) return [];
  const firstSlotText = outline[0]!.text.slice(0, 12);
  const tables = documentXml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? [];
  const out: OoxmlFixedBlockFact[] = [];
  for (const table of tables) {
    // 表格文本：判定属于哪个大纲槽位区间
    const text = stripTags(table).replace(/\s+/g, "").slice(0, 400);
    if (!text) continue;
    // 含图片引用的块跨文档必然断链（rels/media 不随迁），跳过保平安
    if (/r:embed=|r:id=/.test(table)) continue;
    const slotHit = outline.find((entry) => text.includes(entry.text.replace(/\s+/g, "").slice(0, 8)));
    if (slotHit) continue; // 槽位内部的示例表（会被源内容替换）不回收
    // 找表格之前最近的标题（用 outline 的段落序近似：取表格位置在文档中的序数）
    const tablePos = documentXml.indexOf(table);
    const priorHeadings = outline.filter((entry) => entry.index !== undefined);
    const heading = priorHeadings
      .filter((entry) => {
        const pos = documentXml.indexOf(entry.text.slice(0, 12));
        return pos >= 0 && pos < tablePos;
      })
      .pop();
    const placement: OoxmlFixedBlockFact["placement"] =
      heading && heading.text.includes(firstSlotText) ? "appendix" : "prelim";
    out.push({
      placement,
      ...(heading ? { heading: heading.text.slice(0, 60) } : {}),
      xml: table,
    });
    if (out.length >= 6) break;
  }
  return out;
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

  const headers: OoxmlFacts["headers"] = [];
  const footers: OoxmlFacts["footers"] = [];
  for (const path of Object.keys(zip.files)) {
    if (!/^word\/(header|footer)\d*\.xml$/.test(path)) continue;
    const xml = await zip.file(path)!.async("string").catch(() => "");
    if (!xml) continue;
    const text = stripTags(xml).trim();
    const images = await hfImages(zip, path, xml);
    const entry = {
      file: path.replace(/^word\//, ""),
      text: (images.length > 0 ? `[图片×${images.length}]${text ? " " + text : ""}` : text).slice(0, 200),
      images,
    };
    if (path.includes("header")) headers.push(entry);
    else footers.push(entry);
  }

  const coverFacts = documentXml ? await coverImages(zip, documentXml) : [];
  const coverLines = documentXml ? coverText(documentXml) : [];
  const outline = documentXml ? outlineFacts(documentXml, stylesXml) : [];
  const numbering = await numberingFacts(zip, stylesXml);
  const fixedBlocks = documentXml ? fixedBlockFacts(documentXml, outline) : [];

  return {
    styles,
    sections,
    headers,
    footers,
    coverImages: coverFacts,
    coverText: coverLines,
    outline,
    numbering,
    fixedBlocks,
  };
}

/** 首个分节/分页之前的段落文本行（封面区），最多 40 行、单行 120 字符。 */
function coverText(documentXml: string): string[] {
  const boundaries = ["<w:sectPr", 'w:type="page"']
    .map((token) => documentXml.indexOf(token))
    .filter((index) => index > 0);
  const head = documentXml.slice(0, boundaries.length > 0 ? Math.min(...boundaries) : documentXml.length);
  const lines: string[] = [];
  for (const para of head.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) ?? []) {
    const text = [...para.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("").trim();
    if (!text) continue;
    lines.push(text.slice(0, 120));
    if (lines.length >= 40) break;
  }
  return lines;
}
