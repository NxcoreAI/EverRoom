/**
 * slides 风格管线类型：纵览图 → 提取与定参 → StyleParams → builder/风格卡。
 *
 * StyleParams 是风格的唯一机器事实源（「确定性从数据来」）：
 * - 色板/字号/字体/装饰/母题全部在此定稿，builder 不得偏离；
 * - 布局坐标归布局树链路（slides-layouter/编译器），风格侧只留构图家族倾向；
 * - 用户可见的效果文案（effectLines）由 styler 一并产出，走风格卡展示，
 *   不含任何来源说明（像素换算/近似匹配等禁词归 styler SYSTEM 约束）。
 */

import type { TypeToken } from "../slides-layout/theme.js";

/** 引擎可用色值：#RRGGBB。 */
export type StyleHex = string;

export interface StylePalette {
  /** 页底色（浅色或深色底由它决定）。 */
  background: StyleHex;
  /** 卡片/面板底色。 */
  surface: StyleHex;
  /** 主色：标题、色块、图表主角系列。 */
  primary: StyleHex;
  /** 强调色：唯一，用于关键数字/高亮。 */
  accent: StyleHex;
  /** 正文文字。 */
  text: StyleHex;
  /** 次级文字（注释、图注、轴标签）。 */
  textMuted: StyleHex;
  /** 深底页（封面/章节）上的文字色。 */
  onDarkText: StyleHex;
  /** 图表系列色（同色调渐次，4~6 个，主角系列=primary）。 */
  chartSeries: StyleHex[];
}

export interface StyleTypographySizes {
  /** 封面大标题（pt）。 */
  coverTitle: number;
  /** 章节页标题。 */
  sectionTitle: number;
  /** 内容页标题。 */
  pageTitle: number;
  /** 副标题/引导语。 */
  subtitle: number;
  /** 正文要点。 */
  body: number;
  /** 注释、数据标签、图表刻度。 */
  caption: number;
  /** KPI 大数字。 */
  kpi: number;
  /** 表格正文。 */
  table: number;
}

export interface StyleTypography {
  /** 标题字体（引擎可用字体名）。 */
  fontHeading: string;
  /** 正文字体。 */
  fontBody: string;
  sizes: StyleTypographySizes;
  /** v2 字号 token；缺省由 sizes 推导。 */
  typeScale?: Partial<Record<TypeToken, number>>;
  headingBold: boolean;
}

export interface StyleSpacing {
  /** 页边距（px，1280×720 画布）。 */
  margin: number;
  /** 卡片/分栏间距。 */
  gutter: number;
  /** 卡片内边距。 */
  cardPadding: number;
  /** 卡片圆角（px）。 */
  cornerRadius: number;
}

export interface StyleDecoration {
  /** 卡片描边色；null = 无描边。 */
  cardStroke: StyleHex | null;
  /** 描边粗细（pt，0.25~3）。 */
  cardStrokeWidthPt: number;
  /** 卡片阴影（引擎三档 + 无）。 */
  cardShadow: "none" | "soft" | "medium" | "strong";
  /** 分割线样式（引擎 shape 词汇）。 */
  divider: "line" | "none";
  /** 配图裁切方式；产品图/人像用 contain 防裁边。 */
  imageFit: "cover" | "contain";
}

/** 母题：全篇重复的视觉签名。 */
export interface StyleMotif {
  kind: "ghost-number" | "ghost-word" | "color-band" | "corner-accent" | "none";
  /** 母题参数（如 ghost 的 alpha 与字号、色带方向），按 kind 解释。 */
  spec: Record<string, string | number>;
}

/**
 * 构图家族：全篇版式选型与节奏的倾向轴（颜色/字体之外的风格第三轴）。
 * swiss=严格网格对齐；editorial=不对称分栏大留白；poster=超大字/大数字主导；
 * immersive=大图/深底氛围主导。权威来源是用户挑中的纵览候选（direction 绑定）。
 */
export type StyleComposition = "swiss" | "editorial" | "poster" | "immersive";

export interface StyleParams {
  palette: StylePalette;
  typography: StyleTypography;
  spacing: StyleSpacing;
  decoration: StyleDecoration;
  motif: StyleMotif;
  /** 封面/章节页是否深底反白。 */
  darkCover: boolean;
  /** 风格卡效果语言（用户可读，禁止来源说明）。 */
  effectLines: string[];
  /** 构图家族；归一层保证始终有值（缺失时按色板/字体确定性推导）。 */
  composition?: StyleComposition;
}

/** 聚类结果的一簇：色值与面积占比。 */
export interface StyleColorCluster {
  hex: StyleHex;
  /** 0~1，像素占比。 */
  ratio: number;
}

/** 纵览图候选（已按内容哈希入对象库）。 */
export interface StyleOverviewImage {
  contentHash: string;
  /** 风格方向短名（styler direction 候选或兜底变体名），挑图卡展示用。 */
  label?: string;
  /** 该候选绑定的构图家族；用户挑中即成为全篇 composition 的唯一权威。 */
  composition?: StyleComposition;
  /** 生成轮次（第几次「不满意」重生成）。 */
  generation: number;
}

export type SlidesStyleStage =
  | "images_ready"
  | "extracting"
  | "card_ready"
  | "confirmed";

/** 风格会话持久化行（slides_style_sessions 表的 JSON 语义）。 */
export interface SlidesStyleSessionData {
  id: string;
  draftDocumentId: string | null;
  instruction: string;
  /** 用户累积反馈（「不要太蓝」等），逐条进入下轮生图提示词。 */
  feedback: string[];
  overviewImages: StyleOverviewImage[];
  selectedImageHash: string | null;
  styleParams: StyleParams | null;
  /** 自校收敛后的演示页图（file_blobs hash）。 */
  demoImageHash: string | null;
  stage: SlidesStyleStage;
  generation: number;
}

export const STYLE_HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** 校验色值并归一化为 #RRGGBB 小写；非法抛错（聚类/合成层不允许脏值进 params）。 */
export function normalizeStyleHex(value: string, field: string): StyleHex {
  const trimmed = value.trim();
  if (!STYLE_HEX_PATTERN.test(trimmed)) {
    throw new Error(`风格色值 ${field} 必须是 #RRGGBB：${value}`);
  }
  return trimmed.toLowerCase();
}
