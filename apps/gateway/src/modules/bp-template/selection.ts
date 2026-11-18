/**
 * BP 模板选型与注入渲染（方案 §4.2/§4.3，docs/bp-template-plan.zh-CN.md）。
 *
 * 选型结果（人选确认后）在此渲染为 slides-planner 的 draft 输入：
 *   - outline：赛道建议顺序 → 逐页标题（13 项，远低于 planner 32 项上限）
 *   - referenceOutline：核心判断 + 各模块"要回答"
 *   - instruction：赛道专项要求 + 优先指标 + 常见错误 + 阶段调整 + 专项叠加 + 讲述顺序
 *
 * 纯函数、零副作用；数据来自同目录 data.ts（转录自标准 v1.0）。
 */
import {
  BP_ADDONS,
  BP_MODULES,
  BP_NARRATIVE_ORDERS,
  BP_STAGE_TUNINGS,
  BP_STANDARD_VERSION,
  BP_TRACKS,
  BP_X01_MODULES,
  type BpAddon,
  type BpModuleId,
  type BpStage,
  type BpTrackDef,
  type BpTrackId,
} from "./data.js";

/** 选型结果：选型卡六问的机器表示（标准"BP 结构选型流程"）。 */
export interface BpSelection {
  trackId: BpTrackId;
  /** 讲述顺序：BP_NARRATIVE_ORDERS 的下标；缺省用赛道默认顺序。 */
  narrativeOrderIndex?: number;
  stage: BpStage;
  /** 本轮关键判断（一句话，如"客户会持续用"）；写入 deck 元数据与 instruction。 */
  keyJudgement: string;
  /** 专项叠加 ID 列表（BP_ADDONS.id）。 */
  addonIds: string[];
  /** 是否叠加 X01 资产运营扩展。 */
  includeX01: boolean;
}

/** 渲染产物：对齐 slides-planner draft 输入的三个可注入字段。 */
export interface BpPlannerInjection {
  outline: string[];
  referenceOutline: string[];
  instruction: string;
}

const MODULE_BY_ID = new Map<BpModuleId, (typeof BP_MODULES)[number]>(BP_MODULES.map((m) => [m.id, m]));
const TRACK_BY_ID = new Map<BpTrackId, BpTrackDef>(BP_TRACKS.map((t) => [t.id, t]));
const ADDON_BY_ID = new Map<string, BpAddon>(BP_ADDONS.map((a) => [a.id, a]));

export class BpSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BpSelectionError";
  }
}

/** 讲述顺序数量（标准"四种可复用的讲述顺序"）。 */
export const BP_NARRATIVE_ORDER_COUNT = BP_NARRATIVE_ORDERS.length;

/** 讲述顺序的确定性重排：把标准"建议顺序"按讲述顺序的模块组语义重新分组。
 *  标准的四种顺序是文字规则（orderNote），不是模块 ID 序列；此处按规则文字
 *  提取每组应前置的模块集合，其余保持赛道相对顺序跟在后面——确定性、可解释。 */
const NARRATIVE_HEAD_MODULES: readonly BpModuleId[][] = [
  ["M01", "M03", "M02", "M04", "M07"], // 需求尚未形成共识：定位与洞察→问题→时机→产品→初步验证
  ["M01", "M04", "M07"], // 产品与数据已验证：定位后尽早展示产品与进展
  ["M02", "M04", "M07", "M06"], // 技术与工程验证驱动：需求→路线对比→验证
  ["M02", "M04", "M07", "M08", "M09"], // 服务或资产交付驱动：客户交付→单元经济→复制
];

export function reorderForNarrative(trackOrder: readonly BpModuleId[], narrativeIndex: number): BpModuleId[] {
  const heads = NARRATIVE_HEAD_MODULES[narrativeIndex];
  if (!heads) return [...trackOrder];
  const headSet = new Set(heads);
  const head = heads.filter((id) => trackOrder.includes(id));
  const tail = trackOrder.filter((id) => !headSet.has(id));
  return [...head, ...tail];
}

/** 渲染 instruction 的预算上限（planner instruction 上限 16000 字符，预留用户附加要求）。 */
const INSTRUCTION_BUDGET = 12000;

