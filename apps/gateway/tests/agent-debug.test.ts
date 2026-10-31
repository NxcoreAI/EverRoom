import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStatusSnapshot, SubagentInvocation } from "@nxcore/agent-contract";
import type { AgentRuntime, AgentRuntimeDescription } from "@nxcore/agent-runtime";
import type { GatewayConfig } from "../src/config.js";
import { createDatabase, type GatewayDatabase } from "../src/infrastructure/database/client.js";
import {
  agentEvents,
  agentRuns,
  agentSessions,
  subagentDefinitions,
  subagentInvocationEvents,
  subagentInvocations,
  subagentRevisions,
} from "../src/infrastructure/database/schema.js";
import type { BuiltinAgentBundle } from "../src/modules/agent/builtin-bundles.js";
import type { AgentDefinition, AgentResolver } from "../src/modules/agent/resolver.js";
import type { AgentStatusService } from "../src/modules/agent/status-service.js";
import { AgentDebugService } from "../src/modules/agent-debug/service.js";
import { agentDebugRoutes } from "../src/modules/agent-debug/routes.js";
import type { AgentDebugUsageRecord } from "../src/modules/agent-debug/types.js";
import { AgentDebugUsageStore } from "../src/modules/agent-debug/usage-store.js";
import type { SubagentOrchestrator } from "../src/modules/subagents/orchestrator.js";
import type { SubagentRegistry } from "../src/modules/subagents/registry.js";
import type { LoadedSubagentDefinition } from "../src/modules/subagents/types.js";

/**
 * Agent 调试面板网关层（/v1/agent-debug/*）单测：service/routes 全部 stub，不建库；
 * 仅 usage-store 用一次临时 SQLite（迁移 + 直插数据）验证查询与事件聚合。
 * 固化「能力字段以 runtime.describe() 的实际装配为准，而不是 agent.yaml 声明」、
 * 「响应绝不含 apiKey / MCP headers」以及 usage 的 limit 夹取与 totals 语义。
 */

const temporaryDirectories: string[] = [];
const openDatabases: Array<ReturnType<typeof createDatabase>> = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) database.sqlite.close();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const MAIN_DEFINITION: AgentDefinition = {
  id: "main",
  name: "主 Agent",
  description: "处理用户对话",
  configDirectory: "/tmp/main",
  kind: "builtin",
};

const DOC_WRITER_DEFINITION: AgentDefinition = {
  id: "doc-writer",
  name: "Document Writer",
  description: "承接文档正文生成",
  configDirectory: "/tmp/doc-writer",
  kind: "developer",
};

/** 静态 bundle：声明了 slides_create/slides_edit，但 runtime 并未装配这些工具。 */
const MAIN_BUNDLE: BuiltinAgentBundle = {
  id: "main",
  name: "Main Agent",
  description: "bundle description（不应覆盖 registration）",
  runtime: "pi",
  systemPrompt: "BUNDLE SYSTEM PROMPT",
  capabilities: ["conversation.respond", "slides.create"],
  tools: ["document_list", "slides_create", "slides_edit"],
  skills: ["./skills/document-export"],
  skillPrompts: { "document-export": "BUNDLE SKILL BODY" },
  directory: "/agents/main",
};

const MAIN_DESCRIPTION: AgentRuntimeDescription = {
  runtimeId: "pi:main",
  model: {
    provider: "bailian",
    model: "qwen-max",
    baseUrl: "https://ai.example.test/v1",
    api: "openai-completions",
    reasoning: "medium",
    temperature: 0.3,
    maxTokens: 8192,
    contextWindow: 128_000,
  },
  role: "user-facing",
  systemPrompt: "RUNTIME SYSTEM PROMPT",
  skills: [{ name: "document-export", prompt: "RUNTIME SKILL BODY" }],
  tools: [
    { name: "document_list", label: "List documents", description: "列出文档" },
    { name: "connector_query", label: "Query", description: "查询连接器" },
  ],
  builtinTools: ["read", "bash"],
  mcpServers: ["everroom-connectors"],
  promptGuidelines: ["guideline-1"],
  limits: { maxToolCallsPerRun: null, maxToolResultChars: null, runContextGuard: null },
  capabilities: { streaming: true, reasoning: true, tools: true, steering: true, resume: false },
};

const MAIN_RUNTIME = {
  id: "pi",
  describe: async () => MAIN_DESCRIPTION,
  getCapabilities: async () => MAIN_DESCRIPTION.capabilities,
} as unknown as AgentRuntime;

