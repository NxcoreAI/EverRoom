/**
 * slides-editor 语义修复支撑：storyboard/v2 时代它是「草稿压缩成页文案」的影子
 * 压缩器；该链路（含 storyboard/v2 写入）已删除，现在的内容契约是 storyboard/v3
 * （见 slides-semantic-contract.ts）。本文件保留的确定性检查/归一化纯函数只服务
 * 历史 storyboard/v2 记录的读回与校验，semantic 修复经 slides-semantic-stage 派发。
 */

import { createHash } from "node:crypto";
import type { SubagentInvocation } from "@nxcore/agent-contract";
import type { SceneDensity } from "../slides-layout/scene.js";
import {
  PAGE_FORMS,
  PAGE_WEIGHTS,
  PAGE_FORM_SPEC,
  deriveComposition,
  deriveSkeleton,
  factsMaxForForm,
  isPageForm,
  isPageWeight,
  proseBudgetForForm,
  unitsValid,
  type PageForm,
  type PageWeight,
} from "./slides-page-form.js";

/** 大纲每页要声明的内容形态与分量；版式名不再出现在大纲输出里。 */
export const EDITOR_FORMS = PAGE_FORMS;
export const EDITOR_WEIGHTS = PAGE_WEIGHTS;

export interface StoryboardCheckOptions {
  /**
   * 已停用：页面版式不再由风格卡的构图家族决定，改由每页的内容形态推导。
   * 字段保留只为兼容既有调用方；传了也不参与校验。
   */
  deckComposition?: string;
  /**
   * 场景密度：字数预算的基准（宽密场景一页能承载更多字）。
   * 代码压缩与校对器必须用同一个密度，否则会出现"压得下的字数被判超预算"。
   */
  density?: SceneDensity;
}
export const EDITOR_ROLES = ["cover", "toc", "section", "content", "data", "table", "flow", "quote", "closing"] as const;
export const EDITOR_EMPHASIS = ["title", "number", "image", "quote", "chart", "table"] as const;
export const EDITOR_DENSITIES = ["sparse", "standard", "dense"] as const;

const METADATA_RE = /全篇|页数|页配比|板块配比|平均每页|约\s*\d+\s*分钟|共\s*\d+\s*页|受众[:：]|制作说明/;
/** 页面文案里的 AI 套话/免责声明：只应进 speakerNotes，不应进 copy。 */
const AI_FLAVOR_RE = /(统计口径|口径待|待核实|待补充|未核实|仅作参考|仅供参考|本页为|占位|待确认|不完全对应|尚无第三方验证|未附证明|未标注负责|按原始口径)/;
const ELLIPSIS_RE = /(?:…{2,}|\.{3,}|·{4,}|···)/;

function hasAiFlavor(value: string | undefined): boolean {
  return Boolean(value && (AI_FLAVOR_RE.test(value) || ELLIPSIS_RE.test(value)));
}

function cleanCopyText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/(?:…{2,}|\.{3,}|·{4,}|···)/g, "").trim();
  return text || undefined;
}

/** 页面 copy 去 AI 味：去掉免责声明/省略号；口径与待核实留给讲稿。 */
export function scrubPageCopy(copy: EditorCopy): EditorCopy {
  const supporting = copy.supporting.filter((item) => !hasAiFlavor(item));
  const facts = copy.facts
    .filter((fact) => !hasAiFlavor(fact.label) && !hasAiFlavor(fact.value) && !hasAiFlavor(fact.body))
    .map(({ note, ...rest }) => ({
      ...rest,
      ...(note && !hasAiFlavor(note) ? { note } : {}),
    }));
  const sourceParts = (copy.source ?? "").split(/[；;]/).map((part) => part.trim()).filter(Boolean);
  const source = sourceParts.filter((part) => !hasAiFlavor(part)).join("；").slice(0, 80) || undefined;
  const quote = copy.quote
    ? {
        ...(cleanCopyText(copy.quote.text) ? { text: cleanCopyText(copy.quote.text)! } : {}),
        ...(cleanCopyText(copy.quote.attribution) ? { attribution: cleanCopyText(copy.quote.attribution)! } : {}),
      }
    : undefined;
  return {
    ...copy,
    ...(copy.kicker ? { kicker: cleanCopyText(copy.kicker) ?? "" } : {}),
    message: cleanCopyText(copy.message) ?? copy.message,
    supporting,
    facts,
    ...(source ? { source } : {}),
    ...(quote && (quote.text || quote.attribution) ? { quote } : {}),
  };
}

