import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(registry.get("multimodal-document-parser")?.revision.outputSchema).toMatchObject({
      required: expect.arrayContaining(["summary", "facts", "missingFields"]),
    });

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
      agents: expect.arrayContaining([
        expect.objectContaining({
          id: "content-analyst",
          name: "Content Analyst",
        }),
        expect.objectContaining({
          id: "multimodal-document-parser",
          name: "Multimodal Document Parser",
        }),
      ]),
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

    const analysisWithFileTool = createSubagentPiTools(registry, orchestrator, {
      resolveFileMarkdown: async (fileId) => fileId === "file-1" ? "文件中记录了待办事项。" : null,
    }).find((tool) => tool.name === "content_analysis")!;
    const analysisWithFileResult = await analysisWithFileTool.execute({
      runId: "main-file-run",
      sessionId: "main-session",
      runtimeSessionRef: null,
      prompt: "分析文件",
      pageLabel: "Main Agent",
      roomId: null,
    }, {
      task: "提取文件中的待办事项",
      fileId: "file-1",
      context: "只关注可执行事项",
      sourceLabel: "example.md",
    });
    expect(JSON.parse(analysisWithFileResult.content)).toMatchObject({
      agentId: "content-analyst",
      status: "completed",
    });

    const dispatch = vi.fn().mockResolvedValue({
      id: "document-invocation",
      agentDefinitionId: "multimodal-document-parser",
      status: "completed",
      result: {
        text: JSON.stringify({ summary: "这是一份季度经营报告。" }),
        structuredOutput: {
          summary: "这是一份季度经营报告。",
          facts: [{ key: "主题", value: "季度经营", evidenceRefs: ["block-1"] }],
          missingFields: [],
        },
      },
      errorMessage: null,
    });
    const documentAnalysisTool = createSubagentPiTools(
      registry,
      { dispatch } as unknown as SubagentOrchestrator,
    ).find((tool) => tool.name === "document_analysis")!;
    const documentAnalysisResult = await documentAnalysisTool.execute({
      runId: "main-document-run",
      sessionId: "main-session",
      runtimeSessionRef: null,
      prompt: "这个文档写了什么？",
      pageLabel: "Main Agent",
      roomId: null,
    }, {
      fileEntryId: "file-report",
      fileVersionId: "fver-report-v1",
      question: "这个文档写了什么？",
      localeHint: "zh-CN",
    });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "multimodal-document-parser",
      input: expect.objectContaining({
        fileEntryId: "file-report",
        fileVersionId: "fver-report-v1",
        question: "这个文档写了什么？",
        privacyPolicy: "local_only",
      }),
      parentRunId: "main-document-run",
    }));
    expect(JSON.parse(documentAnalysisResult.content)).toMatchObject({
      status: "completed",
      summary: "这是一份季度经营报告。",
      facts: [{ key: "主题", value: "季度经营", evidenceRefs: ["block-1"] }],
      missingFields: [],
      outputFormat: "structured",
    });

    const proseDispatch = vi.fn().mockResolvedValue({
      id: "document-prose-invocation",
      agentDefinitionId: "multimodal-document-parser",
      status: "completed",
      result: { text: "文档解析完成。李展萍就读于示例大学，学籍状态为在籍。" },
      errorMessage: null,
    });
    const proseTool = createSubagentPiTools(
      registry,
      { dispatch: proseDispatch } as unknown as SubagentOrchestrator,
    ).find((tool) => tool.name === "document_analysis")!;
    const proseResult = await proseTool.execute({
      runId: "main-document-prose-run",
      sessionId: "main-session",
      runtimeSessionRef: null,
      prompt: "这份文档写了什么？",
      pageLabel: "Main Agent",
      roomId: null,
    }, {
      fileEntryId: "file-student",
      fileVersionId: "fver-student-v1",
      question: "这份文档写了什么？",
    });
    expect(JSON.parse(proseResult.content)).toMatchObject({
      status: "completed",
      summary: null,
      facts: null,
      missingFields: null,
      outputFormat: null,
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
