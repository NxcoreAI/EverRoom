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

import type { KnowledgeLlmConfig } from "../../config.js";

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
  constructor(private readonly config: KnowledgeLlmConfig) {}

  /** ③′ 实体抽取：一次调用出 summary + 开放实体列表。 */
  async extract(title: string, markdown: string): Promise<ExtractionResult> {
    const prompt = [
      `资料标题：${title}`,
      "",
      markdown.slice(0, 12_000),
      "",
      "请给出抽取 JSON。",
    ].join("\n");
    return this.chatJson(EXTRACT_SYSTEM_PROMPT, prompt, parseExtractionResponse);
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
    return this.chatJson(JUDGE_SYSTEM_PROMPT, prompt, parseJudgeResponse);
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
    return this.chatJson(REGISTER_SYSTEM_PROMPT, prompt, parseRegisterResponse);
  }

  /** 两次尝试（第二次带解析错误反馈），失败抛 KnowledgeLlmError。 */
  private async chatJson<T>(
    systemPrompt: string,
    userPrompt: string,
    parse: (content: string) => T,
  ): Promise<T> {
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const content = await this.chat([
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: lastError ? `${userPrompt}\n\n上一次输出无法解析：${lastError}\n请严格只输出合法 JSON。` : userPrompt,
        },
      ]);
      try {
        return parse(content);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new KnowledgeLlmError(`LLM response unparsable: ${lastError}`);
  }

  private async chat(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          temperature: 0.1,
          max_tokens: 1_024,
        }),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });
    } catch (error) {
      throw new KnowledgeLlmError(
        `knowledge LLM request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new KnowledgeLlmError(`knowledge LLM HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new KnowledgeLlmError("knowledge LLM response missing choices[0].message.content");
    }
    return content.slice(0, MAX_RESPONSE_CHARS);
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

const EXTRACT_SYSTEM_PROMPT = [
  "你是资料实体抽取器。从资料中抽取它涉及的实体（人物/项目/主题/长期目标/议题/事件），并概括资料内容。",
  "规则：",
  "1. name 用资料中的规范叫法（首次全称，后文简称可辨）；同一实体只出一个，不要既出全称又出简称。",
  "2. kind 六选一：人物/项目/主题/长期目标/议题/事件。",
  "3. 通用词不是实体：「用户」「API」「系统」「文档」「数据」「公司」「团队」等任何资料都会出现的词不成实体。",
  "4. salience = 该实体在此资料中的分量 0~1：资料核心主题 ≈0.9，重要参与者 ≈0.5，顺带提及 <0.3。",
  "5. evidence 一句原文短句（≤50 字），说明该实体在资料中的角色。",
  "6. 单份资料实体数 ≤10；资料没有可抽取实体时输出空数组（合法结果，不要硬凑）。",
  "只输出一个 JSON 对象，不要 markdown 代码块、不要解释。格式：",
  '{"summary":"不超过300字的资料概括","entities":[{"name":"...","kind":"人物|项目|主题|长期目标|议题|事件","salience":0.9,"evidence":"..."}]}',
].join("\n");

const JUDGE_SYSTEM_PROMPT = [
  "你是实体同一性判定员。判断两个实体描述是否指向同一个现实实体。",
  "规则：",
  "1. 名称相近但指代不同（如两个同名的不同人、缩写撞车的不同项目）必须判 different。",
  "2. 类型（kind）语义冲突（一个人物一个项目）几乎必然 different，除非依据句显示确实混用。",
  "3. 依据句是主要证据：双方依据句描述的对象/事件/时间段是否吻合。",
  "4. 拿不准时判 different（分立累积无害，错合并才需要事后拆分）。",
  "只输出一个 JSON 对象，不要 markdown 代码块、不要解释。格式：",
  '{"same":true,"reason":"不超过100字的判定依据"}',
].join("\n");

const REGISTER_SYSTEM_PROMPT = [
  "你是实体登记员。一个候选实体已积累足够证据即将转正为正式空间（Room），请综合它的全部依据句与关联资料摘要，产出登记材料。",
  "规则：",
  "1. name：实体的规范名称（Room 标题底稿）——用依据句中出现最一致、最正式的叫法，不要发明新名。",
  "2. summary：Room 概述，不超过 200 字，综合它是什么、证据显示它在做什么。",
  "3. aliases：规范名之外的其余叫法（曾用名/简称/译名），只收依据句中真实出现的，没有就空数组。",
  "只输出一个 JSON 对象，不要 markdown 代码块、不要解释。格式：",
  '{"name":"...","summary":"...","aliases":["..."]}',
].join("\n");

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
