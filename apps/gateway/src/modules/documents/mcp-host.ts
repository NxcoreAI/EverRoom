import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type JSONRPCMessage,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { createBuiltinDocumentCapabilityRegistry } from "./capabilities/builtins.js";
import { DocumentCapabilityRegistry } from "./capabilities/registry.js";
import {
  record,
  type DocumentExecutionContext,
  type DocumentRoomRegistry,
  type DocumentToolDefinition,
  type DocumentToolResult,
} from "./capabilities/types.js";
import type { DocumentService } from "./service.js";
import type { DocumentOperationService } from "./operations/service.js";
import { DocumentServiceError } from "./errors.js";
import {
  resolveTrustedMcpSession,
  revokeTrustedMcpSession,
} from "../agent/mcp-session-authority.js";

export type DocumentMcpContext = DocumentExecutionContext;
export type { DocumentRoomRegistry } from "./capabilities/types.js";
export type DocumentMcpToolDefinition = DocumentToolDefinition;
export type DocumentMcpToolResult = DocumentToolResult;

export interface DocumentToolDiagnostic {
  level: "debug" | "info" | "warn";
  event: "document.tool.completed" | "document.tool.failed";
  toolName: string;
  sessionId: string;
  runId: string;
  roomId: string | null;
  durationMs: number;
  /** Number of attempts for the same run/tool/operation/sequence tuple. */
  attempt?: number;
  /** True when this successful call follows a failed attempt. */
  recovered?: boolean;
  recoveredFromErrorCode?: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

const DIAGNOSTIC_FIELDS = [
  "documentId", "operationId", "patchId", "baseVersion", "sequence",
  "finalSequence", "acceptedSequence", "kind", "operation", "state", "applied",
  "documentChanged", "documentVersion", "nextAction", "target", "code", "statusCode",
  "currentVersion", "retryable", "invalidBlockIds", "expectedSequence", "message",
  "rejectedMarkdownBytes", "doNotRepeatPreviousArguments", "fragmentReduced",
  "readReceiptResolved", "operationIdCorrected", "blockCount",
  "operationInferred", "finalSequenceCorrected", "adjacentContextStripped",
  "requiredMaximumCharacters", "expectedFinalSequence", "beforeCharacters", "afterCharacters",
] as const;

function diagnosticPayload(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of DIAGNOSTIC_FIELDS) {
    if (value[field] !== undefined) result[field] = value[field];
  }
  if (typeof value.markdown === "string") result.markdownBytes = Buffer.byteLength(value.markdown, "utf8");
  if (typeof value.text === "string") result.textBytes = Buffer.byteLength(value.text, "utf8");
  return result;
}

export function documentToolErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof DocumentServiceError) {
    return {
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
      ...(error.details ?? {}),
    };
  }
  const message = error instanceof Error ? error.message : "Document tool failed";
  return { code: message.split(":", 1)[0], message };
}

function requestId(message: JSONRPCMessage): RequestId | undefined {
  return "id" in message ? message.id : undefined;
}

function keyFor(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

class ExchangeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  private started = false;
  private readonly pending = new Map<string, (messages: JSONRPCMessage[]) => void>();

  async start(): Promise<void> {
    this.started = true;
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const id = requestId(message);
    if (id === undefined) return;
    const resolve = this.pending.get(keyFor(id));
    if (!resolve) return;
    this.pending.delete(keyFor(id));
    resolve([message]);
  }

  async close(): Promise<void> {
    this.pending.clear();
    this.onclose?.();
  }

  exchange(message: JSONRPCMessage): Promise<JSONRPCMessage[]> {
    if (!this.started || !this.onmessage) throw new Error("MCP transport is not ready");
    const id = requestId(message);
    if (id === undefined) {
      this.onmessage(message);
      return Promise.resolve([]);
    }
    return new Promise((resolve) => {
      this.pending.set(keyFor(id), resolve);
      this.onmessage?.(message);
    });
  }
}

interface HostSession {
  server: Server;
  transport: ExchangeTransport;
  readonly context: DocumentMcpContext;
}

export class DocumentMcpHost {
  private readonly sessions = new Map<string, Promise<HostSession>>();
  private readonly toolAttempts = new Map<string, { attempt: number; lastFailureCode?: string }>();
  readonly capabilities: DocumentCapabilityRegistry;

  constructor(
    documents: DocumentService,
    rooms?: DocumentRoomRegistry,
    capabilities?: DocumentCapabilityRegistry,
    private readonly operations?: DocumentOperationService,
    private readonly onDiagnostic?: (diagnostic: DocumentToolDiagnostic) => void,
  ) {
    this.capabilities = capabilities ?? createBuiltinDocumentCapabilityRegistry(documents, rooms, operations);
  }

  listTools(): readonly DocumentMcpToolDefinition[] {
    return this.capabilities.listTools();
  }

  instructions(): string {
    return this.capabilities.promptGuidelines().join(" ");
  }

  async exchange(
    sessionId: string,
    message: Record<string, unknown>,
    context: DocumentMcpContext,
  ): Promise<Record<string, unknown>[]> {
    if (message.jsonrpc !== "2.0") throw new Error("Invalid MCP JSON-RPC message");
    let session = this.sessions.get(sessionId);
    if (message.method === "initialize") {
      if (session) {
        const previous = await session;
        await previous.server.close().catch(() => undefined);
      }
      session = this.createSession(context);
      this.sessions.set(sessionId, session);
    } else if (!session) {
      throw new Error("MCP session must start with initialize");
    }
    const current = await session;
    this.assertSameContext(current.context, context);
    return await current.transport.exchange(message as JSONRPCMessage) as Record<string, unknown>[];
  }

