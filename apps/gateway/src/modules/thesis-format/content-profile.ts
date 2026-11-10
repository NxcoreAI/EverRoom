/**
 * 论文排版 v2 · 内容剖面（方案 §4.2 / §6.1 / §6.4）。
 *
 * 输入是引擎给的扁平块大纲（`describeThesisBlocks`：{index,kind,level?,text}），
 * 输出是带**语义身份**的块流：归一化标题、剥离出的原编号、章节角色、锚点、
 * 图表题注配对。映射引擎只吃这份剖面，不再直接看引擎的原始块。
 *
 * 纯确定性：不做任何"猜内容"的判断，判不出来的留给映射引擎按 R4 追加。
 */

import { anchorKindOf, type AnchorKind } from "./thesis-anchors.js";
import { normalizeTitle, numberingFamily, stripNumbering, titleTokens, type NumberingFamily } from "./text-normalize.js";

/** 引擎块大纲（与 genoffice describeThesisBlocks 同构；此处只声明用到的字段）。 */
export interface OutlineBlock {
  index: number;
  kind: "heading" | "paragraph" | "table" | "image" | "list";
  level?: number;
  text: string;
}

/** 块在本文大纲里的角色（相对深度，与原始 level 解耦）。 */
export type BlockRole = "chapter" | "section" | "subsection" | "body";

export interface ContentBlock {
  /** 贯穿到输出，保证块守恒可验证。 */
  traceId: string;
  index: number;
  kind: OutlineBlock["kind"];
  /** 原始 outline 层级（仅诊断）。 */
  level?: number;
  role: BlockRole;
  text: string;
  /** 标题块才有：归一化文本 / 原编号 / 编号体系 / token / 锚点。 */
  normalized?: string;
  originalNumber?: string;
  numberingFamily?: NumberingFamily;
  tokens?: string[];
  anchor?: AnchorKind;
  /** 图表题注：指向它描述的那个块 traceId。 */
  captionOf?: string;
  /** 紧接在图片/表格后的"图 1 xxx"这类题注文本。 */
  isCaption?: boolean;
  /** 所属章节的 traceId（标题块为自身）。 */
  chapterTraceId?: string;
}

export interface ContentOutlineNode {
  traceId: string;
  text: string;
  normalized: string;
  /** 归一化后的 token（映射引擎算相似度用）。 */
  tokens: string[];
  /** 原文编号前缀（"一、"、"1.1"），判编号体系是否同类用。 */
  originalNumber?: string;
  level: number;
  role: BlockRole;
  anchor?: AnchorKind;
  /** 子树内的块区间 [start, end)（含标题自身）。 */
  blockStart: number;
  blockEnd: number;
  children: ContentOutlineNode[];
}

export interface ContentProfile {
  version: 2;
  blocks: ContentBlock[];
  /** 章节树（用于 R2 顺序对齐与报告）。 */
  outline: ContentOutlineNode[];
  /** 文档级锚点：命中即直达对应槽位。 */
  anchors: Partial<Record<AnchorKind, string>>;
  gaps: string[];
}

/** 题注文本特征（图 X / 表 X / Figure X / Table X）。 */
const CAPTION_PATTERN = /^\s*(图|表|figure|table)\s*[0-9一二三四五六七八九十]+([.\-－]\s*[0-9]+)?\s*[:：.、]?\s*\S+/i;

/**
 * 标题角色推断（方案 §6.4）：**不直接用原始 level**。
 *
 * 真实文档里"一、业务场景分析"可能被排成 Heading 2、子节排成 Heading 3，
 * 层级数字本身不可信。这里按"文档里标题层级的相对深度"重新分档：
 * 出现的最小 level = 章节层，其次 = 小节，再深 = 子节。
 */
export function inferRoles(levels: number[]): { roleOfLevel: Map<number, BlockRole>; minLevel: number } {
  const distinct = [...new Set(levels)].sort((a, b) => a - b);
  const roleOfLevel = new Map<number, BlockRole>();
  distinct.forEach((level, index) => {
    roleOfLevel.set(level, index === 0 ? "chapter" : index === 1 ? "section" : "subsection");
  });
  return { roleOfLevel, minLevel: distinct[0] ?? 1 };
}

/** 判断块是否与上一个块构成"图片/表格 + 题注"关系。 */
function isCaptionAfter(kind: OutlineBlock["kind"], previous: OutlineBlock | undefined): boolean {
  if (!previous) return false;
  if (previous.kind !== "image" && previous.kind !== "table") return false;
  return kind === "paragraph" || kind === "list";
}

/**
 * 构建内容剖面。
 *
 * @param blocks 引擎块大纲（按文档顺序）
 */
