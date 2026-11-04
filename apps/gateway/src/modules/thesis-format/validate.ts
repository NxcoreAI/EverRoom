/**
 * 格式卡校验与兜底：解析代理输出 → 可装机 ThesisFormatCard。
 * 原则：字段缺失给中文论文常见默认值；非法值抛错（不静默放行脏卡）。
 */

import { CHINESE_SIZE_PT, type ThesisFontSpec, type ThesisFormatCard, type ThesisHfImage } from "./types.js";

/** 模版页眉图片守门：data:URL 结构合法才收，防脏 JSON 进卡；上限 6 张。 */
function hfImages(value: unknown): ThesisHfImage[] {
  if (!Array.isArray(value)) return [];
  const out: ThesisHfImage[] = [];
  for (const raw of value.slice(0, 6)) {
    if (!raw || typeof raw !== "object") continue;
    const src = raw as Record<string, unknown>;
    const dataUrl = src.dataUrl;
    if (typeof dataUrl !== "string" || !/^data:image\/(png|jpeg|gif|bmp|x-emf|x-wmf);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) continue;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
    const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
      typeof v === "string" && (allowed as readonly string[]).includes(v) ? v as T : undefined;
    out.push({
      dataUrl,
      widthPx: num(src.widthPx),
      heightPx: num(src.heightPx),
      floating: src.floating === true ? true : undefined,
      behind: src.behind === true ? true : undefined,
      posH: oneOf(src.posH, ["left", "center", "right"] as const),
      posV: oneOf(src.posV, ["top", "center", "bottom"] as const),
      posXPx: num(src.posXPx),
      posYPx: num(src.posYPx),
      posHRel: oneOf(src.posHRel, ["page", "margin"] as const),
      posVRel: oneOf(src.posVRel, ["page", "margin", "paragraph"] as const),
    });
  }
  return out;
}

