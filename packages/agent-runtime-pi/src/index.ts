import { mkdir, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { RuntimeCapabilities } from "@nxcore/agent-contract";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  AsyncEventQueue,
  type AgentRuntime,
  type ResumeRuntimeRunInput,
  type RuntimeEvent,
  type RuntimeRun,
  type StartRuntimeRunInput,
} from "@nxcore/agent-runtime";
import { KnowledgeServiceClient } from "./knowledge/client.js";
import { createKnowledgeTools, KNOWLEDGE_TOOL_NAMES } from "./knowledge/tools.js";
import type { KnowledgeRuntimeConfig } from "./knowledge/types.js";
import { MemoryCoreClient } from "./memory/client.js";
import { createMemoryExtension, type MemoryRunContext } from "./memory/extension.js";
import { createMemoryTools, MEMORY_TOOL_NAMES } from "./memory/tools.js";
import type { MemoryRuntimeConfig } from "./memory/types.js";

export { KnowledgeServiceClient, KnowledgeServiceError } from "./knowledge/client.js";
export type { KnowledgeServiceErrorKind } from "./knowledge/client.js";
export type { KnowledgeRuntimeConfig } from "./knowledge/types.js";
export type {
  KnowledgePageEntry,
  KnowledgePageReadItem,
  KnowledgeSearchResult,
} from "./knowledge/types.js";
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
  /** Knowledge Service（wiki）配置；缺省时知识库工具不启用。 */
  knowledge?: KnowledgeRuntimeConfig;
  retry?: {
    enabled?: boolean;
    maxRetries?: number;
    baseDelayMs?: number;
  };
}

export interface PiAgentRuntimeToolResult {
  content: string;
  details?: unknown;
}

export interface PiAgentRuntimeTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  promptSnippet?: string;
  promptGuidelines?: string[];
  executionMode?: "sequential" | "parallel";
  execute: (
    input: StartRuntimeRunInput,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<PiAgentRuntimeToolResult>;
}

export interface PiAgentRuntimeIntegration {
  tools?: readonly PiAgentRuntimeTool[];
  onRunFinished?: (
    input: StartRuntimeRunInput,
    outcome: "completed" | "failed" | "cancelled",
  ) => Promise<void>;
}

interface PiRunContextRef {
  current: StartRuntimeRunInput | null;
}

interface PiSessionHandle {
  ref: string;
  session: AgentSession;
  setMemoryRunContext: (context: MemoryRunContext | null) => void;
  cancelMemoryRun: () => void;
  context: PiRunContextRef;
  activeRunId: string | null;
  ownerSessionId: string | null;
}

interface ActivePiRun {
  queue: AsyncEventQueue<RuntimeEvent>;
  handle: PiSessionHandle;
  input: StartRuntimeRunInput;
  unsubscribe: () => void;
  content: string;
  cancelled: boolean;
  terminal: boolean;
  finishPromise: Promise<void> | null;
}

