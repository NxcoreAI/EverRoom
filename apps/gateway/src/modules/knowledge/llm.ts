/**
 * LLM 层（entity-room-plan §4.1/§4.2/§4.4）：只做开放式抽取与身份判定，
 * 不做归属判决（ED2）。三个调用点：
 *
 * - extract          资料 → { summary, entities[] }（取代原 summarize + arbitrate）
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

export interface ExtractionResult {
  summary: string;
  entities: ExtractedEntity[];
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

  return { summary, entities: [...byName.values()].slice(0, 10) };
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
