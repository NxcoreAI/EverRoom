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
  /** 模版页眉里的图片（校徽 logo 等）：装机时按版位事实回填到输出页眉。 */
  images?: ThesisHfImage[];
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
  /** 模版封面上的图片（校徽/校名标识）：装机时回填到重建后的封面顶部。
   *  由网关从模版 OOXML 事实确定性写入，不经解析代理。 */
  logo?: ThesisHfImage;
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
  /** v2 模板剖面（槽位骨架 + 固定元素 + 样式锁）。缺省 = 老卡片，走区间映射。 */
  profile?: import("./template-profile.js").TemplateProfile;
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
    headers: Array<{ file: string; text: string; images: ThesisHfImage[] }>;
    footers: Array<{ file: string; text: string; images: ThesisHfImage[] }>;
    /** 封面区正文图片（校徽等）：装订重建封面时按此回填。 */
    coverImages?: ThesisHfImage[];
    /** 封面区文本行（段落序）：代理据此填封面字段。 */
    coverText?: string[];
    /** 模板正文大纲（章节骨架）。 */
    outline?: import("./ooxml-facts.js").OoxmlOutlineEntry[];
    /** 编号方案。 */
    numbering?: import("./ooxml-facts.js").OoxmlNumberingFact;
    /** 模板固定表单（评价表等，原样 XML）：装订时回插，保证模板自有内容不丢。 */
    fixedBlocks?: import("./ooxml-facts.js").OoxmlFixedBlockFact[];
  }>;
  /** 规范条文/样例全文（文件名 → 文本）。 */
  documentsText: Array<{ name: string; text: string }>;
}

/** 页眉/页脚图片（从模版 OOXML 抽出的事实，装机时原样回填）。 */
export interface ThesisHfImage {
  dataUrl: string;
  widthPx?: number | undefined;
  heightPx?: number | undefined;
  floating?: boolean | undefined;
  behind?: boolean | undefined;
  posH?: "left" | "center" | "right" | undefined;
  posV?: "top" | "center" | "bottom" | undefined;
  posXPx?: number | undefined;
  posYPx?: number | undefined;
  posHRel?: "page" | "margin" | undefined;
  posVRel?: "page" | "margin" | "paragraph" | undefined;
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
  chapters: Array<{
    level: 1 | 2 | 3 | 4;
    headingText: string;
    blockStart: number;
    blockEnd: number;
    /** 该章节归属的模板槽位 id（v3 模板骨架装订据此把内容放回模版原位）。 */
    slotId?: string;
  }>;
  /** 参考文献条目（已按卡模板逐条排好的最终文本，含 [n] 前缀）。 */
  references: string[];
  /** 附录：复用源块区间；null = 无附录。 */
  appendixBlocks: { start: number; end: number } | null;
  /**
   * AI 补写的空小节内容（仅当用户打开「AI 补写空白小节」时存在）。
   * title 对应模版小节标题；渲染器插入时自带「AI 生成」标记。
   */
  generatedSections?: Array<{ title: string; text: string }>;
  /** 致谢段落；空数组 = 源文档无致谢（仅排标题页）。 */
  acknowledgementParagraphs: string[];
  /** v2 未归类内容区间（渲染为正文末尾独立小节并高亮标记，不丢内容）。 */
  unmatchedBlocks?: Array<{ start: number; end: number; label?: string }>;
  /** 模板自有固定表单（原样 XML）：prelim=目录后首个槽位前；appendix=全文末尾。 */
  fixedBlocks?: Array<{ placement: 'prelim' | 'appendix'; heading?: string; xml: string }>;
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

/**
 * 工作台规则面板下发的一次排版选项。
 * 全部可缺省——缺省即严格模式 + 保留全部固定元素（与既有行为一致）。
 */
export interface ThesisReformatOptions {
  /** 是否回填模版 Logo（封面校徽 + 页眉图）。 */
  keepLogo?: boolean;
  /** 是否沿用模版的页眉页脚（false = 输出不带页眉页脚）。 */
  keepHeaderFooter?: boolean;
  /** 允许 AI 补写空白小节（默认关；生成内容带「AI 生成」标记）。 */
  aiFill?: boolean;
  /** 标题层级映射：源文档角色 → 模板标题级别（1–4）。 */
  headingMapping?: {
    chapter?: 1 | 2 | 3 | 4;
    section?: 1 | 2 | 3 | 4;
    subsection?: 1 | 2 | 3 | 4;
  };
}
