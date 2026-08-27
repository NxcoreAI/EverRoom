import type {
  AgentActiveDocumentContext,
  AgentRoomReference,
  CreateContextRoomInput,
  CreateContextRoomResult,
  DocumentCapabilityManifest,
  DocumentOperation,
  DocumentOperationCommandInput,
} from "@nxcore/agent-contract";
import type {
  AddDocumentOperationItemInput,
  CreateDocumentOperationInput,
  DocumentOperationCommandMutation,
} from "../operations/service.js";

export interface DocumentExecutionContext {
  agentSessionId: string;
  runId: string;
  roomId: string | null;
  availableRooms?: AgentRoomReference[];
  activeDocument?: AgentActiveDocumentContext;
}

export interface DocumentRoomRegistry {
  listReferences(): AgentRoomReference[];
  createRoom(input: CreateContextRoomInput): Promise<CreateContextRoomResult>;
}

export interface DocumentToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
}

export type DocumentToolResult = Record<string, unknown> & {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
};

export interface DocumentCapabilityTool extends DocumentToolDefinition {
  execute(
    args: Record<string, unknown>,
    context: DocumentExecutionContext,
  ): Promise<DocumentToolResult> | DocumentToolResult;
}

export interface DocumentCapabilityPlugin {
  manifest: DocumentCapabilityManifest;
  promptGuidelines: readonly string[];
  tools: readonly DocumentCapabilityTool[];
  start?(
    request: NormalizedStartDocumentOperationInput,
  ): Promise<DocumentOperationPlan> | DocumentOperationPlan;
  command?(
    operation: DocumentOperation,
    command: DocumentOperationCommandInput,
  ): Promise<DocumentOperationCommandMutation> | DocumentOperationCommandMutation;
  recover?(): Promise<void> | void;
}

export interface DocumentOperationPlan {
  operation: CreateDocumentOperationInput;
  items?: AddDocumentOperationItemInput[];
}

/**
 * 已归一化的 start 请求：路由层会把 invocationId 溯源映射为 sessionId = runId = invocationId，
 * 插件拿到的 context 恒有 sessionId/runId（落库形状与主 Agent 会话溯源一致）。
 */
export interface NormalizedStartDocumentOperationInput {
  capabilityId: string;
  context: {
    roomId: string;
    documentId?: string;
    sessionId: string;
    runId: string;
  };
  input: Record<string, unknown>;
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function success(value: unknown): DocumentToolResult {
  const structuredContent = record(value);
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent,
  };
}

export function stringArg(args: Record<string, unknown>, name: string, allowEmpty = false): string {
  const value = args[name];
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`INVALID_REQUEST: ${name} is required`);
  }
  return value;
}

export function integerArg(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`INVALID_REQUEST: ${name} must be a non-negative integer`);
  }
  return Number(value);
}
