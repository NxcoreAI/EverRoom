/**
 * 论文格式卡：thesis-format 管线的唯一机器事实源。
 *
 * 解析代理从模版文件（规范条文 + OOXML 版式事实）产出本卡；
 * genoffice thesis-binder 按卡装订 docx。字段语义对齐中文论文规范：
 * 字号用中文字号名（小二/小三/小四/五号…），validate 层换算 pt；
 * 装订引擎不得偏离卡值，缺字段由 validate 层兜默认。
 */

/** 中文字号名 → pt。 */
export const CHINESE_SIZE_PT: Record<string, number> = {
  初号: 42, 小初: 36, 一号: 26, 小一: 24, 二号: 22, 小二: 18,
  三号: 16, 小三: 15, 四号: 14, 小四: 12, 五号: 10.5, 小五: 9,
  六号: 7.5, 七号: 5.5,
};

/** 字号值：中文字号名或直接 pt 数。 */
export type ThesisSize = string | number;

export interface ThesisFontSpec {
  /** 中文字体（宋体/黑体…）。 */
  eastAsia: string;
  /** 西文字体（Times New Roman…）。 */
  ascii: string;
  size: ThesisSize;
  bold: boolean;
}

export interface ThesisParagraphSpec {
  align: "left" | "center" | "right" | "justify";
  /** 段首缩进字符数（2 = 空两格）。 */
  firstLineIndentChars: number;
  /** 多倍行距（1.25）；与 exactPt 二选一。 */
  lineSpacingMultiple?: number;
  /** 固定行距 pt。 */
  lineSpacingExactPt?: number;
  spaceBeforePt: number;
  spaceAfterPt: number;
}

export interface ThesisPageSetup {
  widthMm: number;
  heightMm: number;
  orientation: "portrait" | "landscape";
  marginTopMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  marginRightMm: number;
  /** 装订线宽。 */
  gutterMm: number;
}

export interface ThesisHeaderRule {
  enabled: boolean;
  /** 内容模板，支持 {title} 占位。 */
  template: string;
  font: ThesisFontSpec;
  /** 页眉文字下是否带横线。 */
  underline: boolean;
  /** 封面页是否省略页眉页脚。 */
  skipOnCover: boolean;
}

export interface ThesisFooterRule {
  enabled: boolean;
  font: ThesisFontSpec;
  /** 前置部分（摘要至目录）页码格式；正文恒为 decimal 且从 1 重编。 */
  frontMatterFormat: "roman" | "decimal";
}

/** 论文部件类型（装订骨架槽位）。 */
export type ThesisPartType =
  | "cover"
  | "commitment"
  | "abstract_zh"
  | "abstract_en"
  | "toc"
  | "chapter"
  | "appendix"
  | "references"
  | "acknowledgement"
  | "achievements";

/** 部件前的分隔：none=接排、page=换页、section=分节（页码格式切换点）、sectionRestart=分节且页码重编。 */
export type ThesisBreakBefore = "none" | "page" | "section" | "sectionRestart";

export interface ThesisPartRule {
  type: ThesisPartType;
  /** 部件标题文案（摘要/Abstract/目录/参考文献/致谢…；chapter 为空）。 */
  title: string;
  titleFont: ThesisFontSpec;
  /** 部件标题不参与章节编号。 */
  breakBefore: ThesisBreakBefore;
  /** 仅 appendix/achievements：无内容时整件省略。 */
  optional: boolean;
}

/** 标题层级样式：编号由装订器按 numeric-tree 内联进标题文本。 */
export interface ThesisHeadingRule {
  level: 1 | 2 | 3 | 4;
  font: ThesisFontSpec;
  align: "left" | "center";
  /** 编号形态：numeric-tree=1/1.1/1.1.1；none=无编号。 */
  numbering: "numeric-tree" | "none";
  paragraph: ThesisParagraphSpec;
}

export interface ThesisAbstractRule {
  titleFont: ThesisFontSpec;
  bodyFont: ThesisFontSpec;
  bodyParagraph: ThesisParagraphSpec;
  /** 关键词行规则。 */
  keywordPrefix: string;
  keywordPrefixBold: boolean;
  keywordSeparator: string;
}

export interface ThesisTocRule {
  enabled: boolean;
  /** 目录层级，如 "1-3"。 */
  levels: string;
  titleFont: ThesisFontSpec;
}

