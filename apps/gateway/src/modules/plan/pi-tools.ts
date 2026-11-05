import type { PiAgentRuntimeTool, PiAgentRuntimeToolResult } from "@nxcore/agent-runtime-pi";
import type { PlanItem, PlanRef } from "@nxcore/agent-contract";
import { formatPlanClaimPackage } from "@nxcore/agent-contract";

import { PlanError, type PlanService } from "./service.js";

/**
 * 计划（任务 / todo）工具面。
 *
 * 设计原则（改之前先看 docs/workspace-plan-task-design.zh-CN.md §8）：
 * - 认领前必须 `plan_get` 读包，避免"凭记忆干"；
 * - 材料只给引用，正文自己用 file_read / document_read 取；
 * - 做完必须 `plan_update(status=done, resultSummary=…)`，做不完必须 `plan_release(原因)`；
 * - 一个 run 内建任务上限 10 条、认领上限 3 条（防任务爆炸与并行摊薄质量）。
 */

const MAX_TASKS_PER_RUN = 10;
const MAX_CLAIMS_PER_RUN = 3;
const MAX_LIST = 30;

function itemLine(item: PlanItem): string {
  const owner = item.ownerKind === "agent"
    ? `Agent ${item.ownerAgentId ?? ""}`.trim()
    : item.ownerKind === "user"
      ? "你（用户）"
      : "待认领";
  const due = item.dueAt ? ` · 截止 ${item.dueAt.slice(0, 10)}` : "";
  const blocked = item.blockedBy.length ? ` · 依赖 ${item.blockedBy.length} 项` : "";
  return `- [${item.status}] ${item.title}（${item.id.slice(0, 8)}…，${item.priority}，${owner}${due}${blocked}）`;
}

function describeFailure(error: unknown): { content: string; details: Record<string, unknown> } | null {
  if (!(error instanceof PlanError)) return null;
  switch (error.code) {
    case "plan_claimed_elsewhere":
      return {
        content: `这条任务已被其他会话认领（持有者 ${String(error.details.holderSessionId ?? "unknown")}，租约到 ${String(error.details.expiresAt ?? "未知")}）。可以先做别的，或等租约过期。`,
        details: { error: error.code, ...error.details },
      };
    case "plan_blocked":
      return {
        content: `这条任务还有未完成的前置依赖：${JSON.stringify(error.details.blocking ?? [])}。先完成它们。`,
        details: { error: error.code, ...error.details },
      };
    case "plan_scope_mismatch":
      return {
        content: "这条任务不属于当前空间，不能认领或修改（跨空间一律拒绝）。",
        details: { error: error.code, ...error.details },
      };
    case "plan_version_conflict":
      return {
        content: `这条任务刚被别人改过（当前版本 ${String(error.details.currentVersion ?? "?")}）。用 plan_get 重新读一遍再操作。`,
        details: { error: error.code, ...error.details },
      };
    case "plan_result_required":
      return {
        content: "把任务标记完成时必须写 resultSummary：一句话说明交付了什么、还有哪些已知缺口。",
        details: { error: error.code },
      };
    case "plan_item_not_found":
      return { content: "找不到这条任务，先用 plan_list 确认 id。", details: { error: error.code } };
    case "plan_workspace_not_found":
      return { content: "当前会话没有所属工作空间，无法使用计划。", details: { error: error.code } };
    default:
      return { content: `计划操作失败：${error.code}`, details: { error: error.code, ...error.details } };
  }
}

function normalizeRefsParam(value: unknown): PlanRef[] {
  if (!Array.isArray(value)) return [];
  const refs: PlanRef[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const kind = typeof record.kind === "string" ? record.kind : "";
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!["file", "document", "session", "url"].includes(kind) || !id) continue;
    refs.push({
      kind: kind as PlanRef["kind"],
      id,
      title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : id,
    });
  }
  return refs;
}