export function resolveSizePt(size: unknown, fallbackPt: number, field: string): number {
  if (typeof size === "number" && Number.isFinite(size) && size > 0 && size <= 200) return size;
  if (typeof size === "string") {
    const direct = Number(size.trim().replace(/pt$/i, ""));
    if (Number.isFinite(direct) && direct > 0 && direct <= 200) return direct;
    const named = CHINESE_SIZE_PT[size.trim()];
    if (named) return named;
  }
  if (size === undefined || size === null || size === "") return fallbackPt;
  throw new Error(`论文格式卡字段 ${field} 的字号非法：${String(size)}`);
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function font(value: any, fallback: { eastAsia: string; ascii: string; size: number; bold: boolean }, field: string): ThesisFontSpec {
  const src = (value && typeof value === "object") ? value : {};
  return {
    eastAsia: str(src.eastAsia, fallback.eastAsia),
    ascii: str(src.ascii, fallback.ascii),
    size: resolveSizePt(src.size, fallback.size, field),
    bold: bool(src.bold, fallback.bold),
  };
}

function paragraph(value: any, fallback: { align: "left" | "center" | "right" | "justify"; firstLineIndentChars: number; lineSpacingMultiple?: number; lineSpacingExactPt?: number; spaceBeforePt: number; spaceAfterPt: number }) {
  const src = (value && typeof value === "object") ? value : {};
  const multiple = typeof src.lineSpacingMultiple === "number" && src.lineSpacingMultiple > 0 ? src.lineSpacingMultiple : undefined;
  const exact = typeof src.lineSpacingExactPt === "number" && src.lineSpacingExactPt > 0 ? src.lineSpacingExactPt : undefined;
  return {
    align: oneOf(src.align, ["left", "center", "right", "justify"] as const, fallback.align),
    firstLineIndentChars: num(src.firstLineIndentChars, fallback.firstLineIndentChars),
    lineSpacingMultiple: multiple ?? fallback.lineSpacingMultiple,
    lineSpacingExactPt: exact ?? fallback.lineSpacingExactPt,
    spaceBeforePt: num(src.spaceBeforePt, fallback.spaceBeforePt),
    spaceAfterPt: num(src.spaceAfterPt, fallback.spaceAfterPt),
  };
}

const SONG = { eastAsia: "宋体", ascii: "Times New Roman", size: 12, bold: false };

/** 校验并兜底出完整格式卡；输入须是解析代理输出的对象。 */
/** 封面图片守门：单张、data:URL 结构合法才收；缺省不写字段（不编造 logo）。 */
function coverLogo(value: unknown): { logo: ThesisHfImage } | Record<string, never> {
  const [image] = hfImages(value === undefined ? [] : [value]);
  return image ? { logo: image } : {};
}

export function validateThesisFormatCard(raw: unknown, sourceName: string): ThesisFormatCard {
  if (!raw || typeof raw !== "object") throw new Error("论文格式卡必须是对象");
  const src: any = raw;

  const page = (src.page && typeof src.page === "object") ? src.page : {};
  const header = (src.header && typeof src.header === "object") ? src.header : {};
  const footer = (src.footer && typeof src.footer === "object") ? src.footer : {};
  const abstract = (src.abstract && typeof src.abstract === "object") ? src.abstract : {};
  const toc = (src.toc && typeof src.toc === "object") ? src.toc : {};
  const figs = (src.figuresTables && typeof src.figuresTables === "object") ? src.figuresTables : {};
  const refs = (src.references && typeof src.references === "object") ? src.references : {};
  const cover = (src.cover && typeof src.cover === "object") ? src.cover : {};
  const fixed = (src.fixedTexts && typeof src.fixedTexts === "object") ? src.fixedTexts : {};

  const headings = Array.isArray(src.headings) ? src.headings : [];
  const defaultHeadings = [
    { level: 1, font: { eastAsia: "黑体", ascii: "Times New Roman", size: 18, bold: true }, align: "center", numbering: "numeric-tree" },
    { level: 2, font: { eastAsia: "黑体", ascii: "Times New Roman", size: 15, bold: true }, align: "left", numbering: "numeric-tree" },
    { level: 3, font: { eastAsia: "黑体", ascii: "Times New Roman", size: 14, bold: true }, align: "left", numbering: "numeric-tree" },
  ];
  const headingsOut = defaultHeadings.map((def, i) => {
    const h = (headings[i] && typeof headings[i] === "object") ? headings[i] : headings.find((x: any) => x && x.level === def.level) || {};
    return {
      level: (i + 1) as 1 | 2 | 3 | 4,
      font: font(h.font, def.font, `headings[${i}].font`),
      align: oneOf(h.align, ["left", "center"] as const, def.align as "left" | "center"),
      numbering: oneOf(h.numbering, ["numeric-tree", "none"] as const, "numeric-tree"),
      paragraph: paragraph(h.paragraph, { align: "left", firstLineIndentChars: 0, spaceBeforePt: 6, spaceAfterPt: 6 }),
    };
  });

  const partTitleFont = { eastAsia: "黑体", ascii: "Times New Roman", size: 18, bold: true };
  const partDefaults: Array<{ type: any; title: string; breakBefore: any; optional: boolean }> = [
    { type: "cover", title: "", breakBefore: "none", optional: false },
    { type: "commitment", title: "毕业论文（设计）诚信承诺书", breakBefore: "page", optional: false },
    { type: "abstract_zh", title: "摘要", breakBefore: "page", optional: false },
    { type: "abstract_en", title: "Abstract", breakBefore: "page", optional: false },
    { type: "toc", title: "目录", breakBefore: "page", optional: false },
    { type: "chapter", title: "", breakBefore: "sectionRestart", optional: false },
    { type: "appendix", title: "附录", breakBefore: "page", optional: true },
    { type: "references", title: "参考文献", breakBefore: "page", optional: false },
    { type: "acknowledgement", title: "致谢", breakBefore: "page", optional: false },
    { type: "achievements", title: "攻读学位期间的研究成果", breakBefore: "page", optional: true },
  ];
  const partsIn = Array.isArray(src.parts) ? src.parts : [];
  const partsOut = partDefaults.map((def) => {
    const p = partsIn.find((x: any) => x && x.type === def.type) || {};
    const pTitle = def.title ? str(p.title, def.title) : "";
    return {
      type: def.type,
      title: pTitle,
      titleFont: font(p.titleFont, partTitleFont, `parts.${def.type}.titleFont`),
      breakBefore: oneOf(p.breakBefore, ["none", "page", "section", "sectionRestart"] as const, def.breakBefore),
      optional: bool(p.optional, def.optional),
    };
  });

  const entryTemplates: Record<string, string> = {
    book: "[{n}] 作者. 书名[M]. 出版地: 出版社, 年份.",
    journal: "[{n}] 作者. 题名[J]. 刊名, 年份(卷, 期): 页码.",
    conference: "[{n}] 作者. 论文题名[C]. 论文集名. 出版地: 出版社, 年份: 页码.",
    thesis: "[{n}] 作者. 题名[D]. 保存地: 保存单位, 年份.",
    electronic: "[{n}] 责任者. 文献题名. 网址, 访问日期.",
    other: "[{n}] 作者. 题名[Z]. 年份.",
    ...(refs.entryTemplates && typeof refs.entryTemplates === "object" ? refs.entryTemplates : {}),
  };

  const coverFieldsIn = Array.isArray(cover.fields) ? cover.fields : [];
  const coverFields = coverFieldsIn.length > 0
    ? coverFieldsIn.filter((f: any) => f && typeof f.label === "string" && typeof f.key === "string").map((f: any) => ({ label: f.label, key: f.key }))
    : [
      { label: "题    目", key: "title" },
      { label: "姓    名", key: "name" },
      { label: "学    号", key: "studentId" },
      { label: "学    院", key: "college" },
      { label: "专    业", key: "major" },
      { label: "指导教师", key: "advisor" },
      { label: "申请学位", key: "degree" },
    ];

  const commitment = Array.isArray(fixed.commitment)
    ? fixed.commitment.filter((p: unknown): p is string => typeof p === "string" && p.trim().length > 0)
    : [];

  return {
    page: {
      widthMm: num(page.widthMm, 210),
      heightMm: num(page.heightMm, 297),
      orientation: oneOf(page.orientation, ["portrait", "landscape"] as const, "portrait"),
      marginTopMm: num(page.marginTopMm, 25),
      marginBottomMm: num(page.marginBottomMm, 25),
      marginLeftMm: num(page.marginLeftMm, 20),
      marginRightMm: num(page.marginRightMm, 20),
      gutterMm: num(page.gutterMm, 0.5),
    },
    base: {
      font: font((src.base && src.base.font), SONG, "base.font"),
      paragraph: paragraph(src.base && src.base.paragraph, { align: "justify", firstLineIndentChars: 2, lineSpacingMultiple: 1.25, spaceBeforePt: 0, spaceAfterPt: 0 }),
    },
    header: {
      enabled: bool(header.enabled, true),
      template: str(header.template, "{title}"),
      font: font(header.font, { eastAsia: "宋体", ascii: "Times New Roman", size: 10.5, bold: false }, "header.font"),
      underline: bool(header.underline, true),
      skipOnCover: bool(header.skipOnCover, true),
      images: hfImages(header.images),
    },
    footer: {
      enabled: bool(footer.enabled, true),
      font: font(footer.font, { eastAsia: "黑体", ascii: "Times New Roman", size: 10.5, bold: true }, "footer.font"),
      frontMatterFormat: oneOf(footer.frontMatterFormat, ["roman", "decimal"] as const, "roman"),
    },
    headings: headingsOut,
    parts: partsOut,
    abstract: {
      titleFont: font(abstract.titleFont, partTitleFont, "abstract.titleFont"),
      bodyFont: font(abstract.bodyFont, SONG, "abstract.bodyFont"),
      bodyParagraph: paragraph(abstract.bodyParagraph, { align: "justify", firstLineIndentChars: 2, lineSpacingMultiple: 1.25, spaceBeforePt: 0, spaceAfterPt: 0 }),
      keywordPrefix: str(abstract.keywordPrefix, "关键词："),
      keywordPrefixBold: bool(abstract.keywordPrefixBold, true),
      keywordSeparator: str(abstract.keywordSeparator, "，"),
    },
    toc: {
      enabled: bool(toc.enabled, true),
      levels: str(toc.levels, "1-3"),
      titleFont: font(toc.titleFont, partTitleFont, "toc.titleFont"),
    },
    figuresTables: {
      figureCaption: oneOf(figs.figureCaption, ["below", "above"] as const, "below"),
      tableCaption: oneOf(figs.tableCaption, ["below", "above"] as const, "above"),
      captionFont: font(figs.captionFont, { eastAsia: "宋体", ascii: "Times New Roman", size: 10.5, bold: false }, "figuresTables.captionFont"),
      numbering: oneOf(figs.numbering, ["chapter", "sequential"] as const, "chapter"),
      tableStyle: oneOf(figs.tableStyle, ["three-line", "grid", "plain"] as const, "three-line"),
    },
    references: {
      entryTemplates,
      inTextCitation: oneOf(refs.inTextCitation, ["bracket-superscript", "bracket-inline", "none"] as const, "bracket-superscript"),
      listFont: font(refs.listFont, SONG, "references.listFont"),
      listParagraph: paragraph(refs.listParagraph, { align: "justify", firstLineIndentChars: 0, lineSpacingMultiple: 1.25, spaceBeforePt: 0, spaceAfterPt: 0 }),
    },
    cover: {
      schoolName: str(cover.schoolName, ""),
      ...coverLogo(cover.logo),
      degreeLine: str(cover.degreeLine, "本科毕业论文（设计）"),
      yearLine: str(cover.yearLine, ""),
      fields: coverFields,
      footerLine: str(cover.footerLine, ""),
      schoolFont: font(cover.schoolFont, { eastAsia: "宋体", ascii: "Times New Roman", size: 26, bold: true }, "cover.schoolFont"),
      fieldLabelFont: font(cover.fieldLabelFont, { eastAsia: "宋体", ascii: "Times New Roman", size: 15, bold: false }, "cover.fieldLabelFont"),
    },
    fixedTexts: { commitment },
    cardMeta: {
      sourceName,
      parsedAt: new Date().toISOString(),
    },
  };
}
