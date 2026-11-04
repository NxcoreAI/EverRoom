import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { SlidesGenerationBudget, abortableItems } from "../src/modules/subagents/slides-generation-budget.js";
import { SlidesGenerationCheckpointStore } from "../src/modules/subagents/slides-generation-checkpoints.js";
import { arrangeBatchCheckpointKey } from "../src/modules/subagents/slides-arrange-batches.js";
import { SubagentResultCollector } from "../src/modules/subagents/runtime-manager.js";
import { createSlidesTreeResultValidator } from "../src/modules/subagents/slides-agent-tools.js";
import type { LoadedSubagentRevision } from "../src/modules/subagents/types.js";

afterEach(() => vi.useRealTimers());

describe("shared slides generation budget", () => {
  const limits = { maxDurationMs: 1000, maxTokens: 100, maxInvocations: 3 };
  it("counts cumulative usage once and shares tokens across planning, repair and review", () => {
    const budget = new SlidesGenerationBudget(limits);
    try {
      budget.claim("planner");
      budget.observeUsage("planner", { input: 20, output: 10 });
      budget.observeUsage("planner", { input: 20, output: 10 });
      budget.observeUsage("planner", { input: 10 });
      budget.claim("repair");
      budget.observeUsage("repair", { input: 15, output: 5, cacheRead: 10 });
      expect(budget.snapshot()).toMatchObject({ tokens: 60, invocations: 2 });
      budget.claim("review");
      budget.observeUsage("review", { input: 40 });
      expect(() => budget.check()).toThrow("slides_generation_token_budget_exceeded");
    } finally { budget.dispose(); }
  });

  it("restores consumed calls and allows reuse of one invocation without spending twice", () => {
    const budget = new SlidesGenerationBudget(limits);
    try {
      budget.restore({ elapsedMs: 100, tokens: 10, invocations: 2 });
      budget.claim("last");
      budget.claim("last");
      expect(budget.snapshot().invocations).toBe(3);
      expect(() => budget.claim("extra")).toThrow("slides_generation_invocation_budget_exceeded");
    } finally { budget.dispose(); }
  });

  it("enforces the remaining active duration after restore", () => {
    vi.useFakeTimers();
    const budget = new SlidesGenerationBudget(limits);
    budget.restore({ elapsedMs: 900, tokens: 0, invocations: 0 });
    vi.advanceTimersByTime(100);
    expect(budget.signal.aborted).toBe(true);
    expect(() => budget.check()).toThrow("slides_generation_time_budget_exceeded");
    budget.dispose();
  });

  it("defaults to no budget: token / call / wall-clock never abort a smoke-test run", () => {
    vi.useFakeTimers();
    const budget = new SlidesGenerationBudget();
    try {
      for (let index = 0; index < 200; index += 1) budget.claim(`inv-${index}`);
      budget.observeUsage("inv-0", { input: 1_500_000, output: 1_500_000 });
      budget.restore({ elapsedMs: 0, tokens: 2_000_000, invocations: 128 });
      vi.advanceTimersByTime(4 * 60 * 60_000);
      expect(budget.remainingMs()).toBe(Number.POSITIVE_INFINITY);
      expect(budget.snapshot()).toMatchObject({ tokens: 5_000_000, invocations: 328 });
      expect(budget.signal.aborted).toBe(false);
      expect(() => budget.check()).not.toThrow();
    } finally { budget.dispose(); }
  });

  it("accepts Infinity as an explicit no-limit marker", () => {
    const budget = new SlidesGenerationBudget({ maxDurationMs: Infinity, maxTokens: Infinity, maxInvocations: Infinity });
    try {
      budget.claim("planner");
      budget.observeUsage("planner", { input: 50_000_000 });
      expect(budget.remainingMs()).toBe(Number.POSITIVE_INFINITY);
      expect(() => budget.check()).not.toThrow();
    } finally { budget.dispose(); }
  });

  it("stops a stalled page producer immediately on parent cancellation", async () => {
    const parent = new AbortController();
    const budget = new SlidesGenerationBudget(limits, parent.signal);
    const source: AsyncIterable<number> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
    const reading = abortableItems(source, budget.signal).next();
    const assertion = expect(reading).rejects.toThrow("cancelled by user");
    parent.abort(new Error("cancelled by user"));
    await assertion;
    budget.dispose();
  });

  it("rejects an already exhausted restored token allowance", () => {
    const budget = new SlidesGenerationBudget(limits);
    expect(() => budget.restore({ elapsedMs: 0, tokens: 100, invocations: 1 }))
      .toThrow("slides_generation_token_budget_exceeded");
    budget.dispose();
  });
});

