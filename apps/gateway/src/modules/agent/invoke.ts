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
        // ACP 渠道的 cancel 会向 adapter 子进程 stdin 写 JSON-RPC：子进程已死
        // 时 write 照样 reject（child.stdin 的 'error' 监听只吞流事件），漏接
        // 即未处理拒绝、杀进程（2026-10-17 排障）。超时本就要放弃本次调用，
        // cancel 失败只记日志。
        runtime.cancel(runId).catch((error: unknown) => {
          console.warn(`[agent-invoke] cancel after timeout failed (${options.pageLabel}):`, error);
        });
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
