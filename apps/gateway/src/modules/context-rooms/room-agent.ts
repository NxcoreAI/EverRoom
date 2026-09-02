import { randomUUID } from "node:crypto";
import type { SubagentInvocation } from "@nxcore/agent-contract";
import { SELECTION_REWRITE_OPERATION_GRACE_MS } from "../agent/service.js";
import type { SubagentOrchestrator } from "../subagents/orchestrator.js";

export const CONTEXT_ROOM_AGENT_ID = "context-room";

export const CONTEXT_ROOM_KINDS = ["人物", "项目", "主题", "长期目标", "议题", "事件"] as const;
export type ContextRoomKind = typeof CONTEXT_ROOM_KINDS[number];

export type ContextRoomAgentTask =
  | "room-enrich"
  | "room-overview"
  | "brief-refresh"
  | "selection-rewrite"
  | "merge-name";

const TASK_LABELS: Record<ContextRoomAgentTask, string> = {
  "room-enrich": "整理新创建的 Context Room",
  "room-overview": "生成 Context Room 总览",
  "brief-refresh": "再生成 Context Room 简报",
  "selection-rewrite": "改写文档选区",
  "merge-name": "为合并后的新 Context Room 推荐名称",
};

export interface ContextRoomEnrichment {
  kind: ContextRoomKind;
  overview: string;
  background: string;
  goal: string;
  status: string;
  nextSteps: string[];
  entities: Array<{ name: string; kind: string; description: string }>;
  facts: Array<{ content: string; type: string }>;
}

export interface ContextRoomBriefRefresh {
  background: string;
  goal: string;
  status: string;
  risks: string[];
  decisions: string[];
}

export interface ContextRoomOverviewSynthesis {
  overview: Array<{
    key: string | null;
    text: string;
    aspect: "summary" | "background" | "goal";
    confidence: number | null;
    evidenceRefs: string[];
  }>;
  status: Array<{
    key: string | null;
    text: string;
    category: "conclusion" | "progress" | "problem" | "blocker";
    state: "active" | "resolved" | "unknown";
    confidence: number | null;
    evidenceRefs: string[];
  }>;
  nextSteps: Array<{
    key: string | null;
    text: string;
    owner: string | null;
    dueAt: string | null;
    priority: "high" | "medium" | "low" | null;
    confidence: number | null;
    evidenceRefs: string[];
  }>;
}

function text(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function textArray(value: unknown, maxItems: number, maxLength: number): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const normalized = text(item, maxLength);
        return normalized ? [normalized] : [];
      }).slice(0, maxItems)
    : [];
}

function confidence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : null;
}

function nullableText(value: unknown, maxLength: number): string | null {
  return text(value, maxLength) || null;
}

function objectFromOutput(content: string): Record<string, unknown> {
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const direct = JSON.parse(normalized) as unknown;
    if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as Record<string, unknown>;
  } catch {
    // Some providers wrap otherwise valid JSON in a short explanation.
  }
  for (let start = normalized.indexOf("{"); start >= 0; start = normalized.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < normalized.length; index += 1) {
      const character = normalized[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") inString = false;
        continue;
      }
      if (character === "\"") inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth !== 0) continue;
        try {
          const embedded = JSON.parse(normalized.slice(start, index + 1)) as unknown;
          if (embedded && typeof embedded === "object" && !Array.isArray(embedded)) {
            return embedded as Record<string, unknown>;
          }
        } catch {
          break;
        }
      }
    }
  }
  throw new Error("Context Room Agent returned invalid JSON");
}

export function fallbackContextRoomEnrichment(
  input: { title: string; description: string },
): ContextRoomEnrichment {
  const isChinese = /[㐀-鿿]/u.test(`${input.title}${input.description}`);
  return {
    kind: "主题",
    overview: input.description,
    background: input.description,
    goal: input.description,
    status: isChinese ? "已创建，等待补充资料" : "Created; awaiting more material",
    nextSteps: [],
    entities: [],
    facts: [],
  };
}

