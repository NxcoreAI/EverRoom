import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MemoryCoreClient } from "./client.js";

export const MEMORY_TOOL_NAMES = ["memory_search", "conversation_search"] as const;

/**
 * 注册给 pi agent 的两个记忆工具。
 * 均为只读检索，3s 超时，失败返回错误文本由模型自行决定后续。
 */
export function createMemoryTools(
  client: MemoryCoreClient,
  getCurrentSessionId: () => string | undefined,
): ToolDefinition[] {
  const memorySearch = defineTool({
    name: "memory_search",
    label: "记忆检索",
    description:
      "检索长期记忆（L1 原子记忆：用户偏好、事实、约束、决策）。当用户提及过去的偏好、决定或之前讨论过的内容，而当前上下文中没有时调用。",
    parameters: Type.Object({
      query: Type.String({ description: "检索关键词或问题" }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "返回条数，默认 5" })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const items = await client.searchAtomic(params.query, params.limit ?? 5);
        const text = items.length === 0
          ? "没有匹配的长期记忆。"
          : items.map((item) => {
              const date = item.updated_at?.slice(0, 10) ?? "";
              const background = item.background ? `（${item.background}）` : "";
              return `- ${item.content}${background}${date ? ` [${date}]` : ""}`;
            }).join("\n");
        return { content: [{ type: "text", text }], details: { count: items.length } };
      } catch (error) {
        return {
          content: [{ type: "text", text: `记忆检索失败：${String(error)}` }],
          details: { count: 0 },
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
