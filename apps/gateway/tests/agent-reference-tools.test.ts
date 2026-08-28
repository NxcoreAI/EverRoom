import { describe, expect, it, vi } from "vitest";
import { createReferencedAgentConversationTools } from "../src/modules/agent/reference-tools.js";

const baseRun = {
  runId: "run-1",
  sessionId: "session-1",
  runtimeSessionRef: null,
  prompt: "基于这版改",
  pageLabel: "Agent",
  roomId: null,
};

describe("agent_conversation_query", () => {
  it("queries only the conversation referenced on the Main Agent run", async () => {
    const resolveReference = vi.fn(async () => "Login v1 history");
    const tool = createReferencedAgentConversationTools(resolveReference)[0]!;

    const result = await tool.execute({
      ...baseRun,
      referencedConversationId: "thread-login-v1",
    }, { query: "登录页做到哪一步" });

    expect(resolveReference).toHaveBeenCalledWith("thread-login-v1", "登录页做到哪一步");
    expect(result).toMatchObject({
      content: "Login v1 history",
      details: { conversationId: "thread-login-v1", readOnly: true },
    });
  });

  it("is unavailable when the user did not @ reference a conversation", async () => {
    const tool = createReferencedAgentConversationTools(async () => "history")[0]!;

    await expect(tool.execute(baseRun, { query: "context" }))
      .rejects.toThrow("referenced_agent_conversation_unavailable");
  });
});