export interface ThesisFiguresTablesRule {
  /** 图题位置。 */
  figureCaption: "below" | "above";
  /** 表题位置。 */
  tableCaption: "below" | "above";
  captionFont: ThesisFontSpec;
  /** 按章编号（图2-1）或全文连续（图1）。 */
  numbering: "chapter" | "sequential";
  tableStyle: "three-line" | "grid" | "plain";
}

export interface ThesisReferencesRule {
  /** 条目格式模板，按文献类型（{n} 占位序号）。 */
  entryTemplates: Record<string, string>;
  /** 正文引用标注形态。 */
  inTextCitation: "bracket-superscript" | "bracket-inline" | "none";
  listFont: ThesisFontSpec;
  listParagraph: ThesisParagraphSpec;
}

export interface ThesisCoverField {
  /** 封面行标签（含全角空格，如「题    目」）。 */
  label: string;
  /** 值槽位键：title/name/studentId/college/major/advisor/degree/custom:*。 */
  key: string;
}

export interface ThesisCoverRule {
  schoolName: string;
  /** 文种行（本科毕业论文（设计））。 */
  degreeLine: string;
  yearLine: string;
  fields: ThesisCoverField[];
  /** 落款行（嘉 应 学 院 教 务 部 制）。 */
  footerLine: string;
  schoolFont: ThesisFontSpec;
  fieldLabelFont: ThesisFontSpec;
}

export interface ThesisFixedTexts {
  /** 诚信承诺书全文（按段）。 */
  commitment: string[];
}

export interface ThesisFormatCard {
  page: ThesisPageSetup;
  /** 正文基础样式（Normal）。 */
  base: { font: ThesisFontSpec; paragraph: ThesisParagraphSpec };
  header: ThesisHeaderRule;
  footer: ThesisFooterRule;
  headings: ThesisHeadingRule[];
  parts: ThesisPartRule[];
  abstract: ThesisAbstractRule;
  toc: ThesisTocRule;
  figuresTables: ThesisFiguresTablesRule;
  references: ThesisReferencesRule;
  cover: ThesisCoverRule;
  fixedTexts: ThesisFixedTexts;
  cardMeta: {
    sourceName: string;
    parsedAt: string;
  };
}

/** 解析代理的输入载荷：OOXML 版式事实 + 各文档正文文本。 */
export interface ThesisTemplateFacts {
  /** 文件名 → 版式事实（styles/sectPr/页眉页脚）。 */
  ooxml: Array<{
    name: string;
    styles: Array<{ id: string; name: string; fontEastAsia?: string; fontAscii?: string; sizePt?: number; bold?: boolean; lineSpacingMultiple?: number; lineSpacingExactPt?: number; align?: string; firstLineIndentChars?: number }>;
    sections: Array<{ widthMm?: number; heightMm?: number; marginTopMm?: number; marginBottomMm?: number; marginLeftMm?: number; marginRightMm?: number; gutterMm?: number; pageFormat?: string }>;
    headers: Array<{ file: string; text: string }>;
    footers: Array<{ file: string; text: string }>;
  }>;
  /** 规范条文/样例全文（文件名 → 文本）。 */
  documentsText: Array<{ name: string; text: string }>;
}

/** 装订规格：解析代理第二任务输出——源文档内容 → 骨架槽位映射。块区间索引与
 * 桌面 describe（genoffice parseDocx Block 序号）严格对齐，[start, end) 半开。 */
export interface ThesisBindingSpec {
  /** 论文题目（进封面与页眉）。 */
  title: string;
  /** 封面字段值：只填源文档/上下文确定的（如 title）；拼不到的空串。 */
  coverFields: Record<string, string>;
  abstractZh: string;
  keywordsZh: string[];
  abstractEn: string;
  keywordsEn: string[];
  /** 正文章节：headingText 为去编号干净标题（编号由引擎按卡生成）。 */
  chapters: Array<{ level: 1 | 2 | 3 | 4; headingText: string; blockStart: number; blockEnd: number }>;
  /** 参考文献条目（已按卡模板逐条排好的最终文本，含 [n] 前缀）。 */
  references: string[];
  /** 附录：复用源块区间；null = 无附录。 */
  appendixBlocks: { start: number; end: number } | null;
  /** 致谢段落；空数组 = 源文档无致谢（仅排标题页）。 */
  acknowledgementParagraphs: string[];
  /** 攻读学位期间研究成果；空数组 = 无。 */
  achievements: string[];
}

/** 桌面 describe 返回的源文档块大纲（bind_thesis 的输入）。 */
export interface ThesisSourceOutlineBlock {
  index: number;
  kind: "heading" | "paragraph" | "table" | "image" | "list";
  level?: number;
  text: string;
}
