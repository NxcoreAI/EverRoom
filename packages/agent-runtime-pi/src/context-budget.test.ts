import { describe, expect, it } from "vitest";
import {
  clampToolResultText,
  estimateContextChars,
  estimateContextTokens,
  guardRunMessages,
  pruneToolHistory,
} from "./context-budget.js";

describe("clampToolResultText", () => {
  it("未超预算时原样返回", () => {
    expect(clampToolResultText("hello", 10)).toBe("hello");
  });

  it("普通文本超预算时保留前缀并标注截断", () => {
    const text = "x".repeat(500);
    const clamped = clampToolResultText(text, 100);
    expect(clamped.length).toBeLessThanOrEqual(100);
    expect(clamped).toContain("截断");
  });

  it("JSON 结果优先缩短长字符串字段并保持可解析", () => {
    const text = JSON.stringify({
      markdown: "m".repeat(20_000),
      title: "短标题",
      blocks: [{ blockId: "b1", text: "ok" }],
    });
    const clamped = clampToolResultText(text, 4_000);
    expect(clamped.length).toBeLessThanOrEqual(4_000);
    const parsed = JSON.parse(clamped) as Record<string, unknown>;
    expect(parsed.title).toBe("短标题");
    expect(Array.isArray(parsed.blocks)).toBe(true);
    expect(String(parsed.markdown)).toContain("截断");
  });

  it("JSON 仍超预算时退化为带预览的截断对象", () => {
    const text = JSON.stringify(Array.from({ length: 2_000 }, (_, index) => ({ index, text: "v".repeat(200) })));
    const clamped = clampToolResultText(text, 2_000);
    expect(clamped.length).toBeLessThanOrEqual(2_000);
    expect(JSON.parse(clamped)).toMatchObject({ truncated: true });
  });

  it("预算为 0/非法时不截断", () => {
    const text = "x".repeat(10);
    expect(clampToolResultText(text, 0)).toBe(text);
    expect(clampToolResultText(text, Number.NaN)).toBe(text);
  });
});

