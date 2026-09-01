/**
 * LLM 层（entity-room-plan §4.1/§4.2/§4.4）：只做开放式抽取与身份判定，
 * 不做归属判决（ED2）。三个调用点：
 *
 * - extract          资料 → { summary, entities[], facts[] }（取代原 summarize + arbitrate）
 * - judgeEntityIdentity 模糊带/撞名的同一性判定（ED8：系统自主收敛，不打扰用户）
 * - registerEntity   晋升时一次"转正登记"：依据句 → 规范 name + Room 概述 + aliases（ED7）
 *
 * 全部输出严格 JSON；解析失败带错误反馈重试一次，再失败抛错交 worker 退避。
 */

import { invokeAgent } from "../agent/invoke.js";
import { BUILTIN_AGENT_IDS, type AgentResolver } from "../agent/resolver.js";

const CHAT_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_CHARS = 4_000;

export const ENTITY_KINDS = ["人物", "项目", "主题", "长期目标", "议题", "事件"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export class KnowledgeLlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeLlmError";
  }
}

/** ③′ 抽取结果：开集，无候选菜单。 */
export interface ExtractedEntity {
  name: string;
  kind: EntityKind;
  /** 该实体在此资料中的分量 0~1（快照进 entity_doc_links.salience）。 */
  salience: number;
  /** 依据句（原文短句）：可解释性的来源。 */
  evidence: string;
}

/** 事实记忆（PRD：描述实体属性或实体间关系的明确陈述），entities 为涉及的实体规范名。 */
export interface ExtractedFact {
  content: string;
  type: "属性" | "关系";
  entities: string[];
}

export interface ExtractionResult {
  summary: string;
  entities: ExtractedEntity[];
  facts: ExtractedFact[];
}

export interface RoomContextResult {
  overview: string;
  status: string;
  nextSteps: string[];
  entities: Array<{ name: string; kind: EntityKind; description: string }>;
  actionItems: Array<{ title: string; owner: string | null; dueDate: string | null; sourceTitle: string }>;
  meetings: Array<{ title: string; when: string; participants: string[]; sourceTitle: string }>;
}

/** judgeEntityIdentity 输入：双方的身份材料（name + aliases + kind + 依据句样本）。 */
export interface EntityIdentityInput {
  name: string;
  aliases: string[];
  kind: string;
  /** 依据句样本（≤5 条，调用方裁剪）。 */
  evidenceSamples: string[];
}

export interface JudgeResult {
  same: boolean;
  reason: string;
}

/** registerEntity 输入：弱实体的全部证据材料。 */
export interface RegisterInput {
  name: string;
  kind: string;
  /** 全部依据句（entity_doc_links.evidence）。 */
  evidenceLines: string[];
  /** 关联资料摘要（route_decisions 快照）。 */
  docSummaries: string[];
}

export interface RegisterResult {
  name: string;
  summary: string;
  aliases: string[];
}

/** on-demand Room 推荐输入：用户描述 + 已导入资料 + 路由阶段抽好的实体锚点。 */
export interface RoomProposalInput {
  description: string;
  documents: Array<{ title: string; markdown: string }>;
  anchors: Array<{ name: string; kind: string; evidenceScore: number; sourceCount: number }>;
}

/** 推荐卡：anchorName 命中实体才能走晋升链路（资料自动成为 Room 数据）。 */
export interface RoomProposal {
  anchorName: string;
  name: string;
  kind: EntityKind;
  description: string;
  reason: string;
  sourceNames: string[];
}

export class KnowledgeLlm {
  constructor(private readonly agentResolver: AgentResolver) {}

  /** ③′ 实体抽取：一次调用出 summary + 开放实体列表。 */
  async extract(title: string, markdown: string): Promise<ExtractionResult> {
    const prompt = [
      `资料标题：${title}`,
      "",
      markdown.slice(0, 12_000),
      "",
      "请给出抽取 JSON。",
    ].join("\n");
    return this.chatJson("entity-extraction", prompt, parseExtractionResponse);
  }

  /** Room 当前文档集合 → 只读的详情投影，不参与资料归属判决。连接器来源带 label 标注类型。 */
  async summarizeRoom(
    roomTitle: string,
    sourceDocuments: Array<{ title: string; markdown: string; label?: string }>,
  ): Promise<RoomContextResult> {
    const prompt = [
      `Room：${roomTitle}`,
      `今天日期：${new Date().toISOString().slice(0, 10)}`,
      "",
      ...sourceDocuments.slice(0, 12).flatMap((document, index) => [
        `--- 资料 ${index + 1}${document.label ? `（${document.label}）` : ""}：《${document.title}》 ---`,
        document.markdown.slice(0, 6_000),
        "",
      ]),
      "请给出 Room 上下文 JSON。",
    ].join("\n").slice(0, 36_000);
    return this.chatJson("room-context", prompt, parseRoomContextResponse);
  }