export function buildContentProfile(blocks: OutlineBlock[]): ContentProfile {
  const gaps: string[] = [];
  const headingLevels = blocks.filter((block) => block.kind === "heading" && block.level !== undefined).map((block) => block.level!);
  const { roleOfLevel } = inferRoles(headingLevels);

  const content: ContentBlock[] = [];
  const anchors: Partial<Record<AnchorKind, string>> = {};
  let currentChapter: string | undefined;

  blocks.forEach((block, position) => {
    const traceId = `b${position}`;
    const previous = blocks[position - 1];
    const base: ContentBlock = {
      traceId,
      index: block.index,
      kind: block.kind,
      ...(block.level !== undefined ? { level: block.level } : {}),
      role: block.kind === "heading" ? roleOfLevel.get(block.level ?? 1) ?? "chapter" : "body",
      text: block.text,
    };

    if (block.kind === "heading") {
      const { text, number } = stripNumbering(block.text);
      const normalized = normalizeTitle(block.text);
      const anchor = anchorKindOf(block.text);
      if (anchor && !anchors[anchor]) anchors[anchor] = traceId;
      base.normalized = normalized;
      base.tokens = titleTokens(normalized);
      if (number) base.originalNumber = number;
      base.numberingFamily = numberingFamily(number);
      if (anchor) base.anchor = anchor;
      if (base.role === "chapter") currentChapter = traceId;
    } else {
      // 题注识别：紧跟图片/表格后的文字块
      if (CAPTION_PATTERN.test(block.text) && isCaptionAfter(block.kind, previous)) {
        base.isCaption = true;
        base.captionOf = `b${position - 1}`;
      }
    }
    if (currentChapter) base.chapterTraceId = currentChapter;
    content.push(base);
  });

  const outline = buildOutlineTree(content, gaps);
  promoteDocumentTitle(outline, content, gaps);
  if (headingLevels.length === 0) gaps.push("内容文档没有标题层级，全部内容将按追加规则落位");

  return { version: 2, blocks: content, outline, anchors, gaps };
}

/**
 * 单根 + 多子：源文档把「题目」排成了 H1（报告类文档极常见），真正的章节是它的下一级。
 *
 * 不提升的话 `inferRoles` 会把 H1 判成 chapter、H2 判成 section，
 * 整篇正文就成了「一个章节」——映射层只能把它整体塞进模板的第一个槽位，
 * 结果是所有内容挤在「一、项目任务」下面，后面的槽位全空。
 *
 * 提升后：root 降为 body（不再参与章节匹配，它的块由映射层的 R5 前置兜底承接），
 * 其子节点升为 chapter，孙节点升为 section，以此类推。
 *
 * 例外：root 自己长得就像章标题（「第一章 绪论」「一、XX」），而全文又只有这一个
 * 顶级标题时，它**就是**那一章——把它降级会让整章没有章名、子节冒充章节。
 * 单章文档（绪论 + 1.1/1.2）正是这种形状，实测会被误提升。
 */
function promoteDocumentTitle(roots: ContentOutlineNode[], content: ContentBlock[], gaps: string[]): void {
  if (roots.length !== 1) return;
  const root = roots[0]!;
  if (root.children.length < 2) return;
  if (root.children[0]!.level <= root.level) return;
  if (/^\s*(第[一二三四五六七八九十百零0-9]{1,4}\s*[章篇节]|[一二三四五六七八九十]{1,3}\s*[、.．]|[0-9]{1,2}(\.[0-9]{1,2})+\s*\S?|[0-9]{1,2}\s*[、.．])/.test(root.text)) {
    return;
  }

  const promote = (node: ContentOutlineNode, role: BlockRole): void => {
    node.role = role;
    const block = content.find((entry) => entry.traceId === node.traceId);
    if (block) block.role = role;
  };
  const walk = (node: ContentOutlineNode, role: BlockRole): void => {
    promote(node, role);
    const childRole: BlockRole = role === "chapter" ? "section" : "subsection";
    for (const child of node.children) walk(child, childRole);
  };

  promote(root, "body");
  for (const child of root.children) walk(child, "chapter");
  roots.splice(0, roots.length, ...root.children);
  gaps.push(
    `源文档只有一个一级标题「${root.text}」，已按题目处理，其下 ${root.children.length} 个二级标题作为章节`,
  );
}

/** 章节树：按标题块的层级建树，并回填每棵子树覆盖的块区间 [start,end)。 */
function buildOutlineTree(content: ContentBlock[], gaps: string[]): ContentOutlineNode[] {
  const roots: ContentOutlineNode[] = [];
  const stack: ContentOutlineNode[] = [];
  const nodesByTrace = new Map<string, ContentOutlineNode>();

  content.forEach((block, position) => {
    if (block.kind !== "heading" || block.normalized === undefined) return;
    const node: ContentOutlineNode = {
      traceId: block.traceId,
      text: block.text,
      normalized: block.normalized,
      tokens: block.tokens ?? [],
      ...(block.originalNumber ? { originalNumber: block.originalNumber } : {}),
      level: block.level ?? 1,
      role: block.role,
      ...(block.anchor ? { anchor: block.anchor } : {}),
      blockStart: position,
      blockEnd: content.length,
      children: [],
    };
    nodesByTrace.set(node.traceId, node);
    while (stack.length > 0 && stack[stack.length - 1]!.level >= node.level) {
      const closed = stack.pop()!;
      closed.blockEnd = position;
    }
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  });
  while (stack.length > 0) stack.pop()!.blockEnd = content.length;

  if (roots.length === 0 && content.length > 0) gaps.push("未识别出任何章节标题");
  return roots;
}

/** 章节树展平（R2 顺序对齐用）。 */
export function flattenChapters(profile: ContentProfile): ContentOutlineNode[] {
  const out: ContentOutlineNode[] = [];
  const walk = (nodes: ContentOutlineNode[]): void => {
    for (const node of nodes) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(profile.outline);
  return out;
}