function renderInstruction(sel: BpSelection, track: BpTrackDef, order: readonly BpModuleId[]): string {
  const lines: string[] = [];
  lines.push(`【BP 模板】${track.id} ${track.name}（标准 ${BP_STANDARD_VERSION}）`);
  lines.push(`【适用范围】${track.intro}`);
  lines.push(`【本轮关键判断】${sel.keyJudgement}——全册叙事主线围绕这一判断展开。`);
  lines.push(`【核心判断】${track.coreQuestion}`);
  lines.push("");
  lines.push("【模块顺序（骨架，不得增删模块、不得打乱分组语义）】");
  order.forEach((id, i) => {
    const m = MODULE_BY_ID.get(id);
    const ov = track.overrides[id];
    if (!m) return;
    lines.push(`${i + 1}. ${m.title}（${id}）：${m.question}`);
    lines.push(`   应填：${ov ? ov.required : m.content}`);
    if (ov) lines.push(`   赛道专项证据与图表：${ov.evidenceHints.join("、")}`);
    else lines.push(`   证据与图表：${m.evidence}`);
    lines.push(`   检查重点：${m.pitfalls}`);
  });
  lines.push("");
  lines.push(`【优先指标】${track.metrics}`);
  lines.push(`【常见错误（禁止出现）】${track.antiPatterns.join("；")}`);
  const tuning = BP_STAGE_TUNINGS.map((t) => {
    const v = sel.stage === "early" ? t.early : sel.stage === "growth" ? t.growth : t.mature;
    return `${t.dimension}：${v}`;
  });
  lines.push("");
  lines.push(`【发展阶段调整（${sel.stage}，按已验证程度而非轮次）】`);
  tuning.forEach((line) => lines.push(`- ${line}`));
  if (sel.narrativeOrderIndex !== undefined) {
    const narr = BP_NARRATIVE_ORDERS[sel.narrativeOrderIndex];
    if (narr) {
      lines.push("");
      lines.push(`【讲述顺序（${narr.evidencePattern}）】${narr.orderNote}`);
    }
  }
  if (sel.includeX01) {
    lines.push("");
    lines.push("【X01 资产运营扩展（叠加）】");
    BP_X01_MODULES.forEach((x) => {
      lines.push(`- ${x.id}：${x.required}（证据与图表：${x.evidenceHints.join("、")}）`);
    });
  }
  for (const addonId of sel.addonIds) {
    const addon = ADDON_BY_ID.get(addonId);
    if (!addon) continue;
    lines.push("");
    lines.push(`【专项叠加：${addon.name}】${addon.requirements}`);
  }
  lines.push("");
  lines.push("【硬约束】以上模块顺序是骨架；逐页须覆盖各模块的应填内容与检查重点；优先指标优先呈现；常见错误所列情形不得出现。事实、分析与假设分开；关键数字带来源、口径与日期。");
  let text = lines.join("\n");
  if (text.length > INSTRUCTION_BUDGET) {
    // 优先保模块骨架与硬约束，压缩阶段调整与专项（按需注入）
    const hardTail = text.slice(text.indexOf("【硬约束】"));
    const head = text.slice(0, text.indexOf("【发展阶段调整"));
    text = `${head}${hardTail}`;
  }
  return text;
}


export function getBpTrack(trackId: BpTrackId): BpTrackDef {
  const track = TRACK_BY_ID.get(trackId);
  if (!track) throw new BpSelectionError(`unknown bp track: ${trackId}`);
  return track;
}

/** 选型结果 → planner draft 输入。选型卡确认后调用；纯函数可单测。 */
export function buildPlannerInjection(sel: BpSelection): BpPlannerInjection {
  const track = getBpTrack(sel.trackId);
  if (!sel.keyJudgement.trim()) throw new BpSelectionError("keyJudgement is required");
  const narrIdx = sel.narrativeOrderIndex;
  if (narrIdx !== undefined && (narrIdx < 0 || narrIdx >= BP_NARRATIVE_ORDERS.length)) {
    throw new BpSelectionError(`narrativeOrderIndex out of range: ${narrIdx}`);
  }
  const unknownAddons = sel.addonIds.filter((id) => !ADDON_BY_ID.has(id));
  if (unknownAddons.length > 0) throw new BpSelectionError(`unknown addons: ${unknownAddons.join(",")}`);

  const order = narrIdx === undefined ? [...track.moduleOrder] : reorderForNarrative(track.moduleOrder, narrIdx);
  const outline = order.map((id) => MODULE_BY_ID.get(id)!.title);
  const referenceOutline = [track.coreQuestion, ...order.map((id) => MODULE_BY_ID.get(id)!.question)];
  const instruction = renderInstruction(sel, track, order);
  return { outline, referenceOutline, instruction };
}

/** outline 覆盖校验：draft 输出回填用——确认生成的页面标题覆盖模板的 13 个模块。
 *  供网关侧（tools.ts 调用方）在 draft 完成后校验；返回缺失模块，空数组 = 通过。 */
export function missingModuleCoverage(pageTitles: readonly string[], trackId: BpTrackId): string[] {
  const track = getBpTrack(trackId);
  const normalize = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const got = new Set(pageTitles.map(normalize));
  const missing: string[] = [];
  for (const id of track.moduleOrder) {
    const m = MODULE_BY_ID.get(id)!;
    const hit = [...got].some((t) => t.includes(normalize(m.title)) || normalize(m.title).includes(t));
    if (!hit) missing.push(`${id} ${m.title}`);
  }
  return missing;
}