export function createPlanPiTools(plan: PlanService): PiAgentRuntimeTool[] {
  const createdByRun = new Map<string, number>();
  const claimedByRun = new Map<string, number>();

  const requireWorkspace = (workspaceId: string | null | undefined): string => {
    if (!workspaceId) throw new PlanError("plan_workspace_not_found", "plan_workspace_not_found");
    return workspaceId;
  };

  const listTool: PiAgentRuntimeTool = {
    name: "plan_list",
    label: "查看计划",
    description: "列出当前工作空间的计划任务（按状态筛选），用于找活儿、确认任务 id。",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["todo", "doing", "done", "dropped"],
          description: "只看某列；不传 = 全部（最多 30 条）",
        },
        owner: {
          type: "string",
          enum: ["any", "unassigned", "mine", "agent"],
          description: "按负责人筛选：unassigned=待认领，mine=用户自己做，agent=Agent 在做",
        },
        q: { type: "string", description: "关键词（匹配标题/背景/标签）" },
      },
      additionalProperties: false,
    },
    promptSnippet: "查看计划任务",
    promptGuidelines: [
      "用户提到「计划里那条」「之前那个任务」时，先 plan_list 查，不要凭记忆猜。",
    ],
    executionMode: "sequential",
    execute: async (input, params): Promise<PiAgentRuntimeToolResult> => {
      const workspaceId = requireWorkspace(input.workspaceId);
      const owner = typeof params.owner === "string" ? params.owner : "any";
      try {
        const items = plan.list({
          workspaceId,
          ...(typeof params.status === "string" ? { status: params.status as PlanItem["status"] } : {}),
          ...(owner !== "any" ? { owner: owner === "mine" ? "me" : owner as "unassigned" | "agent" } : {}),
          ...(typeof params.q === "string" && params.q.trim() ? { q: params.q.trim() } : {}),
          limit: MAX_LIST,
        });
        if (!items.length) return { content: "这个空间当前没有符合条件的计划任务。", details: { items: [] } };
        const byStatus = new Map<string, PlanItem[]>();
        for (const item of items) {
          const bucket = byStatus.get(item.status) ?? [];
          bucket.push(item);
          byStatus.set(item.status, bucket);
        }
        const lines: string[] = [`共 ${items.length} 条：`];
        for (const status of ["todo", "doing", "done", "dropped"] as const) {
          const bucket = byStatus.get(status);
          if (!bucket?.length) continue;
          lines.push("", `## ${status}`);
          for (const item of bucket) lines.push(itemLine(item));
        }
        return { content: lines.join("\n"), details: { items } };
      } catch (error) {
        const failure = describeFailure(error);
        if (failure) return failure;
        throw error;
      }
    },
  };

  const createTool: PiAgentRuntimeTool = {
    name: "plan_create",
    label: "建计划任务",
    description: "在当前工作空间的计划里新建一条任务（用户之后能在看板上看到并推进它）。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "一句话说清要做什么（≤200 字）" },
        detail: { type: "string", description: "背景与要求，写得越清楚后续越好认领" },
        acceptance: { type: "string", description: "验收标准（怎么算做完）" },
        constraints: { type: "array", items: { type: "string" }, description: "硬约束（口径/格式/禁止项）" },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        dueAt: { type: "string", description: "截止时间（ISO 8601）" },
        refs: {
          type: "array",
          description: "相关材料引用（只存引用不存正文）",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["file", "document", "session", "url"] },
              id: { type: "string" },
              title: { type: "string" },
            },
            required: ["kind", "id"],
            additionalProperties: false,
          },
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    promptSnippet: "建计划任务",
    promptGuidelines: [
      "只有用户明确要求「记到计划里」或你自己要跟踪的后续动作，才建任务；不要为了一次性回答建任务。",
      `一次 run 最多建 ${MAX_TASKS_PER_RUN} 条任务。`,
    ],
    executionMode: "sequential",
    execute: async (input, params): Promise<PiAgentRuntimeToolResult> => {
      const workspaceId = requireWorkspace(input.workspaceId);
      const title = typeof params.title === "string" ? params.title.trim() : "";
      if (!title) throw new Error("plan_create 参数 title 不能为空");
      const used = createdByRun.get(input.runId) ?? 0;
      if (used >= MAX_TASKS_PER_RUN) {
        return {
          content: `本次运行已经建了 ${used} 条任务，达到上限（${MAX_TASKS_PER_RUN}）。先做完手头的。`,
          details: { error: "plan_create_limit" },
        };
      }
      try {
        const item = plan.create({
          workspaceId,
          title,
          detail: typeof params.detail === "string" ? params.detail : null,
          acceptance: typeof params.acceptance === "string" ? params.acceptance : null,
          constraints: Array.isArray(params.constraints)
            ? params.constraints.filter((value): value is string => typeof value === "string")
            : [],
          priority: typeof params.priority === "string" ? params.priority as PlanItem["priority"] : "normal",
          dueAt: typeof params.dueAt === "string" ? params.dueAt : null,
          refs: normalizeRefsParam(params.refs),
          createdBy: "agent",
          createdByAgentId: plan.agentIdForSession(input.sessionId),
        }, { kind: "agent", id: plan.agentIdForSession(input.sessionId), sessionId: input.sessionId });
        createdByRun.set(input.runId, used + 1);
        return {
          content: `已建任务「${item.title}」（id ${item.id}，状态待开始）。用户会在计划看板上看到它。`,
          details: { item },
        };
      } catch (error) {
        const failure = describeFailure(error);
        if (failure) return failure;
        throw error;
      }
    },
  };

  const getTool: PiAgentRuntimeTool = {
    name: "plan_get",
    label: "读任务上下文",
    description: "读取一条任务的完整上下文（背景、验收标准、材料引用、历史与依赖）。认领前必须先调用。",
    parameters: {
      type: "object",
      properties: { itemId: { type: "string", description: "任务 id（plan_list 里的完整 id）" } },
      required: ["itemId"],
      additionalProperties: false,
    },
    promptSnippet: "读任务上下文",
    promptGuidelines: [
      "认领或改状态前先 plan_get，看清 acceptance / constraints / 历史里上次为什么没做完。",
      "材料只给了引用：需要正文时自己用 file_read / document_read 取，不要假装读过。",
    ],
    executionMode: "sequential",
    execute: async (input, params): Promise<PiAgentRuntimeToolResult> => {
      const itemId = typeof params.itemId === "string" ? params.itemId.trim() : "";
      if (!itemId) throw new Error("plan_get 参数 itemId 不能为空");
      try {
        const pkg = plan.claimPackage(itemId);
        if (input.workspaceId && pkg.item.workspaceId !== input.workspaceId) {
          return {
            content: "这条任务不属于当前空间，不能读取或认领。",
            details: { error: "plan_scope_mismatch" },
          };
        }
        return { content: formatPlanClaimPackage(pkg), details: { package: pkg } };
      } catch (error) {
        const failure = describeFailure(error);
        if (failure) return failure;
        throw error;
      }
    },
  };

  const claimTool: PiAgentRuntimeTool = {
    name: "plan_claim",
    label: "认领任务",
    description: "认领当前空间里的一条任务（拿租约并开始执行），返回完整认领包。",
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        note: { type: "string", description: "一句认领说明（会出现在卡片时间线）" },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
    promptSnippet: "认领计划任务",
    promptGuidelines: [
      "认领后就在本会话里干活；做完 plan_update(status=done, resultSummary)，做不完 plan_release 写原因。",
      `一次 run 最多认领 ${MAX_CLAIMS_PER_RUN} 条任务。`,
    ],
    executionMode: "sequential",
    execute: async (input, params): Promise<PiAgentRuntimeToolResult> => {
      const workspaceId = requireWorkspace(input.workspaceId);
      const itemId = typeof params.itemId === "string" ? params.itemId.trim() : "";
      if (!itemId) throw new Error("plan_claim 参数 itemId 不能为空");
      const used = claimedByRun.get(input.runId) ?? 0;
      if (used >= MAX_CLAIMS_PER_RUN) {
        return {
          content: `本次运行已经认领 ${used} 条任务，达到上限（${MAX_CLAIMS_PER_RUN}）。先做完再说。`,
          details: { error: "plan_claim_limit" },
        };
      }
      try {
        const agentId = plan.agentIdForSession(input.sessionId);
        const pkg = plan.claim(itemId, {
          workspaceId,
          sessionId: input.sessionId,
          agentId,
          note: typeof params.note === "string" ? params.note : null,
        });
        claimedByRun.set(input.runId, used + 1);
        return {
          content: `已认领（租约 ${pkg.contract.leaseTtlSec}s，写操作会自动续租）。\n\n${formatPlanClaimPackage(pkg)}`,
          details: { package: pkg },
        };
      } catch (error) {
        const failure = describeFailure(error);
        if (failure) return failure;
        throw error;
      }
    },
  };

  const updateTool: PiAgentRuntimeTool = {
    name: "plan_update",
    label: "更新任务进度",
    description: "更新任务状态、勾选检查项、写完成结论（resultSummary）或留一条进展说明。",
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        status: { type: "string", enum: ["todo", "doing", "done", "dropped"] },
        resultSummary: { type: "string", description: "完成结论：交付了什么、还有哪些缺口" },
        checklist: {
          type: "array",
          description: "替换整份检查项清单",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              done: { type: "boolean" },
            },
            required: ["text", "done"],
            additionalProperties: false,
          },
        },
        note: { type: "string", description: "一句进展说明（进时间线）" },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
    promptSnippet: "更新任务进度",
    promptGuidelines: [
      "标记 done 时必须写 resultSummary。",
      "只在有实质进展时更新，不要为每一步小动作刷时间线。",
    ],
    executionMode: "sequential",
    execute: async (input, params): Promise<PiAgentRuntimeToolResult> => {
      const itemId = typeof params.itemId === "string" ? params.itemId.trim() : "";
      if (!itemId) throw new Error("plan_update 参数 itemId 不能为空");
      const actor = { kind: "agent" as const, id: plan.agentIdForSession(input.sessionId), sessionId: input.sessionId };
      try {
        const current = plan.get(itemId);
        if (input.workspaceId && current.workspaceId !== input.workspaceId) {
          return { content: "这条任务不属于当前空间。", details: { error: "plan_scope_mismatch" } };
        }
        let item = current;
        if (typeof params.status === "string" && params.status !== current.status) {
          item = plan.move(itemId, {
            version: item.version,
            status: params.status as PlanItem["status"],
            resultSummary: typeof params.resultSummary === "string" ? params.resultSummary : null,
            reason: typeof params.note === "string" ? params.note : null,
          }, actor);
        }
        const patch: Parameters<PlanService["update"]>[1] = { version: item.version };
        let dirty = false;
        if (typeof params.resultSummary === "string") {
          patch.resultSummary = params.resultSummary;
          dirty = true;
        }
        if (typeof params.note === "string" && params.note.trim()) {
          patch.note = params.note.trim();
          dirty = true;
        }
        if (Array.isArray(params.checklist)) {
          patch.checklist = params.checklist
            .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
            .map((entry) => ({
              ...(typeof entry.id === "string" ? { id: entry.id } : {}),
              text: typeof entry.text === "string" ? entry.text : "",
              done: entry.done === true,
            }));
          dirty = true;
        }
        if (dirty) item = plan.update(itemId, patch, actor);
        return {
          content: `已更新「${item.title}」：状态 ${item.status}${item.resultSummary ? "，已写结论" : ""}。`,
          details: { item },
        };
      } catch (error) {
        const failure = describeFailure(error);
        if (failure) return failure;
        throw error;
      }
    },
  };

  const releaseTool: PiAgentRuntimeTool = {
    name: "plan_release",
    label: "放回任务",
    description: "干不下去时把任务放回「待开始」，并写清原因（下一位认领者会看到）。",
    parameters: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        reason: { type: "string", description: "为什么做不下去（缺什么、卡在哪）" },
      },
      required: ["itemId", "reason"],
      additionalProperties: false,
    },
    promptSnippet: "放回计划任务",
    promptGuidelines: ["做不完必须 plan_release 写原因，不要静默放弃。"],
    executionMode: "sequential",
    execute: async (input, params): Promise<PiAgentRuntimeToolResult> => {
      const itemId = typeof params.itemId === "string" ? params.itemId.trim() : "";
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      if (!itemId) throw new Error("plan_release 参数 itemId 不能为空");
      if (!reason) throw new Error("plan_release 参数 reason 不能为空");
      try {
        const item = plan.release(itemId, {
          reason,
          sessionId: input.sessionId,
          agentId: plan.agentIdForSession(input.sessionId),
        });
        return { content: `已放回「${item.title}」，原因已记入时间线。`, details: { item } };
      } catch (error) {
        const failure = describeFailure(error);
        if (failure) return failure;
        throw error;
      }
    },
  };

  return [listTool, getTool, claimTool, createTool, updateTool, releaseTool];
}
