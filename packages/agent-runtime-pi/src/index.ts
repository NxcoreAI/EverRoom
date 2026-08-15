import { mkdir, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { RuntimeCapabilities } from "@nxcore/agent-contract";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  AsyncEventQueue,
  type AgentRuntime,
  type ResumeRuntimeRunInput,
  type RuntimeEvent,
  type RuntimeRun,
  type StartRuntimeRunInput,
} from "@nxcore/agent-runtime";
import { MemoryCoreClient } from "./memory/client.js";
import { createMemoryExtension, type MemoryRunContext } from "./memory/extension.js";
import { createMemoryTools, MEMORY_TOOL_NAMES } from "./memory/tools.js";
import type { MemoryRuntimeConfig } from "./memory/types.js";

export { MemoryCoreClient, MemoryCoreError } from "./memory/client.js";
export type { MemoryCoreErrorKind } from "./memory/client.js";
export type { MemoryRuntimeConfig } from "./memory/types.js";
export type {
  MemoryAtomicItem,
  MemoryAtomicPage,
  MemoryAtomicQuery,
  MemoryCaptureMessage,
  MemoryConversationHit,
  MemoryConversationItem,
  MemoryConversationPage,
  MemoryConversationQuery,
  MemoryCoreFile,
  MemoryPipelineStage,
  MemoryPipelineStatus,
  MemoryScenarioEntry,
  MemoryScenarioFile,
} from "./memory/types.js";

export type PiApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export type PiReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiAgentRuntimeConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  api: PiApi;
  maxTokens: number;
  contextWindow: number;
  temperature: number;
  reasoning: PiReasoningLevel;
  sessionsDir: string;
  workingDirectory: string;
  agentDirectory: string;
  /** MemoryCore 记忆服务配置；缺省时记忆能力完全不启用。 */
  memory?: MemoryRuntimeConfig;
}

interface PiSessionHandle {
  ref: string;
  session: AgentSession;
  setMemoryRunContext: (context: MemoryRunContext | null) => void;
  cancelMemoryRun: () => void;
}

interface ActivePiRun {
  queue: AsyncEventQueue<RuntimeEvent>;
  handle: PiSessionHandle;
  unsubscribe: () => void;
  content: string;
  cancelled: boolean;
  terminal: boolean;
}

