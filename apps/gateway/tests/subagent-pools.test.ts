import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_SLIDES_DECK_CONCURRENCY,
  DEFAULT_SLIDES_MAX_CONCURRENT,
} from "../src/config.js";
import { resolvePoolLimit, subagentPoolOf } from "../src/modules/subagents/orchestrator.js";

/**
 * 并发分池：slides 系列（逐页布局/逐页审阅）与交互链路共用过一个窗口时，
 * 一册 15 页的 deck 会把窗口占满，context-room 之类的交互调用被拒。
 * 分池后两者互不挤占；未配置分池时行为与改造前完全一致（这是回归的关键）。
 */
describe("subagentPoolOf", () => {
  it("slides 前缀进 slides 池，其余进 default 池", () => {
    expect(subagentPoolOf("slides-layouter")).toBe("slides");
    expect(subagentPoolOf("slides-planner")).toBe("slides");
    // 影子/旁路作业单独一池：不参与交付，不能占着页级布局的窗口。
    expect(subagentPoolOf("slides-editor")).toBe("background");
    expect(subagentPoolOf("context-room")).toBe("default");
    expect(subagentPoolOf("doc-writer")).toBe("default");
    // 空串（awaitCapacity 未指定 agentId）不能意外落进 slides 池。
    expect(subagentPoolOf("")).toBe("default");
  });
});

describe("resolvePoolLimit", () => {
  it("未配置分池时，三口池都退化为 maxConcurrent（与改造前一致）", () => {
    expect(resolvePoolLimit({ maxConcurrent: 4 }, "slides")).toBe(4);
    expect(resolvePoolLimit({ maxConcurrent: 4 }, "default")).toBe(4);
    expect(resolvePoolLimit({ maxConcurrent: 4 }, "background")).toBe(4);
    expect(resolvePoolLimit({ maxConcurrent: 8 }, "slides")).toBe(8);
  });

  it("配置分池时各池取各自上限", () => {
    const config = { maxConcurrent: 26, slidesMaxConcurrent: 20, defaultMaxConcurrent: 4, backgroundMaxConcurrent: 2 };
    expect(resolvePoolLimit(config, "slides")).toBe(20);
    expect(resolvePoolLimit(config, "default")).toBe(4);
    expect(resolvePoolLimit(config, "background")).toBe(2);
  });

  it("池上限不得突破全池总上限", () => {
    // 误配：slides 池 32 > 全池 20 —— 以全池为准，否则总量失控。
    expect(resolvePoolLimit({ maxConcurrent: 20, slidesMaxConcurrent: 32 }, "slides")).toBe(20);
    // 只配了一个池时，另一个池仍退化到 maxConcurrent。
    expect(resolvePoolLimit({ maxConcurrent: 20, slidesMaxConcurrent: 16 }, "default")).toBe(20);
  });

  it("至少放行 1 个，不会把池压成 0 导致死锁", () => {
    expect(resolvePoolLimit({ maxConcurrent: 1, defaultMaxConcurrent: 0 }, "default")).toBe(1);
  });
});

/**
 * 页级并发窗口（NXCORE_SLIDES_DECK_CONCURRENCY）与各 agent 的 policy.maxConcurrency
 * 是两条独立的闸：页窗口只决定"同时发几个 dispatch"，单代理限额却会把超出的 dispatch
 * 直接硬拒（错误码 subagent_concurrency_limit，走秒级退避后抛错 → 该页落兜底版式）。
 * 2026-10-22 实测：页窗口从 8 提到 16 而 layouter 仍是 8，>8 页的册会掉兜底页。
 * 这条用例把"三者一致"变成可执行断言，防止再犯。
 */
describe("页级并发窗口与 agent 限额一致性", () => {
  const policyOf = (agent: string): { maxConcurrency: number } => {
    const path = fileURLToPath(new URL(`../../../agents/${agent}/agent.yaml`, import.meta.url));
    const parsed = parseYaml(readFileSync(path, "utf8")) as { policy?: { maxConcurrency?: number } };
    const maxConcurrency = parsed.policy?.maxConcurrency;
    expect(typeof maxConcurrency).toBe("number");
    return { maxConcurrency: maxConcurrency as number };
  };

  it("layouter 的单代理限额 ≥ 页级窗口，否则超出窗口的页会被秒拒并落兜底", () => {
    expect(policyOf("slides-layouter").maxConcurrency).toBeGreaterThanOrEqual(DEFAULT_SLIDES_DECK_CONCURRENCY);
  });

  it("layouter 的单代理限额不超过 slides 池容量（否则永远等不到空位）", () => {
    expect(policyOf("slides-layouter").maxConcurrency).toBeLessThanOrEqual(DEFAULT_SLIDES_MAX_CONCURRENT);
  });
});
