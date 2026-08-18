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

export interface AgentCompletedMessageResolution {
  content: string;
  reason: string;
  operationId: string;
  operationStatus: string;
  itemCount: number;
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
  "originalCode", "repeatedAttempts",
] as const;

const NON_PROGRESS_PATCH_ERRORS = new Set([
  "EDIT_EMPTY_REPLACEMENT",
  "EDIT_NO_CHANGE",
  "EDIT_NOT_SHORTER",
  "EDIT_REPEATS_DOCUMENT",
  "CONTINUATION_REPEATS_DOCUMENT",
]);

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
  private readonly toolAttempts = new Map<string, {
    attempt: number;
    lastFailureCode?: string;
    lastInputSignature?: string;
    identicalFailureCount: number;
  }>();
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

  resolveCompletedMessage(input: {
    sessionId: string;
    runId: string;
    content: string;
  }): AgentCompletedMessageResolution | null {
    const operation = this.operations?.list({ sessionId: input.sessionId, runId: input.runId })[0];
    if (!operation) return null;
    const detail = this.operations?.get(operation.id);
    const itemCount = detail?.items.length ?? 0;
    const appliedItemCount = detail?.items.filter((item) =>
      item.status === "applied" || item.appliedVersion !== null).length ?? 0;
    const title = operation.documentTitle ? `《${operation.documentTitle}》` : "该文档";

    if (operation.status === "awaiting_review") {
      return {
        content: appliedItemCount > 0
          ? `${title}已有 ${appliedItemCount} 项修改写入，剩余建议仍需在文档中审阅。`
          : `已为${title}准备好修改建议，正文尚未更改。请在文档中审阅并接受后应用。`,
        reason: "document-operation-awaiting-review",
        operationId: operation.id,
        operationStatus: operation.status,
        itemCount,
      };
    }
    if (operation.status === "applying") {
      return {
        content: `${title}的修改建议正在应用，请稍后查看文档中的最终结果。`,
        reason: "document-operation-applying",
        operationId: operation.id,
        operationStatus: operation.status,
        itemCount,
      };
    }
    if (operation.status === "completed") {
      const action = operation.capabilityId === "document.create"
        ? "创建"
        : operation.capabilityId === "document.continue" ? "续写" : "修改";
      return {
        content: `${title}已完成${action}。`,
        reason: "document-operation-completed",
        operationId: operation.id,
        operationStatus: operation.status,
        itemCount,
      };
    }
    if (operation.status === "conflicted") {
      return {
        content: `${title}的版本已发生变化，本次修改建议未应用。请基于最新内容重试。`,
        reason: "document-operation-conflicted",
        operationId: operation.id,
        operationStatus: operation.status,
        itemCount,
      };
    }
    if (["cancelled", "failed", "expired", "rejected"].includes(operation.status)) {
      return {
        content: appliedItemCount > 0
          ? `${title}已有 ${appliedItemCount} 项修改写入，但本次操作随后中止。请检查文档后再继续。`
          : itemCount === 0
            ? `未能为${title}生成有效的修改建议，文档未发生变化。请给出更具体的修改要求后重试。`
            : `本次对${title}的修改建议已中止，文档未发生变化。`,
        reason: `document-operation-${operation.status}`,
        operationId: operation.id,
        operationStatus: operation.status,
        itemCount,
      };
    }
    return null;
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
    const inputSignature = JSON.stringify(args);
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
      let payload = documentToolErrorPayload(error);
      const failureCode = typeof payload.code === "string" ? payload.code : undefined;
      const identicalFailureCount = previous?.lastInputSignature === inputSignature
        && previous.lastFailureCode === failureCode
        ? previous.identicalFailureCount + 1
        : 1;
      if (name === "context_room_patch_hunk"
        && failureCode
        && NON_PROGRESS_PATCH_ERRORS.has(failureCode)
        && identicalFailureCount >= 2) {
        this.operations?.cancelIncompleteForSession(
          context.agentSessionId,
          `repeated-${failureCode ?? "document-tool-error"}`,
          context.runId,
        );
        const exhausted = new DocumentServiceError(
          "DOCUMENT_TOOL_RETRY_EXHAUSTED",
          "The same invalid patch_hunk arguments were submitted twice. The draft was cancelled; do not call another patch tool and tell the user that no modification was created.",
          409,
          {
            originalCode: failureCode,
            state: "cancelled",
            retryable: false,
            nextAction: "respond_document_unchanged",
            repeatedAttempts: identicalFailureCount,
            documentChanged: false,
          },
        );
        payload = documentToolErrorPayload(exhausted);
        error = exhausted;
      }
      this.toolAttempts.set(attemptKey, {
        attempt,
        ...(failureCode ? { lastFailureCode: failureCode } : {}),
        lastInputSignature: inputSignature,
        identicalFailureCount,
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