/** 子 Agent 的 runtime 不提供 describe：走 revision/config 回退分支。 */
const DOC_WRITER_RUNTIME = {
  id: "pi",
  getCapabilities: async () => ({ streaming: true, reasoning: false, tools: true, steering: false, resume: false }),
} as unknown as AgentRuntime;

const CONFIG: Pick<GatewayConfig, "pi" | "litePi" | "cursorCompletionPi" | "backgroundPi" | "webSearch"> = {
  pi: null,
  litePi: null,
  cursorCompletionPi: null,
  backgroundPi: {
    provider: "bailian",
    model: "qwen-plus",
    baseUrl: "https://background.example.test/v1",
    apiKey: "sk-background-secret",
    api: "openai-completions",
    maxTokens: 4096,
    contextWindow: 128_000,
    temperature: 0.3,
    reasoning: "medium",
    sessionsDir: "/tmp/sessions",
    workingDirectory: "/tmp/workspace",
    agentDirectory: "/tmp/config",
  },
  webSearch: null,
};

const STATUS_SNAPSHOT: AgentStatusSnapshot = {
  generatedAt: "2026-10-29T08:00:00.000Z",
  summary: { total: 2, running: 2, idle: 0, error: 0 },
  agents: [{
    agentId: "main",
    name: "主 Agent",
    description: "处理用户对话",
    kind: "builtin",
    state: "running",
    activeRunCount: 1,
    workspace: { id: "agent://main", isolation: "dedicated", revisionId: null },
    currentRun: {
      id: "run-current",
      task: "写周报",
      pageLabel: "办公室",
      status: "running",
      startedAt: "2026-10-29T07:58:00.000Z",
      completedAt: null,
    },
    lastRun: {
      id: "run-last",
      task: "改标题",
      pageLabel: "文档",
      status: "completed",
      startedAt: "2026-10-29T07:00:00.000Z",
      completedAt: "2026-10-29T07:01:00.000Z",
    },
    updatedAt: "2026-10-29T07:59:00.000Z",
  }, {
    // 子 Agent 的 currentRun 由 AgentStatusService 从 invocation 折成同一形状。
    agentId: "doc-writer",
    name: "Document Writer",
    description: "承接文档正文生成",
    kind: "developer",
    state: "running",
    activeRunCount: 1,
    workspace: { id: "agent://doc-writer", isolation: "dedicated", revisionId: "rev-1" },
    currentRun: {
      id: "inv-3",
      task: "续写第二段",
      pageLabel: null,
      status: "accepted",
      startedAt: null,
      completedAt: null,
    },
    lastRun: {
      id: "inv-2",
      task: "写一段开头",
      pageLabel: null,
      status: "completed",
      startedAt: "2026-10-29T07:10:01.000Z",
      completedAt: "2026-10-29T07:11:00.000Z",
    },
    updatedAt: "2026-10-29T07:12:05.000Z",
  }],
};

const SUBAGENT_DEFINITION = {
  id: "doc-writer",
  name: "Document Writer",
  description: "承接文档正文生成",
  enabled: true,
  currentRevisionId: "rev-1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  revision: {
    id: "rev-1",
    agentDefinitionId: "doc-writer",
    version: 3,
    digest: "digest-1",
    createdAt: "2026-10-01T00:00:00.000Z",
    manifest: {
      schemaVersion: 1,
      id: "doc-writer",
      name: "Document Writer",
      description: "承接文档正文生成",
      enabled: true,
      mode: "dispatch_only",
      promptPath: "./SYSTEM.md",
      skills: ["./skills/draft-create"],
      mcp: [{ server: "everroom-connectors", includeTools: ["*"] }],
      inputSchemaPath: null,
      outputSchemaPath: null,
      policy: { allowedCallers: ["primary-agent"], maxConcurrency: 2, timeoutMs: 600_000, maxToolCalls: 24 },
    },
    systemPrompt: "REVISION SYSTEM PROMPT",
    agentDirectory: "/tmp/subagents/revisions/digest-1/agent",
    // 注册的 MCP 配置可能带 headers/token：调试端点只允许暴露服务器名。
    mcpServers: { "everroom-connectors": { headers: { authorization: "Bearer mcp-secret-token" } } },
    policy: {
      allowedCallers: ["primary-agent"],
      maxConcurrency: 2,
      timeoutMs: 600_000,
      maxToolCalls: 24,
      model: { maxTokens: 2048 },
    },
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  },
} as unknown as LoadedSubagentDefinition;