export interface EditorFact {
  label?: string;
  value?: string;
  unit?: string;
  body?: string;
  note?: string;
}

export interface EditorCopy {
  kicker?: string;
  message: string;
  supporting: string[];
  facts: EditorFact[];
  quote?: { text?: string; attribution?: string };
  source?: string;
  speakerNotes: string;
}

export interface EditorDropped {
  from: string;
  text: string;
  reason: string;
  movedToNotes?: boolean;
}

export interface EditorPage {
  id: string;
  role: string;
  density: string;
  /** 内容形态：这页靠什么证据成立。版式由它推导，不走大纲。 */
  form: PageForm;
  /** 单元数：对照的"方"、序列的"步"、拆解的"块"、表格的行数。 */
  units: number;
  /** 全册分量，用于节奏曲线。 */
  weight: PageWeight;
  emphasis: string;
  intent: string;
  takeaway: string;
  copy: EditorCopy;
  data?: Record<string, unknown>;
  visual?: Record<string, unknown>;
  dropped: EditorDropped[];
}

export interface EditorStoryboard {
  schemaVersion: "storyboard/v2";
  deck: {
    title: string;
    audience?: string;
    occasion?: string;
    durationMin?: number;
    spine: string;
    visualThesis?: string;
  };
  pages: EditorPage[];
  warnings: string[];
}

export interface EditorDraftPage {
  title?: string;
  points?: string[];
  data?: string;
  materialHints?: string;
  notes?: string;
}

export interface StoryboardCheck {
  errors: string[];
  warnings: string[];
  stats: {
    pages: number;
    draftPages: number;
    forms: string[];
    proseChars: number;
    copyChars: number;
    draftPointsChars: number;
    dropped: number;
    speakerNotesChars: number;
  };
}

export interface ShadowPageReport {
  id: string;
  role: string;
  form: string;
  /** 由形态推导出来的引擎构图（只读，供排查用）。 */
  composition: string;
  emphasis: string;
  proseChars: number;
  copyChars: number;
  messageChars: number;
  supporting: number;
  facts: number;
  dropped: number;
  speakerNotesChars: number;
}

export interface EditorShadowReport {
  draftHash: string;
  pageCount: number;
  draftPageCount: number;
  forms: string[];
  proseChars: number;
  copyChars: number;
  draftPointsChars: number;
  reductionPct: number | null;
  dropped: number;
  passed: boolean;
  errors: string[];
  warnings: string[];
  pages: ShadowPageReport[];
}

export function draftPagesHash(pages: EditorDraftPage[]): string {
  return createHash("sha256").update(JSON.stringify(pages), "utf8").digest("hex");
}

function stringValue(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stringArray(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .slice(0, maxItems)
    .map((item) => item.trim().slice(0, maxChars));
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeDropped(value: unknown): EditorDropped[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw): EditorDropped | null => {
      const item = objectValue(raw);
      if (!item) return null;
      const from = stringValue(item.from, 80);
      const text = stringValue(item.text, 300);
      const reason = stringValue(item.reason, 120);
      if (!from || !text || !reason) return null;
      return { from, text, reason, ...(item.movedToNotes === true ? { movedToNotes: true } : {}) };
    })
    .filter((item): item is EditorDropped => item !== null)
    .slice(0, 40);
}

function normalizeCopy(value: unknown): EditorCopy {
  const raw = objectValue(value) ?? {};
  const quote = objectValue(raw.quote);
  return {
    ...(stringValue(raw.kicker, 40) ? { kicker: stringValue(raw.kicker, 40) } : {}),
    message: stringValue(raw.message, 200),
    supporting: stringArray(raw.supporting, 1, 120),
    facts: Array.isArray(raw.facts)
      ? raw.facts.slice(0, 3).map((item) => {
        const fact = objectValue(item) ?? {};
        return {
          ...(stringValue(fact.label, 40) ? { label: stringValue(fact.label, 40) } : {}),
          ...(stringValue(fact.value, 40) ? { value: stringValue(fact.value, 40) } : {}),
          ...(stringValue(fact.unit, 20) ? { unit: stringValue(fact.unit, 20) } : {}),
          ...(stringValue(fact.body, 60) ? { body: stringValue(fact.body, 60) } : {}),
          ...(stringValue(fact.note, 60) ? { note: stringValue(fact.note, 60) } : {}),
        };
      })
      : [],
    ...(quote && (stringValue(quote.text, 80) || stringValue(quote.attribution, 80))
      ? {
          quote: {
            ...(stringValue(quote.text, 80) ? { text: stringValue(quote.text, 80) } : {}),
            ...(stringValue(quote.attribution, 80) ? { attribution: stringValue(quote.attribution, 80) } : {}),
          },
        }
      : {}),
    ...(stringValue(raw.source, 120) ? { source: stringValue(raw.source, 120) } : {}),
    speakerNotes: stringValue(raw.speakerNotes, 400),
  };
}

