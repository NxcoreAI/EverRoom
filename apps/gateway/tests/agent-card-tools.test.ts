import { describe, expect, it, vi } from "vitest";
import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import { createAgentCardTools, type AgentCardRequester } from "../src/modules/agent/agent-card-tools.js";

const input: StartRuntimeRunInput = {
  runId: "run-cards",
  sessionId: "session-cards",
  runtimeSessionRef: null,
  prompt: "",
  pageLabel: "Agent",
  roomId: null,
};

describe("agent_confirm / agent_ask_user 工具", () => {
  it("confirm：用户点确认 → confirmed=true；取消带反馈文本", async () => {
    const requestCard = vi.fn(async (): Promise<{ choice: string; text?: string }> => ({ choice: "approved" }));
    const [confirm] = createAgentCardTools(requestCard as unknown as AgentCardRequester) as [ReturnType<typeof createAgentCardTools>[number]];
    const ok = JSON.parse((await confirm.execute(input, {
      title: "生成 8 页 BP",
      plan: ["读取材料", "写脚本", "生成并自查"],
    })).content) as { confirmed: boolean };
    expect(ok.confirmed).toBe(true);
    expect(requestCard).toHaveBeenCalledWith("run-cards", expect.objectContaining({ kind: "confirm", plan: ["读取材料", "写脚本", "生成并自查"] }));

    const deny = vi.fn(async () => ({ choice: "denied", text: "页数改成 5 页" })) as unknown as AgentCardRequester;
    const [confirm2] = createAgentCardTools(deny) as [ReturnType<typeof createAgentCardTools>[number]];
    const result = JSON.parse((await confirm2.execute(input, { title: "t", plan: ["a"] })).content) as { confirmed: boolean; feedback: string };
    expect(result.confirmed).toBe(false);
    expect(result.feedback).toBe("页数改成 5 页");
  });

  it("ask_user：选项作答与自由输入都回填 answer；缺 question 报错", async () => {
    const byOption = vi.fn(async () => ({ choice: "深色商务风" })) as unknown as AgentCardRequester;
    const [, ask] = createAgentCardTools(byOption) as [never, ReturnType<typeof createAgentCardTools>[number]];
    const r1 = JSON.parse((await ask.execute(input, {
      question: "PPT 用什么风格？",
      options: ["深色商务风", "浅色简约风"],
    })).content) as { answer: string };
    expect(r1.answer).toBe("深色商务风");

    const byText = vi.fn(async () => ({ choice: "", text: "偏向科技感" })) as unknown as AgentCardRequester;
    const [, ask2] = createAgentCardTools(byText) as [never, ReturnType<typeof createAgentCardTools>[number]];
    const r2 = JSON.parse((await ask2.execute(input, { question: "风格偏好？" })).content) as { answer: string };
    expect(r2.answer).toBe("偏向科技感");

    await expect(ask2.execute(input, { question: "  " })).rejects.toThrow("不能为空");
  });
});

describe('agent_confirm 设计决策载荷', () => {
  it('palette 规范化（补 #）+ fonts + notes 透传到卡片', async () => {
    const requestCard = vi.fn(async (): Promise<{ choice: string }> => ({ choice: 'approved' }))
    const requester = requestCard as unknown as AgentCardRequester & { mock: { calls: Array<[string, Record<string, unknown>]> } }
    const [confirm] = createAgentCardTools(requester) as [ReturnType<typeof createAgentCardTools>[number]]
    await confirm.execute(input, {
      title: '将生成 8 页 BP 演示文稿',
      plan: ['读取材料', '写脚本'],
      palette: ['#0B5FFF', '1C7293', 'F96167'],
      fonts: { heading: 'Microsoft YaHei', body: 'Microsoft YaHei' },
      notes: ['深色封面 + 浅色内容页'],
    })
    const card = requester.mock.calls[0]![1] as { palette?: string[]; fonts?: { heading?: string }; notes?: string[] }
    expect(card.palette).toEqual(['#0B5FFF', '#1C7293', '#F96167'])
    expect(card.fonts?.heading).toBe('Microsoft YaHei')
    expect(card.notes).toEqual(['深色封面 + 浅色内容页'])
  })
})
