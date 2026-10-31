/**
 * 本地确定性格式卡构建：直接从 OOXML 事实生成格式卡，**不调用解析代理**。
 *
 * 背景：一次模版上传原来要等 LLM 往返（喂 178KB 事实 + 全文，30s–数分钟），
 * 而真正决定排版结果的版式事实（页面、字体、字号、标题层级、编号、页眉页脚、
 * 封面文本、图片）全部可从 OOXML 确定性抽取——实测 20ms。
 *
 * 因此默认走本模块：秒级出卡，且结果稳定可复现（同一个模版永远同一张卡）。
 * 解析代理仅在本地抽取拿不到关键信息（没有大纲/样式全部缺失）时兜底。
 */
import type { OoxmlFacts, OoxmlOutlineEntry, OoxmlStyleFact } from "./ooxml-facts.js";
import type { ThesisFontSpec, ThesisFormatCard } from "./types.js";
import { mergeTemplateImages } from "./template-images.js";
import { validateThesisFormatCard } from "./validate.js";

export interface LocalCardResult {
  card: ThesisFormatCard;
  /** 本地抽取拿不准/拿不到的点（UI 展示，或据此决定是否升级到代理解析）。 */
  gaps: string[];
  /** 本地结果是否足够可信（不足则调用方应回落到解析代理）。 */
  confident: boolean;
}

const STYLE_FALLBACK_HEADING_SIZES = [16, 15, 14, 13];

/** 从样式事实里挑「一个字都没写」的兜底字体。 */
function styleFont(style: OoxmlStyleFact | undefined, sizePt: ThesisFontSpec["size"]): ThesisFontSpec {
  return {
    eastAsia: style?.fontEastAsia ?? "宋体",
    ascii: style?.fontAscii ?? "Times New Roman",
    size: style?.sizePt ?? sizePt,
    bold: style?.bold ?? false,
  };
}

/** 大纲里首个 level 对应的样式：中文模板常用数字 styleId（"2"/"3"），不能按名字猜。 */
function styleForLevel(facts: OoxmlFacts, level: number): { entry?: OoxmlOutlineEntry; style?: OoxmlStyleFact } {
  const entry = facts.outline.find((item) => item.level === level);
  const style = entry?.styleId ? facts.styles.find((item) => item.id === entry.styleId) : undefined;
  return { ...(entry ? { entry } : {}), ...(style ? { style } : {}) };
}

/** 页眉文字里的「{title}」占位：模板常在页眉写死校名/课程名。 */
function headerTemplateOf(text: string): string {
  const cleaned = text.replace(/\s+/g, "").trim();
  if (!cleaned) return "{title}";
  return cleaned;
}

