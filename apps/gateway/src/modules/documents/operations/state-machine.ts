import type { DocumentOperationStatus } from "@nxcore/agent-contract";
import { DocumentServiceError } from "../errors.js";

const transitions: Readonly<Record<DocumentOperationStatus, ReadonlySet<DocumentOperationStatus>>> = {
  created: new Set(["running", "conflicted", "cancelled", "failed"]),
  running: new Set(["awaiting_input", "awaiting_review", "applying", "completed", "conflicted", "cancelled", "failed", "expired"]),
  awaiting_input: new Set(["running", "awaiting_review", "applying", "conflicted", "cancelled", "failed", "expired"]),
  awaiting_review: new Set(["applying", "rejected", "conflicted", "cancelled", "failed"]),
  applying: new Set(["awaiting_review", "completed", "conflicted", "failed"]),
  completed: new Set(),
  rejected: new Set(),
  conflicted: new Set(["cancelled"]),
  failed: new Set(),
  cancelled: new Set(),
  expired: new Set(),
};

export const ACTIVE_DOCUMENT_OPERATION_STATUSES: readonly DocumentOperationStatus[] = [
  "created",
  "running",
  "awaiting_input",
  "awaiting_review",
  "applying",
];

export const TERMINAL_DOCUMENT_OPERATION_STATUSES: ReadonlySet<DocumentOperationStatus> = new Set([
  "completed",
  "rejected",
  "conflicted",
  "failed",
  "cancelled",
  "expired",
]);

export function assertDocumentOperationTransition(
  current: DocumentOperationStatus,
  next: DocumentOperationStatus,
): void {
  if (current === next || transitions[current].has(next)) return;
  throw new DocumentServiceError(
    "INVALID_OPERATION_TRANSITION",
    `Document operation cannot transition from ${current} to ${next}`,
    409,
  );
}