export function parseContextRoomEnrichment(
  content: string,
  fallback: ContextRoomEnrichment,
): ContextRoomEnrichment {
  const value = objectFromOutput(content);
  const kindValue = text(value.kind, 24);
  const kind = CONTEXT_ROOM_KINDS.includes(kindValue as ContextRoomKind)
    ? kindValue as ContextRoomKind
    : fallback.kind;
  const entities = Array.isArray(value.entities) ? value.entities.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const name = text(record.name, 120);
    if (!name) return [];
    return [{
      name,
      kind: text(record.kind, 40) || "主题",
      description: text(record.description, 500),
    }];
  }).slice(0, 12) : [];
  const facts = Array.isArray(value.facts) ? value.facts.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const content = text(record.content, 600);
    if (!content) return [];
    return [{ content, type: text(record.type, 40) || "事实" }];
  }).slice(0, 20) : [];
  return {
    kind,
    overview: text(value.overview, 2_000) || fallback.overview,
    background: text(value.background, 2_000) || fallback.background,
    goal: text(value.goal, 2_000) || fallback.goal,
    status: text(value.status, 500) || fallback.status,
    nextSteps: textArray(value.nextSteps, 8, 300),
    entities,
    facts,
  };
}

export function parseBriefRefresh(content: string): ContextRoomBriefRefresh {
  const value = objectFromOutput(content);
  return {
    background: text(value.background, 2_000),
    goal: text(value.goal, 2_000),
    status: text(value.status, 500),
    risks: textArray(value.risks, 6, 300),
    decisions: textArray(value.decisions, 6, 300),
  };
}

/**
 * 解析 merge-name 任务输出：{"names": ["...", "..."]}。名称即新 Room 标题：
 * 去重（忽略大小写）、截断到 120（对齐标题上限）、最多 3 条。
 */
export function parseMergeNameSuggestions(content: string): string[] {
  const value = objectFromOutput(content);
  const names = Array.isArray(value.names) ? value.names : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of names) {
    const name = text(item, 120);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
    if (result.length >= 3) break;
  }
  return result;
}

