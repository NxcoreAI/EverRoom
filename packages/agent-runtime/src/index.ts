import type {
  AgentAttachmentKind,
  AgentActiveDocumentContext,
  AgentEventType,
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
