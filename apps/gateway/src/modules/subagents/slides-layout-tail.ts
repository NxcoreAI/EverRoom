/**
 * generate 尾部（布局树链路）：契约注册 → 建 N 页占位 deck → 每页并发 dispatch
 * slides-layouter（窗口 8）→ 按**完成顺序**编译落页（占位页按页序就位，谁先出树谁先落，进度广播）→
 * 页落定后立刻自审（该页渲染图直投视觉模型；修正树机械重落同一页）→
 * 页间树相似度审计（超标页重排 ≤1 次）→ 汇总回收。
 * 落页优先：自审不挡用户看到这一页，只负责在之后提质。
 * agent 只出树与判断；编译、落页、套用全部网关确定性执行。
 */

import { abortableDelay, abortableItems, GenerationBudgetError } from "./slides-generation-budget.js";
import { createHash, randomUUID } from "node:crypto";
import type { RuntimeAttachment } from "@nxcore/agent-runtime";
import type { SubagentInvocation } from "@nxcore/agent-contract";
import type { SlidesProgressEvent, SlidesProgressPlan, SlidesProgressTracker } from "./slides-progress-tracker.js";
import type { OfficeBridgeClient, OfficeCompleteInput } from "../documents/capabilities/office-bridge-client.js";
import { MAX_PAGE_SPEC_LENGTH, skeletonPageSpec } from "../documents/capabilities/office-plugin.js";
import { contractFromStyleParams, type LayoutContract } from "../slides-layout/tree/layout-contract.js";
import { TYPE_TOKENS, type ResolvedTheme } from "../slides-layout/theme.js";
import { dropDeckLayoutContext, registerDeckLayoutContext } from "../slides-layout/deck-contract-context.js";
import { pptxToPng } from "../slides-style/render.js";
import { normalizeTree, type LayoutTree } from "../slides-layout/tree/schema.js";
import { compileTree } from "../slides-layout/tree/compile.js";
import { visualRichnessIssues } from "../slides-layout/tree/v2/richness.js";
import { measureDefects, shrinkToFit, type LayoutDefect } from "../slides-layout/tree/measure.js";
import { auditSimilarity, treeSignature } from "../slides-layout/tree/similarity.js";
import { imageDimensions, resolveImageArs } from "../slides-layout/tree/aspect-ratio.js";
import { pngBase64ToJpegBase64 } from "./screenshot-jpeg.js";
import { checkSemanticBindings, checkSemanticRendered } from "./slides-semantic-bindings.js";
import type { SemanticPage } from "./slides-semantic-contract.js";
import {
  deriveComposition,
  deriveSkeleton,
  isPageForm,
  type EngineComposition,
} from "./slides-page-form.js";

const COMPOSITION_TENDENCY: Record<string, string> = {
  swiss: "强网格、克制留白、对齐严谨",
  editorial: "编辑杂志感、不对称分区、大图与文字块错落",
  poster: "海报感、大字主导、视觉冲击",
  immersive: "沉浸式、大图满版、文字叠于图上",
};

/** 落页尾部用到的 Office 桥子集；completeDeck 可选（旧 mock/宿主无此能力时不补完成通知）。 */
export type LayouterOfficeBridge = Pick<OfficeBridgeClient, "generate" | "fillPage" | "renderPage"> & {
  renderPptx?: OfficeBridgeClient["renderPptx"];
  completeDeck?: (input: OfficeCompleteInput) => Promise<{ ok: boolean }>;
};

export interface LayouterTailDeps {
  progress: SlidesProgressTracker | null;
  bridge: LayouterOfficeBridge | null;
  /**
   * 单册 deck 的页级并发上限（逐页取树 worker 数）。缺省 16＝`DEFAULT_DECK_CONCURRENCY`。
   * 这是「本册同时在飞的页数」，配置时三者须一致：本值、网关 slides 池容量
   * （NXCORE_SUBAGENT_SLIDES_MAX_CONCURRENT，缺省 16）、slides-layouter 的
   * policy.maxConcurrency（缺省 16）。超过后两者会被池/单代理限额秒拒并落兜底页。
   */
  deckConcurrency?: number;
  readMaterialBlob(hash: string): Promise<Uint8Array | null>;
  fetchImageHead(url: string): Promise<Uint8Array | null>;
  /** 幂等键（tools.ts 的 dispatchKey 单一出处）。 */
  makeKey(runId: string, agentId: string, task: string, input: unknown): string;
  /** 带并发限额退避的 dispatch（tools.ts 的 dispatchWithConcurrencyRetry 单一出处）。 */
  /**
   * 单页布局 dispatch。第 4 参是附件——自审回投时把该页渲染图直接投给布局代理，
   * 让它"看着自己的成品"改，而不是读一段二手文字描述。
   */
  dispatchPage(
    input: Record<string, unknown>,
    idempotencyKey: string,
    parentRunId: string | null,
    attachments?: Array<{ filename: string; mimeType: string; kind: "image"; dataUrl: string }>,
  ): Promise<SubagentInvocation>;
}

/** 流式页源：内容批次一就绪就把该页推进来，落页不必等全册编排完成。 */
export interface LayouterPageInputStream {
  totalPages: number;
  /** 占位页标题（与最终页序一致）：骨架页先按它建满。 */
  outline: string[];
  pages: AsyncIterable<{ pageIndex: number; page: PageInput; parentRunId?: string | null }>;
}

/** 续落：配图确认/中断恢复后复用同一个 deck 文件，只落还没落定的页。 */
export interface LayouterExistingDeck {
  fileEntryId: string;
  originalName: string | null;
  /** 已落定页（0 起页序）；这些页不再 dispatch、不再重落。 */
  appliedPages: number[];
  totalPages: number;
}

export interface LayouterTailArgs {
  roomId: string;
  sessionId: string;
  runId: string;
  parentRunId: string | null;
  instruction: string;
  plan: Record<string, unknown>;
  armPlan: SlidesProgressPlan;
  styleParams: Record<string, unknown> | null;
  /** 场景（静默判断得出）：决定字号阶梯、最小字号与字数预算。缺省落最保守一档。 */
  scene?: string | null;
  draftDocumentId: string;
  settle: { pageImagesSessionId?: string; styleSessionIdToSettle?: string | null };
  styleSessions: { patch(id: string, value: Record<string, unknown>): unknown } | null;
  pageImagesStore: { patch(id: string, value: Record<string, unknown>): unknown } | null;
  trashDraft: (documentId: string) => Promise<void>;
  /** 流式页源：与 plan.pages 二选一。给定时 plan.pages 只用于标题/页数。 */
  stream?: LayouterPageInputStream;
  /** 复用已有 deck：跳过建骨架，只补落 appliedPages 之外的页。 */
  existingDeck?: LayouterExistingDeck;
  signal?: AbortSignal;
  onCheckpoint?: (deck: LayouterExistingDeck) => void;
  onUpdate?: (update: { content: string; details: unknown }) => void;
}

export interface PageInput {
  content?: SemanticPage;
  title?: string;
  role?: string;
  density?: string;
  data?: unknown;
  materials?: unknown;
  notes?: unknown;
  /** 2 = v2 页面（storyboard 接线）：layouter 输出 version:2/composition/nodes。 */
  layoutVersion?: number;
  /** 内容形态：这页靠什么证据成立。composition 由它推导，不再由大纲选择。 */
  form?: string;
  units?: number;
  weight?: string;
  /** 骨架意图（给 layouter 的几何指令，不是版式名）。 */
  skeleton?: string;
  composition?: string;
  emphasis?: string;
  intent?: string;
  takeaway?: string;
  copy?: Record<string, unknown>;
  neighbors?: unknown[];
  budget?: Record<string, unknown>;
  /** 视觉丰富度闸门打回时给 layouter 的修正提示（只给一次）。 */
  revisionFeedback?: string;
}

/** 进度事件 → 渲染层进度卡载荷（tools.ts 的 relay 共用；单一出处在本模块）。 */
export function slidesProgressUpdatePayload(event: SlidesProgressEvent): Record<string, unknown> {
  const snapshot = event.snapshot;
  return {
    stage: "page_applied",
    slideIndex: event.slideIndex,
    title: snapshot.title,
    totalPages: snapshot.totalPages,
    pages: snapshot.pages,
    doneCount: snapshot.doneCount,
    ...(snapshot.appliedPages?.length ? { appliedPages: snapshot.appliedPages } : {}),
    updatedAt: event.updatedAt,
    ...(snapshot.narrative ? { narrative: snapshot.narrative } : {}),
    ...(snapshot.warnings?.length ? { warnings: snapshot.warnings } : {}),
  };
}

function styleBriefFrom(styleParams: Record<string, unknown> | null): string {
  if (!styleParams) return "";
  const parts: string[] = [];
  const composition = styleParams.composition;
  if (typeof composition === "string" && COMPOSITION_TENDENCY[composition]) {
    parts.push(COMPOSITION_TENDENCY[composition]!);
  }
  const effectLines = styleParams.effectLines;
  if (Array.isArray(effectLines)) {
    for (const line of effectLines) {
      if (typeof line === "string" && line.trim() && !/^构图[:：]/.test(line.trim())) {
        parts.push(line.trim());
      }
    }
  }
  return parts.join("；").slice(0, 400);
}

/** styleTokens 体积上限（字符）：超了先丢图表色板，再只留三只基准色。 */
export const STYLE_TOKENS_MAX_CHARS = 1200;

function clippedStyleToken(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? [...text].slice(0, max).join("") : null;
}

function finiteStyleToken(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 丢掉空值（null/空串），数组与布尔照原样保留。 */
function compactStyleTokens(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== null && value !== undefined && value !== ""),
  );
}

/**
 * 风格卡 → 布局代理输入里的确定性 token 快照（每 run 只算一次）。
 * agent 拿它当设计系统真源：palette/typeScale/fonts/spacing/decoration 是像素口径，
 * design 轴的默认值在 componentDefaults；组件只写语义 style，不写裸色号裸像素。
 * 长字符串截断（字体名 ≤40 字）、空值丢弃、图表色板只留 4 只；总长超 1200 字符时
 * 依次降级（丢 chartSeries → 只留 background/primary/accent），语义枚举与字号不动。
 */
