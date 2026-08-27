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

export function createRoomOverviewAgentTools(service: RoomOverviewService): PiAgentRuntimeTool[] {
  const resolveRoomId = (input: { roomId?: string | null }, params: Record<string, unknown>): string => {
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
    description: "读取当前 Room 的权威总览、事实来源及已应用纠正。回答 Room 问题或提出纠正前调用。",
    parameters: Type.Object({ roomId: Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false }),
    execute: async (input, params) => {
      const roomId = resolveRoomId(input, params);
      const overview = service.get(roomId);
      const corrections = service.list(roomId).filter((item) => item.status === "applied");
      return { content: JSON.stringify({ overview, corrections }), details: { roomId, overview, corrections } };
    },
  };
  const propose: PiAgentRuntimeTool = {
    name: "context_room_correction_propose",
    label: "提出 Room 纠正",
    description: "把用户对当前 Room 的明确纠正整理成待确认 proposal。调用后必须向用户说明原内容、拟改内容和影响，并停止；不得在同一轮调用 apply。信息不足时先追问，不调用本工具。",
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
    description: "仅在用户当前消息明确确认某个既有 proposal 后调用。不能应用本轮刚创建的 proposal。",
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
  return [contextGet, propose, apply, revoke];
}