/** 只做结构归一（id 补位、数组裁上限），不静默修预算——预算违规交给 checkStoryboard 报错。 */
export function normalizeStoryboard(raw: unknown): { storyboard: EditorStoryboard | null; errors: string[] } {
  const errors: string[] = [];
  const record = objectValue(raw);
  const body = record && objectValue(record.storyboard) ? objectValue(record.storyboard)! : record;
  if (!body) return { storyboard: null, errors: ["storyboard 不是对象"] };
  const deckRaw = objectValue(body.deck) ?? {};
  const title = stringValue(deckRaw.title, 120);
  const spine = stringValue(deckRaw.spine, 300);
  if (!title) errors.push("deck.title 缺失");
  if (!spine) errors.push("deck.spine 缺失");
  const pagesRaw = Array.isArray(body.pages) ? body.pages : [];
  if (pagesRaw.length < 1 || pagesRaw.length > 32) errors.push(`pages 数量 ${pagesRaw.length} 不在 1~32`);
  const pages: EditorPage[] = pagesRaw.slice(0, 32).map((item, index) => {
    const page = objectValue(item) ?? {};
    if (!Array.isArray(page.dropped)) errors.push(`第 ${index + 1} 页缺 dropped 数组`);
    // 形态/单元数/分量不给默认值：缺了就是缺陷，回上游重写这一页，不静默兜到某个版式。
    const formRaw = stringValue(page.form, 24);
    const form = isPageForm(formRaw) ? formRaw : null;
    if (!form) errors.push(`第 ${index + 1} 页 form 缺失或非法：${JSON.stringify(formRaw)}`);
    const unitsRaw = typeof page.units === "number" ? page.units : Number.parseInt(String(page.units ?? ""), 10);
    const units = Number.isFinite(unitsRaw) ? Math.round(unitsRaw) : null;
    if (units === null) errors.push(`第 ${index + 1} 页 units 缺失`);
    const weightRaw = stringValue(page.weight, 12);
    const weight = isPageWeight(weightRaw) ? weightRaw : null;
    if (!weight) errors.push(`第 ${index + 1} 页 weight 缺失或非法：${JSON.stringify(weightRaw)}`);
    return {
      id: stringValue(page.id, 64) || `page-${String(index + 1).padStart(2, "0")}`,
      role: stringValue(page.role, 20) || "content",
      density: stringValue(page.density, 20) || "standard",
      form: form ?? "light-page",
      units: units ?? 1,
      weight: weight ?? "medium",
      emphasis: stringValue(page.emphasis, 20) || "title",
      intent: stringValue(page.intent, 200),
      takeaway: stringValue(page.takeaway, 120),
      copy: normalizeCopy(page.copy),
      ...(objectValue(page.data) ? { data: objectValue(page.data)! } : {}),
      ...(objectValue(page.visual) ? { visual: objectValue(page.visual)! } : {}),
      dropped: normalizeDropped(page.dropped),
    };
  });
  return {
    storyboard: {
      schemaVersion: "storyboard/v2",
      deck: {
        title,
        ...(stringValue(deckRaw.audience, 300) ? { audience: stringValue(deckRaw.audience, 300) } : {}),
        ...(stringValue(deckRaw.occasion, 300) ? { occasion: stringValue(deckRaw.occasion, 300) } : {}),
        ...(typeof deckRaw.durationMin === "number" && Number.isFinite(deckRaw.durationMin)
          ? { durationMin: Math.max(1, Math.min(180, Math.round(deckRaw.durationMin))) }
          : {}),
        spine,
        ...(stringValue(deckRaw.visualThesis, 500) ? { visualThesis: stringValue(deckRaw.visualThesis, 500) } : {}),
      },
      pages,
      warnings: stringArray(body.warnings, 10, 300),
    },
    errors,
  };
}

export function proseLength(copy: EditorCopy): number {
  return [copy.message, ...copy.supporting, copy.quote?.text ?? ""].filter(Boolean).join(" ").length;
}

export function copyLength(copy: EditorCopy): number {
  return [
    copy.kicker,
    copy.message,
    ...copy.supporting,
    ...copy.facts.flatMap((fact) => [fact.label, fact.value, fact.unit, fact.body, fact.note]),
    copy.quote?.text,
    copy.quote?.attribution,
    copy.source,
  ].filter((value): value is string => typeof value === "string").join(" ").length;
}

