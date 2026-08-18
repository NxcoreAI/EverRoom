import { randomUUID } from "node:crypto";
import type { DocumentExecutionContext } from "../documents/capabilities/types.js";

interface TrustedMcpSessionRecord {
  context: DocumentExecutionContext;
  expiresAt: Date;
}

const sessions = new Map<string, TrustedMcpSessionRecord>();
const MCP_SESSION_TTL_MS = 10 * 60 * 1000;

export function issueTrustedMcpSession(
  context: DocumentExecutionContext,
  ttlMs = MCP_SESSION_TTL_MS,
): { sessionId: string; expiresAt: Date } {
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + ttlMs);
  sessions.set(sessionId, { context: structuredClone(context), expiresAt });
  return { sessionId, expiresAt };
}

export function resolveTrustedMcpSession(sessionId: string): DocumentExecutionContext | null {
  const record = sessions.get(sessionId);
  if (!record) return null;
  if (record.expiresAt.getTime() <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return structuredClone(record.context);
}

export function revokeTrustedMcpSession(sessionId: string): void {
  sessions.delete(sessionId);
}