  /** 模糊带同一性判定（4.2/4.5）：双方是否同一实体。 */
  async judgeEntityIdentity(a: EntityIdentityInput, b: EntityIdentityInput): Promise<JudgeResult> {
    const prompt = [
      "实体 A：",
      ...identityLines(a),
      "",
      "实体 B：",
      ...identityLines(b),
      "",
      "请给出同一性判定 JSON。",
    ].join("\n");
    return this.chatJson("entity-identity", prompt, parseJudgeResponse);
  }

  /** 转正登记（4.4 步骤 3）：依据句 + 资料摘要 → Room 身份材料。 */
  async registerEntity(input: RegisterInput): Promise<RegisterResult> {
    const prompt = [
      `实体名称（可能不规范）：${input.name}`,
      `类型：${input.kind}`,
      "",
      "全部依据句（来自关联资料的原文短句）：",
      ...(input.evidenceLines.length > 0
        ? input.evidenceLines.slice(0, 30).map((line, i) => `${i + 1}. ${line}`)
        : ["（无）"]),
      "",
      "关联资料摘要：",
      ...(input.docSummaries.length > 0
        ? input.docSummaries.slice(0, 30).map((line, i) => `${i + 1}. ${line}`)
        : ["（无）"]),
      "",
      "请给出登记 JSON。",
    ].join("\n");
    return this.chatJson("entity-registration", prompt, parseRegisterResponse);
  }

  /**
   * 过滤器降级通道（ingest 第一级闸门）：prompt 自带格式要求，原样透传一次
   * 调用返回原始 JSON 文本（解析由调用方负责）。失败抛 KnowledgeLlmError。
   */
  async chatForFilter(prompt: string): Promise<string> {
    return this.chat("ingest-filter", prompt);
  }

  /**
   * on-demand Room 推荐（创建入口「智能推荐」页签）：用户描述 + 资料 +
   * 实体锚点 → 最多 3 条推荐。锚点来自路由阶段的真实抽取结果，
   * 推荐必须优先围绕锚点实体组织，避免凭空造 Room。
   */
  async proposeRooms(input: RoomProposalInput): Promise<RoomProposal[]> {
    const prompt = [
      input.description.trim()
        ? `用户想创建的 Room（描述）：${input.description.trim().slice(0, 2_000)}`
        : "用户未描述目标 Room，请从资料判断最值得建 Room 的主题。",
      "",
      ...(input.anchors.length > 0 ? [
        "已从资料抽取的候选实体（推荐必须围绕其中之一组织，anchorName 填实体名原文）：",
        ...input.anchors.slice(0, 12).map((anchor, index) =>
          `${index + 1}. ${anchor.name}（类型：${anchor.kind}，证据分 ${anchor.evidenceScore.toFixed(1)}，关联资料 ${anchor.sourceCount} 份）`),
        "",
      ] : ["（资料尚未抽出实体，anchorName 可留空）", ""]),
      ...input.documents.slice(0, 8).flatMap((document, index) => [
        `--- 资料 ${index + 1}：《${document.title}》 ---`,
        document.markdown.slice(0, 6_000),
        "",
      ]),
      "请给出 Room 推荐 JSON。",
    ].join("\n").slice(0, 36_000);
    const proposals = await this.chatJson("room-proposals", prompt, parseProposalsResponse);
    return proposals.slice(0, 3);
  }

