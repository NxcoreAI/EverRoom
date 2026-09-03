import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MemoryCoreClient } from "./client.js";
import { formatAtomicLine } from "./format.js";
import type { MemoryAtomicItem } from "./types.js";

export const MEMORY_TOOL_NAMES = ["memory_search", "conversation_search"] as const;

/**
 * Room 绑定记忆检索 provider（gateway 注入，读 room_memory_attributions 快照）。
 * 返回 MemoryAtomicItem 形状以便与全局检索共用 formatAtomicLine。
 */
export type RoomMemorySearch = (
  roomId: string,
  query: string,
  limit: number,
) => Promise<MemoryAtomicItem[]>;

/**
 * 注册给 pi agent 的两个记忆工具。
 * 均为只读检索，3s 超时，失败返回错误文本由模型自行决定后续。
 */
export function createMemoryTools(
  client: MemoryCoreClient,
  getCurrentSessionId: () => string | undefined,
  roomSearch?: RoomMemorySearch,
): ToolDefinition[] {
  const memorySearch = defineTool({
    name: "memory_search",
    label: "记忆检索",
    description:
      "检索长期记忆（L1 原子记忆：用户偏好、事实、约束、决策）。当用户提及过去的偏好、决定或之前讨论过的内容，而当前上下文中没有时调用。可按时间范围圈定（如\"上周的决定\"、\"八月以来的记录\"）。传 room_id 时仅在该 Context Room 的绑定记忆（用户甄选集合）中检索；不传则全局检索。",
    parameters: Type.Object({
      query: Type.String({ description: "检索关键词或问题" }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "返回条数，默认 5" })),
      room_id: Type.Optional(Type.String({
        description: "仅在指定 Context Room 的绑定记忆中检索；缺省全局检索",
      })),
      time_start: Type.Optional(Type.String({
        description: "时间范围下界（ISO 8601，含端点，如 2026-08-01T00:00:00Z）；按记忆更新时间过滤",
      })),
      time_end: Type.Optional(Type.String({
        description: "时间范围上界（ISO 8601，含端点）；按记忆更新时间过滤",
      })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const limit = params.limit ?? 5;
        const hasRange = params.time_start !== undefined || params.time_end !== undefined;
        let items: MemoryAtomicItem[];
        if (params.room_id !== undefined) {
          if (!roomSearch) {
            return {
              content: [{ type: "text", text: "Room 记忆过滤未配置（room_memory provider 缺失），请改为全局检索。" }],
              details: { count: 0, roomId: params.room_id },
              isError: true,
            };
          }
          items = await roomSearch(params.room_id, params.query, limit);
          // 快照检索无服务端时间过滤，在此按更新时间本地圈定。
          if (hasRange) {
            items = items.filter((item) =>
              (!params.time_start || item.updated_at >= params.time_start)
              && (!params.time_end || item.updated_at <= params.time_end));
          }
        } else {
          items = await client.searchAtomic(
            params.query,
            limit,
            hasRange ? { start: params.time_start, end: params.time_end } : undefined,
          );
        }
        const text = items.length === 0
          ? params.room_id !== undefined
            ? "该 Room 没有匹配的绑定记忆（可去掉 room_id 改为全局检索）。"
            : "没有匹配的长期记忆。"
          : items.map(formatAtomicLine).join("\n");
        return {
          content: [{ type: "text", text }],
          details: { count: items.length, roomId: params.room_id ?? null },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `记忆检索失败：${String(error)}` }],
          details: { count: 0, roomId: params.room_id ?? null },
          isError: true,
        };
      }
    },
  });

  const conversationSearch = defineTool({
    name: "conversation_search",
    label: "历史对话检索",
    description:
      "全文检索历史对话（L0 原始消息，跨会话）。用于找回“之前说过什么”、恢复过去的讨论上下文。",
    parameters: Type.Object({
      query: Type.String({ description: "检索关键词" }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "返回条数，默认 5" })),
      current_session_only: Type.Optional(Type.Boolean({
        description: "仅检索当前会话；默认跨全部会话检索",
      })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const sessionId = params.current_session_only ? getCurrentSessionId() : undefined;
        const hits = await client.searchConversation(params.query, params.limit ?? 5, sessionId);
        const text = hits.length === 0
          ? "没有匹配的历史对话。"
          : hits.map((hit) => {
              const date = hit.timestamp?.slice(0, 16).replace("T", " ") ?? "";
              return `- [${hit.role}${date ? ` ${date}` : ""}] ${hit.content}`;
            }).join("\n");
        return { content: [{ type: "text", text }], details: { count: hits.length } };
      } catch (error) {
        return {
          content: [{ type: "text", text: `历史对话检索失败：${String(error)}` }],
          details: { count: 0 },
          isError: true,
        };
      }
    },
  });

  return [memorySearch, conversationSearch];
}
