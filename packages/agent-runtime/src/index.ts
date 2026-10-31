import type {
  AgentAttachmentKind,
  AgentActiveDocumentContext,
  AgentActiveFileContext,
  AgentEventType,
  AgentOpenFileContext,
  LocalAgentDelegationContext,
  LocalAgentInvocationTarget,
  AgentRoomReference,
  RuntimeCapabilities,
} from "@nxcore/agent-contract";

export { AsyncEventQueue } from "./async-event-queue.js";
export { UnconfiguredAgentRuntime } from "./unconfigured-runtime.js";

export interface RuntimeEvent<T = unknown> {
  type: AgentEventType;
  payload: T;
}

export interface StartRuntimeRunInput {
  runId: string;
  sessionId: string;
  runtimeSessionRef: string | null;
  /** Exact user-authored request before routing context is added. */
  originalPrompt?: string;
  /** Current UI locale; injected into the runtime system prompt for this run. */
  responseLanguage?: string;
  prompt: string;
  attachments?: RuntimeAttachment[];
  pageLabel: string;
  roomId: string | null;
  /** 会话所属工作区：Agent 产物入库时带上（资料库/产物库按空间隔离）。 */
  workspaceId?: string | null;
  availableRooms?: AgentRoomReference[];
  roomSelectionRequired?: boolean;
  captureMemory?: boolean;
  recallMemory?: boolean;
  toolsEnabled?: boolean;
  activeDocument?: AgentActiveDocumentContext;
  /** 用户当前正在浏览的 Office 文件页签（file_entries），工具按 fileId 读取正文。 */
  activeFile?: AgentActiveFileContext;
  /** 工作区当前打开的全部 Office 页签（含 active 标记），供 Agent 感知“一共开了哪些文件”。 */
  openFiles?: AgentOpenFileContext[];
  /** Prior Agent chat made available to Main as an on-demand, read-only context source. */
  referencedConversationId?: string;
  /** @ mentioned local CLI Agents; Main stays the speaker and decides which to dispatch via local_agent_dispatch. */
  referencedLocalAgents?: LocalAgentInvocationTarget[];
  /** Structured handoff for an explicitly selected external/local Agent. */
  delegationContext?: LocalAgentDelegationContext;
  /**
   * 运行期元数据，只供工具/扩展按需读取，不进入 prompt。
   * 子 Agent 派遣时携带 { subagentAgentId, subagentInput }，让工具能按阶段
   * （如 slides-planner 的 draft/arrange）收紧取数预算。
   */
  runtimeMetadata?: Record<string, unknown>;
}

export interface RuntimeAttachment {
  filename: string;
  mimeType: string;
  kind: AgentAttachmentKind;
  text?: string;
  dataUrl?: string;
}

export interface ResumeRuntimeRunInput extends StartRuntimeRunInput {
  lastEventSeq: number;
}

export interface RuntimeRun {
  runId: string;
  runtimeSessionRef: string;
  events: AsyncIterable<RuntimeEvent>;
}

/**
 * 调试面板展示用的模型参数快照（只读，绝不含 apiKey）。
 * 无法从该 runtime 取到的字段为 null（如 OpenAI 兼容 runtime 没有 provider/api 概念）。
 */
export interface AgentRuntimeModelDescription {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  api: string | null;
  reasoning: string | null;
  temperature: number | null;
  maxTokens: number | null;
  contextWindow: number | null;
}

/** 实际挂载到该 runtime 的工具（自定义/网关注入工具，不含 pi 内置工具）。 */
export interface AgentRuntimeToolDescription {
  name: string;
  label?: string;
  description?: string;
}

/** 内联进系统提示词的 Skill（来自 runtime config.skillPrompts）。 */
export interface AgentRuntimeSkillDescription {
  name: string;
  prompt: string;
}

/** 运行预算（pi runtime 参数；未配置的项为 null）。 */
export interface AgentRuntimeLimitsDescription {
  maxToolCallsPerRun: number | null;
  maxToolResultChars: number | null;
  runContextGuard: { triggerTokens: number; keepRecentTurns: number } | null;
}

/**
 * runtime 的实际装配描述：供只读调试面板（/v1/agent-debug/*）展示。
 * 数据必须来自 runtime 自身持有的 config/integration，而不是 agent.yaml 的声明。
 */
export interface AgentRuntimeDescription {
  runtimeId: string;
  model: AgentRuntimeModelDescription | null;
  role: "user-facing" | "internal" | null;
  systemPrompt: string | null;
  skills: AgentRuntimeSkillDescription[];
  tools: AgentRuntimeToolDescription[];
  /** 实际启用的 pi 内置工具集合（含受 includeBashTool 控制的 bash）。 */
  builtinTools: string[];
  /** 已挂载的 MCP 服务器名（工具清单由 MCP 服务器自身决定，此处不可见）。 */
  mcpServers: string[];
  promptGuidelines: string[];
  limits: AgentRuntimeLimitsDescription | null;
  capabilities: RuntimeCapabilities;
}

export interface AgentRuntime {
  readonly id: string;
  getCapabilities(): Promise<RuntimeCapabilities>;
  start(input: StartRuntimeRunInput): Promise<RuntimeRun>;
  resume(input: ResumeRuntimeRunInput): Promise<RuntimeRun>;
  sendInput(runId: string, input: string): Promise<void>;
  cancel(runId: string): Promise<void>;
  deleteSession(runtimeSessionRef: string): Promise<void>;
  dispose(): Promise<void>;
  /** 调试面板用：描述实际装配的 systemPrompt/工具/模型参数。可选，旧实现可不提供。 */
  describe?(): Promise<AgentRuntimeDescription>;
}
