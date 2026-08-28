import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import { Type } from "@sinclair/typebox";
import type { ProposeRoomContextCorrectionInput } from "@nxcore/agent-contract";
import type { RoomOverviewService } from "./overview-service.js";

const Section = Type.Union([
  Type.Literal("overview"), Type.Literal("status"), Type.Literal("next_steps"),
  Type.Literal("timeline"), Type.Literal("entities"),
]);
const Operation = Type.Union([
  Type.Literal("content_replace"), Type.Literal("content_add"), Type.Literal("content_suppress"),
  Type.Literal("fact_correct"), Type.Literal("fact_add"), Type.Literal("source_remove"),
  Type.Literal("source_reassign"),
]);
const CitationEdit = Type.Object({
  operation: Operation,
  section: Section,
  targetClaimId: Type.String({ minLength: 1, maxLength: 200 }),
  targetSource: Type.Optional(Type.Object({
    sourceKind: Type.String({ minLength: 1, maxLength: 100 }),
    sourceId: Type.String({ minLength: 1, maxLength: 256 }),
    sourceTitle: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  }, { additionalProperties: false })),
  targetRoomId: Type.Optional(Type.String({ maxLength: 128 })),
  originalText: Type.String({ minLength: 1, maxLength: 4_000 }),
  replacementText: Type.Optional(Type.String({ maxLength: 4_000 })),
  rationale: Type.Optional(Type.String({ maxLength: 2_000 })),
}, { additionalProperties: false });

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Fold the two argument shapes models produce for citation corrections back into
 * the canonical edits array: fields flattened onto the tool root for a single
 * edit, and a missing per-edit rationale (required by the service).
 */
function normalizeCitationEdits(params: Record<string, unknown>): Array<Record<string, unknown>> {
  const edits = [...params.edits as Array<Record<string, unknown>>];
  if (edits.length === 1) {
    const first = { ...edits[0]! };
    for (const key of ["originalText", "replacementText", "rationale"] as const) {
      const rootValue = nonEmptyText(params[key]);
      if (rootValue && !nonEmptyText(first[key])) first[key] = rootValue;
    }
    edits[0] = first;
  }
  return edits.map((edit) => ({
    ...edit,
    rationale: nonEmptyText(edit.rationale) ?? `引用纠正（${edit.section}/${edit.operation}）`,
  }));
}