export function styleTokensFrom(theme: ResolvedTheme): Record<string, unknown> {
  const design = theme.design;
  const tokens: Record<string, unknown> = compactStyleTokens({
    composition: design.composition,
    darkCover: design.darkCover,
    motif: compactStyleTokens({
      kind: design.motif.kind,
      spec: Object.keys(design.motif.spec).length > 0 ? design.motif.spec : null,
    }),
    palette: compactStyleTokens({
      background: clippedStyleToken(theme.colors.background, 9),
      surface: clippedStyleToken(theme.colors.surface, 9),
      primary: clippedStyleToken(theme.colors.primary, 9),
      accent: clippedStyleToken(theme.colors.accent, 9),
      text: clippedStyleToken(theme.colors.text, 9),
      textMuted: clippedStyleToken(theme.colors.textMuted, 9),
      onDarkText: clippedStyleToken(theme.colors.onDarkText, 9),
      chartSeries: theme.colors.chartSeries.slice(0, 4),
    }),
    typeScale: Object.fromEntries(TYPE_TOKENS.map((token) => [token, theme.typeScale[token]])),
    fonts: compactStyleTokens({
      heading: clippedStyleToken(theme.fonts.heading, 40),
      body: clippedStyleToken(theme.fonts.body, 40),
      headingBold: theme.fonts.headingBold,
    }),
    spacing: {
      margin: theme.spacing.margin,
      gutter: theme.spacing.gutter,
      cardPadding: theme.spacing.cardPadding,
      cornerRadius: theme.spacing.cornerRadius,
    },
    decoration: compactStyleTokens({
      cardStroke: theme.decoration.cardStroke === null ? null : clippedStyleToken(theme.decoration.cardStroke, 9),
      cardStrokeWidthPt: finiteStyleToken(theme.decoration.cardStrokeWidthPt),
      cardShadow: theme.decoration.cardShadow,
      divider: theme.decoration.divider,
      imageFit: theme.decoration.imageFit,
    }),
    componentDefaults: {
      surface: design.surface,
      separator: design.separator,
      align: design.align,
      density: design.density,
      numeral: design.numeral,
      accent: design.accent,
    },
  });

  if (JSON.stringify(tokens).length <= STYLE_TOKENS_MAX_CHARS) return tokens;
  delete (tokens.palette as Record<string, unknown>).chartSeries;
  if (JSON.stringify(tokens).length <= STYLE_TOKENS_MAX_CHARS) return tokens;
  const palette = tokens.palette as Record<string, unknown>;
  const reducedPalette: Record<string, unknown> = {};
  for (const key of ["background", "primary", "accent"]) {
    if (palette[key] !== undefined) reducedPalette[key] = palette[key];
  }
  tokens.palette = reducedPalette;
  return tokens;
}

/** 散文要点 → pointList 条目：找得到短帽（冒号/逗号/年份头）就拆标签，否则编号标签。 */
function pointListItem(point: string, index: number): { label: string; body: string } {
  const text = point.trim();
  const colon = text.search(/[：:]/);
  if (colon >= 2 && colon <= 12) {
    const body = text.slice(colon + 1).trim();
    if (body) return { label: text.slice(0, colon).trim(), body: body.slice(0, 100) };
  }
  const comma = /^([^，,。；\n]{2,12})[，,]/.exec(text);
  if (comma) {
    const body = text.slice(comma[1]!.length + 1).trim();
    if (body) return { label: comma[1]!.trim(), body: body.slice(0, 100) };
  }
  const year = /^([12]\d{3}\s*年(?:\s*[0-9一二三四五六七八九十]{1,3}\s*月)?)[\s，,]/.exec(text);
  if (year) {
    const body = text.slice(year[0].length).trim();
    if (body) return { label: year[1]!.trim(), body: body.slice(0, 100) };
  }
  return { label: `要点 ${String(index + 1).padStart(2, "0")}`, body: text.slice(0, 100) };
}

/** data 的 KPI 行（「指标: 数值 单位（+x%）」）→ stats 条目；图表行跳过；最多 4 条。 */
function kpiStatsItems(data: string): { value: string; label: string; unit?: string }[] {
  const items: { value: string; label: string; unit?: string }[] = [];
  for (const lineRaw of data.split("\n")) {
    if (items.length >= 4) break;
    const line = lineRaw.trim();
    if (!line || /^[a-zA-Z][a-zA-Z0-9]*\s*\|/.test(line)) continue;
    const at = line.search(/[：:]/);
    if (at < 1) continue;
    const rest = line.slice(at + 1).trim();
    const m = /^([\d,.．]+)\s*([^（(\s]+)?/.exec(rest);
    if (!m) continue;
    const growth = /[（(]([+±-][^）)]*)[）)]/.exec(rest);
    const base = line.slice(0, at).trim();
    const label = (growth ? `${base}（${growth[1]!.trim()}）` : base).slice(0, 40);
    const unit = m[2] ?? "";
    items.push({ value: m[1]!, label, ...(unit ? { unit: unit.slice(0, 8) } : {}) });
  }
  return items;
}

/** v2 结构化 data（{stats:[…]}）→ stats 条目；退化时按 KPI 行文本解析；再不行用 copy.facts；语义页用 metric/chart block。 */
function v2StatsItems(page: PageInput): { value: string; label: string; unit?: string }[] {
  // 语义页：metric block 天然是 stats 条目（chart 只有一组数时取首尾差值没有口径，不造数）。
  const metricItems = (page.content?.blocks ?? []).flatMap(block => {
    if (block.type !== "metric") return [];
    const value = typeof block.value === "number" ? String(block.value) : block.value.trim();
    if (!value || !block.label.trim()) return [];
    return [{ value: value.slice(0, 16), label: block.label.trim().slice(0, 40), ...(block.unit ? { unit: block.unit.slice(0, 8) } : {}) }];
  }).slice(0, 4);
  if (metricItems.length > 0) return metricItems;
  const data = page.data;
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const raw = (data as Record<string, unknown>).stats;
    if (Array.isArray(raw)) {
      const items = raw.flatMap((entry) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
        const stat = entry as Record<string, unknown>;
        const value = typeof stat.value === "string" ? stat.value.trim() : "";
        const label = typeof stat.label === "string" ? stat.label.trim() : "";
        if (!value || !label) return [];
        const unit = typeof stat.unit === "string" && stat.unit.trim() ? stat.unit.trim().slice(0, 8) : undefined;
        return [{ value: value.slice(0, 16), label: label.slice(0, 40), ...(unit ? { unit } : {}) }];
      }).slice(0, 4);
      if (items.length > 0) return items;
    }
  }
  if (typeof data === "string") {
    const items = kpiStatsItems(data);
    if (items.length > 0) return items;
  }
  const copy = page.copy;
  const facts = copy && Array.isArray(copy.facts) ? copy.facts : [];
  return facts.flatMap((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const fact = entry as Record<string, unknown>;
    const value = typeof fact.value === "string" ? fact.value.trim() : "";
    const label = typeof fact.label === "string" ? fact.label.trim() : "";
    if (!value || !label) return [];
    const unit = typeof fact.unit === "string" && fact.unit.trim() ? fact.unit.trim().slice(0, 8) : undefined;
    return [{ value: value.slice(0, 16), label: label.slice(0, 40), ...(unit ? { unit } : {}) }];
  }).slice(0, 4);
}

/**
 * 兜底页的构图：优先按这页声明的内容形态推导（兜底页不放图，所以按 hasImage=false 推）；
 * 没有形态字段的历史页才退回 role 映射。
 */
function fallbackComposition(page: PageInput): EngineComposition {
  const role = typeof page.role === "string" ? page.role : "content";
  if (isPageForm(page.form)) {
    return deriveComposition(page.form, { hasImage: false, role });
  }
  if (role === "cover") return "poster";
  if (role === "section") return "chapter";
  if (role === "quote") return "poster";
  if (role === "data") return "hero-data";
  return "swiss";
}

/**
 * 布局代理失败/未交树时的确定性兜底页。与正常页**同格式**：v2 页面，走同一套校验、编译、落页链路。
 * 不放图片（配图是失败的主要来源）；优先保住 message 与数字，条目进 pointList/stats。
 * 这里不是“第二套排版语法”，是同一套语法的最简解：失败不换格式。
 */