/**
 * 页面叙事文案预算按内容形态给，不按 role 给。
 * 序列/拆解这类页天生要 5 个单元，用全局 60~80 字会把它写死成两页。
 *
 * 封面/收尾是固定三行结构（kicker + 主张 + 一行说明），给一个 40 字固定额度，
 * 不跟着形态系数一起缩——否则轻页系数 0.5 会把封面压到写不完一句话。
 */
const COVER_PROSE_ALLOWANCE = 40;

function proseBudget(form: PageForm, role: string, density: SceneDensity = "standard"): number {
  const base = proseBudgetForForm(form, density);
  if (role === "cover" || role === "closing") return Math.max(base, COVER_PROSE_ALLOWANCE);
  return base;
}

/** 主角形态必须与内容形态相容（声明义务的一部分）。 */
function emphasisAllowed(form: PageForm, emphasis: string): boolean {
  switch (form) {
    case "single-fact":
      return emphasis === "number" || emphasis === "title";
    case "image-led":
      return emphasis === "image";
    case "quotation":
      return emphasis === "quote";
    case "table":
      return emphasis === "table";
    case "light-page":
      return emphasis === "title";
    default:
      return true;
  }
}

/** 序列页要有先后线索：序号、年份、或先后词。用来查"声明了串行却没给顺序"。 */
const ORDER_HINT_RE = /(第[一二三四五六七八九十]|[①②③④⑤]|首先|其次|再次|然后|接着|最后|之后|随后|→|->|\b(?:19|20)\d{2}\b)/;

/**
 * 确定性验收：与设计文档 §6.1 C1~C9 同口径。返回的 errors 非空即 editor 输出不可用；
 * 影子模式下只记录，不阻塞现有生成。
 */