  /** 两次尝试（第二次带解析错误反馈），失败抛 KnowledgeLlmError。 */
  private async chatJson<T>(
    skillName: string,
    userPrompt: string,
    parse: (content: string) => T,
  ): Promise<T> {
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const content = await this.chat(
        skillName,
        lastError ? `${userPrompt}\n\n上一次输出无法解析：${lastError}\n请严格只输出合法 JSON。` : userPrompt,
      );
      try {
        return parse(content);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new KnowledgeLlmError(`LLM response unparsable: ${lastError}`);
  }

  /** 判定错误是否为速率限制（429/1302）——瞬时态，退避重试可恢复。 */
  static isRateLimited(error: unknown): boolean {
    return error instanceof KnowledgeLlmError && /HTTP 429|速率限制|rate.?limit/i.test(error.message);
  }

  /**
   * 判定错误是否为输出预算截断（finish_reason=length）——瞬时态：runtime
   * 侧已有 4 倍加预算重试，仍截断说明预算配置偏小，交 worker 退避后重试；
   * 不得落 awaiting_review 死信（否则资料被永久定罪为"抽取失败"）。
   */
  static isTruncated(error: unknown): boolean {
    return error instanceof KnowledgeLlmError && /finish_reason=length/i.test(error.message);
  }

  private async chat(skillName: string, prompt: string): Promise<string> {
    try {
      const content = await invokeAgent(this.agentResolver, BUILTIN_AGENT_IDS.knowledge, [
        `使用 Knowledge Agent 的 ${skillName} Skill。`,
        prompt,
      ].join("\n"), {
        pageLabel: "Knowledge internal workflow",
        timeoutMs: CHAT_TIMEOUT_MS,
      });
      return content.slice(0, MAX_RESPONSE_CHARS);
    } catch (error) {
      throw new KnowledgeLlmError(
        `knowledge Agent invocation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function identityLines(input: EntityIdentityInput): string[] {
  const lines = [`- 名称：${input.name}`];
  if (input.aliases.length > 0) lines.push(`- 别名：${input.aliases.slice(0, 10).join("、")}`);
  lines.push(`- 类型：${input.kind}`);
  if (input.evidenceSamples.length > 0) {
    lines.push("- 依据句：");
    lines.push(...input.evidenceSamples.slice(0, 5).map((line) => `  - ${line}`));
  }
  return lines;
}

/** 剥围栏 + 定位 JSON 对象主体（导出供单测复用）。 */
function parseJsonObject(content: string): Record<string, unknown> {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new KnowledgeLlmError("no JSON object found");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch (error) {
    throw new KnowledgeLlmError(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new KnowledgeLlmError("JSON payload is not an object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * 严格解析抽取输出（导出供单测）：
 * summary/ entities[].{name,kind,salience,evidence} 逐字段校验 + 越界修正；
 * 同名实体去重（保 salience 高者），数量封顶 10。
 * facts[].{content,type,entities} 同样严格解析：按 content 去重、封顶 10；
 * 旧输出无 facts 字段时回落空数组（兼容历史决策重放）。
 */
export function parseExtractionResponse(content: string): ExtractionResult {
  const raw = parseJsonObject(content);

  const summary = typeof raw.summary === "string" ? raw.summary.trim().slice(0, 400) : "";

  const entitiesRaw = Array.isArray(raw.entities) ? raw.entities : [];
  const byName = new Map<string, ExtractedEntity>();
  for (const item of entitiesRaw) {
    if (typeof item !== "object" || item === null) continue;
    const entity = item as Record<string, unknown>;
    const name = typeof entity.name === "string" ? entity.name.trim().slice(0, 120) : "";
    if (!name) continue;
    const kindRaw = typeof entity.kind === "string" ? entity.kind.trim() : "";
    const kind = (ENTITY_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as EntityKind) : "主题";
    const salienceRaw = typeof entity.salience === "number" ? entity.salience : Number(entity.salience);
    const salience = Number.isFinite(salienceRaw) ? Math.min(1, Math.max(0, salienceRaw)) : 0.3;
    const evidence = typeof entity.evidence === "string" ? entity.evidence.trim().slice(0, 300) : "";
    const candidate: ExtractedEntity = { name, kind, salience, evidence };
    // 同名（区分大小写的原文形态）只保留分量最高的一条
    const existing = byName.get(name);
    if (!existing || candidate.salience > existing.salience) byName.set(name, candidate);
  }

  const factsRaw = Array.isArray(raw.facts) ? raw.facts : [];
  const factsByContent = new Map<string, ExtractedFact>();
  for (const item of factsRaw) {
    if (typeof item !== "object" || item === null) continue;
    const fact = item as Record<string, unknown>;
    const factContent = typeof fact.content === "string" ? fact.content.trim().slice(0, 300) : "";
    if (!factContent) continue;
    const typeRaw = typeof fact.type === "string" ? fact.type.trim() : "";
    const type: ExtractedFact["type"] = typeRaw === "关系" ? "关系" : "属性";
    const entities = (Array.isArray(fact.entities) ? fact.entities : [])
      .flatMap((name) => (typeof name === "string" ? [name.trim().slice(0, 120)] : []))
      .filter((name) => name.length > 0)
      .slice(0, 4);
    // 同内容只保留一条（后到覆盖：保留最新形态，实体引用更全的通常在后）
    factsByContent.set(factContent, { content: factContent, type, entities });
  }

  return {
    summary,
    entities: [...byName.values()].slice(0, 10),
    facts: [...factsByContent.values()].slice(0, 10),
  };
}

export function parseRoomContextResponse(content: string): RoomContextResult {
  const raw = parseJsonObject(content);
  const optional = (value: unknown, max: number) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
  const overview = optional(raw.overview, 500) ?? "";
  const status = optional(raw.status, 500) ?? "";
  const nextSteps = Array.isArray(raw.nextSteps)
    ? [...new Set(raw.nextSteps.flatMap((item) => { const value = optional(item, 300); return value ? [value] : []; }))].slice(0, 4)
    : [];
  const entities = Array.isArray(raw.entities) ? raw.entities.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const name = optional(value.name, 120);
    if (!name) return [];
    const rawKind = optional(value.kind, 24) ?? "主题";
    const kind = (ENTITY_KINDS as readonly string[]).includes(rawKind) ? rawKind as EntityKind : "主题";
    return [{ name, kind, description: optional(value.description, 300) ?? "" }];
  }).slice(0, 10) : [];
  const actionItems = Array.isArray(raw.actionItems) ? raw.actionItems.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const title = optional(value.title, 300); const sourceTitle = optional(value.sourceTitle, 300);
    return title && sourceTitle ? [{ title, owner: optional(value.owner, 120), dueDate: optional(value.dueDate, 120), sourceTitle }] : [];
  }).slice(0, 10) : [];
  const meetings = Array.isArray(raw.meetings) ? raw.meetings.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const title = optional(value.title, 300); const when = optional(value.when, 120); const sourceTitle = optional(value.sourceTitle, 300);
    if (!title || !when || !sourceTitle) return [];
    const participants = Array.isArray(value.participants) ? value.participants.flatMap((participant) => { const name = optional(participant, 120); return name ? [name] : []; }).slice(0, 20) : [];
    return [{ title, when, participants, sourceTitle }];
  }).slice(0, 10) : [];
  return { overview, status, nextSteps, entities, actionItems, meetings };
}

/** 严格解析同一性判定输出（导出供单测）。 */
export function parseJudgeResponse(content: string): JudgeResult {
  const raw = parseJsonObject(content);
  const same = raw.same;
  if (typeof same !== "boolean") throw new KnowledgeLlmError(`invalid same: ${String(same)}`);
  const reason = typeof raw.reason === "string" ? raw.reason.trim().slice(0, 500) : "";
  return { same, reason };
}

/** 严格解析登记输出（导出供单测）；name 缺失即失败（调用方回退现有 name 拼底稿）。 */
export function parseRegisterResponse(content: string): RegisterResult {
  const raw = parseJsonObject(content);
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 120) : "";
  if (!name) throw new KnowledgeLlmError("register result requires name");
  const summary = typeof raw.summary === "string" ? raw.summary.trim().slice(0, 500) : "";
  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases
        .filter((alias): alias is string => typeof alias === "string")
        .map((alias) => alias.trim().slice(0, 120))
        .filter((alias) => alias.length > 0 && alias !== name)
    : [];
  return { name, summary, aliases: [...new Set(aliases)].slice(0, 10) };
}

/**
 * 严格解析 Room 推荐输出（导出供单测）：proposals[].{anchorName,name,kind,
 * description,reason,sourceNames} 逐字段校验 + 越界修正；name 缺失即跳过，
 * 全部缺失抛错交 chatJson 带反馈重试。
 */
export function parseProposalsResponse(content: string): RoomProposal[] {
  const raw = parseJsonObject(content);
  const proposalsRaw = Array.isArray(raw.proposals) ? raw.proposals : [];
  const byName = new Map<string, RoomProposal>();
  for (const item of proposalsRaw) {
    if (typeof item !== "object" || item === null) continue;
    const proposal = item as Record<string, unknown>;
    const optional = (value: unknown, max: number) =>
      typeof value === "string" && value.trim() ? value.trim().slice(0, max) : "";
    const name = optional(proposal.name, 120);
    if (!name) continue;
    const anchorName = optional(proposal.anchorName, 120) || name;
    const kindRaw = optional(proposal.kind, 24);
    const kind = (ENTITY_KINDS as readonly string[]).includes(kindRaw) ? kindRaw as EntityKind : "主题";
    const sourceNames = (Array.isArray(proposal.sourceNames) ? proposal.sourceNames : [])
      .flatMap((source) => (typeof source === "string" ? [source.trim().slice(0, 200)] : []))
      .filter((source) => source.length > 0);
    const candidate: RoomProposal = {
      anchorName,
      name,
      kind,
      description: optional(proposal.description, 500),
      reason: optional(proposal.reason, 300),
      sourceNames: [...new Set(sourceNames)].slice(0, 8),
    };
    byName.set(name, candidate);
  }
  if (byName.size === 0) throw new KnowledgeLlmError("proposals result requires at least one proposal");
  return [...byName.values()];
}
