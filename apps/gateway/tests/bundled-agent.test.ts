import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { SubagentOrchestrator } from "../src/modules/subagents/orchestrator.js";
import { SubagentRegistry } from "../src/modules/subagents/registry.js";
import { SubagentRuntimeManager } from "../src/modules/subagents/runtime-manager.js";
import { createSubagentPiTools } from "../src/modules/subagents/tools.js";

const temporaryDirectories: string[] = [];
const logger = { info: () => undefined, warn: () => undefined };

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("bundled project Agent", () => {
  it("is discovered by the main Agent catalog and can be dispatched", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "everroom-bundled-agent-"));
    temporaryDirectories.push(dataDir);
    const config = loadConfig([
      "--token",
      "0123456789abcdef",
      "--data-dir",
      dataDir,
      "--migrations-dir",
      resolve("drizzle"),
    ], {});
    const database = createDatabase(config.databasePath, config.migrationsDir);
    const framework = config.subagents!;
    const registry = new SubagentRegistry(database.db, framework, {}, logger);
    await registry.initialize();
    const runtimeManager = new SubagentRuntimeManager(config, framework);
    const orchestrator = new SubagentOrchestrator(
      database.db,
      framework,
      registry,
      runtimeManager,
      logger,
    );
    orchestrator.initialize();

    const catalog = createSubagentPiTools(registry, orchestrator)
      .find((tool) => tool.name === "agent_catalog")!;
    const catalogResult = await catalog.execute({
      runId: "main-run",
      sessionId: "main-session",
      runtimeSessionRef: null,
      prompt: "catalog",
      pageLabel: "Main Agent",
      roomId: null,
    }, {});
    expect(JSON.parse(catalogResult.content)).toMatchObject({
      agents: [expect.objectContaining({
        id: "content-analyst",
        name: "Content Analyst",
      })],
    });

    const analysisTool = createSubagentPiTools(registry, orchestrator)
      .find((tool) => tool.name === "content_analysis")!;
    const analysisResult = await analysisTool.execute({
      runId: "main-run",
      sessionId: "main-session",
      runtimeSessionRef: null,
      prompt: "分析材料",
      pageLabel: "Main Agent",
      roomId: null,
    }, {
      task: "分析这段材料并提炼事实与风险",
      content: "项目已经上线，但缺少回滚方案。",
    });
    expect(JSON.parse(analysisResult.content)).toMatchObject({
      agentId: "content-analyst",
      status: "completed",
    });

    const invocation = await orchestrator.dispatch({
      agentId: "content-analyst",
      task: "分析材料并提炼结论",
      input: { content: "EverRoom 已把 Agent Bundle 放入项目并随应用打包。" },
      idempotencyKey: "bundled-content-analyst",
      source: "primary_agent",
      parentSessionId: "main-session",
      parentRunId: "main-run",
    });
    expect(invocation).toMatchObject({
      agentDefinitionId: "content-analyst",
      status: "completed",
    });
    expect(invocation.result?.text).toContain("Fake Runtime");

    await orchestrator.dispose();
    database.sqlite.close();
  }, 15_000);
});