export function parseRoomOverviewSynthesis(content: string): ContextRoomOverviewSynthesis {
  const value = objectFromOutput(content);
  const parseOverview = (input: unknown): ContextRoomOverviewSynthesis["overview"] => {
    const items = Array.isArray(input) ? input : [input];
    return items.flatMap((item) => {
      if (typeof item === "string") {
        const normalized = text(item, 2_000);
        return normalized ? [{ key: null, text: normalized, aspect: "summary" as const, confidence: null, evidenceRefs: [] }] : [];
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      const normalized = text(row.text, 2_000);
      if (!normalized) return [];
      const aspect = ["summary", "background", "goal"].includes(String(row.aspect))
        ? row.aspect as "summary" | "background" | "goal"
        : "summary";
      return [{
        key: nullableText(row.key, 120),
        text: normalized,
        aspect,
        confidence: confidence(row.confidence),
        evidenceRefs: textArray(row.evidenceRefs, 20, 300),
      }];
    }).slice(0, 6);
  };
  const parseStatus = (input: unknown): ContextRoomOverviewSynthesis["status"] => {
    const items = Array.isArray(input) ? input : [input];
    return items.flatMap((item) => {
      if (typeof item === "string") {
        const normalized = text(item, 1_000);
        return normalized ? [{
          key: null,
          text: normalized,
          category: "conclusion" as const,
          state: "unknown" as const,
          confidence: null,
          evidenceRefs: [],
        }] : [];
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      const normalized = text(row.text, 1_000);
      if (!normalized) return [];
      const category = ["conclusion", "progress", "problem", "blocker"].includes(String(row.category))
        ? row.category as "conclusion" | "progress" | "problem" | "blocker"
        : "conclusion";
      const state = ["active", "resolved", "unknown"].includes(String(row.state))
        ? row.state as "active" | "resolved" | "unknown"
        : "unknown";
      return [{
        key: nullableText(row.key, 120),
        text: normalized,
        category,
        state,
        confidence: confidence(row.confidence),
        evidenceRefs: textArray(row.evidenceRefs, 20, 300),
      }];
    }).slice(0, 12);
  };
  const parseNextSteps = (input: unknown): ContextRoomOverviewSynthesis["nextSteps"] => (
    (Array.isArray(input) ? input : []).flatMap((item) => {
      if (typeof item === "string") {
        const normalized = text(item, 500);
        return normalized ? [{
          key: null,
          text: normalized,
          owner: null,
          dueAt: null,
          priority: null,
          confidence: null,
          evidenceRefs: [],
        }] : [];
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      const normalized = text(row.text, 500);
      if (!normalized) return [];
      const priority = ["high", "medium", "low"].includes(String(row.priority))
        ? row.priority as "high" | "medium" | "low"
        : null;
      return [{
        key: nullableText(row.key, 120),
        text: normalized,
        owner: nullableText(row.owner, 120),
        dueAt: nullableText(row.dueAt, 120),
        priority,
        confidence: confidence(row.confidence),
        evidenceRefs: textArray(row.evidenceRefs, 20, 300),
      }];
    }).slice(0, 12)
  );
  return {
    overview: parseOverview(value.overview),
    status: parseStatus(value.status),
    nextSteps: parseNextSteps(value.nextSteps),
  };
}

export interface RoomAgentDispatchInput {
  task: ContextRoomAgentTask;
  taskInput: Record<string, unknown>;
  /** 稳定键用于幂等去重（如 room-enrich 按 roomId）；缺省每次新调用。 */
  idempotencyKey?: string;
}

export interface RoomAgentDispatcher {
  /** 等待任务终态并返回完整 Invocation。 */
  dispatch(input: RoomAgentDispatchInput): Promise<SubagentInvocation>;
  /** 立即返回 invocationId，不等待终态；调用方轮询 /v1/subagent-invocations/:id。 */
  dispatchDetached(input: RoomAgentDispatchInput): Promise<string>;
}

/**
 * Context Room 子 Agent 的 internal_workflow 调度封装：
 * 统一 agentId / source / task 文案，业务侧只关心任务与结构化输入。
 */
export class ContextRoomAgentDispatcher implements RoomAgentDispatcher {
  constructor(
    private readonly orchestrator: SubagentOrchestrator,
    /** 划词改写的写作风格注入段（方案 §7.2）：provider 自查生成开关，关闭返回 null。 */
    private readonly writingStyleProvider: { getGenerationPromptSection(): string | null } | null = null,
  ) {}

  dispatch(input: RoomAgentDispatchInput): Promise<SubagentInvocation> {
    return this.orchestrator.dispatch(this.toDispatchInput(input));
  }

  async dispatchDetached(input: RoomAgentDispatchInput): Promise<string> {
    return this.orchestrator.startDetached(this.toDispatchInput(input));
  }

  private toDispatchInput(input: RoomAgentDispatchInput) {
    const writingStyle = input.task === "selection-rewrite"
      ? this.writingStyleProvider?.getGenerationPromptSection() ?? null
      : null;
    return {
      agentId: CONTEXT_ROOM_AGENT_ID,
      task: TASK_LABELS[input.task],
      input: {
        task: input.task,
        ...input.taskInput,
        ...(writingStyle ? { writingStyle } : {}),
      },
      idempotencyKey: input.idempotencyKey ?? `room-agent:${randomUUID()}`,
      source: "internal_workflow" as const,
      parentSessionId: null,
      parentRunId: null,
    };
  }
}

export function invocationText(invocation: SubagentInvocation | null | undefined): string | null {
  const result = invocation?.result;
  return typeof result?.text === "string" && result.text.trim() ? result.text : null;
}

/**
 * 校验 document.selection-rewrite 操作的子 Agent 调用溯源：
 * 必须是 context-room 子 Agent 的 internal_workflow 调用、已 completed、
 * 在宽限期内，且（入参带 roomId 时）与操作目标 Room 一致。
 * 对齐 agent/service.ts 中主 Agent 会话溯源的 completedSelectionRewriteMatches 规则。
 */
export function isSelectionRewriteInvocationAuthorized(
  invocation: SubagentInvocation | null | undefined,
  options: { capabilityId: string; roomId: string; now?: Date },
): boolean {
  if (!invocation || options.capabilityId !== "document.selection-rewrite") return false;
  if (invocation.agentDefinitionId !== CONTEXT_ROOM_AGENT_ID) return false;
  if (invocation.source !== "internal_workflow") return false;
  if (invocation.status !== "completed" || !invocation.completedAt) return false;
  const completedAt = new Date(invocation.completedAt).getTime();
  if (!Number.isFinite(completedAt)) return false;
  const now = options.now?.getTime() ?? Date.now();
  if (now - completedAt > SELECTION_REWRITE_OPERATION_GRACE_MS) return false;
  const input = invocation.input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const inputRoomId = (input as Record<string, unknown>).roomId;
    if (typeof inputRoomId === "string" && inputRoomId !== options.roomId) return false;
  }
  return true;
}
