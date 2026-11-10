import { describe, expect, it } from "vitest";
import { resolveSubagentReasoning, resolveSubagentRuntimeBase } from "../src/modules/subagents/runtime-manager.js";

/**
 * 推理档位解算：实测单页 165s 里 98% 是模型推理（工具只占 4s），
 * 想继续压时长只能动推理量。这条通路让「medium vs low」的 A/B 不必改 agent.yaml，
 * 而缺省不设时必须与改造前完全一致——这是本测试的重点。
 */
describe("resolveSubagentReasoning", () => {
  it("缺省不设时沿用全局档位，slides 与非 slides 一视同仁", () => {
    expect(resolveSubagentReasoning({ agentId: "slides-layouter", fallback: "medium" })).toBe("medium");
    expect(resolveSubagentReasoning({ agentId: "context-room", fallback: "medium" })).toBe("medium");
  });

  it("bundle 自己的 policy.model.reasoning 最优先", () => {
    expect(resolveSubagentReasoning({
      policyReasoning: "high",
      agentId: "slides-layouter",
      slidesOverride: "low",
      fallback: "medium",
    })).toBe("high");
  });

  it("env 覆盖只作用于 slides-*，不影响交互链路", () => {
    expect(resolveSubagentReasoning({
      agentId: "slides-layouter",
      slidesOverride: "low",
      fallback: "medium",
    })).toBe("low");
    expect(resolveSubagentReasoning({
      agentId: "slides-planner",
      slidesOverride: "low",
      fallback: "medium",
    })).toBe("low");
    // 交互链路保持全局档位：context-room 的体验不该被 PPT 的 A/B 牵连。
    expect(resolveSubagentReasoning({
      agentId: "context-room",
      slidesOverride: "low",
      fallback: "medium",
    })).toBe("medium");
  });

  it("全局也没有档位时返回 undefined（交给 runtime 缺省）", () => {
    expect(resolveSubagentReasoning({ agentId: "slides-layouter" })).toBeUndefined();
  });
});

/**
 * 模型底座解算：布局代理与主 Agent 共用主模型——主模型已具备视觉能力，布局自审
 * 直接看渲染图；不再有独立的 vlm 槽。其余子代理仍走 background（成本档）。
 */
describe("resolveSubagentRuntimeBase", () => {
  const pi = { provider: "openai", model: "text-main", baseUrl: "http://relay/v1", apiKey: "k", api: "openai-completions" } as never;
  const backgroundPi = { provider: "openai", model: "text-bg", baseUrl: "http://relay/v1", apiKey: "k", api: "openai-completions" } as never;

  it("布局代理使用主模型，与主 Agent 同底座", () => {
    expect(resolveSubagentRuntimeBase({ agentId: "slides-layouter", backgroundPi, pi })).toBe(pi);
  });

  it("其余子代理仍走 background，不被布局口径串味", () => {
    expect(resolveSubagentRuntimeBase({ agentId: "slides-planner", backgroundPi, pi })).toBe(backgroundPi);
    expect(resolveSubagentRuntimeBase({ agentId: "context-room", backgroundPi, pi })).toBe(backgroundPi);
  });

  it("主模型缺失时布局回退 background；background 缺失时其余子代理回退主模型", () => {
    expect(resolveSubagentRuntimeBase({ agentId: "slides-layouter", backgroundPi })).toBe(backgroundPi);
    expect(resolveSubagentRuntimeBase({ agentId: "slides-planner", pi })).toBe(pi);
  });

  it("全缺返回 null（交给调用方报错）", () => {
    expect(resolveSubagentRuntimeBase({ agentId: "slides-layouter" })).toBeNull();
    expect(resolveSubagentRuntimeBase({ agentId: "slides-planner" })).toBeNull();
  });
});
