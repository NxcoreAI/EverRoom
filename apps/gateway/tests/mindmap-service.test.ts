import { describe, expect, it } from "vitest";
import { nextKickAction } from "../src/modules/knowledge/mindmap-service.js";

describe("nextKickAction", () => {
  it("无行：GET 与 ensure 都 kick（懒生成）", () => {
    expect(nextKickAction({ row: null, force: false, mode: "get" })).toBe("kick");
    expect(nextKickAction({ row: null, force: false, mode: "ensure" })).toBe("kick");
  });

  it("ready：默认 no-op，force 才重生成", () => {
    expect(nextKickAction({ row: { status: "ready" }, force: false, mode: "ensure" })).toBe("noop");
    expect(nextKickAction({ row: { status: "ready" }, force: false, mode: "get" })).toBe("noop");
    expect(nextKickAction({ row: { status: "ready" }, force: true, mode: "ensure" })).toBe("kick");
    expect(nextKickAction({ row: { status: "ready" }, force: true, mode: "get" })).toBe("kick");
  });

  it("pending/processing：no-op（生成中不重复派发）", () => {
    for (const status of ["pending", "processing"] as const) {
      expect(nextKickAction({ row: { status }, force: false, mode: "get" })).toBe("noop");
      expect(nextKickAction({ row: { status }, force: false, mode: "ensure" })).toBe("noop");
      expect(nextKickAction({ row: { status }, force: true, mode: "ensure" })).toBe("noop");
    }
  });

  it("failed：GET 不自动重试（失败态可见），ensure 重试", () => {
    expect(nextKickAction({ row: { status: "failed" }, force: false, mode: "get" })).toBe("noop");
    expect(nextKickAction({ row: { status: "failed" }, force: false, mode: "ensure" })).toBe("kick");
    expect(nextKickAction({ row: { status: "failed" }, force: true, mode: "get" })).toBe("noop");
  });
});