describe("pruneToolHistory", () => {
  function toolTurn(index: number, resultChars: number) {
    return [
      {
        role: "assistant",
        content: [
          { type: "text", text: `轮 ${index}` },
          { type: "toolCall", id: `call-${index}`, name: "document_read", arguments: { big: "a".repeat(2_000) } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: `call-${index}`,
        toolName: "document_read",
        content: [{ type: "text", text: "r".repeat(resultChars) }],
        isError: false,
      },
    ];
  }

  it("工具轮不超过保留数时原样返回", () => {
    const messages = [{ role: "user", content: "任务" }, ...toolTurn(1, 100), ...toolTurn(2, 100)];
    expect(pruneToolHistory(messages, { triggerTokens: 1, keepRecentTurns: 4 })).toBe(messages);
  });

  it("只裁剪最近 N 轮之前的工具结果与参数，消息数量/顺序/配对不变", () => {
    const messages = [
      { role: "user", content: "任务" },
      ...toolTurn(1, 5_000),
      ...toolTurn(2, 5_000),
      ...toolTurn(3, 5_000),
      ...toolTurn(4, 5_000),
    ];
    const pruned = pruneToolHistory(messages, { triggerTokens: 1, keepRecentTurns: 2 }) as Array<Record<string, unknown>>;
    expect(pruned).toHaveLength(messages.length);
    // 最近两轮保持原文
    const recent = pruned.slice(-4) as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(recent[0]!.content[1]!.arguments).toMatchObject({ big: expect.stringContaining("a") });
    expect(recent[1]!.content[0]!.text).toContain("rrrr");
    // 更早两轮：结果变占位、参数清空
    const older = pruned.slice(1, 5) as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(older[0]!.content[1]!.arguments).toEqual({});
    expect(String(older[1]!.content[0]!.text)).toContain("已省略");
  });

  it("guardRunMessages 未超阈值时不裁剪", () => {
    const messages = [{ role: "user", content: "短任务" }];
    expect(guardRunMessages(messages, { triggerTokens: 1_000, keepRecentTurns: 2 })).toBe(messages);
  });

  it("guardRunMessages 超阈值时按轮次裁剪", () => {
    const messages = [{ role: "user", content: "任务" }, ...toolTurn(1, 5_000), ...toolTurn(2, 5_000), ...toolTurn(3, 5_000)];
    const guarded = guardRunMessages(messages, { triggerTokens: 100, keepRecentTurns: 1 }) as Array<Record<string, unknown>>;
    expect(guarded[1]!.role).toBe("assistant");
    expect((guarded[1]!.content as Array<Record<string, unknown>>)[1]!.arguments).toEqual({});
  });

  it("estimateContextChars 统计文本、思考、工具参数与图片", () => {
    const chars = estimateContextChars([
      { role: "user", content: "abc" },
      { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(10) }, { type: "toolCall", id: "c", name: "t", arguments: { a: "b" } }] },
      { role: "toolResult", content: [{ type: "text", text: "r".repeat(5) }, { type: "image", data: "" }] },
    ]);
    expect(chars).toBeGreaterThan(3 + 10 + 5 + 4_800);
  });

  it("estimateContextTokens 对中文按字计，不再用 chars/4 低估一半", () => {
    const message = { role: "toolResult", content: [{ type: "text", text: "中".repeat(2_000) }] };
    expect(estimateContextChars([message]) / 4).toBe(500);
    expect(estimateContextTokens([message])).toBe(1_200);
    // ASCII 口径与 pi 的 chars/4 保持一致。
    expect(estimateContextTokens([{ role: "toolResult", content: [{ type: "text", text: "r".repeat(2_000) }] }])).toBe(500);
  });

  it("guardRunMessages 优先采用 provider 真实 usage：小消息但真实用量超标也裁剪", () => {
    const messages = [{ role: "user", content: "短任务" }, ...toolTurn(1, 100), ...toolTurn(2, 100), ...toolTurn(3, 100)];
    // chars/4 估算只有 ~100 token，真实 usage 报 5,000：必须按真实 usage 触发。
    const guarded = guardRunMessages(messages, { triggerTokens: 1_000, keepRecentTurns: 1 }, 5_000) as Array<Record<string, unknown>>;
    expect(guarded).not.toBe(messages);
    expect((guarded[1]!.content as Array<Record<string, unknown>>)[1]!.arguments).toEqual({});
  });

  it("guardRunMessages 采用 provider 真实 usage：真实用量未超标时不做字符估算误裁", () => {
    const messages = [{ role: "user", content: "任务" }, ...toolTurn(1, 5_000), ...toolTurn(2, 5_000), ...toolTurn(3, 5_000)];
    expect(guardRunMessages(messages, { triggerTokens: 1_000, keepRecentTurns: 1 }, 900)).toBe(messages);
  });

  it("estimateContextTokens 兜底：中文内容在 chars/4 未过阈值时也能触发裁剪", () => {
    const cjkTurn = (index: number) => [
      { role: "assistant", content: [{ type: "text", text: `轮 ${index}` }, { type: "toolCall", id: `call-${index}`, name: "doc", arguments: { big: "中".repeat(100) } }] },
      { role: "toolResult", toolCallId: `call-${index}`, toolName: "doc", content: [{ type: "text", text: "中".repeat(2_000) }], isError: false },
    ];
    const messages = [{ role: "user", content: "任务" }, ...cjkTurn(1), ...cjkTurn(2), ...cjkTurn(3)];
    // chars/4 ≈ 1,500 < 2,000；CJK 感知估算 ≈ 3,900 > 2,000。
    expect((estimateContextChars(messages) / 4)).toBeLessThan(2_000);
    const guarded = guardRunMessages(messages, { triggerTokens: 2_000, keepRecentTurns: 1 });
    expect(guarded).not.toBe(messages);
  });
});