export function checkStoryboard(
  storyboard: EditorStoryboard,
  draftPages: EditorDraftPage[],
  options: StoryboardCheckOptions = {},
): StoryboardCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const pages = storyboard.pages;
  if (pages.length !== draftPages.length) {
    errors.push(`页数 ${pages.length} 与草稿 ${draftPages.length} 不一致`);
  }
  if (!storyboard.deck.title) errors.push("deck.title 缺失");
  if (!storyboard.deck.spine) errors.push("deck.spine 缺失");
  let proseChars = 0;
  let copyChars = 0;
  let speakerNotesChars = 0;
  let dropped = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]!;
    const copy = page.copy;
    const where = `第 ${index + 1} 页`;
    if (!EDITOR_ROLES.includes(page.role as never)) errors.push(`${where}: role 非法 ${page.role}`);
    if (!EDITOR_DENSITIES.includes(page.density as never)) errors.push(`${where}: density 非法 ${page.density}`);
    if (!EDITOR_FORMS.includes(page.form as never)) errors.push(`形态：${where} 的 form 非法 ${page.form}`);
    const form = page.form;
    const spec = PAGE_FORM_SPEC[form];
    if (!unitsValid(form, page.units)) {
      errors.push(`形态：${where} 是${spec.label}，units 需 ${spec.units[0]}~${spec.units[1]}（当前 ${page.units}）`);
    }
    if (!EDITOR_WEIGHTS.includes(page.weight as never)) errors.push(`形态：${where} 的 weight 非法 ${page.weight}`);
    if (!EDITOR_EMPHASIS.includes(page.emphasis as never)) errors.push(`${where}: emphasis 非法 ${page.emphasis}`);
    if (!emphasisAllowed(form, page.emphasis)) {
      errors.push(`形态：${where} 是${spec.label}，主角不能是 ${page.emphasis}`);
    }
    const visualKind = page.visual && typeof page.visual.kind === "string" ? page.visual.kind : "none";
    if (!["none", "material", "generated"].includes(visualKind)) errors.push(`${where}: visual.kind 非法 ${visualKind}`);
    // 声明义务：声明的形态必须真的有对应的材料支撑。约束由内容承担，不由版式选择承担。
    if (form === "image-led" && visualKind === "none") {
      errors.push(`形态：${where} 是「图为主视觉」但没有配图（visual.kind=none）——补图，或换一个形态`);
    }
    if (form === "table") {
      const table = page.data && typeof page.data === "object" && !Array.isArray(page.data)
        ? (page.data as Record<string, unknown>).table
        : undefined;
      const rows = table && typeof table === "object" && !Array.isArray(table)
        ? (table as Record<string, unknown>).rows
        : undefined;
      if (!Array.isArray(rows) || rows.length < 3) {
        errors.push(`形态：${where} 声明了「对照表」但 data.table.rows 不足 3 行——改形态或补表`);
      }
    }
    if (form === "sequence") {
      const orderText = [copy.message, ...copy.supporting, ...copy.facts.map((fact) => `${fact.label ?? ""}${fact.value ?? fact.body ?? ""}`)]
        .filter(Boolean).join(" ");
      if (!ORDER_HINT_RE.test(orderText)) {
        warnings.push(`形态：${where} 声明了「一串先后」，但页面上没有序号/年份/先后词——确认单元顺序真的不可调换`);
      }
    }
    if (page.intent.length < 10 || page.intent.length > 60) errors.push(`${where}: intent ${page.intent.length} 字，需 10~60`);
    if (!page.takeaway || page.takeaway.length > 22) errors.push(`${where}: takeaway 需 1~22 字（当前 ${page.takeaway.length}）`);
    if (!copy.message || copy.message.length > 24) errors.push(`${where}: message 需 1~24 字（当前 ${copy.message.length}）`);
    if (copy.supporting.length > 1) errors.push(`${where}: supporting 最多 1 行`);
    if (copy.supporting.some((item) => item.length > 32)) errors.push(`${where}: supporting 单行超过 32 字`);
    if (copy.facts.length > spec.factsMax) {
      errors.push(`${where}: ${spec.label} 的 facts 最多 ${spec.factsMax} 条（当前 ${copy.facts.length}）`);
    }
    for (const fact of copy.facts) {
      if (fact.label && fact.label.length > 10) errors.push(`${where}: fact label「${fact.label}」超过 10 字`);
      const value = fact.body ?? fact.value ?? "";
      if (value.length > 14) errors.push(`${where}: fact 值「${value}」超过 14 字`);
    }
    if (copy.kicker && copy.kicker.length > 12) errors.push(`${where}: kicker 超过 12 字`);
    if (copy.speakerNotes.length < 60 || copy.speakerNotes.length > 260) {
      errors.push(`${where}: speakerNotes 需 60~260 字（当前 ${copy.speakerNotes.length}）`);
    }
    if (copy.source && copy.source.length > 80) errors.push(`${where}: source 超过 80 字`);
    const prose = proseLength(copy);
    const budget = proseBudget(form, page.role, options.density ?? "standard");
    if (prose > budget) errors.push(`${where}: 叙事文字 ${prose} 字，超过 ${spec.label} 预算 ${budget}`);
    const onSlide = [copy.kicker, copy.message, ...copy.supporting, copy.quote?.text].filter(Boolean).join(" ");
    if (METADATA_RE.test(onSlide)) errors.push(`${where}: 页面上出现制作元数据（页数/时长/受众/配比）`);
    const flavorText = [
      copy.kicker, copy.message, ...copy.supporting,
      ...copy.facts.flatMap((fact) => [fact.label, fact.value, fact.note]),
      copy.quote?.text, copy.source,
    ].filter(Boolean).join(" ");
    if (AI_FLAVOR_RE.test(flavorText) || ELLIPSIS_RE.test(flavorText)) {
      warnings.push(`${where}: copy 出现口径/待核实/省略号等 AI 套话——页面只留结论，meta 信息移讲稿`);
    }
    if (!Array.isArray(page.dropped)) errors.push(`${where}: dropped 必须是数组`);
    const draft = draftPages[index];
    const draftPoints = draft?.points?.length ?? 0;
    if (draftPoints > 0 && page.dropped.length === 0 && copy.supporting.length + copy.facts.length < draftPoints) {
      warnings.push(`${where}: 草稿 ${draftPoints} 条要点，本页 dropped 为空——请确认压缩项都有记录`);
    }
    proseChars += prose;
    copyChars += copyLength(copy);
    speakerNotesChars += copy.speakerNotes.length;
    dropped += page.dropped.length;
  }
  const forms = [...new Set(pages.map((page) => page.form))];
  // 分布约束：防止换掉版式菜单之后「并列拆解」变成新的安全牌。
  if (pages.length >= 8 && forms.length < 3) {
    errors.push(`形态：全册只有 ${forms.length} 种内容形态，≥8 页 deck 至少 3 种`);
  }
  const breakdownCount = pages.filter((page) => page.form === "breakdown").length;
  if (pages.length > 0 && breakdownCount / pages.length > 0.5) {
    errors.push(`形态：「并列拆解」占 ${breakdownCount}/${pages.length} 页，超过一半——结构不同的内容被压成了清单，请回上游重写这些页`);
  }
  // 轻页配额只统计内容页：封面/章节/收尾本来就是轻的，把它们算进来任何小册都会超线。
  const contentPages = pages.filter(
    (page) => page.role !== "cover" && page.role !== "section" && page.role !== "closing",
  );
  const lightCount = contentPages.filter((page) => page.form === "light-page").length;
  if (contentPages.length >= 3 && lightCount / contentPages.length > 0.15) {
    errors.push(`形态：「轻页」占 ${lightCount}/${contentPages.length} 个内容页，超过 15%——轻页是内容少，不是省略结构的出口`);
  }
  // 节奏：分量曲线（替代原来「相邻页版式不得相同」的弱约束）。
  if (pages.length >= 8 && !pages.some((page) => page.weight === "heavy")) {
    errors.push("形态：全册没有一页是重分量，缺少高潮页");
  }
  for (let index = 2; index < pages.length; index += 1) {
    if (pages[index]!.weight === "light" && pages[index - 1]!.weight === "light" && pages[index - 2]!.weight === "light") {
      errors.push(`形态：第 ${index - 1}~${index + 1} 页连续三页都是轻分量，全册没有推进`);
      break;
    }
  }
  if (pages.length >= 4) {
    const head = pages[0]!;
    const tail = pages[pages.length - 1]!;
    if (head.weight === "heavy" && tail.weight === "heavy") {
      warnings.push("封面与收尾都是重分量，中间没有回落");
    }
  }
  if (pages.length >= 8) {
    const heavyIndex = pages.findIndex((page) => page.weight === "heavy");
    if (heavyIndex >= 0) {
      const ratio = heavyIndex / (pages.length - 1);
      if (ratio < 0.55 || ratio > 0.75) {
        warnings.push(`最重的一页在第 ${heavyIndex + 1} 页（${Math.round(ratio * 100)}%），建议落在 55%~75%`);
      }
    }
  }
  if (pages.length >= 8) {
    const sparse = pages.filter((page) => page.density === "sparse").length;
    if (sparse < 2) warnings.push(`sparse 页仅 ${sparse} 页（≥8 页 deck 建议 ≥2）`);
  }
  return {
    errors,
    warnings,
    stats: {
      pages: pages.length,
      draftPages: draftPages.length,
      forms,
      proseChars,
      copyChars,
      draftPointsChars: draftPages.reduce((sum, page) => sum + (page.points ?? []).reduce((n, point) => n + point.length, 0), 0),
      dropped,
      speakerNotesChars,
    },
  };
}

