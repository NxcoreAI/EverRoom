import type {
  AgentAttachmentKind,
  AgentActiveDocumentContext,
  AgentActiveFileContext,
  AgentEventType,
  LocalAgentDelegationContext,
  LocalAgentInvocationTarget,
  AgentOpenFileContext,
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
  availableRooms?: AgentRoomReference[];
  roomSelectionRequired?: boolean;
  captureMemory?: boolean;
  recallMemory?: boolean;
  toolsEnabled?: boolean;
  activeDocument?: AgentActiveDocumentContext;
  /** 用户当前正在浏览的 Office 文件页签（file_entries），工具按 fileId 读取正文。 */
  activeFile?: AgentActiveFileContext;
  /** 当前打开的全部 Office 页签（含 active 标记），供 Agent 感知“一共开了哪些文件”。 */
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

export interface AgentRuntime {
  readonly id: string;
  getCapabilities(): Promise<RuntimeCapabilities>;
  start(input: StartRuntimeRunInput): Promise<RuntimeRun>;
  resume(input: ResumeRuntimeRunInput): Promise<RuntimeRun>;
  sendInput(runId: string, input: string): Promise<void>;
  cancel(runId: string): Promise<void>;
  deleteSession(runtimeSessionRef: string): Promise<void>;
  dispose(): Promise<void>;
}