function fallbackPage(page: PageInput): LayoutTree {
  const role = typeof page.role === "string" && page.role.trim() ? page.role.trim().slice(0, 20) : (page.content?.role ?? "content");
  const copy = page.copy ?? {};
  const copyText = (key: string, max: number): string | undefined => {
    const value = copy[key];
    return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
  };
  const title = typeof page.title === "string" && page.title.trim() ? page.title.trim().slice(0, 80) : undefined;
  // 语义页兜底：文案一律从 content 契约取（message + text block），不能落成「内容生成中断」的空页。
  const semanticTexts = (page.content?.blocks ?? [])
    .flatMap(block => {
      if (block.type === "text") return [block.text];
      if (block.type === "quotation") return [block.text];
      if (block.type === "metric") return [`${block.label} ${block.value}${block.unit ?? ""}`];
      return [];
    })
    .map(text => text.trim())
    .filter(Boolean);
  const message = copyText("message", 80) ?? (page.content?.message ? page.content.message.trim().slice(0, 80) : undefined) ?? title;
  const kicker = copyText("kicker", 24);
  const source = copyText("source", 80);
  const notes = copyText("speakerNotes", 2000)
    ?? (typeof page.content?.notes === "string" && page.content.notes.trim() ? page.content.notes.trim().slice(0, 2000) : undefined)
    ?? (typeof page.notes === "string" && page.notes.trim() ? page.notes.trim().slice(0, 2000) : undefined);
  // 兜底页只吃 v2 内容（copy.supporting 由 storyboard 合并恒定提供），语义页吃 text block 文案。
  const bodyLines = (Array.isArray(copy.supporting) ? copy.supporting : semanticTexts)
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .slice(0, 4);
  const bodyItems = bodyLines.slice(0, 3).map((line, index) => pointListItem(line, index));
  const quote = copy.quote !== null && copy.quote !== undefined && typeof copy.quote === "object" && !Array.isArray(copy.quote)
    ? copy.quote as Record<string, unknown>
    : null;
  const quoteText = typeof quote?.text === "string" && quote.text.trim() ? quote.text.trim().slice(0, 160) : undefined;
  const statsItems = v2StatsItems(page);
  const composition = fallbackComposition(page);
  const nodes: Record<string, unknown>[] = [];
  const pushText = (token: string, text: string, slot: Record<string, unknown>, tone?: string): void => {
    nodes.push({ type: "text", token, text, ...(tone ? { tone } : {}), slot });
  };
  // 标题区短横线：所有构图共用，保证存在非文字锚点。
  const rule = (row: number): Record<string, unknown> => ({ type: "shape", shape: "rect", fill: "tone:primary", slot: { col: [1, 2], row: [row, row] } });

  if (composition === "poster" || composition === "chapter") {
    if (kicker) pushText("kicker", kicker, { col: [1, 6], row: [1, 1] }, "primary");
    pushText("display", quoteText ?? message ?? "内容生成中断，本页为兜底版式", { col: [1, 12], row: [3, 6] });
    nodes.push(rule(7));
    if (bodyLines.length > 0) pushText("lead", bodyLines.slice(0, 2).join("\n"), { col: [1, 10], row: [8, 8] });
  } else if (composition === "hero-data") {
    if (kicker) pushText("kicker", kicker, { col: [1, 6], row: [1, 1] }, "primary");
    if (message) pushText("h1", message, { col: [1, 8], row: [2, 2] });
    const first = statsItems[0];
    pushText("hero", first ? `${first.value}${first.unit ?? ""}` : (message ?? "本页为兜底版式"), { col: [1, 4], row: [3, 5] }, "primary");
    if (first) pushText("label", first.label, { col: [1, 4], row: [6, 6] }, "muted");
    // 数字和条目都要留：hero-data 不是只要一个数——失去条目等于丢内容。
    if (bodyItems.length >= 2) {
      nodes.push({ type: "component", name: "pointList", numbered: true, items: bodyItems, slot: { col: [5, 8], row: [3, 6] } });
    }
    if (statsItems.length >= 2) {
      nodes.push({ type: "component", name: "stats", layout: "column", items: statsItems, slot: { col: [9, 12], row: [2, 7] } });
    }
    nodes.push(rule(7));
  } else {
    if (kicker) pushText("kicker", kicker, { col: [1, 5], row: [1, 1] }, "primary");
    if (message) pushText("h1", message, { col: [1, 9], row: [2, 3] });
    nodes.push(rule(4));
    if (bodyItems.length >= 2) {
      nodes.push({ type: "component", name: "pointList", numbered: true, items: bodyItems, slot: { col: [1, 7], row: [5, 8] } });
    } else if (bodyLines.length === 1) {
      pushText("body", bodyLines[0]!.slice(0, 300), { col: [1, 7], row: [5, 8] });
    }
    if (statsItems.length >= 2) {
      nodes.push({ type: "component", name: "stats", layout: "column", items: statsItems, slot: { col: [9, 12], row: [2, 6] } });
    }
  }

  const footer = source ? { left: source, pageNumbers: true } : { pageNumbers: true };
  try {
    return normalizeTree({
      version: 2,
      role,
      composition,
      ...(composition === "poster" || composition === "chapter" ? { dark: true } : {}),
      ...(notes ? { notes } : {}),
      footer,
      nodes,
    });
  } catch {
    // 兜底页本身也不合法时：退到最小 v2 页。仍然是 v2——失败不换格式。
    // 这里刻意不产出“标题 + 要点列表”：那正是最通用、最没特点的那一版，会变成安全牌。
    // 退化成“轻页”：一句话 + 大留白。
    return normalizeTree({
      version: 2,
      role,
      composition: "poster",
      dark: true,
      footer,
      nodes: [
        { type: "text", token: "display", text: message ?? title ?? "本页内容生成中断", slot: { col: [1, 10], row: [3, 6] } },
        { type: "shape", shape: "rect", fill: "tone:primary", slot: { col: [1, 2], row: [7, 7] } },
      ],
    });
  }
}

/** 减配页输入：支撑条目砍半、去图表、去讲稿、密度降档——布局代理未交树时的第二次机会（格式不变）。 */
function trimmedPage(page: PageInput): PageInput {
  const copy = page.copy ? { ...page.copy } : undefined;
  if (copy) {
    if (Array.isArray(copy.supporting)) {
      const lines = copy.supporting.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
      copy.supporting = lines.slice(0, Math.max(2, Math.ceil(lines.length / 2))).slice(0, 4);
    }
    if (Array.isArray(copy.facts)) copy.facts = copy.facts.slice(0, 3);
    delete copy.speakerNotes;
  }
  const data = page.data !== null && typeof page.data === "object" && !Array.isArray(page.data)
    ? Object.fromEntries(Object.entries(page.data as Record<string, unknown>).filter(([key]) => key !== "chart"))
    : page.data;
  return {
    layoutVersion: 2,
    ...(typeof page.composition === "string" ? { composition: page.composition } : {}),
    ...(typeof page.form === "string" ? { form: page.form } : {}),
    ...(typeof page.units === "number" ? { units: page.units } : {}),
    ...(typeof page.weight === "string" ? { weight: page.weight } : {}),
    ...(typeof page.skeleton === "string" ? { skeleton: page.skeleton } : {}),
    ...(typeof page.emphasis === "string" ? { emphasis: page.emphasis } : {}),
    ...(typeof page.intent === "string" ? { intent: page.intent } : {}),
    ...(typeof page.takeaway === "string" ? { takeaway: page.takeaway } : {}),
    ...(copy ? { copy } : {}),
    ...(page.neighbors ? { neighbors: page.neighbors } : {}),
    ...(page.budget ? { budget: page.budget } : {}),
    ...(typeof page.title === "string" ? { title: page.title } : {}),
    ...(typeof page.role === "string" ? { role: page.role } : {}),
    density: "sparse",
    ...(data !== undefined && data !== null && (typeof data !== "object" || Object.keys(data as Record<string, unknown>).length > 0)
      ? { data }
      : {}),
    ...(page.materials !== undefined ? { materials: page.materials } : {}),
  };
}

/**
 * 单页渲染的并发闸：pptxToPng 会起 LibreOffice 子进程，一册 15 页同时渲染会把
 * 机器打满（实测 16 路 soffice 互相拖慢，反而比串行更久）。渲染只是自审的准备工作，
 * 限流不影响模型侧的并发。
 */
const SELF_REVIEW_RENDER_CONCURRENCY = 2;

/**
 * 自审回投的并发闸：落页不再等自审（先落页、后自审），自审调用会和后续页的取树
 * 同时在飞；页窗口本来就是 slides 池上限，再放一整套自审并发会撞
 * `subagent_concurrency_limit` 而退避。4 路足够让自审跟上落页节奏。
 */
const SELF_REVIEW_CONCURRENCY = 4;

/** 引擎硬闸类缺陷：这些没清干净就不能落页（自审修正也按同一套判）。 */
const BLOCKING_DEFECTS = new Set(["overlap", "emoji", "overflow", "font_floor", "canvas", "element_cap"]);

/**
 * 桌面端「产物未以可编辑会话打开」：落页被拒的确定性原因，不是树/内容的问题。
 * 这种页要明确告诉用户「去产物库打开这本 PPT 再重试」，不要笼统记成落页失败。
 */
function isDeckNotOpenMessage(message: string): boolean {
  return /not_open|未打开|可编辑的\s*PPT|可编辑方式打开/i.test(message);
}

function createSemaphore(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

const PAGE_DISPATCH_RETRY_DELAYS_MS = [2000, 6000];

/**
 * 页级并发窗口缺省值。必须与 `NXCORE_SLIDES_DECK_CONCURRENCY`（config.ts 的
 * `DEFAULT_SLIDES_DECK_CONCURRENCY`）以及 `agents/slides-layouter/agent.yaml` 的
 * `policy.maxConcurrency` 三者一致——页窗口大于后两者时，超出的页会被
 * `subagent_concurrency_limit` 秒拒并落兜底页（见 agents/slides-layouter/agent.yaml 注释）。
 */
const DEFAULT_DECK_CONCURRENCY = 16;

/**
 * 按 `limit` 个 worker 依次认领 `0..count-1` 的索引，worker 跑完一件才认领下一件。
 *
 * 这是页级并发的唯一入口（slides 落页尾部用它扇出逐页布局）。抽成独立函数是为了
 * 能被单测直接钉住：改造前它是硬编码的 `Math.min(8, pages.length)`，一册 15 页会有
 * 7 页干等第一波落定，白白多出一整轮单页耗时（实测 P50 141s）。
 *
 * `worker` 内部的异常不会中断其它页——调用方负责在 worker 内消化（见落页尾部的 slot.resolve）。
 */
export async function runIndexWorkers(
  count: number,
  limit: number,
  worker: (index: number) => Promise<void>,
): Promise<void> {
  const workerCount = Math.min(Math.max(1, Math.floor(limit) || 1), Math.max(count, 0));
  let cursor = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= count) return;
      await worker(index);
    }
  }));
}

/** 并发限额拒绝（框架无排队，满窗即硬拒）：与「代理跑完但树不合格」是两种失败。 */
function isConcurrencyLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === "subagent_concurrency_limit" || message === "subagent_global_concurrency_limit";
}