export function buildShadowReport(
  storyboard: EditorStoryboard,
  draftPages: EditorDraftPage[],
  options: StoryboardCheckOptions = {},
): EditorShadowReport {
  const check = checkStoryboard(storyboard, draftPages, options);
  const { stats } = check;
  const reductionPct = stats.draftPointsChars > 0
    ? Math.round((1 - stats.proseChars / stats.draftPointsChars) * 100)
    : null;
  return {
    draftHash: draftPagesHash(draftPages),
    pageCount: stats.pages,
    draftPageCount: stats.draftPages,
    forms: stats.forms,
    proseChars: stats.proseChars,
    copyChars: stats.copyChars,
    draftPointsChars: stats.draftPointsChars,
    reductionPct,
    dropped: stats.dropped,
    passed: check.errors.length === 0,
    errors: check.errors,
    warnings: check.warnings,
    pages: storyboard.pages.map((page) => ({
      id: page.id,
      role: page.role,
      form: page.form,
      composition: deriveComposition(page.form, {
        hasImage: pageHasImage(page),
        role: page.role,
      }),
      emphasis: page.emphasis,
      proseChars: proseLength(page.copy),
      copyChars: copyLength(page.copy),
      messageChars: page.copy.message.length,
      supporting: page.copy.supporting.length,
      facts: page.copy.facts.length,
      dropped: page.dropped.length,
      speakerNotesChars: page.copy.speakerNotes.length,
    })),
  };
}

// 已拆除：dispatchEditorStoryboard（整册按 6 页一批调用模型的压缩器）。
// 内容链路现在只有 semantic-v3：slides-condense 代码压缩与整册影子均已删除，
// editor 只经 slides-semantic-stage 做指定页修复；本文件的纯函数保留用于
// 历史 storyboard/v2 记录的读回与校验，不再有任何写路径调用。

