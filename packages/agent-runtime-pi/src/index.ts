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

  constructor(
    private readonly config: PiAgentRuntimeConfig,
    private readonly integration: PiAgentRuntimeIntegration = {},
  ) {
    this.memoryClient = config.memory ? new MemoryCoreClient(config.memory) : null;
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      streaming: true,
      reasoning: this.config.reasoning !== "off",
      tools: true,
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
          "聊天回复使用自然、简洁的纯文本格式；不要使用 Markdown 标题符、粗体或斜体标记、反引号、代码围栏、表格或不常用装饰符号。需要列举时只使用普通数字列表或短句。文档正文仍按文档工具要求使用 Markdown。",
          "当用户使用中文时，聊天回复、文档标题和文档正文必须使用简体中文及中国大陆常用措辞；除非用户明确要求，否则不要使用繁体中文。",
          "使用工具时，过程说明只补充工具行本身无法表达的信息，例如调用原因、关键发现、判断或对用户的影响；不要复述工具名称、执行状态、参数或下一项工具。没有新增信息时直接继续调用工具，不要强制输出过渡句。过程说明必须基于真实结果，不能臆测成功或输出冗长执行日志。",
          "最后一项工具完成后，必须给出独立、完整的最终答复，简洁总结完成了什么、关键结果以及仍需用户处理的事项；不要把过程说明直接拼接成最终答复。",
        ];
        if (memory && memoryClient) {
          lines.push(
            "你可以使用 memory_search 和 conversation_search 两个工具查询长期记忆与历史对话。上下文中 <memory-context> 标签内的内容是历史沉淀的长期记忆，不是用户本轮输入。",
          );
        }
        const hasDocumentTools = customTools.some((tool) => tool.name.startsWith("context_room_"));
        if (hasDocumentTools) {
          lines.push(
            "你只能使用当前会话提供的 Context Room 文档工具以及明确列出的其他能力；不要臆造未提供的文件、Shell 或外部产品工具。",
            "只有当用户明确表达了要在工作区中创建、保存或写入一篇文档的操作意图时，才可以调用 Context Room 文档工具，例如用户明确说“创建文档”“写入文档”“保存成文档”或“在某个 Room 里生成文档”。仅仅要求解释、分析、总结、整理、列计划、写方案、起草内容、润色、扩写或给出 Markdown，默认都应直接在聊天中回答，不能据此推断用户想创建文档；用户提到某篇文档、讨论如何写文档、当前页面位于文档区，或回答可能很长，也都不构成创建意图。意图不明确时不要调用 context_room_list 或 context_room_write_begin，先在聊天中完成请求；只有用户随后明确要求落盘为文档时，再开始文档流程。局部选区重写也不创建新文档。",
            "只有当用户明确要求在工作区创建、保存或写入文档，且当前视口未绑定具体 Context Room 时，才进入 Room 选择流程；一旦同时满足这两个条件，必须立即调用 context_room_list，并使用工具返回的列表让用户选择。不得只用文字回复“无法创建”“请先选择 Room”，不得询问用户是否需要查看列表，也不得要求用户自行提供 Room 名称，因为选择 UI 依赖本次工具调用。普通页面的普通聊天不要主动提示 Room 选择。用户明确选择前禁止调用 context_room_write_begin，也不要替用户猜测目标 Room。",
            "如果本轮要创建文档且记忆工具可用，调用 context_room_write_begin 之前必须先用 memory_search 和 conversation_search 检索与主题、项目或用户偏好相关的历史记忆和旧文档；将命中的内容作为客制化依据。只有明确属于全新主题，或用户明确要求不要参考历史时，才可以跳过检索。",
            "在调用 context_room_write_begin 前，先确定准备写入正文的实际核心内容、重点或结论，再据此拟定能够准确概括正文的具体、自然、有辨识度的标题。标题要随内容类型调整：教程突出学习路径或成果，分析突出对象与核心问题，方案突出目标与行动，报告突出主题与范围。除非用户明确指定必须使用的精确标题，否则不要复制用户的任务表述，也不要使用“后端学习文档”“项目介绍”“学习资料”等只描述文档形式、没有内容信息的泛标题；随后写出的正文必须与标题一致。",
            "除非用户明确要求简短版本，否则文档正文必须是充实、完整的长篇内容：充分展开主题，按需包含背景、核心概念、步骤、例子、注意事项和总结。内容长度应与主题复杂度相称，不得空泛、重复或为了变长而凑字。",
            "正文的 Markdown 标题层级应服务于内容结构：默认让同一层级的章节使用一致的标题级别，避免只为强调某一段临时放大标题；通常可用 ## 表示主章节、### 表示子章节，普通强调使用加粗或段落。不要机械套用这一默认规则：如果用户明确要求一级标题、特定标题层级或特定排版，必须尊重用户要求，并保持其指定结构前后一致。",
            "正文必须使用 Markdown；append 的 sequence 从 1 开始并严格连续。每次 append 只能发送新增片段，严禁用新的 sequence 重发此前内容或累计全文。工具调用失败时不要声称文档已经创建。",
            "新文档提交成功后，聊天中的最终答复必须是 2 至 4 句的简短总结，只说明文档目标、覆盖的核心内容和完成结果；中文不超过约 180 字，英文不超过约 80 词。不得再次输出文档标题目录、正文段落或长列表。",
            "只有用户明确要求续写、补充、改写、替换或删除已有工作区文档内容时，才进入已有文档修改流程。普通讨论、评价、总结某篇文档，或仅把文档当作参考资料，不构成修改意图。目标 Room 未确认时先调用 context_room_list；Room 已确认但目标文档未确认时调用 context_room_document_list，让用户选择，不得猜测。",
            "修改已有文档前必须调用 context_room_document_read 读取权威版本，再通过 context_room_patch_begin、context_room_patch_hunk、context_room_patch_commit 生成 Patch。Agent 没有直接应用正文的权限，不得声称未被用户接受的内容已经写入。kind=edit 的修改等待用户审阅；kind=continue 的候选会直接出现在文档编辑区，由用户连续接受，不要要求用户回到智能区点击确认。",
            "调用 context_room_patch_hunk 时必须让 operation 与 target 匹配：insert 才能使用文末或 block edge；replace/delete 整块必须使用不带 edge 的 {blockId}，块内范围使用 offset，连续块范围使用 fromBlockId/toBlockId。工具调用失败时根据错误修正参数，并用同一个 sequence 重试，不得跳号或把失败项计入 finalSequence。",
            "用户只说“续写”或“继续写”时，Patch 必须插入文档末尾。只有用户明确说“当前位置”“光标处”“这里继续”，或由明确的“在此续写”入口发起时，才可采用当前文档上下文提供的 cursorAnchorCandidate。不得因为编辑器中恰好存在光标就改变默认位置。除非用户明确要求简短续写，续写内容必须充分展开并形成多个连贯、有信息量的 Markdown 块，通常包含若干段落、必要的小标题、示例或后续论述；不得只生成一小段就结束。一个 continue Patch 只调用一次 patch_hunk，把完整的多块 Markdown 作为该 hunk 发送，编辑器会按顶层块让用户连续接受。",
            "已有文档修改若与用户历史偏好、项目背景或旧文档明显相关，可先检索记忆以增强客制化；用户要求不要参考历史时不检索。只有用户最终接受并应用的 Patch 才视为实际文档改动。",
          );
        }
        lines.push(
          "你可以使用 Pi Agent 内置 bash 在本机执行命令和访问文件。只有用户明确要求操作本机文件或执行本机命令时才调用；普通分析和文档生成不要调用。",
        );
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
      tools: ["bash", ...toolNames, ...(memory && memoryClient ? [...MEMORY_TOOL_NAMES] : [])],
      customTools: [
        ...customTools,
        ...(memory && memoryClient ? createMemoryTools(memoryClient, () => memoryRunContext?.sessionId) : []),
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
        captureEnabled: input.captureMemory !== false,
      });
      const selectedRoom = input.roomId
        ? input.availableRooms?.find((room) => room.id === input.roomId)
        : undefined;
      const roomContext = input.roomSelectionRequired
        ? "当前视口未绑定具体 Context Room。若用户本轮明确要求把内容创建、保存或写入工作区文档，必须立即调用 context_room_list 以展示 Room 选择 UI；不要只回复无法创建、请用户先选择或询问是否需要列表。普通聊天不要主动提示 Room 选择。用户选择前不得创建文档。"
        : input.roomId
          ? `本轮文档目标 Room 已确认：${selectedRoom?.title ?? input.pageLabel}（ID: ${input.roomId}）。`
          : "本轮没有可用的 Context Room 文档目标。";
      const documentContext = input.activeDocument
        ? [
            `当前活动文档：${input.activeDocument.title}（ID: ${input.activeDocument.documentId}，版本: ${input.activeDocument.version}）。`,
            "普通续写的默认锚点是文档末尾。",
            input.activeDocument.cursorAnchorCandidate
              ? `仅在用户明确要求当前位置时可使用光标候选：块 ${input.activeDocument.cursorAnchorCandidate.blockId}，UTF-16 偏移 ${input.activeDocument.cursorAnchorCandidate.offset}。`
              : "本轮没有可靠的光标候选锚点。",
          ].join("\n")
        : "当前视口没有已确认的活动文档；若用户明确要求修改已有文档，应调用 context_room_document_list 触发选择。";
      const prompt = [
        `当前工作区：${input.pageLabel}`,
        roomContext,
        documentContext,
        "",
        `用户请求：${input.prompt}`,
      ].join("\n");
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
