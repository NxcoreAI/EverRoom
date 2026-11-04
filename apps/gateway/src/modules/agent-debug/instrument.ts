import type { AgentDebugAgentKind, AgentDebugRunStatus } from "@nxcore/agent-contract";
import type {
  AgentRuntime,
  ResumeRuntimeRunInput,
  RuntimeEvent,
  RuntimeRun,
  StartRuntimeRunInput,
} from "@nxcore/agent-runtime";
import type { AgentDebugTraceStore } from "./trace-store.js";

/**
 * 从 runtime 元数据里取「逐页任务」的页序。
 *
 * slides-layouter 的 dispatch input 顶层带 0 起 `pageIndex` + `totalPages`
 * （见 `slides-layout-tail.ts` 的 `layouterInputFor`），orchestrator 会把它放进
 * `runtimeMetadata.subagentInput`。调试页展示用 1 起页序；非逐页任务返回 null。
 */
export function slidePageOfRuntimeMetadata(
  metadata: Record<string, unknown> | undefined,
): { pageIndex: number; pageCount: number | null } | null {
  if (!metadata) return null;
  const subagentInput = metadata.subagentInput;
  if (typeof subagentInput !== "object" || subagentInput === null || Array.isArray(subagentInput)) return null;
  const record = subagentInput as Record<string, unknown>;
  const zeroBased = record.pageIndex;
  if (typeof zeroBased !== "number" || !Number.isInteger(zeroBased) || zeroBased < 0 || zeroBased > 31) return null;
  const totalPages = record.totalPages;
  const pageCount = typeof totalPages === "number" && Number.isInteger(totalPages) && totalPages > 0
    ? totalPages
    : null;
  return { pageIndex: zeroBased + 1, pageCount };
}

/** 被 trace 的 Agent 身份（来自 AgentResolver 定义 / 子 Agent manifest / 本机 Agent target）。 */
export interface AgentDebugTraceDescriptor {
  agentId: string;
  agentName: string;
  agentKind: AgentDebugAgentKind;
  description?: string;
}

const TERMINAL_STATUS_BY_EVENT: Partial<Record<RuntimeEvent["type"], AgentDebugRunStatus>> = {
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
  "run.interrupted": "interrupted",
};

const TRACE_MARK = Symbol.for("nxcore.agent-debug.traced");
const tracedRuntimes = new WeakSet<AgentRuntime>();

function isTraced(runtime: AgentRuntime): boolean {
  return tracedRuntimes.has(runtime)
    || (runtime as unknown as Record<symbol, unknown>)[TRACE_MARK] === true;
}

function markTraced(runtime: AgentRuntime): void {
  tracedRuntimes.add(runtime);
  (runtime as unknown as Record<symbol, unknown>)[TRACE_MARK] = true;
}

function terminalStatus(event: RuntimeEvent): AgentDebugRunStatus | null {
  return TERMINAL_STATUS_BY_EVENT[event.type] ?? null;
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function eventErrorMessage(event: RuntimeEvent): string | null {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const message = (payload as Record<string, unknown>).message;
  return typeof message === "string" && message.length > 0 ? message : null;
}

/**
 * 在 AgentRuntime 边界记录调试事件。
 *
 * 包装 `start()` / `resume()`：run 开始时 `beginRun`，事件流逐条 `recordEvent`，
 * `run.*` 终态事件、事件流抛错或迭代提前结束时 `finishRun`。事件原样向下游
 * 透传（顺序不变、异常照抛）；store 自身的任何异常都不会影响 Agent 行为。
 * 同一 runtime 重复调用只包装一次（WeakSet + Symbol 双保险）。
 */
export function traceRuntime(
  runtime: AgentRuntime,
  store: AgentDebugTraceStore,
  descriptor: AgentDebugTraceDescriptor,
): AgentRuntime {
  if (isTraced(runtime)) return runtime;
  if (typeof runtime.start !== "function" || typeof runtime.resume !== "function") return runtime;
  const originalStart = runtime.start.bind(runtime);
  const originalResume = runtime.resume.bind(runtime);

  const begin = (input: StartRuntimeRunInput | ResumeRuntimeRunInput): string => {
    try {
      const slidePage = slidePageOfRuntimeMetadata(input.runtimeMetadata);
      store.beginRun({
        runId: input.runId,
        agentId: descriptor.agentId,
        agentName: descriptor.agentName,
        agentKind: descriptor.agentKind,
        runtimeId: runtime.id,
        sessionId: input.sessionId,
        pageLabel: input.pageLabel,
        task: (input.originalPrompt ?? input.prompt).trim(),
        ...(slidePage ? { slidePageIndex: slidePage.pageIndex } : {}),
        ...(slidePage && slidePage.pageCount !== null ? { slidePageCount: slidePage.pageCount } : {}),
        ...(descriptor.description ? { agentDescription: descriptor.description } : {}),
      });
    } catch {
      // 调试数据面失败绝不阻断 Agent run。
    }
    return input.runId;
  };

  const record = (runId: string, event: RuntimeEvent): void => {
    try {
      store.recordEvent(runId, event);
    } catch {
      // 同上：trace 是旁路。
    }
  };

  const finish = (runId: string, status: AgentDebugRunStatus, message?: string | null): void => {
    try {
      store.finishRun(runId, status, message ?? null);
    } catch {
      // 同上：trace 是旁路。
    }
  };

  const observe = (source: AsyncIterable<RuntimeEvent>, runId: string): AsyncIterable<RuntimeEvent> => ({
    async *[Symbol.asyncIterator]() {
      let finished = false;
      try {
        for await (const event of source) {
          record(runId, event);
          const status = terminalStatus(event);
          if (status) {
            finished = true;
            finish(runId, status, eventErrorMessage(event));
          }
          yield event;
        }
      } catch (error) {
        if (!finished) finish(runId, "failed", errorMessageOf(error));
        throw error;
      } finally {
        // 消费者提前 break / 迭代结束但没收到终态事件：按 interrupted 收尾。
        if (!finished) finish(runId, "interrupted");
      }
    },
  });

  const start = async (input: StartRuntimeRunInput): Promise<RuntimeRun> => {
    const runId = begin(input);
    try {
      const runtimeRun = await originalStart(input);
      return { ...runtimeRun, events: observe(runtimeRun.events, runId) };
    } catch (error) {
      finish(runId, "failed", errorMessageOf(error));
      throw error;
    }
  };

  const resume = async (input: ResumeRuntimeRunInput): Promise<RuntimeRun> => {
    const runId = begin(input);
    try {
      const runtimeRun = await originalResume(input);
      return { ...runtimeRun, events: observe(runtimeRun.events, runId) };
    } catch (error) {
      finish(runId, "failed", errorMessageOf(error));
      throw error;
    }
  };

  const target = runtime as AgentRuntime & {
    start: typeof runtime.start;
    resume: typeof runtime.resume;
  };
  target.start = start;
  target.resume = resume;
  markTraced(target);
  return target;
}