const INVOCATIONS: SubagentInvocation[] = [
  {
    id: "inv-2",
    agentDefinitionId: "doc-writer",
    agentRevisionId: "rev-1",
    source: "primary_agent",
    parentSessionId: null,
    parentRunId: null,
    task: "写一段开头",
    input: null,
    status: "completed",
    result: null,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-10-29T07:10:00.000Z",
    startedAt: "2026-10-29T07:10:01.000Z",
    completedAt: "2026-10-29T07:11:00.000Z",
  },
  {
    id: "inv-1",
    agentDefinitionId: "slides-builder",
    agentRevisionId: "rev-x",
    source: "scheduler",
    parentSessionId: null,
    parentRunId: null,
    task: "其它子代理的调用",
    input: null,
    status: "completed",
    result: null,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-10-29T07:00:00.000Z",
    startedAt: null,
    completedAt: null,
  },
  {
    id: "inv-3",
    agentDefinitionId: "doc-writer",
    agentRevisionId: "rev-1",
    source: "primary_agent",
    parentSessionId: null,
    parentRunId: null,
    task: "续写第二段",
    input: null,
    status: "accepted",
    result: null,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-10-29T07:12:00.000Z",
    startedAt: null,
    completedAt: null,
  },
];

function createService(
  usage?: Pick<AgentDebugUsageStore, "listRuns" | "listInvocations">,
): AgentDebugService {
  const resolver = {
    list: () => [MAIN_DEFINITION, DOC_WRITER_DEFINITION],
    getDefinition: (agentId: string) => {
      const definition = [MAIN_DEFINITION, DOC_WRITER_DEFINITION].find(({ id }) => id === agentId);
      if (!definition) throw new Error(`Agent is not registered: ${agentId}`);
      return definition;
    },
    resolve: (agentId: string) => (agentId === "main" ? MAIN_RUNTIME : DOC_WRITER_RUNTIME),
  } as unknown as AgentResolver;
  return new AgentDebugService({
    config: CONFIG,
    resolver,
    statuses: { snapshot: () => STATUS_SNAPSHOT } as unknown as Pick<AgentStatusService, "snapshot">,
    subagents: {
      get: (agentId: string) => (agentId === "doc-writer" ? SUBAGENT_DEFINITION : null),
    } as unknown as Pick<SubagentRegistry, "get">,
    invocations: {
      listInvocations: () => INVOCATIONS,
    } as unknown as Pick<SubagentOrchestrator, "listInvocations">,
    usage: usage ?? {
      listRuns: () => [],
      listInvocations: () => [],
    },
    loadBundle: (id) => {
      if (id === "main") return MAIN_BUNDLE;
      throw new Error(`bundle is missing: ${id}`);
    },
  });
}