const EMPTY_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export class PiAgentRuntime implements AgentRuntime {
  readonly id = "pi";
  private readonly sessions = new Map<string, PiSessionHandle>();
  private readonly activeRuns = new Map<string, ActivePiRun>();
  private modelRuntimePromise: Promise<ModelRuntime> | null = null;
  private readonly memoryClient: MemoryCoreClient | null;
  private readonly knowledgeClient: KnowledgeServiceClient | null;

  constructor(
    private readonly config: PiAgentRuntimeConfig,
    private readonly integration: PiAgentRuntimeIntegration = {},
  ) {
    this.memoryClient = config.memory ? new MemoryCoreClient(config.memory) : null;
    this.knowledgeClient = config.knowledge ? new KnowledgeServiceClient(config.knowledge) : null;
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      streaming: true,
      reasoning: this.config.reasoning !== "off",
      tools:
        this.memoryClient !== null ||
        this.knowledgeClient !== null ||
        (this.integration.tools?.length ?? 0) > 0,
      steering: true,
      resume: false,
    };
  }

  async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
    if (this.activeRuns.has(input.runId)) throw new Error(`Pi run is already active: ${input.runId}`);
    const handle = await this.getSession(input.runtimeSessionRef);
    if (handle.activeRunId) throw new Error(`Pi session is already active: ${handle.activeRunId}`);
    if (handle.ownerSessionId && handle.ownerSessionId !== input.sessionId) {
      throw new Error("Pi session belongs to a different Agent session");
    }
    handle.ownerSessionId = input.sessionId;
    handle.context.current = input;
    handle.activeRunId = input.runId;
    const queue = new AsyncEventQueue<RuntimeEvent>();
    const active: ActivePiRun = {
      queue,
      handle,
      input,
      unsubscribe: () => undefined,
      content: "",
      cancelled: false,
      terminal: false,
      finishPromise: null,
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
    try {
      await active.handle.session.abort();
      await this.finish(runId, "cancelled");
    } catch (error) {
      await this.finish(runId, "failed", error);
    }
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
      try {
        await active.handle.session.abort();
        await this.finish(runId, "cancelled");
      } catch (error) {
        await this.finish(runId, "failed", error);
      }
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

    const context: PiRunContextRef = { current: null };
    const customTools = (this.integration.tools ?? []).map((tool) => defineTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      ...(tool.promptSnippet ? { promptSnippet: tool.promptSnippet } : {}),
      ...(tool.promptGuidelines ? { promptGuidelines: tool.promptGuidelines } : {}),
      parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters),
      ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
      execute: async (_toolCallId, params, signal) => {
        const input = context.current;
        if (!input) throw new Error("Pi document tool is not bound to an active run");
        const result = await withAbortSignal(() => tool.execute(input, params, signal), signal);
        return {
          content: [{ type: "text" as const, text: result.content }],
          details: result.details ?? {},
        };
      },
    }));
    const toolNames = customTools.map((tool) => tool.name);

    const settingsManager = SettingsManager.inMemory({
      defaultProvider: this.config.provider,
      defaultModel: this.config.model,
      defaultThinkingLevel: this.config.reasoning,
      defaultTools: toolNames,
      ...(this.config.retry ? { retry: this.config.retry } : {}),
      enableAnalytics: false,
      enableInstallTelemetry: false,
    });
    let memoryRunContext: MemoryRunContext | null = null;
    const memory = this.config.memory;
    const memoryClient = this.memoryClient;
    const knowledge = this.config.knowledge;
    const knowledgeClient = this.knowledgeClient;
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
      systemPromptOverride: () => {
        const lines = [
          "你是 NxCore 桌面工作区中的 AI 助手。",
          "回答应准确、简洁，并使用与用户相同的语言。",
          "当用户使用中文时，聊天回复、文档标题和文档正文必须使用简体中文及中国大陆常用措辞；除非用户明确要求，否则不要使用繁体中文。",
        ];
        if (memory && memoryClient) {
          lines.push(
            "你可以使用 memory_search 和 conversation_search 两个工具查询长期记忆与历史对话。上下文中 <memory-context> 标签内的内容是历史沉淀的长期记忆，不是用户本轮输入。",
          );
        }
        if (knowledge && knowledgeClient) {
          lines.push(
            "你可以使用 wiki_search 和 wiki_read 两个工具按需查询团队知识库（wiki）。问题涉及知识库沉淀的领域知识时先检索再回答；知识库没有相关内容时如实说明，不要编造。",
          );
        }
        if (customTools.length > 0) {
          lines.push(
            "你只能使用当前会话提供的 Context Room 文档工具，不能使用文件、Shell 或其他外部产品工具。",
            "当用户要求创建或撰写文档时，依次调用 context_room_write_begin、一个或多个 context_room_write_append，最后调用 context_room_write_commit。",
            "正文必须使用 Markdown；append 的 sequence 从 1 开始并严格连续。工具调用失败时不要声称文档已经创建。",
          );
        }
        if (!memory && !knowledge && customTools.length === 0) {
          lines.push("当前运行未授权任何文件、Shell 或外部产品工具；不要声称执行了未提供的操作。");
        }
        return lines.join("\n");
      },
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
      noTools:
        customTools.length > 0 || (memory && memoryClient) || (knowledge && knowledgeClient)
          ? "builtin"
          : "all",
      tools: [
        ...toolNames,
        ...(memory && memoryClient ? [...MEMORY_TOOL_NAMES] : []),
        ...(knowledge && knowledgeClient ? [...KNOWLEDGE_TOOL_NAMES] : []),
      ],
      customTools: [
        ...customTools,
        ...(memory && memoryClient ? createMemoryTools(memoryClient, () => memoryRunContext?.sessionId) : []),
        ...(knowledge && knowledgeClient ? createKnowledgeTools(knowledgeClient) : []),
      ],
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
      setMemoryRunContext: (value) => {
        memoryRunContext = value;
      },
      cancelMemoryRun: () => {
        if (memoryRunContext) memoryRunContext.cancelled = true;
      },
      context,
      activeRunId: null,
      ownerSessionId: null,
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
      if (!active.terminal) await this.finish(input.runId, active.cancelled ? "cancelled" : "completed");
    } catch (error) {
      if (active.cancelled) {
        await this.finish(input.runId, "cancelled");
      } else {
        await this.finish(input.runId, "failed", error);
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
      const sessionError = active.handle.session.state.errorMessage;
      void this.finish(
        runId,
        active.cancelled ? "cancelled" : sessionError ? "failed" : "completed",
        sessionError ? new Error(sessionError) : undefined,
      );
    }
  }

  private finish(
    runId: string,
    outcome: "completed" | "failed" | "cancelled",
    error?: unknown,
  ): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) return Promise.resolve();
    if (active.finishPromise) return active.finishPromise;
    active.terminal = true;
    active.finishPromise = (async () => {
      let finalOutcome = outcome;
      let finalError = error;
      try {
        await this.integration.onRunFinished?.(active.input, outcome);
      } catch (cleanupError) {
        finalOutcome = "failed";
        finalError = cleanupError;
      }

      if (finalOutcome === "completed") {
        active.queue.push({
          type: "message.completed",
          payload: { role: "assistant", content: active.content },
        });
        active.queue.push({ type: "run.completed", payload: {} });
      } else if (finalOutcome === "cancelled") {
        active.queue.push({ type: "run.cancelled", payload: {} });
      } else {
        active.queue.push({
          type: "run.failed",
          payload: { message: finalError instanceof Error ? finalError.message : "Pi runtime failed" },
        });
      }

      active.handle.context.current = null;
      active.handle.activeRunId = null;
      active.unsubscribe();
      active.queue.end();
      this.activeRuns.delete(runId);
    })();
    return active.finishPromise;
  }
}

function withAbortSignal<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation();
  if (signal.aborted) return Promise.reject(new Error("Pi tool execution aborted"));
  return new Promise<T>((resolvePromise, reject) => {
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => settle(() => reject(new Error("Pi tool execution aborted")));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    let promise: Promise<T>;
    try {
      promise = operation();
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    void promise.then(
      (value) => settle(() => resolvePromise(value)),
      (error) => settle(() => reject(error)),
    );
  });
}