export interface EditorDispatchInput {
  /** storyboard 批量压缩时本批首屏在整本 deck 中的 0-based 页码。 */
  pageOffset?: number;
  /** 整本 deck 页数；批量模式用于保持全局构图节奏。 */
  pageCount?: number;
  instruction: string;
  roomId: string;
  title: string;
  draftPages: EditorDraftPage[];
  audience?: string;
  occasion?: string;
  durationMin?: number;
  visualThesis?: string;
  /** 风格卡给内容侧的最小 design brief（构图家族/明暗/母题/主色系）。 */
  deckStyle?: Record<string, unknown>;
  /** 内容形态/声明义务未过时的返工反馈（只用于第二次 dispatch）。 */
  formFeedback?: string;
}

export function buildEditorInput(input: EditorDispatchInput): Record<string, unknown> {
  return {
    instruction: input.instruction,
    roomId: input.roomId,
    title: input.title.slice(0, 120),
    draftPages: input.draftPages,
    ...(typeof input.pageOffset === "number" ? { pageOffset: input.pageOffset } : {}),
    ...(typeof input.pageCount === "number" ? { pageCount: input.pageCount } : {}),
    ...(input.audience ? { audience: input.audience.slice(0, 300) } : {}),
    ...(input.occasion ? { occasion: input.occasion.slice(0, 300) } : {}),
    ...(typeof input.durationMin === "number" ? { durationMin: input.durationMin } : {}),
    ...(input.visualThesis ? { visualThesis: input.visualThesis.slice(0, 500) } : {}),
    ...(input.deckStyle ? { deckStyle: input.deckStyle } : {}),
    ...(input.formFeedback ? { formFeedback: input.formFeedback.slice(0, 500) } : {}),
  };
}

export interface EditorRepairInput extends Omit<EditorDispatchInput, "pageOffset" | "pageCount"> {
  /** 已经定稿的整册 storyboard：修复器只改选中页，其余页必须原样还回来。 */
  priorStoryboard: EditorStoryboard;
  /** 允许改动的页 id（其余页改动一律丢弃）。 */
  repairPageIds: string[];
  /** 校对器给出的具体缺陷（逐条对应到页）。 */
  defects: string[];
}

/**
 * 页级修复的 dispatch 输入。
 * 与"整册压缩"输入的区别：草稿页被裁到只有要修的那几页，并附上已经定稿的 storyboard。
 * 这样模型看到的是"这几页哪里不合格"，而不是"把整册重排一遍"。
 */
export function buildEditorRepairInput(input: EditorRepairInput): Record<string, unknown> {
  const base = buildEditorInput(input);
  const keep = new Set(input.repairPageIds);
  const pages = input.priorStoryboard.pages.filter((page) => keep.has(page.id));
  return {
    ...base,
    draftPages: input.draftPages.filter((_page, index) => {
      const storyPage = input.priorStoryboard.pages[index];
      return !storyPage || keep.has(storyPage.id);
    }),
    priorStoryboard: { deck: input.priorStoryboard.deck, pages },
    repairPageIds: input.repairPageIds,
    defects: input.defects.slice(0, 12),
  };
}

/**
 * 把修复结果并回定稿 storyboard：**只接受被点名的页**。
 * 修复器顺手改别的页、改页数、改 deck 元信息，一律丢弃并记一条 rejected。
 * 这是"页级修复"与"整册重排"的边界，必须由代码守，不能靠提示词自觉。
 */
export function mergeRepairedPages(
  base: EditorStoryboard,
  repaired: EditorStoryboard,
  pageIds: string[],
): { storyboard: EditorStoryboard; rejected: string[] } {
  const allowed = new Set(pageIds);
  const byId = new Map(repaired.pages.map((page) => [page.id, page]));
  const rejected: string[] = [];
  if (repaired.pages.length !== base.pages.length) {
    rejected.push(`修复结果页数 ${repaired.pages.length} 与原册 ${base.pages.length} 不一致，只采纳同名页`);
  }
  const pages = base.pages.map((page) => {
    const replacement = byId.get(page.id);
    if (!replacement) {
      if (allowed.has(page.id)) rejected.push(`缺少第 ${page.id} 页的修复结果`);
      return page;
    }
    if (allowed.has(page.id)) return replacement;
    const changed = JSON.stringify(replacement) !== JSON.stringify(page);
    if (changed) rejected.push(`${page.id} 不在本次修复范围，改动已丢弃`);
    return page;
  });
  return {
    storyboard: {
      ...base,
      pages,
      warnings: [...new Set([...(base.warnings ?? []), ...(repaired.warnings ?? [])])],
    },
    rejected,
  };
}