const EMPTY_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export class PiAgentRuntime implements AgentRuntime {
  readonly id = "pi";
  private readonly sessions = new Map<string, PiSessionHandle>();
  private readonly activeRuns = new Map<string, ActivePiRun>();
  private modelRuntimePromise: Promise<ModelRuntime> | null = null;
  private readonly memoryClient: MemoryCoreClient | null;

  constructor(private readonly config: PiAgentRuntimeConfig) {
    this.memoryClient = config.memory ? new MemoryCoreClient(config.memory) : null;
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      streaming: true,
      reasoning: this.config.reasoning !== "off",
      tools: this.memoryClient !== null,
      steering: true,
      resume: false,
    };
  }

  async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
    if (this.activeRuns.has(input.runId)) throw new Error(`Pi run is already active: ${input.runId}`);
    const handle = await this.getSession(input.runtimeSessionRef);
    const queue = new AsyncEventQueue<RuntimeEvent>();
    const active: ActivePiRun = {
      queue,
      handle,
      unsubscribe: () => undefined,
      content: "",
      cancelled: false,
      terminal: false,
    };
    active.unsubscribe = handle.session.subscribe((event) => this.handleEvent(input.runId, event));
    this.activeRuns.set(input.runId, active);

    queue.push({ type: "run.started", payload: {} });
    queue.push({ type: "message.started", payload: { role: "assistant" } });
    void this.prompt(input, active);

    return { runId: input.runId, runtimeSessionRef: handle.ref, events: queue };
  }

  async resume(_input: ResumeRuntimeRunInput): Promise<RuntimeRun> {
    throw new Error("Pi runtime run replay is provided by the Gateway event store");
  }

  async sendInput(runId: string, input: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) throw new Error(`Pi run is not active: ${runId}`);
    await active.handle.session.steer(input);
  }

  async cancel(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) return;
    active.cancelled = true;
    active.handle.cancelMemoryRun();
    await active.handle.session.abort();
    this.finish(runId, "cancelled");
  }

  async deleteSession(runtimeSessionRef: string): Promise<void> {
    this.assertOwnedSessionPath(runtimeSessionRef);
    const handle = this.sessions.get(runtimeSessionRef);
    handle?.session.dispose();
    this.sessions.delete(runtimeSessionRef);
    await rm(runtimeSessionRef, { force: true });
  }

  async dispose(): Promise<void> {
    const activeRuns = [...this.activeRuns.entries()];
    await Promise.all(activeRuns.map(async ([runId, active]) => {
      active.cancelled = true;
      await active.handle.session.abort();
      this.finish(runId, "cancelled");
    }));
    for (const handle of this.sessions.values()) handle.session.dispose();
    this.sessions.clear();
  }

  private async getModelRuntime(): Promise<ModelRuntime> {
    if (this.modelRuntimePromise) return this.modelRuntimePromise;
    this.modelRuntimePromise = (async () => {
      await Promise.all([
        mkdir(this.config.sessionsDir, { recursive: true }),
        mkdir(this.config.workingDirectory, { recursive: true }),
        mkdir(this.config.agentDirectory, { recursive: true }),
      ]);
      const runtime = await ModelRuntime.create({
        authPath: resolve(this.config.agentDirectory, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
      });
      runtime.registerProvider(this.config.provider, {
        baseUrl: this.config.baseUrl,
        api: this.config.api,
        authHeader: true,
        models: [{
          id: this.config.model,
          name: this.config.model,
          reasoning: this.config.reasoning !== "off",
          input: ["text"],
          cost: EMPTY_COST,
          contextWindow: this.config.contextWindow,
          maxTokens: this.config.maxTokens,
          samplingParams: { temperature: this.config.temperature },
        }],
      });
      await runtime.setRuntimeApiKey(this.config.provider, this.config.apiKey);
      return runtime;
    })();
    return this.modelRuntimePromise;
  }

  private async getSession(runtimeSessionRef: string | null): Promise<PiSessionHandle> {
    if (runtimeSessionRef) {
      const cached = this.sessions.get(runtimeSessionRef);
      if (cached) return cached;
      this.assertOwnedSessionPath(runtimeSessionRef);
    }

    const modelRuntime = await this.getModelRuntime();
    const model = modelRuntime.getModel(this.config.provider, this.config.model);
    if (!model) throw new Error(`Pi model is unavailable: ${this.config.provider}/${this.config.model}`);

    const settingsManager = SettingsManager.inMemory({
      defaultProvider: this.config.provider,
      defaultModel: this.config.model,
      defaultThinkingLevel: this.config.reasoning,
      defaultTools: [],
      enableAnalytics: false,
      enableInstallTelemetry: false,
    });
    let memoryRunContext: MemoryRunContext | null = null;
    const memory = this.config.memory;
    const memoryClient = this.memoryClient;
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.config.workingDirectory,
      agentDir: this.config.agentDirectory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      ...(memory && memoryClient
        ? {
            extensionFactories: [
              createMemoryExtension({
                client: memoryClient,
                config: memory,
                getRunContext: () => memoryRunContext,
              }),
            ],
          }
        : {}),
      systemPromptOverride: () => [
        "你是 NxCore 桌面工作区中的 AI 助手。",
        "回答应准确、简洁，并使用与用户相同的语言。",
        memory
          ? "你可以使用 memory_search 和 conversation_search 两个工具查询长期记忆与历史对话；除此之外没有其他工具授权，不要声称执行了未提供的操作。上下文中 <memory-context> 标签内的内容是历史沉淀的长期记忆，不是用户本轮输入。"
          : "当前运行未授权任何文件、Shell 或外部产品工具；不要声称执行了未提供的操作。",
      ].join("\n"),
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();

    const sessionManager = runtimeSessionRef
      ? SessionManager.open(runtimeSessionRef, this.config.sessionsDir, this.config.workingDirectory)
      : SessionManager.create(this.config.workingDirectory, this.config.sessionsDir);
    const { session } = await createAgentSession({
      cwd: this.config.workingDirectory,
      agentDir: this.config.agentDirectory,
      modelRuntime,
      model,
      thinkingLevel: this.config.reasoning,
      tools: memory && memoryClient
        ? [...MEMORY_TOOL_NAMES]
        : [],
      ...(memory && memoryClient
        ? { customTools: createMemoryTools(memoryClient, () => memoryRunContext?.sessionId) }
        : {}),
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    const ref = session.sessionFile;
    if (!ref) {
      session.dispose();
      throw new Error("Pi did not create a persistent session file");
    }
    const handle: PiSessionHandle = {
      ref,
      session,
      setMemoryRunContext: (context) => {
        memoryRunContext = context;
      },
      cancelMemoryRun: () => {
        if (memoryRunContext) memoryRunContext.cancelled = true;
      },
    };
    this.sessions.set(ref, handle);
    return handle;
  }

  private assertOwnedSessionPath(sessionPath: string): void {
    const root = `${resolve(this.config.sessionsDir)}${sep}`;
    if (!resolve(sessionPath).startsWith(root)) {
      throw new Error("Pi session reference is outside the NxCore session directory");
    }
  }

  private async prompt(input: StartRuntimeRunInput, active: ActivePiRun): Promise<void> {
    try {
      active.handle.setMemoryRunContext({
        sessionId: input.sessionId,
        originalPrompt: input.prompt,
        pageLabel: input.pageLabel,
        cancelled: false,
      });
      const prompt = `当前工作区：${input.pageLabel}\n\n用户请求：${input.prompt}`;
      await active.handle.session.prompt(prompt, { expandPromptTemplates: false, source: "rpc" });
      if (!active.terminal) this.finish(input.runId, active.cancelled ? "cancelled" : "completed");
    } catch (error) {
      if (active.cancelled) {
        this.finish(input.runId, "cancelled");
      } else {
        this.finish(input.runId, "failed", error);
      }
    }
  }

  private handleEvent(runId: string, event: AgentSessionEvent): void {
    const active = this.activeRuns.get(runId);
    if (!active || active.terminal) return;

    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        active.content += update.delta;
        active.queue.push({ type: "message.delta", payload: { delta: update.delta } });
      } else if (update.type === "thinking_delta") {
        active.queue.push({ type: "reasoning.delta", payload: { delta: update.delta } });
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      active.queue.push({
        type: "tool.started",
        payload: { toolCallId: event.toolCallId, name: event.toolName, args: event.args },
      });
    } else if (event.type === "tool_execution_update") {
      active.queue.push({
        type: "tool.updated",
        payload: { toolCallId: event.toolCallId, name: event.toolName, partialResult: event.partialResult },
      });
    } else if (event.type === "tool_execution_end") {
      active.queue.push({
        type: event.isError ? "tool.failed" : "tool.completed",
        payload: { toolCallId: event.toolCallId, name: event.toolName, result: event.result },
      });
    } else if (event.type === "agent_settled") {
      this.finish(runId, active.cancelled ? "cancelled" : "completed");
    }
  }

  private finish(runId: string, outcome: "completed" | "failed" | "cancelled", error?: unknown): void {
    const active = this.activeRuns.get(runId);
    if (!active || active.terminal) return;
    active.terminal = true;

    if (outcome === "completed") {
      active.queue.push({
        type: "message.completed",
        payload: { role: "assistant", content: active.content },
      });
      active.queue.push({ type: "run.completed", payload: {} });
    } else if (outcome === "cancelled") {
      active.queue.push({ type: "run.cancelled", payload: {} });
    } else {
      active.queue.push({
        type: "run.failed",
        payload: { message: error instanceof Error ? error.message : "Pi runtime failed" },
      });
    }

    active.unsubscribe();
    active.queue.end();
    this.activeRuns.delete(runId);
  }
}