  async exchangeTrusted(
    sessionId: string,
    message: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const context = resolveTrustedMcpSession(sessionId);
    if (!context) throw new Error("MCP_SESSION_INVALID: Trusted MCP session is missing or expired");
    return this.exchange(sessionId, message, context);
  }

  async closeTrustedSession(sessionId: string): Promise<void> {
    revokeTrustedMcpSession(sessionId);
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (session) await (await session).server.close().catch(() => undefined);
  }

  callTool(
    name: string,
    args: Record<string, unknown>,
    context: DocumentMcpContext,
  ): Promise<DocumentMcpToolResult> {
    return this.executeTool(name, args, context);
  }

  async abortAgentSession(sessionId: string, reason: string, runId?: string): Promise<void> {
    this.operations?.cancelActiveForSession(sessionId, reason, runId);
  }

  async finishAgentRun(
    sessionId: string,
    outcome: "completed" | "failed" | "cancelled",
    runId?: string,
  ): Promise<void> {
    const reason = `pi-agent-run-${outcome}`;
    if (outcome === "completed") {
      this.operations?.cancelIncompleteForSession(sessionId, reason, runId);
      this.clearToolAttempts(runId);
      return;
    }
    this.operations?.cancelActiveForSession(sessionId, reason, runId);
    this.clearToolAttempts(runId);
  }

  async close(): Promise<void> {
    const sessions = await Promise.allSettled(this.sessions.values());
    this.sessions.clear();
    this.toolAttempts.clear();
    await Promise.all(sessions.flatMap((result) => result.status === "fulfilled"
      ? [result.value.server.close().catch(() => undefined)]
      : []));
  }

  private async createSession(context: DocumentMcpContext): Promise<HostSession> {
    const transport = new ExchangeTransport();
    const holder: HostSession = {
      server: null as unknown as Server,
      transport,
      context: structuredClone(context),
    };
    const server = new Server(
      { name: "everroom-context-room", version: "2.0.0" },
      { capabilities: { tools: {} }, instructions: this.instructions() },
    );
    holder.server = server;
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.capabilities.listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        return await this.executeTool(
          request.params.name,
          record(request.params.arguments),
          holder.context,
        );
      } catch (error) {
        const payload = documentToolErrorPayload(error);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          structuredContent: payload,
          isError: true,
        };
      }
    });
    await server.connect(transport);
    return holder;
  }

  private assertSameContext(bound: DocumentMcpContext, request: DocumentMcpContext): void {
    if (
      bound.agentSessionId !== request.agentSessionId
      || bound.runId !== request.runId
      || bound.roomId !== request.roomId
    ) {
      throw new Error("MCP_CONTEXT_MISMATCH: MCP session is bound to another Agent run or Room");
    }
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    context: DocumentMcpContext,
  ): Promise<DocumentMcpToolResult> {
    const startedAt = performance.now();
    const attemptKey = this.toolAttemptKey(name, args, context);
    const previous = this.toolAttempts.get(attemptKey);
    const attempt = (previous?.attempt ?? 0) + 1;
    try {
      const result = await this.capabilities.execute(name, args, context);
      const recoveredFromErrorCode = previous?.lastFailureCode;
      const recovered = Boolean(recoveredFromErrorCode);
      this.emitDiagnostic({
        // Hunk retries are important operational events: logging only the
        // rejection makes a recovered run look like "failed -> commit".
        level: name.endsWith("_begin") || name.endsWith("_commit") || recovered ? "info" : "debug",
        event: "document.tool.completed",
        toolName: name,
        sessionId: context.agentSessionId,
        runId: context.runId,
        roomId: context.roomId,
        durationMs: Math.round(performance.now() - startedAt),
        attempt,
        ...(recoveredFromErrorCode ? { recovered: true, recoveredFromErrorCode } : {}),
        input: diagnosticPayload(args),
        output: diagnosticPayload(result.structuredContent),
      });
      this.toolAttempts.delete(attemptKey);
      return result;
    } catch (error) {
      const payload = documentToolErrorPayload(error);
      this.toolAttempts.set(attemptKey, {
        attempt,
        ...(typeof payload.code === "string" ? { lastFailureCode: payload.code } : {}),
      });
      this.emitDiagnostic({
        level: "warn",
        event: "document.tool.failed",
        toolName: name,
        sessionId: context.agentSessionId,
        runId: context.runId,
        roomId: context.roomId,
        durationMs: Math.round(performance.now() - startedAt),
        attempt,
        input: diagnosticPayload(args),
        error: diagnosticPayload(payload),
      });
      throw error;
    }
  }

  private emitDiagnostic(diagnostic: DocumentToolDiagnostic): void {
    try {
      this.onDiagnostic?.(diagnostic);
    } catch {}
  }

  private toolAttemptKey(name: string, args: Record<string, unknown>, context: DocumentMcpContext): string {
    const operationId = typeof args.operationId === "string" ? args.operationId : "";
    const sequence = typeof args.sequence === "number" ? String(args.sequence) : "";
    return `${context.runId}:${name}:${operationId}:${sequence}`;
  }

  private clearToolAttempts(runId?: string): void {
    if (!runId) return;
    for (const key of this.toolAttempts.keys()) {
      if (key.startsWith(`${runId}:`)) this.toolAttempts.delete(key);
    }
  }
}
