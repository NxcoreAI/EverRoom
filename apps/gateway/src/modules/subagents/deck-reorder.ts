/**
 * deck-composer 子 Agent 的受众重排支撑（DeckGen 比赛项目 W3）：
 * 受众画像库、修辞结构模板、AudiencePlan 归一/校验与排序大纲构建。
 * 契约唯一真源：deckgen 仓 docs/contracts/audience-plan.schema.json（v1.0-rc1）。
 * 与 deck-draft.ts 同构：只放与 orchestrator 无耦合的纯函数与常量。
 */
import type { DeckDraftSpec } from "./deck-draft.js";

export const DECK_REORDER_TASK_LABEL = "受众重排";

export const AUDIENCE_PROFILE_IDS = ["judge", "investor", "customer", "tech"] as const;
export type AudienceProfileId = (typeof AUDIENCE_PROFILE_IDS)[number];

export const RHETORIC_IDS = ["pyramid", "scqa", "timeline"] as const;
export type RhetoricId = (typeof RHETORIC_IDS)[number];

export interface AudienceProfile {
  id: AudienceProfileId;
  label: string;
  defaultRhetoric: RhetoricId;
  /** 画像排序信号：该受众先看什么、信什么、反感什么。注入子 Agent 输入。 */
  guidance: string;
}

export const AUDIENCE_PROFILES: readonly AudienceProfile[] = [
  {
    id: "judge",
    label: "比赛评委",
    defaultRhetoric: "pyramid",
    guidance: "关注创新点、完整性与可验证性：先给结论与创新性声明，再展开方法与验证，强调差异化与工程严谨（确定性审计、测试覆盖、契约冻结），收尾给可复现的证据链；避免空泛的市场话术。",
  },
  {
    id: "investor",
    label: "投资人",
    defaultRhetoric: "scqa",
    guidance: "关注市场规模、痛点强度、壁垒与回报：先铺情境与冲突，突出数据与增长信号，明确竞争壁垒（数据飞轮/流程架构/迁移成本），收尾给下一步与所需资源；技术细节降权。",
  },
  {
    id: "customer",
    label: "客户",
    defaultRhetoric: "scqa",
    guidance: "关注自身痛点与可获得价值：讲同行业痛点场景，方案如何落地、成本与风险如何控制，用案例与交付物说话；内部实现与团队叙事降权。",
  },
  {
    id: "tech",
    label: "技术评审",
    defaultRhetoric: "pyramid",
    guidance: "关注架构决策与正确性：先给架构总览与关键取舍，再深入数据结构/接口契约/事务与失败路径，提供验证手段（测试、审计、兼容基准）；容忍并欢迎高密度细节。",
  },
];

export interface RhetoricTemplate {
  id: RhetoricId;
  label: string;
  guidance: string;
}

export const RHETORIC_TEMPLATES: readonly RhetoricTemplate[] = [
  {
    id: "pyramid",
    label: "金字塔原理",
    guidance: "结论先行：主题→分论点→论据数据，每层支撑上层，横向同层 MECE 不重不漏。",
  },
  {
    id: "scqa",
    label: "SCQA",
    guidance: "情境-冲突-问题-答案：先建立共识情境，再激化冲突，引出关键问题，最后给答案与证据。",
  },
  {
    id: "timeline",
    label: "时间线",
    guidance: "按演进顺序：过去（背景/积累）→ 现在（现状/拐点）→ 未来（规划/愿景）。",
  },
];

export function audienceProfileOf(id: string): AudienceProfile | null {
  return AUDIENCE_PROFILES.find((profile) => profile.id === id) ?? null;
}

export function rhetoricTemplateOf(id: string): RhetoricTemplate | null {
  return RHETORIC_TEMPLATES.find((template) => template.id === id) ?? null;
}

export type AudienceDetail = "expand" | "keep" | "shrink" | "cut";

export interface DeckAudiencePlan {
  profileId: AudienceProfileId;
  rhetoric: RhetoricId;
  orderedBlockIds: string[];
  perBlock: Record<string, { detail: AudienceDetail; note?: string }>;
  rationale: string | null;
}

const DETAIL_VALUES: ReadonlySet<string> = new Set(["expand", "keep", "shrink", "cut"]);

function rowOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * AudiencePlan 归一与校验（跨字段语义）：
 * ① orderedBlockIds 不重、必须 ⊆ 草稿块 id，且恰好覆盖全部非 cut 块；
 * ② perBlock 键必须 ⊆ 草稿块 id，detail 合法；
 * ③ profileId 必须回显输入画像（防张冠李戴）。
 */
export function normalizeAudiencePlan(
  output: Record<string, unknown>,
  spec: DeckDraftSpec,
  expectedProfileId: AudienceProfileId,
): DeckAudiencePlan | null {
  if (output.kind !== "audience-reorder") return null;
  if (output.profileId !== expectedProfileId) return null;
  const rhetoric = RHETORIC_IDS.includes(output.rhetoric as RhetoricId)
    ? output.rhetoric as RhetoricId
    : null;
  if (!rhetoric) return null;
  const known = new Set(spec.blocks.map((block) => block.id));
  if (!Array.isArray(output.orderedBlockIds)) return null;
  const orderedBlockIds: string[] = [];
  for (const id of output.orderedBlockIds) {
    if (typeof id !== "string" || !known.has(id) || orderedBlockIds.includes(id)) return null;
    orderedBlockIds.push(id);
  }
  const perBlockRaw = rowOf(output.perBlock);
  if (!perBlockRaw) return null;
  const perBlock: DeckAudiencePlan["perBlock"] = {};
  for (const [blockId, value] of Object.entries(perBlockRaw)) {
    if (!known.has(blockId)) return null;
    const entry = rowOf(value);
    if (!entry || typeof entry.detail !== "string" || !DETAIL_VALUES.has(entry.detail)) return null;
    perBlock[blockId] = {
      detail: entry.detail as AudienceDetail,
      ...(typeof entry.note === "string" && entry.note.trim()
        ? { note: entry.note.trim().slice(0, 200) }
        : {}),
    };
  }
  const orderedSet = new Set(orderedBlockIds);
  for (const id of known) {
    const detail = perBlock[id]?.detail ?? "keep";
    const inOrder = orderedSet.has(id);
    if (detail === "cut" && inOrder) return null;
    if (detail !== "cut" && !inOrder) return null;
  }
  if (orderedBlockIds.length === 0) return null;
  const rationale = typeof output.rationale === "string" && output.rationale.trim()
    ? output.rationale.trim().slice(0, 1000)
    : null;
  return { profileId: expectedProfileId, rhetoric, orderedBlockIds, perBlock, rationale };
}

export interface AudienceOutlineEntry {
  order: number;
  id: string;
  kind: string;
  detail: AudienceDetail;
  preview: string;
  note?: string;
}

/** 排序大纲（喂 slides_create 的 outline 候选；W4 密度规划接管分页后作为其输入）。 */
export function audienceOutlineOf(
  spec: DeckDraftSpec,
  plan: DeckAudiencePlan,
): AudienceOutlineEntry[] {
  const byId = new Map(spec.blocks.map((block) => [block.id, block]));
  return plan.orderedBlockIds.map((id, index) => {
    const block = byId.get(id)!;
    const entry = plan.perBlock[id] ?? { detail: "keep" as AudienceDetail };
    return {
      order: index + 1,
      id,
      kind: block.kind,
      detail: entry.detail,
      preview: block.content.slice(0, 80),
      ...(entry.note ? { note: entry.note } : {}),
    };
  });
}