export function buildCardFromFacts(facts: OoxmlFacts, sourceName: string, baseCard?: ThesisFormatCard): LocalCardResult {
  const card = validateThesisFormatCard((baseCard ?? {}) as never, sourceName);
  const gaps: string[] = [];

  // ---- 页面：首节最可信（后续节多为正文小节，边距可能被单独调过）----
  // 校名：页眉里的全称最可信（页眉常写「广州城市理工学院…」），封面首行多为学院
  const headerSchool = facts.headers
    .map((part) => part.text.match(/[\u4e00-\u9fa5]{2,12}(?:大学|学院)/)?.[0])
    .find((name) => Boolean(name));
  if (headerSchool) card.cover.schoolName = headerSchool;

  const page = facts.sections[0];
  if (page) {
    if (page.widthMm) card.page.widthMm = page.widthMm;
    if (page.heightMm) card.page.heightMm = page.heightMm;
    if (page.marginTopMm !== undefined) card.page.marginTopMm = page.marginTopMm;
    if (page.marginBottomMm !== undefined) card.page.marginBottomMm = page.marginBottomMm;
    if (page.marginLeftMm !== undefined) card.page.marginLeftMm = page.marginLeftMm;
    if (page.marginRightMm !== undefined) card.page.marginRightMm = page.marginRightMm;
    if (page.gutterMm !== undefined) card.page.gutterMm = page.gutterMm;
  } else {
    gaps.push("未读到分节信息，页面按下 A4 默认值");
  }

  // ---- 正文基础样式：Normal 样式优先，否则取最常用的正文样式 ----
  const normal = facts.styles.find((style) => /^Normal$/i.test(style.id) || /^正文$/.test(style.name));
  const bodyStyle = normal ?? facts.styles[0];
  card.base.font = styleFont(bodyStyle, 12);
  if (bodyStyle) {
    if (bodyStyle.lineSpacingMultiple) card.base.paragraph.lineSpacingMultiple = bodyStyle.lineSpacingMultiple;
    if (bodyStyle.align) card.base.paragraph.align = bodyStyle.align as typeof card.base.paragraph.align;
    if (bodyStyle.firstLineIndentChars !== undefined) {
      card.base.paragraph.firstLineIndentChars = bodyStyle.firstLineIndentChars;
    }
  } else {
    gaps.push("未读到正文样式，正文按宋体小四兜底");
  }

  // ---- 标题层级：按大纲各级首个标题反查样式 ----
  for (const level of [1, 2, 3, 4] as const) {
    const rule = card.headings.find((item) => item.level === level);
    if (!rule) continue;
    const { entry, style } = styleForLevel(facts, level);
    const hasRunFact = entry?.runSizePt !== undefined || Boolean(entry?.runFontEastAsia);
    // 字体来源优先级：段落 run（模板真实观感）> 样式定义 > 默认兜底
    if (hasRunFact) {
      rule.font = {
        ...rule.font,
        ...(entry?.runFontEastAsia ? { eastAsia: entry.runFontEastAsia } : {}),
        ...(entry?.runSizePt !== undefined ? { size: entry.runSizePt } : {}),
        ...(entry?.runBold !== undefined ? { bold: entry.runBold } : {}),
      };
    } else if (style) {
      rule.font = styleFont(style, STYLE_FALLBACK_HEADING_SIZES[level - 1] ?? rule.font.size);
    } else {
      gaps.push(`未读到 ${level} 级标题版式，按默认字号兜底`);
      rule.font = { ...rule.font, size: STYLE_FALLBACK_HEADING_SIZES[level - 1] ?? rule.font.size };
    }
    if (style?.align === "left" || style?.align === "center") rule.align = style.align;
    if (style?.lineSpacingMultiple) {
      rule.paragraph = { ...rule.paragraph, lineSpacingMultiple: style.lineSpacingMultiple };
    }
  }

  // ---- 页眉页脚：取首个含图片或文字的部件 ----
  const headerPart = facts.headers.find((part) => part.images.length > 0) ?? facts.headers[0];
  if (headerPart) {
    card.header.enabled = true;
    card.header.template = headerTemplateOf(headerPart.text) || card.header.template;
    if (headerPart.images.length > 0) {
      card.header.images = headerPart.images.filter((image) => Boolean(image.dataUrl));
    }
  } else {
    card.header.enabled = false;
  }
  if (facts.footers.length === 0) {
    card.footer.enabled = false;
  } else {
    card.footer.enabled = true;
    const frontFormat = facts.sections[0]?.pageFormat;
    if (frontFormat === "upperRoman" || frontFormat === "lowerRoman") card.footer.frontMatterFormat = "roman";
  }

  // ---- 封面字段标签：从封面区文本行识别（值由源文档/上下文在排版时填）----
  const coverLines = facts.coverText.slice(0, 24);
  const labelMap: Array<{ re: RegExp; key: string }> = [
    { re: /^(题\s*目|论文题目|课题名称)/, key: "title" },
    { re: /^(专\s*业|专业名称)/, key: "major" },
    { re: /^(班\s*级|班级名称)/, key: "className" },
    { re: /^(学生姓名|姓\s*名|学生名字)/, key: "studentName" },
    { re: /^(学生学号|学\s*号)/, key: "studentId" },
    { re: /^(指导教师|指导老师)/, key: "advisor" },
    { re: /^(日\s*期|完成日期)/, key: "date" },
  ];
  const labels: Record<string, string> = {};
  for (const line of coverLines) {
    for (const { re, key } of labelMap) {
      if (re.test(line) && !labels[key]) labels[key] = line.trim();
    }
  }
  // 封面字段标签：识别到模板真实标签就用模板的（校验层的默认标签不是这份模板的）
  const detected = Object.entries(labels).map(([key, label]) => ({ label, key }));
  if (detected.length > 0) {
    card.cover.fields = detected;
  } else {
    gaps.push("封面字段标签未识别，按默认标签排");
  }

  // ---- 图片：封面 logo / 页眉图片字节由事实确定性写入 ----
  const merged = mergeTemplateImages(card, {
    ooxml: [
      {
        name: sourceName,
        coverImages: facts.coverImages,
        coverText: facts.coverText,
        headers: facts.headers,
      },
    ],
    documentsText: [],
  } as never);

  // ---- 可信度：没有大纲 = 认不出章节骨架，必须回落代理 ----
  const confident = facts.outline.length > 0 && facts.styles.length > 0;
  if (facts.outline.length === 0) gaps.push("未读到章节大纲，无法建立槽位骨架");
  return { card: merged, gaps, confident };
}
