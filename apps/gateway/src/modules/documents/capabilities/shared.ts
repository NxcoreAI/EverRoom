import { createHash } from "node:crypto";
import type {
  DocumentCapabilityManifest,
  DocumentMutationTarget,
} from "@nxcore/agent-contract";
import type { DocumentService } from "../service.js";

export type CapabilityBackend = Pick<DocumentService,
  | "list"
  | "readDocumentForAgent"
  | "get"
  | "prepareOperationCommit"
  | "notifyDocumentRewriteApplied"
  | "normalizeAgentDocumentChunk"
  | "prepareAgentDocumentDraft"
  | "prepareAgentDocumentFinalize"
>;

export const annotations = (readOnlyHint: boolean, destructiveHint = false) => ({
  readOnlyHint,
  destructiveHint,
  openWorldHint: false,
});

export function manifest(
  id: string,
  type: DocumentCapabilityManifest["type"],
  interactionMode: DocumentCapabilityManifest["interactionMode"],
  presenterKey: string | null,
  requiresRoom: boolean,
  requiresDocument: boolean,
): DocumentCapabilityManifest {
  return {
    id,
    version: 1,
    type,
    interactionMode,
    presenterKey,
    permissions: type === "query"
      ? ["room:read", "document:read"]
      : ["room:read", "document:read", "document:write"],
    requiresRoom,
    requiresDocument,
  };
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function normalizePatchTarget(
  operation: "insert" | "replace" | "delete",
  value: Record<string, unknown>,
): { target: DocumentMutationTarget; corrected: boolean } {
  if (operation !== "insert"
    && typeof value.blockId === "string"
    && (value.edge === "before" || value.edge === "after")
    && value.fromOffset === undefined
    && value.toOffset === undefined) {
    return { target: { blockId: value.blockId }, corrected: true };
  }
  return { target: value as DocumentMutationTarget, corrected: false };
}
