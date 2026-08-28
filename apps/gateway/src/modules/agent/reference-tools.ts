import { Type } from "@sinclair/typebox";
import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";

export function createReferencedAgentConversationTools(
  resolveReference: (threadId: string, query: string) => Promise<string | null>,
): PiAgentRuntimeTool[] {
  return [{
    name: "agent_conversation_query",
    label: "Query referenced Agent conversation",
    description: "查询用户本轮通过 @ 引用的历史 Agent 会话。它是只读上下文子 Agent，不直接与用户对话；需要理解‘这版’‘之前的实现’等指代时调用，并由 Main Agent 基于结果回复用户。",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 4_000 }),
    }, { additionalProperties: false }),
    execute: async (run, params) => {
      if (!run.referencedConversationId) throw new Error("referenced_agent_conversation_unavailable");
      const query = String(params.query ?? "").trim();
      if (!query) throw new Error("referenced_agent_conversation_query_required");
      const context = await resolveReference(run.referencedConversationId, query);
      if (!context) throw new Error("referenced_agent_conversation_unavailable");
      return {
        content: context,
        details: { conversationId: run.referencedConversationId, readOnly: true },
      };
    },
  }];
}