/** 取 invocation 的结构化 storyboard；失败/未提交返回 null（影子模式只告警，不阻塞）。 */
export function storyboardFromInvocation(
  invocation: SubagentInvocation,
  draftPages: EditorDraftPage[],
  options: StoryboardCheckOptions = {},
): { storyboard: EditorStoryboard | null; errors: string[] } {
  if (invocation.status !== "completed") {
    return { storyboard: null, errors: [`editor ${invocation.status}${invocation.errorCode ? `: ${invocation.errorCode}` : ""}`] };
  }
  const structured = invocation.result?.structuredOutput;
  const raw = structured !== null && typeof structured === "object" && !Array.isArray(structured)
    ? structured
    : (invocation.result?.text ?? "");
  const normalized = normalizeStoryboard(raw);
  if (!normalized.storyboard) return { storyboard: null, errors: normalized.errors };
  const check = checkStoryboard(normalized.storyboard, draftPages, options);
  return { storyboard: normalized.storyboard, errors: [...normalized.errors, ...check.errors] };
}


/** planner arrange 的 plan page → editor 输入页（白名单，避免把 materials 等未知字段塞进 input schema）。 */
export function editorPagesFromPlan(plan: Record<string, unknown>): EditorDraftPage[] {
  const pages = Array.isArray(plan.pages) ? plan.pages : [];
  return pages
    .filter((page): page is Record<string, unknown> => page !== null && typeof page === "object" && !Array.isArray(page))
    .map((page) => ({
      ...(typeof page.title === "string" ? { title: page.title.slice(0, 80) } : {}),
      ...(Array.isArray(page.points)
        ? { points: (page.points as unknown[]).filter((point): point is string => typeof point === "string").slice(0, 8) }
        : {}),
      ...(typeof page.data === "string" ? { data: page.data.slice(0, 2000) } : {}),
      ...(typeof page.notes === "string" ? { notes: page.notes.slice(0, 300) } : {}),
    }));
}

function budgetForForm(form: PageForm, role: string, density: SceneDensity = "standard"): { prose: number; copy: number; notes: number } {
  return { prose: proseBudget(form, role, density), copy: 120, notes: 260 };
}

/** 这页能不能有图：看视觉方案，也看 planner 在 plan 页上挂的素材。 */
function pageHasImage(page: EditorPage, planPage?: Record<string, unknown>): boolean {
  const visualKind = page.visual && typeof page.visual.kind === "string" ? page.visual.kind : "none";
  if (visualKind !== "none") return true;
  const materials = planPage?.materials;
  return Array.isArray(materials) && materials.length > 0;
}

/**
 * editor storyboard + planner plan → layouter 的 v2 plan。
 * 只把文案/构图/密度换成 storyboard 口径，保留 plan 的 materials 作为配图来源。
 * 页数不一致返回 null（调用方按可重试失败回报，不静默错位）。
 */
export function mergeStoryboardIntoPlan(
  plan: Record<string, unknown>,
  storyboard: EditorStoryboard,
  options: { density?: SceneDensity } = {},
): Record<string, unknown> | null {
  const pages = Array.isArray(plan.pages) ? plan.pages : [];
  if (pages.length !== storyboard.pages.length) return null;
  const merged = pages.map((raw, index) => {
    const page = raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    const story = storyboard.pages[index]!;
    const neighbors = [
      ...(index > 0
        ? [{
            pageIndex: index - 1,
            form: storyboard.pages[index - 1]!.form,
            takeaway: storyboard.pages[index - 1]!.takeaway.slice(0, 40),
          }]
        : []),
      ...(index + 1 < storyboard.pages.length
        ? [{
            pageIndex: index + 1,
            form: storyboard.pages[index + 1]!.form,
            takeaway: storyboard.pages[index + 1]!.takeaway.slice(0, 40),
          }]
        : []),
    ];
    return {
      ...page,
      role: story.role,
      density: story.density,
      layoutVersion: 2,
      // 版式由内容形态推导，大纲不再声明它。
      form: story.form,
      units: story.units,
      weight: story.weight,
      composition: deriveComposition(story.form, { hasImage: pageHasImage(story, page), role: story.role }),
      skeleton: deriveSkeleton(story.form, story.units),
      emphasis: story.emphasis,
      intent: story.intent,
      takeaway: story.takeaway,
      copy: scrubPageCopy(story.copy),
      ...(story.data ? { data: story.data } : {}),
      ...(neighbors.length > 0 ? { neighbors } : {}),
      budget: budgetForForm(story.form, story.role, options.density ?? "standard"),
    };
  });
  return { ...plan, pages: merged };
}


