import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import { Type } from "@sinclair/typebox";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import type { MemoryService } from "../memory/service.js";
import type { RoomOverviewService } from "./overview-service.js";
import { buildRoomContextDigest } from "./room-context-digest.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function memoryToolErrorText(label: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${label}失败：${message}`;
}

/**
 * 注册给 context-room 子 Agent 的网关工具（SubagentRuntimeManager.registerAgentTools）。
 *
 * dispatch 子 Agent 的 Pi 配置由 SubagentRuntimeManager 从 backgroundPi 剥除
 * memory/knowledge/mcp 构建，因此检索能力在这里以显式工具提供：
 * - memory_search / conversation_search：复用 MemoryService（与主 Agent 记忆工具同源）。
 * - room_context_get：Room 信息、事实、来源、纠正与文档正文（查询体抽为共享投影
 *   room-context-digest.ts，与主 Agent room_analysis 的网关侧组装共用），供总览生成与简报再生成。
 * - room_task_create / room_schedule_create：总览再生后把「有明确动作 + 时间」的
 *   nextStep 落地为本地待办/日程（不回写第三方账号；幂等不重复）。
 */
export function createContextRoomAgentTools(deps: {
  db: GatewayDatabase;
  memory: MemoryService | null;
  overview: RoomOverviewService;
}): PiAgentRuntimeTool[] {
  const { db, memory, overview } = deps;

  const memorySearch: PiAgentRuntimeTool = {
    name: "memory_search",
    label: "记忆检索",
    description: "检索长期记忆（L1 原子记忆：用户偏好、事实、约束、决策）。整理 Room 前必须先用标题与描述调用。",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    }, { additionalProperties: false }),
    execute: async (_run, params) => {
      if (!memory?.enabled) {
        return { content: "记忆检索不可用（Memory 未配置）。", details: { count: 0, enabled: false } };
      }
      try {
        const { items } = await memory.searchAtomic(String(params.query ?? ""), Number(params.limit ?? 5));
        const text = items.length === 0
          ? "没有匹配的长期记忆。"
          : items.map((item) => `- ${item.content}${item.updatedAt ? `（${item.updatedAt}）` : ""}`).join("\n");
        return { content: text, details: { count: items.length } };
      } catch (error) {
        return {
          content: memoryToolErrorText("记忆检索", error),
          details: { count: 0 },
          isError: true,
        };
      }
    },
  };

  const conversationSearch: PiAgentRuntimeTool = {
    name: "conversation_search",
    label: "历史对话检索",
    description: "全文检索历史对话（L0 原始消息，跨会话）。整理 Room 前必须先用标题与描述调用。",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    }, { additionalProperties: false }),
    execute: async (_run, params) => {
      if (!memory?.enabled) {
        return { content: "历史对话检索不可用（Memory 未配置）。", details: { count: 0, enabled: false } };
      }
      try {
        const { messages } = await memory.searchConversations(String(params.query ?? ""), Number(params.limit ?? 5));
        const text = messages.length === 0
          ? "没有匹配的历史对话。"
          : messages.map((message) => `- ${message.role === "assistant" ? "助手" : "用户"}：${message.content}`).join("\n");
        return { content: text, details: { count: messages.length } };
      } catch (error) {
        return {
          content: memoryToolErrorText("历史对话检索", error),
          details: { count: 0 },
          isError: true,
        };
      }
    },
  };

  const roomContextGet: PiAgentRuntimeTool = {
    name: "room_context_get",
    label: "读取 Room 资料",
    description: "读取指定 Room 的信息、结构化事实、来源、已应用纠正，以及文档 Markdown 正文（超长截断）。用于总览生成与简报再生成。",
    parameters: Type.Object({
      roomId: Type.String({ minLength: 1, maxLength: 128 }),
    }, { additionalProperties: false }),
    execute: async (_run, params) => {
      const roomId = String(params.roomId ?? "").trim();
      if (!roomId) throw new Error("room_context_room_id_required");
      // 查询与预算截断逻辑在共享投影模块（room-context-digest.ts），
      // 与主 Agent room_analysis 的网关侧组装共用同一实现。
      const payload = buildRoomContextDigest(db, roomId);
      return {
        content: JSON.stringify(payload),
        details: { roomId, count: payload.documentCount, isRecord: isRecord(payload) },
      };
    },
  };

  const roomTaskCreate: PiAgentRuntimeTool = {
    name: "room_task_create",
    label: "创建 Room 本地待办",
    description: "在指定 Room 创建一条本地待办（不写入第三方账号）。总览再生后，把 nextSteps 中有明确动作的建议落地时调用；同名未完成待办已存在则不重复创建。",
    parameters: Type.Object({
      roomId: Type.String({ minLength: 1, maxLength: 128 }),
      title: Type.String({ minLength: 1, maxLength: 500 }),
      dueAt: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
      priority: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
      notes: Type.Optional(Type.Union([Type.String({ maxLength: 4_000 }), Type.Null()])),
    }, { additionalProperties: false }),
    execute: async (_run, params) => {
      try {
        const result = overview.createLocalAction(String(params.roomId), {
          kind: "task",
          title: String(params.title),
          ...(params.dueAt != null ? { dueAt: String(params.dueAt) } : {}),
          ...(params.priority != null ? { priority: String(params.priority) } : {}),
          ...(params.notes != null ? { notes: String(params.notes) } : {}),
        }, { createdBy: "agent" });
        return {
          content: result.duplicate
            ? `待办「${result.action.title}」已存在，未重复创建。`
            : `已创建本地待办「${result.action.title}」。`,
          details: { roomId: result.action.roomId, action: result.action, duplicate: result.duplicate },
        };
      } catch (error) {
        return { content: memoryToolErrorText("创建本地待办", error), details: { created: false }, isError: true };
      }
    },
  };

  const roomScheduleCreate: PiAgentRuntimeTool = {
    name: "room_schedule_create",
    label: "创建 Room 本地日程",
    description: "在指定 Room 创建一条本地日程（不写入第三方日历账号）。总览再生后，把 nextSteps 中有明确时间的事项落地时调用；startedAt 必须是可解析时间，同名日程已存在则不重复创建。",
    parameters: Type.Object({
      roomId: Type.String({ minLength: 1, maxLength: 128 }),
      title: Type.String({ minLength: 1, maxLength: 500 }),
      startedAt: Type.String({ minLength: 1, maxLength: 120 }),
      endAt: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
      allDay: Type.Optional(Type.Boolean()),
      location: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
      notes: Type.Optional(Type.Union([Type.String({ maxLength: 4_000 }), Type.Null()])),
    }, { additionalProperties: false }),
    execute: async (_run, params) => {
      try {
        const result = overview.createLocalAction(String(params.roomId), {
          kind: "schedule",
          title: String(params.title),
          startedAt: String(params.startedAt),
          ...(params.endAt != null ? { endAt: String(params.endAt) } : {}),
          ...(params.allDay === true ? { allDay: true } : {}),
          ...(params.location != null ? { location: String(params.location) } : {}),
          ...(params.notes != null ? { notes: String(params.notes) } : {}),
        }, { createdBy: "agent" });
        return {
          content: result.duplicate
            ? `日程「${result.action.title}」已存在，未重复创建。`
            : `已创建本地日程「${result.action.title}」（${result.action.startedAt ?? ""}）。`,
          details: { roomId: result.action.roomId, action: result.action, duplicate: result.duplicate },
        };
      } catch (error) {
        return { content: memoryToolErrorText("创建本地日程", error), details: { created: false }, isError: true };
      }
    },
  };

  return [memorySearch, conversationSearch, roomContextGet, roomTaskCreate, roomScheduleCreate];
}
