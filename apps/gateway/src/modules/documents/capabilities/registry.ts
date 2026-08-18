import type {
  DocumentCapabilityManifest,
  DocumentOperation,
  DocumentOperationCommandInput,
  StartDocumentOperationInput,
} from "@nxcore/agent-contract";
import { DocumentServiceError } from "../errors.js";
import type { DocumentOperationCommandMutation } from "../operations/service.js";
import type { DocumentOperationService } from "../operations/service.js";
import type {
  DocumentCapabilityPlugin,
  DocumentCapabilityTool,
  DocumentExecutionContext,
  DocumentToolDefinition,
  DocumentToolResult,
} from "./types.js";

export class DocumentCapabilityRegistry {
  private readonly plugins = new Map<string, DocumentCapabilityPlugin>();
  private readonly tools = new Map<string, DocumentCapabilityTool>();

  constructor(private readonly operations?: DocumentOperationService) {}

  register(plugin: DocumentCapabilityPlugin): this {
    if (this.plugins.has(plugin.manifest.id)) {
      throw new Error(`Duplicate document capability: ${plugin.manifest.id}`);
    }
    for (const tool of plugin.tools) {
      if (this.tools.has(tool.name)) throw new Error(`Duplicate document tool: ${tool.name}`);
    }
    this.plugins.set(plugin.manifest.id, plugin);
    for (const tool of plugin.tools) this.tools.set(tool.name, tool);
    return this;
  }

  listTools(): DocumentToolDefinition[] {
    return [...this.tools.values()].map(({ execute: _execute, ...definition }) => definition);
  }

  promptGuidelines(): string[] {
    return [...new Set([...this.plugins.values()].flatMap((plugin) => plugin.promptGuidelines))];
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context: DocumentExecutionContext,
  ): Promise<DocumentToolResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`METHOD_NOT_FOUND: Unknown tool ${name}`);
    const plugin = [...this.plugins.values()].find((candidate) => candidate.tools.includes(tool));
    if (plugin) this.assertContext(plugin.manifest, context, args);
    return await tool.execute(args, context);
  }

  async command(
    operation: DocumentOperation,
    command: DocumentOperationCommandInput,
  ): Promise<DocumentOperationCommandMutation> {
    const plugin = this.plugins.get(operation.capabilityId);
    if (!plugin?.command) {
      throw new DocumentServiceError(
        "UNSUPPORTED_OPERATION_COMMAND",
        `Capability ${operation.capabilityId} does not handle operation commands`,
        409,
      );
    }
    if (operation.capabilityVersion !== plugin.manifest.version
      || operation.interactionMode !== plugin.manifest.interactionMode
      || operation.presenterKey !== plugin.manifest.presenterKey) {
      throw new DocumentServiceError(
        "OPERATION_MANIFEST_MISMATCH",
        `Operation ${operation.id} does not match capability ${operation.capabilityId}`,
        409,
      );
    }
    if (!plugin.manifest.permissions.includes("document:write")) {
      throw new DocumentServiceError(
        "CAPABILITY_PERMISSION_DENIED",
        `Capability ${operation.capabilityId} cannot mutate documents`,
        403,
      );
    }
    return await plugin.command(operation, command);
  }

  async start(request: StartDocumentOperationInput): Promise<DocumentOperation> {
    const plugin = this.plugins.get(request.capabilityId);
    if (!plugin?.start || !this.operations) {
      throw new DocumentServiceError(
        "UNSUPPORTED_DOCUMENT_CAPABILITY",
        `Capability ${request.capabilityId} cannot start an operation`,
        409,
      );
    }
    this.assertContext(plugin.manifest, {
      agentSessionId: request.context.sessionId,
      runId: request.context.runId,
      roomId: request.context.roomId,
      ...(request.context.documentId ? { activeDocument: {
        roomId: request.context.roomId,
        documentId: request.context.documentId,
        title: "",
        version: 0,
        defaultAnchor: "end",
      } } : {}),
    });
    const plan = await plugin.start(request);
    if (plan.operation.capabilityId !== plugin.manifest.id
      || plan.operation.capabilityVersion !== plugin.manifest.version
      || plan.operation.interactionMode !== plugin.manifest.interactionMode
      || plan.operation.presenterKey !== plugin.manifest.presenterKey
      || plan.operation.roomId !== request.context.roomId
      || plan.operation.sessionId !== request.context.sessionId
      || plan.operation.runId !== request.context.runId
      || (plan.operation.documentId ?? undefined) !== request.context.documentId) {
      throw new DocumentServiceError(
        "OPERATION_PLAN_INVALID",
        `Capability ${request.capabilityId} returned an invalid operation plan`,
        500,
      );
    }
    const operation = this.operations.create(plan.operation);
    if (!plan.items?.length) return operation;
    const prepared = await this.operations.execute(operation.id, {
      commandId: `${operation.id}:start`,
      expectedRevision: operation.revision,
      type: "operation.start",
      payload: { itemCount: plan.items.length },
    }, () => ({
      status: "awaiting_review",
      addItems: plan.items ?? [],
      expiresAt: null,
    }));
    return prepared.operation;
  }

  async recover(): Promise<void> {
    for (const plugin of this.plugins.values()) await plugin.recover?.();
  }

  private assertContext(
    manifest: DocumentCapabilityManifest,
    context: DocumentExecutionContext,
    args: Record<string, unknown> = {},
  ): void {
    if (manifest.requiresRoom && !context.roomId) {
      throw new DocumentServiceError("ROOM_SELECTION_REQUIRED", "ROOM_SELECTION_REQUIRED: Select a Context Room before using this capability", 409);
    }
    const hasRunOperation = manifest.type === "mutation"
      && typeof this.operations?.list === "function"
      && this.operations.list({
        sessionId: context.agentSessionId,
        runId: context.runId,
        active: true,
      }).length > 0;
    if (manifest.requiresDocument
      && !context.activeDocument?.documentId
      && ![args.documentId, args.operationId]
        .some((value) => typeof value === "string" && value.trim())
      && !hasRunOperation) {
      throw new DocumentServiceError("DOCUMENT_SELECTION_REQUIRED", "DOCUMENT_SELECTION_REQUIRED: Select a document before using this capability", 409);
    }
    if (manifest.type === "mutation" && !manifest.permissions.includes("document:write")) {
      throw new DocumentServiceError("CAPABILITY_PERMISSION_DENIED", `Capability ${manifest.id} cannot write documents`, 403);
    }
  }
}
