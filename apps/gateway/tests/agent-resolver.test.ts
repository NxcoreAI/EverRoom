import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "@nxcore/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { invokeAgent } from "../src/modules/agent/invoke.js";
import { OpenAiCompletionAgentRuntime } from "../src/modules/agent/openai-completion-runtime.js";
import { createAgentResolver, createCursorCompletionRuntime } from "../src/modules/agent/runtime-factory.js";
import { AgentResolver, BUILTIN_AGENT_IDS } from "../src/modules/agent/resolver.js";
import { loadAllBuiltinAgentBundles } from "../src/modules/agent/builtin-bundles.js";
import { bundledAgentDefinitionsDir } from "../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("AgentResolver", () => {
  it("loads every built-in Agent from the shipped agents directory", () => {
    const bundles = loadAllBuiltinAgentBundles(bundledAgentDefinitionsDir());
    expect(bundles.map(({ id }) => id).sort()).toEqual(Object.values(BUILTIN_AGENT_IDS).sort());
    for (const bundle of bundles) {
      expect(bundle.systemPrompt.length).toBeGreaterThan(0);
      expect(bundle.directory).toContain(`/agents/${bundle.id}`);
    }
  });

  it("selects lazily by stable Agent id and caches one runtime", async () => {
    const resolver = new AgentResolver();
    const runtime = { dispose: vi.fn(async () => undefined) } as unknown as AgentRuntime;
    const factory = vi.fn(() => runtime);
    resolver.register({
      id: "test-agent",
      name: "Test Agent",
      description: "Test",
      configDirectory: "/tmp/test-agent/config",
      kind: "developer",
    }, factory);

    expect(factory).not.toHaveBeenCalled();
    expect(resolver.resolve("test-agent")).toBe(runtime);
    expect(resolver.resolve("test-agent")).toBe(runtime);
    expect(factory).toHaveBeenCalledTimes(1);
    await resolver.dispose();
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it("registers model-backed built-ins with isolated config directories", () => {
    const dataDir = "/tmp/everroom-agent-resolver";
    const config = loadConfig(["--token", "0123456789abcdef", "--data-dir", dataDir], {
      NXCORE_KNOWLEDGE_ENABLED: "true",
      NXCORE_KNOWLEDGE_ROOM_WIKIS_ENABLED: "true",
      NXCORE_KNOWLEDGE_ROUTER_ENABLED: "true",
      NXCORE_KNOWLEDGE_LLM_BASE_URL: "https://knowledge.example/v1",
      NXCORE_KNOWLEDGE_LLM_API_KEY: "knowledge-key",
      NXCORE_KNOWLEDGE_LLM_MODEL: "knowledge-model",
      NXCORE_AGENT_RUNTIME: "pi",
      NXCORE_AI_PROVIDER: "openai",
      NXCORE_AI_MODEL: "main-model",
      NXCORE_AI_BASE_URL: "https://main.example/v1",
      NXCORE_AI_API_KEY: "main-key",
      NXCORE_WEB_SEARCH_ENABLED: "true",
      NXCORE_WEB_SEARCH_API_KEY: "search-key",
    });
    const resolver = createAgentResolver(config);

    expect(resolver.list().map(({ id }) => id).sort()).toEqual([
      BUILTIN_AGENT_IDS.knowledge,
      BUILTIN_AGENT_IDS.webSearch,
    ].sort());
    for (const agent of resolver.list()) {
      expect(agent.configDirectory).toBe(join(dataDir, "agent", "runtimes", agent.id, "config"));
    }
  });
});

describe("Agent runtime isolation", () => {
  it("scopes cursor completion sessions, workspace, config and runtime id", () => {
    const dataDir = "/tmp/everroom-cursor-agent";
    const config = loadConfig(["--token", "0123456789abcdef", "--data-dir", dataDir], {
      NXCORE_AGENT_RUNTIME: "pi",
      NXCORE_AI_PROVIDER: "openai",
      NXCORE_AI_MODEL: "main-model",
      NXCORE_AI_BASE_URL: "https://main.example/v1",
      NXCORE_AI_API_KEY: "main-key",
    });
    const runtime = createCursorCompletionRuntime(config) as unknown as {
      config: { runtimeId: string; sessionsDir: string; workingDirectory: string; agentDirectory: string };
    };
    const root = join(dataDir, "agent", "runtimes", BUILTIN_AGENT_IDS.cursorCompletion);

    expect(runtime.config).toMatchObject({
      runtimeId: `pi:${BUILTIN_AGENT_IDS.cursorCompletion}`,
      sessionsDir: join(root, "sessions"),
      workingDirectory: join(root, "workspace"),
      agentDirectory: join(root, "config"),
    });
  });

  it("keeps OpenAI-compatible calls behind an AgentRuntime", async () => {
    const root = await mkdtemp(join(tmpdir(), "everroom-agent-runtime-"));
    temporaryDirectories.push(root);
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ model: "search-model", enable_search: true });
      return new Response(JSON.stringify({ choices: [{ message: { content: "search result" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const resolver = new AgentResolver();
    resolver.register({
      id: BUILTIN_AGENT_IDS.webSearch,
      name: "Web Search Agent",
      description: "Search",
      configDirectory: join(root, "config"),
      kind: "builtin",
    }, () => new OpenAiCompletionAgentRuntime({
      runtimeId: BUILTIN_AGENT_IDS.webSearch,
      baseUrl: "https://search.example/v1",
      apiKey: "secret",
      model: "search-model",
      systemPrompt: "Search",
      requestOptions: { enable_search: true },
      sessionsDir: join(root, "sessions"),
      workingDirectory: join(root, "workspace"),
      agentDirectory: join(root, "config"),
    }));

    await expect(invokeAgent(resolver, BUILTIN_AGENT_IDS.webSearch, "EverRoom", {
      pageLabel: "search",
    })).resolves.toBe("search result");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://search.example/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    await resolver.dispose();
  });
});