/** 页级 dispatch 长退避：并发限额是常态（页窗口 ≥ 池/单代理窗口），拒绝即退避重试，耗尽才落兜底。 */
async function dispatchWithPageRetry(
  fn: () => Promise<SubagentInvocation>,
  signal?: AbortSignal,
): Promise<SubagentInvocation> {
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await fn();
    } catch (error) {
      signal?.throwIfAborted();
      if (!isConcurrencyLimitError(error)) throw error;
      const delay = PAGE_DISPATCH_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw error;
      await abortableDelay(delay, signal);
    }
  }
}

/**
 * 代理产物 → 布局树。接受条件只有一条：**v2 页面**（`version: 2`）。
 * v1 树不再被任何写路径接受——落到兜底页，而不是退回另一套语法。
 */
function treeFromInvocation(
  invocation: SubagentInvocation,
  page: PageInput,
): { tree: LayoutTree; fellBack: boolean; designIntent?: string; reason?: string; blocked?: Record<string, unknown> } {
  if (invocation.status === "completed") {
    const structured = invocation.result?.structuredOutput;
    if (structured !== null && typeof structured === "object" && !Array.isArray(structured)) {
      const result = structured as Record<string, unknown>;
      if (result.status === "blocked") return {
        tree: fallbackPage(page), fellBack: true, reason: String(result.reason),
        blocked: { reason: result.reason, attempts: result.attempts, requestedAction: result.requestedAction },
      };
      const raw = result.tree;
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        try {
          const tree = normalizeTree(raw);
          if (tree.version === 2) {
            if (page.content) {
              const errors = checkSemanticBindings(page.content, tree.v2, structured as Record<string, unknown>,
                Array.isArray(page.materials) ? (page.materials as PageMaterial[]).flatMap(m => typeof m.url === "string" ? [m.url] : []) : []);
              if (errors.length) return { tree: fallbackPage(page), fellBack: true, reason: errors.join("; ") };
            }
            return { tree, fellBack: false,
              ...(typeof result.designIntent === "string" && result.designIntent.trim()
                ? { designIntent: result.designIntent.slice(0, 1000) } : {}),
            };
          }
          return { tree: fallbackPage(page), fellBack: true, reason: "交回的是 v1 树，已按 v2 兜底页落页" };
        } catch (error) {
          return {
            tree: fallbackPage(page),
            fellBack: true,
            reason: `树不合法：${error instanceof Error ? error.message.slice(0, 120) : String(error)}`,
          };
        }
      }
    }
    return { tree: fallbackPage(page), fellBack: true, reason: "未提交结构化布局树" };
  }
  return { tree: fallbackPage(page), fellBack: true, reason: `代理状态 ${invocation.status}` };
}

interface PageMaterial { url?: unknown; desc?: unknown; aspectRatio?: unknown }

function materialUrls(pages: PageInput[]): string[] {
  const urls = new Set<string>();
  for (const page of pages) {
    if (!Array.isArray(page.materials)) continue;
    for (const material of page.materials as PageMaterial[]) {
      if (material !== null && typeof material === "object" && typeof material.url === "string"
        && /^(https?:\/\/|everroom-material:\/\/)/i.test(material.url)) {
        urls.add(material.url);
      }
    }
  }
  return [...urls];
}

/** 页内容 → layouter 输入（白名单拷贝，schema 对齐 agents/slides-layouter/schemas/input.schema.json）。 */
function layouterInputFor(
  base: { token: string; totalPages: number; styleBrief: string; styleTokens: Record<string, unknown> },
  page: PageInput,
  index: number,
  neighborSignatures?: string[],
): Record<string, unknown> {
  const materials = Array.isArray(page.materials)
    ? (page.materials as PageMaterial[])
        .filter((m) => m !== null && typeof m === "object" && typeof m.url === "string")
        .slice(0, page.content ? 8 : 4)
        .map((m) => ({
          url: (m.url as string).slice(0, 500),
          ...(typeof m.desc === "string" ? { desc: m.desc.slice(0, 200) } : {}),
          ...(typeof m.aspectRatio === "number" && Number.isFinite(m.aspectRatio) && m.aspectRatio > 0
            ? { aspectRatio: m.aspectRatio }
            : {}),
        }))
    : [];
  if (page.content) return {
    task: "layout", deckToken: base.token, pageIndex: index, totalPages: base.totalPages,
    layoutVersion: 2, content: page.content, role: page.content.role,
    density: page.density ?? "standard", materials, neighbors: page.neighbors ?? [],
    ...(page.revisionFeedback ? { revisionFeedback: page.revisionFeedback.slice(0, 300) } : {}),
    ...(base.styleBrief ? { styleBrief: base.styleBrief } : {}), styleTokens: base.styleTokens,
  };
  return {
    task: "layout",
    deckToken: base.token,
    pageIndex: index,
    totalPages: base.totalPages,
    layoutVersion: 2,
    role: typeof page.role === "string" ? page.role : "content",
    density: typeof page.density === "string" ? page.density : "standard",
    ...(typeof page.composition === "string" ? { composition: page.composition } : {}),
    ...(typeof page.form === "string" ? { form: page.form } : {}),
    ...(typeof page.units === "number" ? { units: page.units } : {}),
    ...(typeof page.skeleton === "string" && page.skeleton.trim()
      ? { skeleton: page.skeleton.slice(0, 140) }
      : isPageForm(page.form)
        ? { skeleton: deriveSkeleton(page.form, page.units) }
        : {}),
    ...(typeof page.emphasis === "string" ? { emphasis: page.emphasis } : {}),
    ...(typeof page.intent === "string" ? { intent: page.intent.slice(0, 200) } : {}),
    ...(typeof page.takeaway === "string" ? { takeaway: page.takeaway.slice(0, 40) } : {}),
    // v2 不传 planner 的动作标题：模型会拿它当 h1，压过 copy.message 并导致长标题换行。
    ...(page.copy ? { copy: page.copy } : {}),
    ...(page.data !== undefined && page.data !== null ? { data: page.data } : {}),
    ...(materials.length > 0 ? { materials } : {}),
    ...(Array.isArray(page.neighbors) && page.neighbors.length > 0 ? { neighbors: page.neighbors.slice(0, 2) } : {}),
    ...(page.budget ? { budget: page.budget } : {}),
    ...(typeof page.revisionFeedback === "string" && page.revisionFeedback.trim()
      ? { revisionFeedback: page.revisionFeedback.slice(0, 300) }
      : {}),
    // 重排任务：给出邻页签名，要求本页与每一个都不同构。
    ...(neighborSignatures && neighborSignatures.length > 0
      ? { neighborSignatures: neighborSignatures.slice(0, 4) }
      : {}),
    ...(base.styleBrief ? { styleBrief: base.styleBrief } : {}),
    styleTokens: base.styleTokens,
  };
}

/**
 * 素材库检索可能返回缩略图（实测封面 300×168、产品图 480×360）；铺满页面后会糊成一片。
 * 落页前按 blob 头尺寸丢掉低清图：封面/沉浸页要求 1280×720，其余配图要求 800×450；
 * 宁可退化为纯色/图形版式，也不交付糊图。
 */
async function dropLowResolutionMaterials(
  pages: PageInput[],
  deps: Pick<LayouterTailDeps, "readMaterialBlob" | "fetchImageHead">,
  warnings: string[],
  /** 单页调用时的全册页序（用于告警页码）；缺省按数组下标。 */
  pageOffset = 0,
): Promise<void> {
  for (const [offset, page] of pages.entries()) {
    const index = pageOffset + offset;
    const hero = page.role === "cover" || page.composition === "immersive";
    if (!Array.isArray(page.materials)) continue;
    const minWidth = hero ? 1280 : 800;
    const minHeight = hero ? 720 : 450;
    const kept: unknown[] = [];
    let dropped = 0;
    for (const material of page.materials as PageMaterial[]) {
      const url = typeof material?.url === "string" ? material.url : "";
      if (!/^(everroom-material:\/\/|https?:\/\/)/i.test(url)) {
        kept.push(material);
        continue;
      }
      let bytes: Uint8Array | null = null;
      try {
        const hash = /^everroom-material:\/\/([0-9a-f]{64})$/i.exec(url)?.[1];
        bytes = hash ? await deps.readMaterialBlob(hash.toLowerCase()) : await deps.fetchImageHead(url);
      } catch {
        bytes = null;
      }
      const dims = bytes ? imageDimensions(bytes) : null;
      if (dims && (dims.w < minWidth || dims.h < minHeight)) {
        dropped += 1;
        continue;
      }
      kept.push(material);
    }
    if (dropped > 0) {
      page.materials = kept;
      // 没有可用大图后，immersive/editorial 的硬约束不再成立：按形态 + hasImage=false 重新推导，
      // 避免整页被 validate 拒收，也避免这里成为绕过形态推导的第二条写路径。
      if (page.content) {
        page.revisionFeedback = "实际素材已更新；根据仍可用的图片与完整内容重新设计。必留图片不可用时明确失败。";
      } else if (isPageForm(page.form)) {
        page.composition = deriveComposition(page.form, { hasImage: kept.length > 0, role: page.role ?? "content" });
      } else if (page.composition === "immersive") {
        page.composition = "poster";
      } else if (page.composition === "editorial") {
        page.composition = "swiss";
      }
      warnings.push(`第 ${index + 1} 页配图分辨率不足（<${minWidth}×${minHeight}），已丢弃 ${dropped} 张并退化版式`);
    }
  }
}

interface FinalPage {
  spec: Record<string, unknown>;
  degraded: boolean;
  focusHints: string[];
  defects: LayoutDefect[];
}

function finalizeTree(
  tree: LayoutTree,
  contract: LayoutContract,
  imageArs: Map<string, number>,
  options?: { pageIndex?: number; pageCount?: number },
  preserveContent = false,
): FinalPage {
  const result = compileTree(tree, contract, undefined, options);
  const defects = measureDefects(result, contract, { imageArs });
  if (defects.length === 0 || preserveContent) {
    return { spec: result.spec as unknown as Record<string, unknown>, degraded: false, focusHints: [], defects };
  }
  const shrunk = shrinkToFit(tree, contract, { imageArs });
  return {
    spec: shrunk.result.spec as unknown as Record<string, unknown>,
    degraded: shrunk.degraded,
    focusHints: shrunk.defects.map((d) => `${d.path}：${d.detail}`),
    defects: shrunk.defects,
  };
}