describe("AgentDebugService", () => {
  it("列表摘要来自注册信息 + 运行时装配（kind 映射 builtin/subagent）", async () => {
    const response = await createService().listAgents();

    expect(response.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(response.agents.map(({ id }) => id)).toEqual(["main", "doc-writer"]);

    const main = response.agents[0]!;
    expect(main).toEqual({
      id: "main",
      kind: "builtin",
      // registration 的名字（bundle 的 "Main Agent" 不覆盖）。
      name: "主 Agent",
      description: "处理用户对话",
      runtime: "pi",
      runtimeRole: "user-facing",
      model: "bailian/qwen-max",
      state: "running",
      activeRunCount: 1,
      // 来自 AgentStatusService.snapshot().currentRun，内置 Agent 无 source。
      currentRun: {
        id: "run-current",
        task: "写周报",
        status: "running",
        startedAt: "2026-10-29T07:58:00.000Z",
        completedAt: null,
        pageLabel: "办公室",
        source: null,
      },
      // 2 个自定义工具 + 2 个 pi 内置工具；bundle 声明的 slides_create 不算。
      toolCount: 4,
      skillCount: 1,
      revisionId: null,
      updatedAt: "2026-10-29T07:59:00.000Z",
    });

    const docWriter = response.agents[1]!;
    expect(docWriter).toMatchObject({
      kind: "subagent",
      name: "Document Writer",
      runtime: "pi",
      runtimeRole: null,
      // runtime 无 describe 时回退 backgroundPi 档位 + policy.model 覆盖。
      model: "bailian/qwen-plus",
      state: "running",
      activeRunCount: 1,
      toolCount: 0,
      skillCount: 1,
      revisionId: "rev-1",
      updatedAt: "2026-10-29T07:12:05.000Z",
    });
    // 子 Agent 的 currentRun 同形映射；accepted 折成 running，pageLabel 为 null。
    expect(docWriter.currentRun).toEqual({
      id: "inv-3",
      task: "续写第二段",
      status: "running",
      startedAt: null,
      completedAt: null,
      pageLabel: null,
      source: null,
    });
  });

  it("内置 Agent 详情以 describe() 为准，不使用 agent.yaml 声明的工具/能力", async () => {
    const response = await createService().getAgent("main");
    expect(response).not.toBeNull();
    const { agent } = response!;

    expect(agent.systemPrompt).toBe("RUNTIME SYSTEM PROMPT");
    expect(agent.systemPrompt).not.toContain("BUNDLE");
    expect(agent.tools).toEqual([
      { name: "document_list", label: "List documents", description: "列出文档", source: "custom" },
      { name: "connector_query", label: "Query", description: "查询连接器", source: "custom" },
      { name: "read", label: null, description: null, source: "builtin" },
      { name: "bash", label: null, description: null, source: "builtin" },
    ]);
    // agent.yaml 里声明的 slides_create/slides_edit 未参与装配，不能出现在「实际工具」里。
    expect(agent.tools.map(({ name }) => name)).not.toContain("slides_create");
    expect(agent.skills).toEqual([
      { name: "document-export", path: "./skills/document-export", prompt: "RUNTIME SKILL BODY" },
    ]);
    expect(agent.mcpServers).toEqual(["everroom-connectors"]);
    expect(agent.promptGuidelines).toEqual(["guideline-1"]);
    expect(agent.modelInfo).toEqual(MAIN_DESCRIPTION.model);
    expect(agent.capabilities).toEqual(MAIN_DESCRIPTION.capabilities);
    expect(agent.limits).toEqual({
      maxToolCallsPerRun: null,
      maxToolResultChars: null,
      runContextGuard: null,
    });
    expect(agent.policy).toBeNull();
    expect(agent.subagent).toBeNull();
    // run 活动来自 AgentStatusService.snapshot()：当前 run 在前，内置 Agent 无 source。
    expect(agent.recentActivity).toEqual([
      {
        id: "run-current",
        task: "写周报",
        status: "running",
        startedAt: "2026-10-29T07:58:00.000Z",
        completedAt: null,
        pageLabel: "办公室",
        source: null,
      },
      {
        id: "run-last",
        task: "改标题",
        status: "completed",
        startedAt: "2026-10-29T07:00:00.000Z",
        completedAt: "2026-10-29T07:01:00.000Z",
        pageLabel: "文档",
        source: null,
      },
    ]);
  });

  it("子 Agent 详情回退 revision：systemPrompt/policy/mcp，Skill 只给路径不内联正文", async () => {
    const response = await createService().getAgent("doc-writer");
    expect(response).not.toBeNull();
    const { agent } = response!;

    expect(agent.systemPrompt).toBe("REVISION SYSTEM PROMPT");
    expect(agent.skills).toEqual([
      { name: "draft-create", path: "./skills/draft-create", prompt: null },
    ]);
    expect(agent.mcpServers).toEqual(["everroom-connectors"]);
    expect(agent.policy).toEqual({
      allowedCallers: ["primary-agent"],
      maxConcurrency: 2,
      timeoutMs: 600_000,
      maxToolCalls: 24,
      model: { maxTokens: 2048 },
    });
    expect(agent.subagent).toMatchObject({
      revisionId: "rev-1",
      version: 3,
      digest: "digest-1",
      agentDirectory: "/tmp/subagents/revisions/digest-1/agent",
      skills: ["./skills/draft-create"],
      mcp: [{ server: "everroom-connectors", includeTools: ["*"], excludeTools: null }],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    });
    expect(agent.modelInfo).toMatchObject({
      provider: "bailian",
      model: "qwen-plus",
      maxTokens: 2048,
      contextWindow: 128_000,
    });
    // 无 describe 时用 revision.policy.maxToolCalls 作预算回退。
    expect(agent.limits).toEqual({
      maxToolCallsPerRun: 24,
      maxToolResultChars: null,
      runContextGuard: null,
    });
    // 最近调用只取本 agent 的前 5 条，pageLabel 恒 null，source 透传。
    expect(agent.recentActivity).toEqual([
      {
        id: "inv-2",
        task: "写一段开头",
        status: "completed",
        startedAt: "2026-10-29T07:10:01.000Z",
        completedAt: "2026-10-29T07:11:00.000Z",
        pageLabel: null,
        source: "primary_agent",
      },
      {
        id: "inv-3",
        task: "续写第二段",
        // accepted（尚未开跑）折叠为 running。
        status: "running",
        startedAt: null,
        completedAt: null,
        pageLabel: null,
        source: "primary_agent",
      },
    ]);
  });

  it("响应绝不含 apiKey 与 MCP headers", async () => {
    const service = createService();
    const payload = JSON.stringify({
      list: await service.listAgents(),
      main: await service.getAgent("main"),
      docWriter: await service.getAgent("doc-writer"),
    });

    expect(payload).not.toContain("sk-background-secret");
    expect(payload).not.toContain("mcp-secret-token");
    expect(payload).not.toContain("apiKey");
    expect(payload).not.toContain("authorization");
  });
});

/** usage 记录测试数据：默认一条已完成的 run。 */
function usageRecord(overrides: Partial<AgentDebugUsageRecord> & { id: string }): AgentDebugUsageRecord {
  return {
    kind: "run",
    sessionId: "session-1",
    sessionTitle: "季度总结",
    task: "写周报",
    status: "completed",
    roomId: null,
    pageLabel: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    toolCalls: 0,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    error: null,
    source: null,
    revisionId: null,
    ...overrides,
  };
}

describe("AgentDebugService usage", () => {
  it("内置 Agent 走 listRuns，子 Agent 走 listInvocations，totals 按该批记录求和", async () => {
    const runRecords = [
      usageRecord({ id: "run-2", status: "running", toolCalls: 1 }),
      usageRecord({ id: "run-1", inputTokens: 120, outputTokens: 30, cacheReadTokens: 10 }),
    ];
    const invocationRecords = [
      usageRecord({
        id: "inv-1",
        kind: "invocation",
        source: "primary_agent",
        revisionId: "rev-1",
        inputTokens: 200,
        outputTokens: 50,
      }),
    ];
    const listRuns = vi.fn((_agentId: string, _limit: number) => runRecords);
    const listInvocations = vi.fn((_agentId: string, _limit: number) => invocationRecords);
    const service = createService({ listRuns, listInvocations });

    const builtin = await service.usage("main", 20);
    expect(listRuns).toHaveBeenCalledWith("main", 20);
    expect(listInvocations).not.toHaveBeenCalled();
    expect(builtin).not.toBeNull();
    expect(builtin!.agentId).toBe("main");
    expect(builtin!.records).toEqual(runRecords);
    // 无 usage 的记录按 0 计入（不是 null 传染）。
    expect(builtin!.totals).toEqual({ runs: 2, inputTokens: 120, outputTokens: 30 });
    expect(builtin!.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const subagent = await service.usage("doc-writer", 20);
    expect(listInvocations).toHaveBeenCalledWith("doc-writer", 20);
    expect(subagent).toMatchObject({
      agentId: "doc-writer",
      records: invocationRecords,
      totals: { runs: 1, inputTokens: 200, outputTokens: 50 },
    });
  });

  it("limit 夹取到 1..100（非法值回落缺省 20）", async () => {
    const listRuns = vi.fn((_agentId: string, _limit: number) => []);
    const service = createService({ listRuns, listInvocations: () => [] });

    await service.usage("main", 500);
    await service.usage("main", 0);
    await service.usage("main", Number.NaN);
    await service.usage("main", 42);

    expect(listRuns.mock.calls.map(([, limit]) => limit)).toEqual([100, 1, 20, 42]);
  });

  it("未知 agent 返回 null 且不查库", async () => {
    const listRuns = vi.fn((_agentId: string, _limit: number) => []);
    const listInvocations = vi.fn((_agentId: string, _limit: number) => []);
    const service = createService({ listRuns, listInvocations });

    await expect(service.usage("unknown-agent", 20)).resolves.toBeNull();
    expect(listRuns).not.toHaveBeenCalled();
    expect(listInvocations).not.toHaveBeenCalled();
  });
});

describe("agentDebugRoutes", () => {
  it("GET /v1/agent-debug/agents 返回摘要列表", async () => {
    const app = Fastify();
    await app.register(agentDebugRoutes(createService()));

    const response = await app.inject({ method: "GET", url: "/v1/agent-debug/agents" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { agents: Array<{ id: string }>; generatedAt: string };
    expect(body.agents.map(({ id }) => id)).toEqual(["main", "doc-writer"]);
    expect(body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await app.close();
  });

  it("GET /v1/agent-debug/agents/:id 返回详情，未知 id 404", async () => {
    const app = Fastify();
    await app.register(agentDebugRoutes(createService()));

    const detail = await app.inject({ method: "GET", url: "/v1/agent-debug/agents/main" });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      agent: { id: "main", systemPrompt: "RUNTIME SYSTEM PROMPT" },
    });

    const missing = await app.inject({ method: "GET", url: "/v1/agent-debug/agents/unknown-agent" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: "not_found",
      message: "Unknown Agent: unknown-agent",
    });

    await app.close();
  });

  it("GET /v1/agent-debug/agents/:id/usage 透传记录、默认 limit 20、未知 id 404", async () => {
    const records = [usageRecord({ id: "run-1", inputTokens: 7 })];
    const listRuns = vi.fn((_agentId: string, _limit: number) => records);
    const app = Fastify();
    await app.register(agentDebugRoutes(createService({ listRuns, listInvocations: () => [] })));

    const response = await app.inject({ method: "GET", url: "/v1/agent-debug/agents/main/usage" });
    expect(response.statusCode).toBe(200);
    expect(listRuns).toHaveBeenCalledWith("main", 20);
    expect(response.json()).toMatchObject({
      agentId: "main",
      records,
      totals: { runs: 1, inputTokens: 7, outputTokens: 0 },
    });

    const limited = await app.inject({ method: "GET", url: "/v1/agent-debug/agents/main/usage?limit=5" });
    expect(limited.statusCode).toBe(200);
    expect(listRuns).toHaveBeenCalledWith("main", 5);

    // TypeBox 在入口就拒绝越界 limit（服务层另有夹取，双保险）。
    const tooLarge = await app.inject({ method: "GET", url: "/v1/agent-debug/agents/main/usage?limit=101" });
    expect(tooLarge.statusCode).toBe(400);

    const missing = await app.inject({ method: "GET", url: "/v1/agent-debug/agents/nope/usage" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not_found", message: "Unknown Agent: nope" });

    await app.close();
  });
});

/* ── usage-store：临时 SQLite（真实迁移 + 直插数据） ───────────────────── */

async function createUsageDatabase(): Promise<GatewayDatabase> {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-agent-debug-usage-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  openDatabases.push(database);
  return database.db;
}

function seedUsageDatabase(db: GatewayDatabase): void {
  db.insert(agentSessions).values({
    id: "session-1",
    roomId: "room-1",
    pageLabel: "办公室",
    runtimeId: "pi:main",
    activeAgentId: "main",
    title: "季度总结",
    status: "idle",
  }).run();
  db.insert(agentRuns).values([
    {
      id: "run-completed",
      sessionId: "session-1",
      agentId: "main",
      idempotencyKey: "key-1",
      prompt: "写周报",
      roomId: "room-1",
      status: "completed",
      startedAt: new Date("2026-10-29T07:00:00.000Z"),
      completedAt: new Date("2026-10-29T07:00:10.000Z"),
      createdAt: new Date("2026-10-29T07:00:00.000Z"),
    },
    {
      id: "run-running",
      sessionId: "session-1",
      agentId: "main",
      idempotencyKey: "key-2",
      prompt: "继续写",
      status: "running",
      startedAt: new Date(Date.now() - 5_000),
      completedAt: null,
      createdAt: new Date("2026-10-29T07:04:00.000Z"),
    },
    {
      id: "run-accepted",
      sessionId: "session-1",
      agentId: "main",
      idempotencyKey: "key-3",
      prompt: "被接受的请求",
      status: "accepted",
      startedAt: null,
      completedAt: null,
      createdAt: new Date("2026-10-29T07:05:00.000Z"),
    },
    {
      id: "run-other-agent",
      sessionId: "session-1",
      agentId: "main-lite",
      idempotencyKey: "key-4",
      prompt: "别的档位",
      status: "completed",
      startedAt: new Date("2026-10-29T07:06:00.000Z"),
      completedAt: new Date("2026-10-29T07:06:01.000Z"),
      createdAt: new Date("2026-10-29T07:06:00.000Z"),
    },
  ]).run();
  db.insert(agentEvents).values([
    { id: "ev-run-1", sessionId: "session-1", runId: "run-completed", seq: 1, type: "tool.started", payload: { name: "document_list" } },
    { id: "ev-run-2", sessionId: "session-1", runId: "run-completed", seq: 2, type: "tool.started", payload: { name: "document_read" } },
    {
      id: "ev-run-3",
      sessionId: "session-1",
      runId: "run-completed",
      seq: 3,
      type: "message.completed",
      payload: { role: "assistant", content: "ok", usage: { input: 120, output: 30, cacheRead: 10, cacheWrite: 5 } },
    },
    { id: "ev-run-4", sessionId: "session-1", runId: "run-running", seq: 1, type: "tool.started", payload: { name: "file_read" } },
    // 别的 Agent 的事件不能混入 main 的聚合。
    {
      id: "ev-run-5",
      sessionId: "session-1",
      runId: "run-other-agent",
      seq: 1,
      type: "message.completed",
      payload: { usage: { input: 999, output: 999, cacheRead: 999 } },
    },
  ]).run();

  db.insert(subagentDefinitions).values([
    { id: "doc-writer", name: "Document Writer", description: "写作", enabled: true, currentRevisionId: "rev-1" },
    { id: "slides-builder", name: "Slides Builder", description: "落页", enabled: true, currentRevisionId: "rev-2" },
  ]).run();
  db.insert(subagentRevisions).values([
    {
      id: "rev-1",
      agentDefinitionId: "doc-writer",
      version: 1,
      digest: "digest-1",
      manifest: {},
      systemPrompt: "prompt",
      agentDirectory: "/tmp/subagents/rev-1",
      mcpServers: {},
      policy: {},
    },
    {
      id: "rev-2",
      agentDefinitionId: "slides-builder",
      version: 1,
      digest: "digest-2",
      manifest: {},
      systemPrompt: "prompt",
      agentDirectory: "/tmp/subagents/rev-2",
      mcpServers: {},
      policy: {},
    },
  ]).run();
  db.insert(subagentInvocations).values([
    {
      id: "inv-completed",
      agentDefinitionId: "doc-writer",
      agentRevisionId: "rev-1",
      source: "primary_agent",
      idempotencyKey: "inv-key-1",
      task: "写一段开头",
      input: {},
      status: "completed",
      startedAt: new Date("2026-10-29T07:10:01.000Z"),
      completedAt: new Date("2026-10-29T07:10:06.000Z"),
      createdAt: new Date("2026-10-29T07:10:00.000Z"),
    },
    {
      id: "inv-running",
      agentDefinitionId: "doc-writer",
      agentRevisionId: "rev-1",
      source: "scheduler",
      parentSessionId: "session-1",
      idempotencyKey: "inv-key-2",
      task: "续写第二段",
      input: {},
      status: "running",
      startedAt: new Date(Date.now() - 2_000),
      completedAt: null,
      createdAt: new Date("2026-10-29T07:12:00.000Z"),
    },
    {
      id: "inv-timedout",
      agentDefinitionId: "doc-writer",
      agentRevisionId: "rev-1",
      source: "internal_workflow",
      idempotencyKey: "inv-key-3",
      task: "超时任务",
      input: {},
      status: "timed_out",
      startedAt: new Date("2026-10-29T07:11:00.000Z"),
      completedAt: new Date("2026-10-29T07:11:30.000Z"),
      errorCode: "timeout",
      errorMessage: "subagent invocation timed out",
      createdAt: new Date("2026-10-29T07:11:30.000Z"),
    },
    {
      id: "inv-other-agent",
      agentDefinitionId: "slides-builder",
      agentRevisionId: "rev-2",
      source: "primary_agent",
      idempotencyKey: "inv-key-4",
      task: "别的子代理",
      input: {},
      status: "completed",
      createdAt: new Date("2026-10-29T07:14:00.000Z"),
    },
  ]).run();
  db.insert(subagentInvocationEvents).values([
    { id: "ev-inv-1", invocationId: "inv-completed", seq: 1, type: "tool.started", payload: { name: "document_list" } },
    { id: "ev-inv-2", invocationId: "inv-completed", seq: 2, type: "tool.started", payload: { name: "document_read" } },
    { id: "ev-inv-3", invocationId: "inv-completed", seq: 3, type: "tool.started", payload: { name: "subagent_submit_result" } },
    {
      id: "ev-inv-4",
      invocationId: "inv-completed",
      seq: 4,
      type: "message.completed",
      payload: { role: "assistant", content: "done", usage: { input: 200, output: 50, cacheRead: 20 } },
    },
    { id: "ev-inv-5", invocationId: "inv-running", seq: 1, type: "tool.started", payload: { name: "file_read" } },
    {
      id: "ev-inv-6",
      invocationId: "inv-other-agent",
      seq: 1,
      type: "message.completed",
      payload: { usage: { input: 999, output: 999, cacheRead: 999 } },
    },
  ]).run();
}

describe("AgentDebugUsageStore", () => {
  it("listRuns：按 agent 过滤 + createdAt desc + 会话 title/pageLabel + 事件聚合 + duration", async () => {
    const db = await createUsageDatabase();
    seedUsageDatabase(db);
    const store = new AgentDebugUsageStore(db);

    const runs = store.listRuns("main", 10);
    expect(runs.map(({ id }) => id)).toEqual(["run-accepted", "run-running", "run-completed"]);

    const accepted = runs[0]!;
    expect(accepted).toMatchObject({
      kind: "run",
      task: "被接受的请求",
      status: "running", // accepted → running
      startedAt: null,
      durationMs: null,
      toolCalls: 0,
      inputTokens: null,
    });

    const running = runs[1]!;
    expect(running).toMatchObject({
      kind: "run",
      sessionId: "session-1",
      sessionTitle: "季度总结",
      task: "继续写",
      status: "running",
      roomId: null,
      pageLabel: "办公室",
      completedAt: null,
      toolCalls: 1,
      inputTokens: null,
      source: null,
      revisionId: null,
    });
    // 运行中：durationMs = now - startedAt（不等待完成）。
    expect(running.durationMs).toBeGreaterThanOrEqual(4_000);
    expect(running.durationMs).toBeLessThan(60_000);

    const completed = runs[2]!;
    expect(completed).toMatchObject({
      sessionId: "session-1",
      sessionTitle: "季度总结",
      task: "写周报",
      status: "completed",
      roomId: "room-1",
      pageLabel: "办公室",
      startedAt: "2026-10-29T07:00:00.000Z",
      completedAt: "2026-10-29T07:00:10.000Z",
      durationMs: 10_000,
      // 2 条 tool.started；message.completed.usage 求和，别的 Agent 的 999 不混入。
      toolCalls: 2,
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 10,
      error: null,
    });

    // limit 与 agent 过滤都生效。
    expect(store.listRuns("main", 1).map(({ id }) => id)).toEqual(["run-accepted"]);
    expect(store.listRuns("main-lite", 10).map(({ id }) => id)).toEqual(["run-other-agent"]);
    expect(store.listRuns("nobody", 10)).toEqual([]);
  });

  it("listInvocations：状态映射 / 错误 / source / revision / 父会话 title + 事件聚合", async () => {
    const db = await createUsageDatabase();
    seedUsageDatabase(db);
    const store = new AgentDebugUsageStore(db);

    const invocations = store.listInvocations("doc-writer", 10);
    expect(invocations.map(({ id }) => id)).toEqual(["inv-running", "inv-timedout", "inv-completed"]);

    const running = invocations[0]!;
    expect(running).toMatchObject({
      kind: "invocation",
      sessionId: "session-1",
      sessionTitle: "季度总结",
      task: "续写第二段",
      status: "running",
      roomId: null,
      pageLabel: null,
      completedAt: null,
      toolCalls: 1,
      inputTokens: null,
      source: "scheduler",
      revisionId: "rev-1",
      error: null,
    });
    expect(running.durationMs).toBeGreaterThanOrEqual(1_000);
    expect(running.durationMs).toBeLessThan(60_000);

    const timedOut = invocations[1]!;
    expect(timedOut).toMatchObject({
      // timed_out → failed
      status: "failed",
      durationMs: 30_000,
      toolCalls: 0,
      inputTokens: null,
      error: "subagent invocation timed out",
      source: "internal_workflow",
      sessionId: null,
      sessionTitle: null,
    });

    const completed = invocations[2]!;
    expect(completed).toMatchObject({
      status: "completed",
      sessionId: null,
      sessionTitle: null,
      startedAt: "2026-10-29T07:10:01.000Z",
      completedAt: "2026-10-29T07:10:06.000Z",
      durationMs: 5_000,
      toolCalls: 3,
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 20,
      source: "primary_agent",
      revisionId: "rev-1",
    });

    expect(store.listInvocations("slides-builder", 10).map(({ id }) => id)).toEqual(["inv-other-agent"]);
    expect(store.listInvocations("nobody", 10)).toEqual([]);
  });
});