describe("durable slides generation checkpoints", () => {
  it("reopens a migrated SQLite database with batches, deck progress and consumed budget intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "slides-checkpoint-"));
    let database: ReturnType<typeof createDatabase> | undefined;
    try {
      const path = join(root, "gateway.sqlite");
      database = createDatabase(path, resolve("drizzle"));
      const first = new SlidesGenerationCheckpointStore(database.db);
      first.patch("generation", { batches: { "0": { title: "第一批", pages: [] } } });
      first.patch("generation", { deck: { fileEntryId: "deck", originalName: "deck.pptx", totalPages: 9, appliedPages: [0, 2] },
        budget: { elapsedMs: 120, tokens: 50, invocations: 3 } });
      database.sqlite.close();
      database = createDatabase(path, resolve("drizzle"));
      const resumed = new SlidesGenerationCheckpointStore(database.db);
      expect(resumed.read("generation")).toMatchObject({
        batches: { "0": { title: "第一批" } }, deck: { appliedPages: [0, 2] }, budget: { tokens: 50, invocations: 3 },
      });
      resumed.patch("generation", { batches: { "1": { title: "第二批" } } });
      expect(Object.keys(resumed.read("generation").batches)).toEqual(["0", "1"]);
      resumed.clear("generation");
      expect(resumed.read("generation")).toEqual({ batches: {} });
    } finally {
      database?.sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invalidates reuse when content, agent revision or model configuration changes", () => {
    const input = { roomId: "r", draftDocumentId: "d", instruction: "generate", sourcesHash: "content-a", batchSize: 8,
      generation: { revisions: ["rev-a"], model: "model-a" } };
    const key = arrangeBatchCheckpointKey(input);
    expect(arrangeBatchCheckpointKey({ ...input, sourcesHash: "content-b" })).not.toBe(key);
    expect(arrangeBatchCheckpointKey({ ...input, generation: { ...input.generation, revisions: ["rev-b"] } })).not.toBe(key);
    expect(arrangeBatchCheckpointKey({ ...input, generation: { ...input.generation, model: "model-b" } })).not.toBe(key);
  });
});

it("accepts a structured blocked submission for semantic pages and rejects incomplete or ambiguous submissions", async () => {
  const outputSchema = JSON.parse(readFileSync(resolve("../../agents/slides-layouter/schemas/output.schema.json"), "utf8"));
  const collector = new SubagentResultCollector();
  const tool = collector.createTool({ id: "rev", outputSchema } as LoadedSubagentRevision, createSlidesTreeResultValidator())!;
  const input = { runId: "blocked", sessionId: "s", runtimeSessionRef: null, prompt: "", pageLabel: "test", roomId: null };
  collector.prepare("rev", input.runId, { content: { blocks: [] } });
  const result = { status: "blocked", reason: "缺少图表来源", attempts: ["检查了给定素材"], requestedAction: "提供原始数据" };
  await expect(tool.execute(input, { status: "blocked" })).rejects.toThrow("subagent_result_schema_invalid");
  await expect(tool.execute(input, { ...result, tree: {} })).rejects.toThrow("subagent_result_schema_invalid");
  await expect(tool.execute(input, result)).resolves.toMatchObject({ details: { accepted: true } });
  expect(collector.take("rev", input.runId)).toEqual(result);
});
