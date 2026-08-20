import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "@nxcore/agent-runtime";
import type { AgentResolver } from "./resolver.js";

export interface InvokeAgentOptions {
  sessionId?: string;
  pageLabel?: string;
  timeoutMs?: number;
}

export async function invokeAgent(
  resolver: AgentResolver,
  agentId: string,
  prompt: string,
  options: InvokeAgentOptions = {},
): Promise<string> {
  return invokeRuntime(resolver.resolve(agentId), prompt, {
    sessionId: options.sessionId ?? `${agentId}:${randomUUID()}`,
    pageLabel: options.pageLabel ?? agentId,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

export async function invokeRuntime(
  runtime: AgentRuntime,
  prompt: string,
  options: Required<Pick<InvokeAgentOptions, "sessionId" | "pageLabel">> & Pick<InvokeAgentOptions, "timeoutMs">,
): Promise<string> {
  const runId = randomUUID();
  const controller = new AbortController();
  const timeout = options.timeoutMs
    ? setTimeout(() => {
        controller.abort();
        void runtime.cancel(runId);
      }, options.timeoutMs)
    : null;
  timeout?.unref();
  let runtimeSessionRef: string | null = null;
  try {
    const run = await runtime.start({
      runId,
      sessionId: options.sessionId,
      runtimeSessionRef: null,
      prompt,
      pageLabel: options.pageLabel,
      roomId: null,
      captureMemory: false,
      recallMemory: false,
    });
    runtimeSessionRef = run.runtimeSessionRef;
    let content = "";
    for await (const event of run.events) {
      if (controller.signal.aborted) throw new Error(`Agent invocation timed out: ${options.pageLabel}`);
      if (event.type === "message.completed") {
        const value = (event.payload as { content?: unknown }).content;
        if (typeof value === "string") content = value;
      }
      if (event.type === "run.failed" || event.type === "run.cancelled" || event.type === "run.interrupted") {
        const message = (event.payload as { message?: unknown }).message;
        throw new Error(typeof message === "string" ? message : `Agent invocation failed: ${options.pageLabel}`);
      }
    }
    if (!content.trim()) throw new Error(`Agent returned empty content: ${options.pageLabel}`);
    return content;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (runtimeSessionRef) await runtime.deleteSession(runtimeSessionRef).catch(() => undefined);
  }
}
