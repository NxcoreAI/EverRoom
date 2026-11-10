import { describe, expect, it } from "vitest";
import { wrapSessionManagerDroppingThinking } from "./index.js";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

function createStubManager() {
  const appended: Array<{ role?: string; content?: Array<{ type?: string }> }> = [];
  const manager = {
    appended,
    appendMessage(message: never) {
      appended.push(message as unknown as { role?: string; content?: Array<{ type?: string }> });
      return "entry-1";
    },
    buildSessionContext() {
      return {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "旧会话遗留思考" },
              { type: "toolCall", id: "tc-1" },
            ],
          },
          { role: "user", content: [{ type: "text", text: "hi" }] },
        ],
      };
    },
    appendCustomEntry() {
      return "custom-1";
    },
  };
  return manager as unknown as SessionManager & typeof manager;
}

describe("wrapSessionManagerDroppingThinking", () => {
  it("appendMessage 原地剥除 assistant 思考块", () => {
    const stub = createStubManager();
    const wrapped = wrapSessionManagerDroppingThinking(stub);
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "推理草稿" },
        { type: "text", text: "结论" },
        { type: "toolCall", id: "tc-1" },
      ],
    };
    wrapped.appendMessage(message as never);
    expect(stub.appended).toHaveLength(1);
    expect(message.content).toEqual([
      { type: "text", text: "结论" },
      { type: "toolCall", id: "tc-1" },
    ]);
    expect(stub.appended[0]).toBe(message);
  });

  it("纯思考的 assistant 消息保持原样", () => {
    const stub = createStubManager();
    const wrapped = wrapSessionManagerDroppingThinking(stub);
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "被打断的思考" }],
    };
    wrapped.appendMessage(message as never);
    expect(message.content).toEqual([{ type: "thinking", thinking: "被打断的思考" }]);
  });

  it("非 assistant 消息原样透传", () => {
    const stub = createStubManager();
    const wrapped = wrapSessionManagerDroppingThinking(stub);
    const message = { role: "user", content: [{ type: "text", text: "hi" }] };
    wrapped.appendMessage(message as never);
    expect(stub.appended[0]).toBe(message);
  });

  it("buildSessionContext 过滤旧会话中的思考块", () => {
    const stub = createStubManager();
    const wrapped = wrapSessionManagerDroppingThinking(stub);
    const context = wrapped.buildSessionContext() as unknown as {
      messages: Array<{ role: string; content: Array<{ type?: string }> }>;
    };
    expect(context.messages[0]!.content).toEqual([{ type: "toolCall", id: "tc-1" }]);
    expect(context.messages[1]!.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("其余方法正常委托", () => {
    const stub = createStubManager();
    const wrapped = wrapSessionManagerDroppingThinking(stub);
    expect(wrapped.appendCustomEntry("x", {})).toBe("custom-1");
  });
});