export async function runLayouterTail(
  deps: LayouterTailDeps,
  args: LayouterTailArgs,
): Promise<{ content: string; details: unknown }> {
  const { plan, armPlan } = args;
  const stream = args.stream ?? null;
  const existingDeck = args.existingDeck ?? null;
  const planPages = (Array.isArray(plan.pages) ? plan.pages : []).filter(
    (p): p is PageInput => p !== null && typeof p === "object" && !Array.isArray(p),
  );
  /** 流式模式下页数组先按总页数占位，页到达时填入（未到达的洞=内容未就绪）。 */
  const pages: PageInput[] = stream ? new Array<PageInput>(stream.totalPages) : planPages;
  const totalPages = stream ? stream.totalPages : pages.length;
  const fail = (errorCode: string, message: string, retryable = false, extra: Record<string, unknown> = {}) => ({
    content: JSON.stringify({
      ...(args.parentRunId ? { invocationId: args.parentRunId } : {}),
      status: "failed",
      errorCode,
      retryable,
      message,
      ...extra,
    }),
    details: { errorCode },
  });

  const stopped = () => {
    const reason = args.signal?.reason;
    const errorCode = reason instanceof GenerationBudgetError ? reason.code : "slides_generation_cancelled";
    return fail(errorCode, reason instanceof GenerationBudgetError ? "生成预算已耗尽，已保留页面与草稿。" : "生成已取消，已保留页面与草稿。", true,
      { status: reason instanceof GenerationBudgetError ? "failed" : "cancelled" });
  };
  if (args.signal?.aborted) return stopped();
  if (totalPages < 1 || totalPages > 32) return fail("slides_layout_pages_invalid", "方案页数无效（1~32 页）", true);
  if (existingDeck && existingDeck.totalPages !== totalPages) {
    return fail("slides_layout_resume_pages_invalid", "续落的 deck 页数与方案页数不一致；请重新发起 generate。", true);
  }
  if (!deps.bridge) return fail("slides_office_bridge_unavailable", "桌面 Office 桥未配置，无法落页");

  const warnings: string[] = [];
  /** deck 标题（收尾真完成载荷与补发 done 共用）。 */
  const deckTitle = (typeof plan.title === "string" && plan.title.trim() ? plan.title : armPlan.title).slice(0, 120);
  /** 已落定页（页号）；最终 page_applied 的 doneCount 与 completed 都以它为准。 */
  const appliedPages = new Set<number>(existingDeck?.appliedPages ?? []);
  const appliedSlideIndex = new Map<number, number>();
  const appliedFocusHints = new Map<number, string[]>();
  /** 失败/退化页（页号）：引擎降档、兜底版式、落页失败、未落定。 */
  const degradedPages = new Set<number>();
  /** 是否遇到「桌面端未打开该 PPT」导致的落页失败：最终载荷要明确可重试原因。 */
  let deckNotOpen = false;
  const blockedPages: Array<Record<string, unknown>> = [];
  const contract = contractFromStyleParams(args.styleParams as never, args.scene ?? null);
  // 风格卡 token 快照每 run 只算一次，v1/v2/重排/减配输入共用同一份。
  const styleTokens = styleTokensFrom(contract.theme);
  // 流式页源：素材 QC 与图片宽高比在每页到达时再做（此时才知道这页有哪些素材），
  // 非流式照旧一次算全册。
  let imageArs: Map<string, number>;
  if (stream) {
    imageArs = new Map();
  } else {
    await dropLowResolutionMaterials(pages, deps, warnings);
    imageArs = await resolveImageArs(materialUrls(pages), {
      readMaterialBlob: deps.readMaterialBlob,
      fetchHead: deps.fetchImageHead,
    });
  }
  /** 单页到达时的素材准备：低清丢弃 + 图片宽高比进 map（契约上下文按引用共享）。 */
  const preparePageMaterials = async (index: number): Promise<void> => {
    const page = pages[index];
    if (!page) return;
    await dropLowResolutionMaterials([page], deps, warnings, index);
    const ars = await resolveImageArs(materialUrls([page]), {
      readMaterialBlob: deps.readMaterialBlob,
      fetchHead: deps.fetchImageHead,
    });
    for (const [url, ar] of ars) imageArs.set(url, ar);
  };
  const token = `${args.runId}:layout`;
  registerDeckLayoutContext(token, { contract, imageArs });
  const bridge = deps.bridge;

  const progressKey = `slides-generate:${args.runId}`;
  const progress = deps.progress;
  if (progress) {
    progress.arm(progressKey, armPlan);
    if (args.onUpdate) {
      progress.setRelay(progressKey, (event) => {
        const payload = slidesProgressUpdatePayload(event);
        args.onUpdate?.({ content: JSON.stringify(payload), details: payload });
      });
    }
  }

  let fileEntryId = "";
  let originalName: string | null = null;
  const checkpoint = () => {
    if (!fileEntryId) return;
    args.onCheckpoint?.({ fileEntryId, originalName, totalPages,
      appliedPages: [...appliedPages].filter(index => !degradedPages.has(index)).sort((a, b) => a - b) });
  };

  /** 最终全量快照：全部页落定后的真完成载荷（failedPages 用 0 起页序）。 */
  const finalPayloadFor = (completed: boolean, failedPages: number[]): Record<string, unknown> => ({
    stage: "page_applied",
    title: deckTitle,
    totalPages,
    doneCount: appliedPages.size,
    // 完成顺序 ≠ 页序：落定页号集合是卡面打勾的唯一依据。
    appliedPages: [...appliedPages].sort((a, b) => a - b),
    roomId: args.roomId,
    documentId: args.draftDocumentId,
    pages: armPlan.pages.slice(0, 32),
    completed,
    ...(fileEntryId ? { fileEntryId } : {}),
    ...(originalName ? { fileName: originalName } : {}),
    ...(completed && args.draftDocumentId ? { draftArchived: true } : {}),
    ...(failedPages.length > 0 ? { failedPages } : {}),
    ...(deckNotOpen ? { landingBlocked: "deck_not_open" } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(armPlan.narrative ? { narrative: armPlan.narrative } : {}),
    updatedAt: Date.now(),
  });
  /** 补发 done：deferDone 生成期不广播，「全部页落定」才是真完成。失败不阻塞工具结果。 */
  const notifyComplete = async (completed: boolean, failedPages: number[]): Promise<void> => {
    if (!fileEntryId) return;
    try {
      await bridge.completeDeck?.({
        fileId: fileEntryId,
        title: deckTitle,
        ...(originalName ? { originalName } : {}),
        roomId: args.roomId,
        completed,
        appliedPages: appliedPages.size,
        totalPages,
        ...(failedPages.length > 0 ? { failedPages } : {}),
      });
    } catch {
      // 完成通知是体验增强，失败不影响已落好的产物。
    }
  };

  try {
    args.signal?.throwIfAborted();
    const outline = stream
      ? stream.outline.slice(0, totalPages)
      : pages.map((p) => (typeof p.title === "string" && p.title.trim() ? p.title : "未命名页").slice(0, 80));
    /** 占位页标题：流式源可能短于总页数，缺省「未命名页」。 */
    const titleOf = (index: number): string => outline[index] ?? "未命名页";
    if (existingDeck) {
      // 续落：deck 与占位页都已存在，只补没落定的页，不再 generate（避免产生第二个文件）。
      fileEntryId = existingDeck.fileEntryId;
      originalName = existingDeck.originalName;
    } else {
      const deckIdempotency = `agent-slides:${createHash("sha256").update(JSON.stringify([args.runId, deckTitle]), "utf8").digest("hex")}`;
      // 占位页：按计划页数一次建满（骨架页自带页号，打开即见 N 页的进行时骨架）。
      // 落页因此只做「按页序替换」，不再依赖「末尾追加」语义——于是可以按完成顺序落，
      // 慢页不挡快页（2026-10-21：逐页落页从按页序改为按完成顺序）。
      const placeholders = Array.from({ length: totalPages }, (_, index) =>
        skeletonPageSpec(deckTitle, titleOf(index), index, totalPages));
      args.signal?.throwIfAborted();
      const created = await bridge.generate({
        title: deckTitle,
        format: "pptx",
        pages: placeholders,
        roomId: args.roomId,
        fileName: null,
        idempotencyKey: deckIdempotency,
        deferDone: true,
      });
      if (!created.fileEntryId) return fail("slides_office_generation_failed", "桌面端未返回文件条目");
      fileEntryId = created.fileEntryId;
      originalName = created.originalName ?? null;
    }

    checkpoint();
    args.signal?.throwIfAborted();
    const styleBrief = styleBriefFrom(args.styleParams);
    const base = { token, totalPages, styleBrief, styleTokens };

    // 每页并发取树（页序占位）。页级窗口=deps.deckConcurrency（NXCORE_SLIDES_DECK_CONCURRENCY，
    // 缺省 16）；实际同时在飞的上限还受 slides 池容量（NXCORE_SUBAGENT_SLIDES_MAX_CONCURRENT）与
    // 单代理限额（layouter policy.maxConcurrency）约束，被拒会走页级退避重试，耗尽才兜底该页。
    // 落页与取树流水线化：worker 只负责把页级窗口压住，落页侧按**完成顺序**消费。
    // promise 必须一次建全（而不是 worker 认领时才建）：落页侧要立刻订阅全部页，
    // 否则窗口外的页在订阅时还是数组空洞，会被 map 静默跳过。
    type TreeOutcome = {
      tree: LayoutTree;
      fellBack: boolean;
      designIntent?: string;
      unavailable?: boolean;
      reason?: string;
      blocked?: Record<string, unknown>;
      /** 复用 deck 时已落定的页 / 流式源里始终没到达的页：不落页，占位保持原样。 */
      skipped?: "applied" | "missing" | "cancelled";
    };
    const trees: TreeOutcome[] = new Array(totalPages);
    const pending: Array<{ promise: Promise<TreeOutcome>; resolve: (value: TreeOutcome) => void }> =
      Array.from({ length: totalPages }, () => {
        let resolve!: (value: TreeOutcome) => void;
        const promise = new Promise<TreeOutcome>((res) => {
          resolve = res;
        });
        return { promise, resolve };
      });
    const treePromises = pending.map((entry) => entry.promise);
    /** 复用 deck：已落定页直接跳过（不 dispatch、不重落），其余页照常。 */
    const appliedFromDeck = new Set<number>(existingDeck?.appliedPages ?? []);
    /** 流式页携带的父调用（批次 planner invocation）：布局调用挂到对应批次下，时间线成链。 */
    const pageParents: Array<string | null | undefined> = new Array(totalPages);
    const fetchTreeOnce = async (index: number): Promise<TreeOutcome> => {
      args.signal?.throwIfAborted();
      const input = layouterInputFor(base, pages[index]!, index);
      try {
        const invocation = await dispatchWithPageRetry(() =>
          deps.dispatchPage(input, deps.makeKey(args.runId, "slides-layouter", `page:${index}`, input), pageParents[index] ?? args.parentRunId), args.signal);
        args.signal?.throwIfAborted();
        const placed = treeFromInvocation(invocation, pages[index]!);
        if (placed.blocked) return placed;
        if (!placed.fellBack) {
          const page = pages[index]!;
          if (typeof page.composition === "string"
            && placed.tree.version === 2 && placed.tree.v2?.composition !== page.composition) {
            warnings.push(
              `第 ${index + 1} 页 composition 与 storyboard 不一致（${page.composition}→${placed.tree.v2?.composition ?? "?"}），按实际落页`,
            );
          }
          if (placed.tree.version === 2 && placed.tree.v2) {
            const richness = page.content ? [] : visualRichnessIssues(placed.tree.v2);
            if (richness.length > 0) {
              const revisionPage = { ...page, revisionFeedback: richness.join("；") };
              const revisionInput = layouterInputFor(base, revisionPage, index);
              try {
                const revision = await dispatchWithPageRetry(() =>
                  deps.dispatchPage(revisionInput, deps.makeKey(args.runId, "slides-layouter", `visual:${index}`, revisionInput), pageParents[index] ?? args.parentRunId), args.signal);
                const revised = treeFromInvocation(revision, revisionPage);
                if (!revised.fellBack && revised.tree.version === 2 && revised.tree.v2
                  && visualRichnessIssues(revised.tree.v2).length === 0) {
                  warnings.push(`第 ${index + 1} 页视觉丰富度不足，已按闸门提示补图形`);
                  return revised;
                }
              } catch {
                // 视觉补救失败：保留原树并告警，不阻塞整册。
              }
              warnings.push(`第 ${index + 1} 页视觉丰富度不足（纯文字白底），保留当前树`);
            }
          }
          return placed;
        }
        // 布局代理未交树（失败/超时/坏树）：减配重试一次——支撑条目砍半、去图表、去讲稿、
        // 密度降档，格式仍是 v2；仍不收敛才落 v2 兜底页。dispatch 被拒（并发限额）不算未交树，走 catch 退避。
        const trimmed = pages[index]!.content
          ? { ...pages[index]!, revisionFeedback: `上次提交未通过：${placed.reason ?? "布局无效"}。不要重画整页或换构图；只按错误做最小修改（补绑定、调区域、删装饰）后立即提交；仍不收敛就简化结构提交，或按 blocked 说明限制。` }
          : trimmedPage(pages[index]!);
        const retryInput = layouterInputFor(base, trimmed, index);
        try {
          const retry = await dispatchWithPageRetry(() =>
            deps.dispatchPage(retryInput, deps.makeKey(args.runId, "slides-layouter", `page:${index}:trimmed`, retryInput), pageParents[index] ?? args.parentRunId), args.signal);
          const retryPlaced = treeFromInvocation(retry, pages[index]!);
          if (retryPlaced.blocked) return retryPlaced;
          if (retryPlaced.fellBack) return placed;
          warnings.push(`第 ${index + 1} 页布局代理减配重试后收敛`);
          return retryPlaced;
        } catch {
          return placed;
        }
      } catch (error) {
        // 并发窗口被占满（dispatch 退避/容量等待都耗尽）＝代理不可用，不是「代理交了坏树」：
        // 记为 unavailable 供整册判定，避免把「20 页兜底版式」当成成功交付（2026-10-20 事故）。
        return {
          tree: fallbackPage(pages[index]!),
          fellBack: true,
          ...(isConcurrencyLimitError(error) ? { unavailable: true } : {}),
        };
      }
    };
    /**
     * 自审：布局代理写完这一页，网关把它**自己的渲染图**作为附件投回去，
     * 让同一个视觉模型看着实物改，而不是读一段二手文字描述（旧 slides-reviewer 的做法）。
     *
     * 为什么是"同一 agent 的第二次调用"而不是一次调用内看图：pi runtime 的工具结果
     * 只能是文本（`PiAgentRuntimeToolResult.content: string`），图片只能在 prompt 时经
     * attachments 投递。所以"agent 自己看自己的成品"必然是一次回投。
     *
     * 失败一律保留原树：自审是提质不是闸门，任何异常都不能让这一页变成兜底页。
     */
    const renderSlots = createSemaphore(SELF_REVIEW_RENDER_CONCURRENCY);
    const reviewSlots = createSemaphore(SELF_REVIEW_CONCURRENCY);
    const visualValidation = new Map<number, "reviewed" | "revised-rendered" | "unverified">();
    let selfReviewUnavailableNoted = false;
    const selfReviewPage = async (index: number, outcome: TreeOutcome): Promise<TreeOutcome> => {
      args.signal?.throwIfAborted();
      if (outcome.fellBack || outcome.tree.version !== 2) return outcome;
      visualValidation.set(index, "unverified");
      if (!bridge || typeof bridge.renderPptx !== "function") {
        // 不能静默降级：没渲染桥＝这一册没人看过图，交付时要说出来（每册只记一条）。
        if (!selfReviewUnavailableNoted) {
          selfReviewUnavailableNoted = true;
          warnings.push("自审跳过：渲染桥不支持 renderPptx，本册未做视觉自审");
        }
        return outcome;
      }
      try {
        const compiled = compileTree(outcome.tree, contract, undefined, { pageIndex: index + 1, pageCount: totalPages });
        const pptx = await renderSlots(() => { args.signal?.throwIfAborted(); return bridge!.renderPptx!({ title: "单页自审", pages: [JSON.stringify(compiled.spec)] }); });
        const png = await renderSlots(async () => { args.signal?.throwIfAborted(); return pptxToPng(pptx); });
        const pngBase64 = png.toString("base64");
        // PNG 无损在背景图页可达 1.5MB+，直投会 413；压成 JPEG 再投，失败回退原图。
        let shotBase64 = pngBase64;
        let mimeType = "image/png";
        try {
          shotBase64 = await pngBase64ToJpegBase64(pngBase64);
          mimeType = "image/jpeg";
        } catch {
          // sips 不可用时保持原 PNG
        }
        const reviewInput = {
          ...layouterInputFor(base, pages[index]!, index),
          currentTree: outcome.tree.v2,
          ...(outcome.designIntent ? { previousDesignIntent: outcome.designIntent } : {}),
          revisionFeedback: pages[index]!.content
            ? "附件是 currentTree 的真实渲染图。按 SYSTEM.md「视觉自审」先记录图上观察，再逐项核对内容、焦点与关系、空白与容器、对齐与层级、断行与裁切、页脚页码；对照 previousDesignIntent 验收。自审只做一次：最多改 1 个根因、校验 1 次后提交；没有图上证据的问题不改，不要借自审探索新构图。保留全部内容，修正后防止原有表达退化。notes 写观察、修改或保留理由及待确认项；返回完整 tree、designIntent、bindings。无需修改则原样交树；修改版不会再次回投看图。"
            : "附件是 currentTree 的真实渲染图。按 SYSTEM.md「视觉自审」先记录图上观察，再逐项核对内容、焦点与关系、空白与容器、对齐与层级、断行与裁切、页脚页码及旧模式兼容门槛。自审只做一次：最多改 1 个根因、校验 1 次后提交；没有图上证据的问题不改，不要借自审探索新构图。保留全部内容，修正后防止原有表达退化。notes 写观察、修改或保留理由及待确认项；返回完整 v2 tree。无需修改则原样交树；修改版不会再次回投看图。",
        };
        const invocation = await dispatchWithPageRetry(() =>
          deps.dispatchPage(
            reviewInput,
            deps.makeKey(args.runId, "slides-layouter", `self-review:${index}`, reviewInput),
            pageParents[index] ?? args.parentRunId,
            [{ filename: `page-${String(index + 1)}.${mimeType === "image/jpeg" ? "jpg" : "png"}`, mimeType, kind: "image", dataUrl: `data:${mimeType};base64,${shotBase64}` }],
          ), args.signal);
        args.signal?.throwIfAborted();
        const revised = treeFromInvocation(invocation, pages[index]!);
        if (revised.fellBack || revised.tree.version !== 2) return outcome;
        // 只有"能落页且没有阻塞缺陷"的修正才采纳，否则保留原树。
        const final = finalizeTree(revised.tree, contract, imageArs, { pageIndex: index + 1, pageCount: totalPages }, Boolean(pages[index]?.content));
        if (pages[index]!.content && checkSemanticRendered(pages[index]!.content!, final.spec as unknown as { elements: unknown[]; notes?: string }).length) {
          warnings.push(`第 ${index + 1} 页自审修正未保留完整内容，保留原页`);
          return outcome;
        }
        if (pages[index]!.content ? final.defects.length > 0 : final.defects.some((defect) => BLOCKING_DEFECTS.has(defect.type))) {
          warnings.push(`第 ${index + 1} 页自审修正未收敛，保留原页`);
          return outcome;
        }
        if (JSON.stringify(revised.tree) !== JSON.stringify(outcome.tree)) {
          // The review image belongs to the original tree. Render the exact accepted revision as well.
          const finalPptx = await renderSlots(() => { args.signal?.throwIfAborted(); return bridge!.renderPptx!({ title: "单页最终验证", pages: [JSON.stringify(final.spec)] }); });
          const finalPng = await renderSlots(() => { args.signal?.throwIfAborted(); return pptxToPng(finalPptx); });
          if (!imageDimensions(finalPng)) throw new Error("final_render_invalid");
          visualValidation.set(index, "revised-rendered");
          warnings.push(`第 ${index + 1} 页经自审修正`);
        } else visualValidation.set(index, "reviewed");
        return revised;
      } catch {
        warnings.push(`第 ${index + 1} 页视觉自审未完成，保留已校验的原树（未验证）`);
        return outcome;
      }
    };

    // 自审改为「落页之后」的独立阶段（见下），不再阻塞取树/落页。

    // 页级并发：改造前硬编码 8（= 当时的全局子代理窗口），一册 15 页只能 8 页同时在飞，
    // 其余页干等 worker 归还，足足多出一整轮单页耗时（实测 P50 141s → 165s）。
    // 改为可配置后，一册 15 页可一次全飞；上限仍取总页数，页数少于窗口时不空转。
    const deckWindow = deps.deckConcurrency ?? DEFAULT_DECK_CONCURRENCY;
    /** 一页取树（挂到页级并发闸内）。 */
    const dispatchPageTree = async (index: number): Promise<void> => {
      const slot = pending[index]!;
      if (args.signal?.aborted) {
        slot.resolve({ tree: fallbackPage(pages[index] ?? { title: titleOf(index) }), fellBack: true, skipped: "cancelled" });
        return;
      }
      try {
        // worker 只负责取树：树一到就 resolve，落页侧立刻开始落（自审在落页之后，见下）。
        slot.resolve(await fetchTreeOnce(index));
      } catch (error) {
        // 兜底：绝不让某一页的 promise 悬空（悬空页会让落页侧永远等不到它）。
        slot.resolve({
          tree: pages[index] ? fallbackPage(pages[index]!) : fallbackPage({ title: titleOf(index) }),
          fellBack: true,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    };
    let workers: Promise<void>;
    if (!stream) {
      workers = runIndexWorkers(totalPages, deckWindow, async (index) => {
        // 复用 deck：已落定页不再 dispatch。
        if (appliedFromDeck.has(index)) {
          // 已落定页：不落页也不算失败（fellBack 会让整册判定把它记进 failedPages）。
          pending[index]!.resolve({ tree: fallbackPage(pages[index] ?? { title: titleOf(index) }), fellBack: false, skipped: "applied" });
          return;
        }
        await dispatchPageTree(index);
      });
    } else {
      // 流式页源：内容批次一就绪就推一页进来；窗口满时等任意一页完成再收下一页。
      // 流结束/抛错后，未到达的页标记 missing（占位页保持，不落半成品）。
      workers = (async () => {
        const inFlight = new Set<Promise<void>>();
        const scheduled = new Set<number>();
        for (const index of appliedFromDeck) {
          pending[index]?.resolve({ tree: fallbackPage({ title: titleOf(index) }), fellBack: false, skipped: "applied" });
        }
        try {
          for await (const item of abortableItems(stream.pages, args.signal)) {
            const index = item.pageIndex;
            if (!Number.isInteger(index) || index < 0 || index >= totalPages || appliedFromDeck.has(index) || scheduled.has(index)) continue;
            pages[index] = item.page;
            pageParents[index] = item.parentRunId;
            await preparePageMaterials(index);
            const task = dispatchPageTree(index).finally(() => { inFlight.delete(task); });
            scheduled.add(index);
            inFlight.add(task);
            if (inFlight.size >= deckWindow) await Promise.race(inFlight);
          }
        } catch (error) {
          warnings.push(`内容批次流中断（${error instanceof Error ? error.message : String(error)}），未就绪页保留占位`);
        }
        await Promise.all(inFlight);
        for (let index = 0; index < totalPages; index += 1) {
          if (scheduled.has(index) || appliedFromDeck.has(index)) continue;
          pending[index]!.resolve({
            tree: fallbackPage({ title: titleOf(index) }),
            // 未落页由 appliedPages 判定，不额外标 fellBack（否则失败页会被重复归类）。
            fellBack: false,
            skipped: "missing",
            reason: "内容未就绪",
          });
        }
      })();
    }

    // 按完成顺序落页：占位页已按计划页序建满，谁的树先就绪谁先替换自己那页
    // （slideIndex = 计划页序，与完成顺序无关；某页失败只留它自己的占位页，不连累后页）。
    // fillPage 打的是同一个活会话，调用本身必须串行——用一条队列按「到达顺序」排队，
    // 慢页只延迟自己，不再挡住后面已就绪的页。
    // 两条防线保留：① 降档后仍有引擎硬闸类缺陷（重叠/emoji/溢出）的页落确定性兜底版式；
    // ② 页号集合统计落定页，重排重落不重复计数。
    let landingTail: Promise<unknown> = Promise.resolve();
    const applyPage = async (index: number, tree: LayoutTree): Promise<boolean> => {
      args.signal?.throwIfAborted();
      // 页脚页码用逻辑页号（1 基）；总页数按计划页数（兜底占位页仍占页码）。
      const footerOpts = { pageIndex: index + 1, pageCount: totalPages };
      let final = finalizeTree(tree, contract, imageArs, footerOpts, Boolean(pages[index]?.content));
      if (pages[index]?.content) {
        const errors = checkSemanticRendered(pages[index]!.content!, final.spec as unknown as { elements: unknown[]; notes?: string });
        if (errors.length) {
          degradedPages.add(index);
          warnings.push(`第 ${index + 1} 页内容校验失败：${errors.join("; ")}`);
          return false;
        }
      }
      if (final.degraded) {
        degradedPages.add(index);
        warnings.push(`第 ${index + 1} 页经引擎降档兜底装下内容`);
      }
      if (pages[index]?.content ? final.defects.length > 0 : final.defects.some((defect) => BLOCKING_DEFECTS.has(defect.type))) {
        degradedPages.add(index);
        if (pages[index]?.content) {
          warnings.push(`第 ${index + 1} 页几何校验未通过，保留可重试状态`);
          return false;
        }
        warnings.push(`第 ${index + 1} 页布局树未收敛（${final.defects[0]!.type}），已用兜底版式`);
        final = finalizeTree(fallbackPage(pages[index] ?? { title: titleOf(index) }), contract, imageArs, footerOpts);
      }
      const specJson = JSON.stringify(final.spec);
      if (specJson.length > MAX_PAGE_SPEC_LENGTH) {
        degradedPages.add(index);
        warnings.push(`第 ${index + 1} 页 PageSpec 超长，保留占位页`);
        return false;
      }
      // 占位页已就位：slideIndex 恒等于计划页序，原地替换，不存在越界级联。
      const slideIndex = index;
      let result: Awaited<ReturnType<typeof bridge.fillPage>>;
      try {
        result = await bridge.fillPage({ fileId: fileEntryId, slideIndex, specJson });
      } catch (error) {
        degradedPages.add(index);
        const message = error instanceof Error ? error.message : String(error);
        if (isDeckNotOpenMessage(message)) {
          deckNotOpen = true;
          warnings.push(`第 ${index + 1} 页落页失败：桌面端未打开该 PPT 的可编辑会话（not_open），保留占位页；在产物库打开该 PPT 后可重试`);
        } else {
          warnings.push(`第 ${index + 1} 页落页异常（${message.slice(0, 160)}），保留占位页`);
        }
        return false;
      }
      if (!result.ok || result.applied !== true) {
        degradedPages.add(index);
        const reason = result.error ?? "桌面端拒绝";
        if (isDeckNotOpenMessage(reason)) {
          deckNotOpen = true;
          warnings.push(`第 ${index + 1} 页落页失败：桌面端未打开该 PPT 的可编辑会话（not_open），保留占位页；在产物库打开该 PPT 后可重试`);
        } else {
          warnings.push(`第 ${index + 1} 页落页失败（${reason}），保留占位页`);
        }
        return false;
      }
      appliedPages.add(index);
      appliedSlideIndex.set(index, slideIndex);
      checkpoint();
      // 完成顺序 ≠ 页序：进度快照带落定页号集合，卡按页号打勾（不能用「前 doneCount 页已完成」）。
      progress?.notify(progressKey, slideIndex, [...appliedPages]);
      if (final.focusHints.length > 0) appliedFocusHints.set(index, final.focusHints);
      return true;
    };
    /** 落页排队：按到达顺序串行（会话不是并发安全的），不按页序。 */
    const landPage = (index: number, tree: LayoutTree): Promise<boolean> => {
      const task = landingTail.then(() => applyPage(index, tree));
      landingTail = task.then(() => undefined, () => undefined);
      return task;
    };

    // 每页落页信号：审页要尽早开工，得先知道"这一页落定了"。
    const landingSettled = new Map<number, Promise<void>>();
    const landingSignals = new Map<number, () => void>();
    for (let index = 0; index < totalPages; index += 1) {
      landingSettled.set(index, new Promise<void>((resolve) => landingSignals.set(index, resolve)));
    }
    // 落页阶段：树一到就落页（用户先看到这一页），自审放在落页之后——
    // 把本页渲染图回投布局代理，采纳的修正树再补落同一页（先交付、后提质）。
    // 自审不阻塞落页，也不改变「已完成页」判定：首版页先落定，修正只做覆盖。
    const selfReviewTasks: Array<Promise<void>> = [];
    const landings = treePromises.map((promise, index) => promise.then(async (outcome) => {
      trees[index] = outcome;
      if (outcome.blocked) {
        blockedPages.push({ pageIndex: index, ...outcome.blocked });
        degradedPages.add(index);
        landingSignals.get(index)?.();
        return;
      }
      // 复用 deck 的已落定页 / 内容未就绪页：占位页保持原样，不落页、不自审。
      if (outcome.skipped) {
        if (outcome.skipped === "missing") {
          warnings.push(`第 ${index + 1} 页内容未就绪（${outcome.reason ?? "批次未完成"}），保留占位页`);
        }
        landingSignals.get(index)?.();
        return;
      }
      if (outcome.fellBack) {
        if (pages[index]?.content) {
          degradedPages.add(index);
          warnings.push(`第 ${index + 1} 页设计未通过：${outcome.reason ?? "未收敛"}；未落入占位页，内容与草稿保留`);
          landingSignals.get(index)?.();
          return;
        }
        warnings.push(`第 ${index + 1} 页布局代理未交合格树（${outcome.reason ?? "未收敛"}），已用 v2 兜底页`);
      }
      try {
        await landPage(index, outcome.tree);
      } catch (error) {
        // 单页异常不拖垮整册：该页留占位页，其余页继续落。
        degradedPages.add(index);
        warnings.push(`第 ${index + 1} 页落页异常（${error instanceof Error ? error.message : String(error)}），保留占位页`);
      } finally {
        landingSignals.get(index)?.();
      }
      if (outcome.fellBack) return;
      // 落页后再自审：看着自己这一页的真实渲染图改；修正树只覆盖同一页，不动别的页。
      if (args.signal?.aborted) return;
      const review = reviewSlots(() => selfReviewPage(index, outcome)).then(async (reviewed) => {
        args.signal?.throwIfAborted();
        // 无修正（原样交回）时不重落；只有树真的变了才覆盖同一页。
        if (JSON.stringify(reviewed.tree) === JSON.stringify(outcome.tree)) return;
        trees[index] = reviewed;
        try {
          await landPage(index, reviewed.tree);
        } catch (error) {
          warnings.push(`第 ${index + 1} 页自审修正补落异常（${error instanceof Error ? error.message : String(error)}），保留首版页`);
        }
      });
      selfReviewTasks.push(review.catch(() => undefined));
    }));
    await Promise.all(landings);
    await Promise.all(selfReviewTasks);
    await workers;
    args.signal?.throwIfAborted();

    // 代理不可用（并发窗口被占满、dispatch 容量等待耗尽）的页达到半数：这一轮根本没拿到
    // 版面，落下的是兜底版式整册。不要以 completed 交付——2026-10-20 事故里 20/20 页兜底
    // 却回成功，用户拿到一本无配图、无图表的 deck。这里回报可重试失败（已落页保留，
    // 重试可复用已完成页），让上层重试而不是假装完成。
    const unavailablePages = trees
      .map((outcome, index) => (outcome?.unavailable === true ? index : -1))
      .filter((index) => index >= 0);
    if (unavailablePages.length >= Math.max(1, Math.ceil(totalPages / 2))) {
      const busyFailedPages = [...new Set([
        ...unavailablePages,
        ...Array.from({ length: totalPages }, (_, index) => index).filter((index) => !appliedPages.has(index)),
      ])].sort((a, b) => a - b);
      warnings.push(`布局代理并发不可用：${unavailablePages.length}/${totalPages} 页未取到布局树，本轮不交付兜底整册`);
      const busyPayload = finalPayloadFor(false, busyFailedPages);
      args.onUpdate?.({ content: JSON.stringify(busyPayload), details: busyPayload });
      await notifyComplete(false, busyFailedPages);
      return fail(
        "slides_layout_agents_unavailable",
        `布局代理并发窗口被占满（${unavailablePages.length}/${totalPages} 页未取到布局树）。本轮不产出兜底整册：已落页进度保留，稍后重试会复用已完成页面。`,
        true,
        {
          ...(fileEntryId ? { fileEntryId } : {}),
          failedPages: busyFailedPages,
          warnings,
        },
      );
    }

    // 页间相似度审计：相邻同签名页重排一次（带邻页签名提示），重排结果替换重落。
    const rerollTargets = pages.some(p => p?.content) ? [] : auditSimilarity(trees.map((t) => t.tree))
      .filter(index => pages[index] && !trees[index]?.skipped && !trees[index]?.blocked);
    for (const index of rerollTargets.slice(0, 2)) {
      const signatures = [
        ...(index > 0 ? [treeSignature(trees[index - 1]!.tree)] : []),
        ...(index + 1 < trees.length ? [treeSignature(trees[index + 1]!.tree)] : []),
      ];
      const input = layouterInputFor(base, pages[index]!, index, signatures);
      try {
        const invocation = await dispatchWithPageRetry(() =>
          deps.dispatchPage(input, deps.makeKey(args.runId, "slides-layouter", `reroll:${index}`, input), args.parentRunId), args.signal);
        const rerolled = treeFromInvocation(invocation, pages[index]!);
        if (!rerolled.fellBack && treeSignature(rerolled.tree) !== treeSignature(trees[index]!.tree)) {
          trees[index] = rerolled;
          warnings.push(`第 ${index + 1} 页与邻页结构雷同，已重排`);
          await landPage(index, rerolled.tree);
        }
      } catch {
        // 重排失败保留原页
      }
    }


    // 失败/退化页（0 起页序）：未落定、引擎降档兜底、布局代理兜底都算——完成摘要要能定位。
    const failedPages = [...new Set(
      Array.from({ length: totalPages }, (_, index) => index).filter((index) =>
        !appliedPages.has(index) || degradedPages.has(index) || trees[index]?.fellBack === true),
    )].sort((a, b) => a - b);
    const completed = appliedPages.size === totalPages && (!pages.some(p => p?.content) || failedPages.length === 0);
    checkpoint();
    if (appliedPages.size === 0 && blockedPages.length > 0) {
      await notifyComplete(false, failedPages);
      return { content: JSON.stringify({ status: "blocked", fileEntryId, appliedPages: [], blockedPages,
        message: "页面设计受阻，请按 blockedPages 中的 requestedAction 补充素材或决定内容。", warnings }),
        details: { blockedPages, fileEntryId } };
    }
    if (appliedPages.size === 0) {
      const zeroPayload = finalPayloadFor(false, failedPages);
      args.onUpdate?.({ content: JSON.stringify(zeroPayload), details: zeroPayload });
      await notifyComplete(false, failedPages);
      return fail("slides_layout_apply_failed", deckNotOpen
        ? "全部页面落页失败：桌面端没有以可编辑会话打开这本 PPT（not_open）。在产物库打开该 PPT 后重试即可复用已生成方案。"
        : "全部页面落页失败；方案已就绪，可重试 generate。", true, {
        fileEntryId,
        failedPages,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(deckNotOpen ? { landingBlocked: "deck_not_open" } : {}),
      });
    }
    args.signal?.throwIfAborted();
    if (completed && args.draftDocumentId) {
      await args.trashDraft(args.draftDocumentId).catch(() => {});
    }
    args.signal?.throwIfAborted();
    const settleStyleSessionId = args.settle.styleSessionIdToSettle ?? null;
    if (completed && settleStyleSessionId && args.styleSessions) {
      args.styleSessions.patch(settleStyleSessionId, { stage: "confirmed" });
    }
    if (completed && args.settle.pageImagesSessionId && args.pageImagesStore) {
      args.pageImagesStore.patch(args.settle.pageImagesSessionId, { stage: "resolved" });
    }
    // 最终全量快照 + 真完成通知（done 后移到全部页落定）。
    const finalPayload = finalPayloadFor(completed, failedPages);
    args.onUpdate?.({ content: JSON.stringify(finalPayload), details: finalPayload });
    args.signal?.throwIfAborted();
    await notifyComplete(completed, failedPages);
    args.signal?.throwIfAborted();
    return {
      content: JSON.stringify({
        ...(args.parentRunId ? { invocationId: args.parentRunId } : {}),
        status: completed ? "completed" : "partial",
        fileEntryId,
        fileName: originalName,
        pages: appliedPages.size,
        // 落定页号（完成顺序 ≠ 页序）：未完成的页是占位页，重试只补这些页。
        appliedPages: [...appliedPages].sort((a, b) => a - b),
        outline,
        warnings,
        ...(blockedPages.length ? { blockedPages } : {}),
        ...(pages.some(p => p?.content) ? { contentMode: "semantic-v3", visualValidation: Array.from({ length: totalPages }, (_, i) => visualValidation.get(i) ?? "unverified") } : {}),
        ...(failedPages.length > 0 ? { failedPages } : {}),
        ...(deckNotOpen ? { landingBlocked: "deck_not_open" } : {}),
        summary: completed
          ? `已生成 ${appliedPages.size} 页演示文稿`
          : `已生成 ${appliedPages.size}/${totalPages} 页，未完成页可重试`,
      }),
      details: {
        fileEntryId,
        pages: appliedPages.size,
        appliedPages: [...appliedPages].sort((a, b) => a - b),
        warnings,
        failedPages,
        ...(deckNotOpen ? { landingBlocked: "deck_not_open" } : {}),
      },
    };
  } catch (error) {
    checkpoint();
    // 异常也尽量给出可定位的失败页并补完成通知，避免前端停在「生成中」。
    const failedPages = Array.from({ length: totalPages }, (_, index) => index).filter((index) => !appliedPages.has(index));
    const catchPayload = finalPayloadFor(false, failedPages);
    args.onUpdate?.({ content: JSON.stringify(catchPayload), details: catchPayload });
    await notifyComplete(false, failedPages);
    if (args.signal?.aborted) {
      const result = stopped();
      return { content: JSON.stringify({ ...JSON.parse(result.content), fileEntryId, appliedPages: [...appliedPages], failedPages }),
        details: { ...result.details, fileEntryId, appliedPages: [...appliedPages], failedPages } };
    }
    return fail(
      "slides_layout_tail_failed",
      `布局树落页失败：${error instanceof Error ? error.message : String(error)}`,
      true,
      { ...(fileEntryId ? { fileEntryId } : {}), failedPages },
    );
  } finally {
    dropDeckLayoutContext(token);
    progress?.disarm(progressKey);
  }
}
