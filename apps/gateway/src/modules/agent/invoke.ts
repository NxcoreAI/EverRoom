import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "@nxcore/agent-runtime";
import type { AgentResolver } from "./resolver.js";

export interface InvokeAgentOptions {
  sessionId?: string;
  pageLabel?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
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
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

export async function invokeRuntime(
  runtime: AgentRuntime,
  prompt: string,
  options: Required<Pick<InvokeAgentOptions, "sessionId" | "pageLabel">> & Pick<InvokeAgentOptions, "timeoutMs" | "signal">,
): Promise<string> {
  const runId = randomUUID();
  const controller = new AbortController();
  let started = false;
  const cancel = () => {
    if (!started) return;
    // An ACP adapter may have exited before it can receive the cancellation.
    void runtime.cancel(runId).catch((error: unknown) => {
      console.warn(`[agent-invoke] cancel failed (${options.pageLabel}):`, error);
    });
  };
  const abort = (message: string) => {
    controller.abort(new Error(message));
    cancel();
  };
  const onAbort = () => abort(`Agent invocation cancelled: ${options.pageLabel}`);
  if (options.signal?.aborted) onAbort();
  controller.signal.throwIfAborted();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = options.timeoutMs ? setTimeout(() => {
    abort(`Agent invocation timed out: ${options.pageLabel}`);
  }, options.timeoutMs) : null;
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
    started = true;
    runtimeSessionRef = run.runtimeSessionRef;
    if (controller.signal.aborted) cancel();
    let content = "";
    for await (const event of run.events) {
      controller.signal.throwIfAborted();
      if (event.type === "message.completed") {
        const value = (event.payload as { content?: unknown }).content;
        if (typeof value === "string") content = value;
      }
      if (event.type === "run.failed" || event.type === "run.cancelled" || event.type === "run.interrupted") {
        const message = (event.payload as { message?: unknown }).message;
        throw new Error(typeof message === "string" ? message : `Agent invocation failed: ${options.pageLabel}`);
      }
    }
    controller.signal.throwIfAborted();
    if (!content.trim()) throw new Error(`Agent returned empty content: ${options.pageLabel}`);
    return content;
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
    if (runtimeSessionRef) await runtime.deleteSession(runtimeSessionRef).catch(() => undefined);
  }
}