export function createRoomOverviewAgentTools(service: RoomOverviewService): PiAgentRuntimeTool[] {  const resolveRoomId = (input: { roomId?: string | null }, params: Record<string, unknown>): string => {
    const requested = typeof params.roomId === "string" ? params.roomId.trim() : "";
    const value = input.roomId ?? requested;
    if (!value) throw new Error("ROOM_SELECTION_REQUIRED: Open or select a Context Room first");
    if (input.roomId && requested && requested !== input.roomId) {
      throw new Error("ROOM_SELECTION_MISMATCH: The correction target differs from the current Room");
    }
    return value;
  };
  const contextGet: PiAgentRuntimeTool = {
    name: "context_room_context_get",
    label: "读取 Room 总览上下文",
    description: "读取当前 Room 的权威总览、事实来源、已应用纠正，以及当前会话仍待确认的纠正 proposal。回答 Room 问题、提出纠正或处理用户确认前调用。",
    parameters: Type.Object({ roomId: Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false }),
    execute: async (input, params) => {
      const roomId = resolveRoomId(input, params);
      const overview = service.get(roomId);
      const corrections = service.list(roomId);
      const appliedCorrections = corrections.filter((item) => item.status === "applied");
      const pendingCorrections = corrections.filter((item) =>
        item.status === "proposed" && item.sessionId === input.sessionId);
      const payload = { overview, corrections: appliedCorrections, pendingCorrections };
      return { content: JSON.stringify(payload), details: { roomId, ...payload } };
    },
  };
  const regenerate: PiAgentRuntimeTool = {
    name: "context_room_overview_regenerate",
    label: "更新 Room 总览",
    description: "当用户要求根据当前 Room 已收录的最新资料更新、刷新或重新生成总览时调用。该操作直接重新生成并保存新版总览，不用于用户指定原文和替换文本的纠正。完成后如实说明总览已更新。",
    parameters: Type.Object({ roomId: Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false }),
    execute: async (input, params) => {
      const roomId = resolveRoomId(input, params);
      const overview = await service.regenerate(roomId);
      return {
        content: "Room 总览已根据当前资料重新生成并保存。",
        details: { roomId, overview },
      };
    },
  };
  const propose: PiAgentRuntimeTool = {
    name: "context_room_correction_propose",
    label: "提出 Room 纠正",
    description: "把用户对当前 Room 的明确纠正整理成待确认 proposal。只要已经形成具体的原内容和拟改内容，就必须先成功调用本工具，不能只在聊天正文中虚构提案。调用成功后说明改动并停止；不得在同一轮调用 apply。信息不足时先追问。",
    parameters: Type.Object({
      roomId: Type.Optional(Type.String({ maxLength: 128 })),
      operation: Operation,
      section: Section,
      targetClaimId: Type.Optional(Type.String({ maxLength: 200 })),
      targetSource: Type.Optional(Type.Object({
        sourceKind: Type.String({ minLength: 1, maxLength: 100 }),
        sourceId: Type.String({ minLength: 1, maxLength: 256 }),
        sourceTitle: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
      }, { additionalProperties: false })),
      targetRoomId: Type.Optional(Type.String({ maxLength: 128 })),
      originalText: Type.Optional(Type.String({ maxLength: 4_000 })),
      replacementText: Type.Optional(Type.String({ maxLength: 4_000 })),
      rationale: Type.String({ minLength: 1, maxLength: 2_000 }),
    }, { additionalProperties: false }),
    execute: async (input, params) => {
      const roomId = resolveRoomId(input, params);
      const proposalInput = {
        ...params,
        operation: params.operation,
        section: params.section,
        rationale: String(params.rationale),
        entryPoint: "agent",
      } as ProposeRoomContextCorrectionInput;
      const proposal = service.propose(roomId, proposalInput, { sessionId: input.sessionId, runId: input.runId });
      return {
        content: `已创建待确认纠正 ${proposal.id}。请向用户展示拟议改动并等待下一轮明确确认。`,
        details: { proposal, confirmationRequired: true },
      };
    },
  };
  const apply: PiAgentRuntimeTool = {
    name: "context_room_correction_apply",
    label: "应用已确认的 Room 纠正",
    description: "仅在用户当前消息明确确认 context_room_context_get 返回的当前会话既有 pendingCorrections 后调用，使用其中精确 proposal id。不能应用本轮刚创建的 proposal。",
    parameters: Type.Object({
      roomId: Type.Optional(Type.String({ maxLength: 128 })),
      proposalId: Type.String({ minLength: 1, maxLength: 200 }),
    }, { additionalProperties: false }),
    execute: async (input, params) => {
      const roomId = resolveRoomId(input, params);
      const result = service.apply(roomId, String(params.proposalId), { sessionId: input.sessionId, runId: input.runId });
      return { content: "纠正已应用，总览与后续 Agent 上下文已经更新。", details: result };
    },
  };
  const applyCitation: PiAgentRuntimeTool = {
    name: "context_room_correction_apply_citation",
    label: "直接应用引用的 Room 纠正",
    description: "仅用于用户从当前 Room 总览五个支持区块选中文本并附带评论的请求。先读取 Room 上下文，然后为引用上下文列出的每个 claim 在 edits 中提交一条独立编辑；跨 claim 的合并应替换保留的 claim 并 suppress 其余 claim。所有编辑会先统一校验，再以一个事务保存并应用；任一目标失效则整批不写入。无需再次向用户确认，不得用于没有选区引用的模糊纠正。",
    parameters: Type.Object({
      roomId: Type.Optional(Type.String({ maxLength: 128 })),
      edits: Type.Array(CitationEdit, { minItems: 1, maxItems: 20 }),
      // 容错声明：模型偶尔把单条 edit 的字段摊平到根参数上，声明后在 execute 归一回 edits[0]。
      originalText: Type.Optional(Type.String({ maxLength: 4_000 })),
      replacementText: Type.Optional(Type.String({ maxLength: 4_000 })),
      rationale: Type.Optional(Type.String({ maxLength: 2_000 })),
    }, { additionalProperties: false }),
    execute: async (input, params) => {
      const roomId = resolveRoomId(input, params);
      const correctionInputs = normalizeCitationEdits(params).map((edit) => ({
        ...edit,
        operation: edit.operation,
        section: edit.section,
        targetClaimId: String(edit.targetClaimId),
        originalText: String(edit.originalText),
        rationale: String(edit.rationale),
        entryPoint: "agent",
      })) as ProposeRoomContextCorrectionInput[];
      const result = service.applyCitations(roomId, correctionInputs, {
        sessionId: input.sessionId,
        runId: input.runId,
      });
      return {
        content: `已原子应用 ${result.corrections.length} 条引用纠正，总览与后续 Agent 上下文已经更新，无需再次确认。`,
        details: result,
      };
    },
  };
  const revoke: PiAgentRuntimeTool = {
    name: "context_room_correction_revoke",
    label: "撤销 Room 纠正",
    description: "仅在用户明确要求撤销某条已应用纠正时调用。",
    parameters: Type.Object({
      roomId: Type.Optional(Type.String({ maxLength: 128 })),
      correctionId: Type.String({ minLength: 1, maxLength: 200 }),
    }, { additionalProperties: false }),
    execute: async (input, params) => {
      const roomId = resolveRoomId(input, params);
      const result = service.revoke(roomId, String(params.correctionId));
      return { content: "纠正已撤销，总览已经重新生成。", details: result };
    },
  };
  const taskCreate: PiAgentRuntimeTool = {
    name: "context_room_task_create",
    label: "在当前 Room 创建本地待办",
    description: "在当前 Room 创建一条本地待办（不写入任何第三方账号）。用户明确要求记录待办、提醒，或你从 Room 资料中整理出有明确动作的待办时调用。同名未完成待办已存在则不会重复创建。完成后如实说明已记录。",
    parameters: Type.Object({
      roomId: Type.Optional(Type.String({ maxLength: 128 })),
      title: Type.String({ minLength: 1, maxLength: 500 }),
      dueAt: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
      priority: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
      notes: Type.Optional(Type.Union([Type.String({ maxLength: 4_000 }), Type.Null()])),
    }, { additionalProperties: false }),
    execute: async (input, params) => {
      const roomId = resolveRoomId(input, params);
      const result = service.createLocalAction(roomId, {
        kind: "task",
        title: String(params.title),
        ...(params.dueAt != null ? { dueAt: String(params.dueAt) } : {}),
        ...(params.priority != null ? { priority: String(params.priority) } : {}),
        ...(params.notes != null ? { notes: String(params.notes) } : {}),
      }, { createdBy: "agent", runId: input.runId });
      return {
        content: result.duplicate
          ? `待办「${result.action.title}」已存在，未重复创建。`
          : `已在 Room 创建本地待办「${result.action.title}」。`,
        details: { roomId, action: result.action, duplicate: result.duplicate, overview: result.overview },
      };
    },
  };
  const scheduleCreate: PiAgentRuntimeTool = {
    name: "context_room_schedule_create",
    label: "在当前 Room 创建本地日程",
    description: "在当前 Room 创建一条本地日程（不写入任何第三方日历账号）。用户明确要求记录日程、安排时间，或你从 Room 资料中整理出有明确时间的事项时调用；startedAt 必须是可解析的时间。同名日程已存在则不会重复创建。完成后如实说明已记录。",
    parameters: Type.Object({
      roomId: Type.Optional(Type.String({ maxLength: 128 })),
      title: Type.String({ minLength: 1, maxLength: 500 }),
      startedAt: Type.String({ minLength: 1, maxLength: 120 }),
      endAt: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
      allDay: Type.Optional(Type.Boolean()),
      location: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
      notes: Type.Optional(Type.Union([Type.String({ maxLength: 4_000 }), Type.Null()])),
    }, { additionalProperties: false }),
    execute: async (input, params) => {
      const roomId = resolveRoomId(input, params);
      const result = service.createLocalAction(roomId, {
        kind: "schedule",
        title: String(params.title),
        startedAt: String(params.startedAt),
        ...(params.endAt != null ? { endAt: String(params.endAt) } : {}),
        ...(params.allDay === true ? { allDay: true } : {}),
        ...(params.location != null ? { location: String(params.location) } : {}),
        ...(params.notes != null ? { notes: String(params.notes) } : {}),
      }, { createdBy: "agent", runId: input.runId });
      return {
        content: result.duplicate
          ? `日程「${result.action.title}」已存在，未重复创建。`
          : `已在 Room 创建本地日程「${result.action.title}」（${result.action.startedAt ?? ""}）。`,
        details: { roomId, action: result.action, duplicate: result.duplicate, overview: result.overview },
      };
    },
  };
  const taskComplete: PiAgentRuntimeTool = {
    name: "context_room_task_complete",
    label: "完成/恢复 Room 本地待办",
    description: "把当前 Room 的一条本地待办（待办面板可勾选的「助手待办」）标记为已完成，或把已完成改回未完成。仅在用户明确要求时调用；actionId 用 context_room_context_get 总览里 next_steps 中 itemType 为 task 且来源为 local-task 的 actionId。",
    parameters: Type.Object({
      roomId: Type.Optional(Type.String({ maxLength: 128 })),
      taskId: Type.String({ minLength: 1, maxLength: 128 }),
      completed: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    execute: async (input, params) => {
      const roomId = resolveRoomId(input, params);
      const result = service.completeLocalAction(roomId, String(params.taskId), params.completed !== false);
      return {
        content: `本地待办「${result.action.title}」已${result.action.completedAt ? "标记完成" : "恢复未完成"}。`,
        details: { roomId, action: result.action, overview: result.overview },
      };
    },
  };
  const actionDelete: PiAgentRuntimeTool = {
    name: "context_room_action_delete",
    label: "删除 Room 本地日程/待办",
    description: "删除当前 Room 的一条本地日程或待办（仅限来源为 local-schedule / local-task 的条目，连接器数据不可删）。仅在用户明确要求移除时调用。",
    parameters: Type.Object({
      roomId: Type.Optional(Type.String({ maxLength: 128 })),
      actionId: Type.String({ minLength: 1, maxLength: 128 }),
    }, { additionalProperties: false }),
    execute: async (input, params) => {
      const roomId = resolveRoomId(input, params);
      const result = service.deleteLocalAction(roomId, String(params.actionId));
      return {
        content: `本地条目「${result.action.title}」已删除。`,
        details: { roomId, action: result.action, overview: result.overview },
      };
    },
  };
  return [
    contextGet, regenerate, propose, apply, applyCitation, revoke,
    taskCreate, scheduleCreate, taskComplete, actionDelete,
  ];
}
