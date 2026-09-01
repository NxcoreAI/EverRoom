import { randomUUID } from "node:crypto";
import type {
  SubagentInvocation,
  SubagentInvocationResult,
  SubagentInvocationSource,
  SubagentInvocationStatus,
} from "@nxcore/agent-contract";
import type { AgentRuntime, RuntimeEvent } from "@nxcore/agent-runtime";
import { Ajv, type ValidateFunction } from "ajv";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  subagentInvocationEvents,
  subagentInvocations,
} from "../../infrastructure/database/schema.js";
import type { SubagentFrameworkConfig } from "../../config.js";
import { SubagentRegistry } from "./registry.js";
import { SubagentRuntimeManager } from "./runtime-manager.js";
import type { LoadedSubagentDefinition, SubagentLogger } from "./types.js";

export interface DispatchSubagentInput {
  agentId: string;
  task: string;
  input?: unknown;
  idempotencyKey: string;
  source: SubagentInvocationSource;
  parentSessionId?: string | null;
  parentRunId?: string | null;
  signal?: AbortSignal;
}

interface ActiveInvocation {
  runtime: AgentRuntime;
  promise: Promise<SubagentInvocation>;
}

class InvocationTimeoutError extends Error {}

function isCompletedStatus(status: SubagentInvocationStatus): status is "completed" {
  return status === "completed";
}

function callerPolicyName(source: SubagentInvocationSource): string {
  if (source === "primary_agent") return "primary-agent";
  if (source === "internal_workflow") return "internal-workflow";
  return "scheduler";
}

function toInvocation(row: typeof subagentInvocations.$inferSelect): SubagentInvocation {
  return {
    id: row.id,
    agentDefinitionId: row.agentDefinitionId,
    agentRevisionId: row.agentRevisionId,
    source: row.source,
    parentSessionId: row.parentSessionId,
    parentRunId: row.parentRunId,
    task: row.task,
    input: row.input,
    status: row.status,
    result: row.result,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export class SubagentOrchestrator {
  private readonly active = new Map<string, ActiveInvocation>();
  private readonly schemaValidators = new WeakMap<Record<string, unknown>, ValidateFunction>();
  private readonly ajv = new Ajv({ strict: false, allErrors: true });

  constructor(
    private readonly db: GatewayDatabase,
    private readonly config: SubagentFrameworkConfig,
    private readonly registry: SubagentRegistry,
    private readonly runtimeManager: SubagentRuntimeManager,
    private readonly logger: SubagentLogger,
  ) {}

  initialize(): number {
    const result = this.db.update(subagentInvocations).set({
      status: "interrupted",
      errorCode: "gateway_restarted",
      errorMessage: "Gateway restarted before the invocation completed",
      completedAt: new Date(),
    }).where(inArray(subagentInvocations.status, ["accepted", "running"])).run();
    return result.changes;
  }

  listDefinitions() {
    return this.registry.listAll().map(({ revision: _revision, ...definition }) => definition);
  }

  listInvocations(limit = 100): SubagentInvocation[] {
    return this.db.select().from(subagentInvocations)
      .orderBy(desc(subagentInvocations.createdAt))
      .limit(Math.min(Math.max(limit, 1), 500))
      .all()
      .map(toInvocation);
  }

  getInvocation(invocationId: string): SubagentInvocation | null {
    const row = this.db.select().from(subagentInvocations)
      .where(eq(subagentInvocations.id, invocationId)).get();
    return row ? toInvocation(row) : null;
  }

  async dispatch(input: DispatchSubagentInput): Promise<SubagentInvocation> {
    const { invocationId, completion, joined } = await this.begin(input);
    if (joined) return completion;
    const cancelFromParent = () => {
      const runtime = this.active.get(invocationId)?.runtime;
      if (runtime) void runtime.cancel(invocationId).catch(() => undefined);
    };
    input.signal?.addEventListener("abort", cancelFromParent, { once: true });
    if (input.signal?.aborted) cancelFromParent();
    try {
      return await completion;
    } finally {
      input.signal?.removeEventListener("abort", cancelFromParent);
      this.active.delete(invocationId);
    }
  }

  /**
   * 分离式调度：持久化 Invocation 并启动执行后立即返回 invocationId，
   * 不等待终态。调用方通过 GET /v1/subagent-invocations/:id 轮询结果。
   */
  async startDetached(input: DispatchSubagentInput): Promise<string> {
    const { invocationId, completion, joined } = await this.begin(input);
    if (joined) return invocationId;
    const cancelFromParent = () => {
      const runtime = this.active.get(invocationId)?.runtime;
      if (runtime) void runtime.cancel(invocationId).catch(() => undefined);
    };
    input.signal?.addEventListener("abort", cancelFromParent, { once: true });
    if (input.signal?.aborted) cancelFromParent();
    void completion.finally(() => {
      input.signal?.removeEventListener("abort", cancelFromParent);
      this.active.delete(invocationId);
    }).catch(() => undefined);
    return invocationId;
  }

  private async begin(input: DispatchSubagentInput): Promise<{
    invocationId: string;
    completion: Promise<SubagentInvocation>;
    /** true 表示命中既有幂等记录，生命周期由原始调用方管理。 */
    joined: boolean;
  }> {
    const normalizedTask = input.task.trim();
    if (!normalizedTask) throw new Error("subagent_task_required");
    const existing = this.db.select().from(subagentInvocations).where(and(
      eq(subagentInvocations.source, input.source),
      input.parentRunId
        ? eq(subagentInvocations.parentRunId, input.parentRunId)
        : isNull(subagentInvocations.parentRunId),
      eq(subagentInvocations.idempotencyKey, input.idempotencyKey),
    )).get();
    if (existing) {
      const active = this.active.get(existing.id);
      if (active) return { invocationId: existing.id, completion: active.promise, joined: true };
      return { invocationId: existing.id, completion: Promise.resolve(toInvocation(existing)), joined: true };
    }

    const definition = this.registry.get(input.agentId);
    if (!definition || !definition.enabled) throw new Error("subagent_not_found_or_disabled");
    try {
      this.validateDispatch(definition, input);
    } catch (error) {
      // M3 观察期（方案 §5）：并发/全局限额拒绝（subagent_concurrency_limit 等）是
      // T2 的直接证据，记录后原样抛出（框架无排队，拒绝即硬失败）。
      this.logger.warn({
        agentId: input.agentId,
        task: normalizedTask,
        error: error instanceof Error ? error.message : String(error),
      }, "subagent dispatch rejected");
      throw error;
    }
    const invocationId = randomUUID();
    const now = new Date();
    this.db.insert(subagentInvocations).values({
      id: invocationId,
      agentDefinitionId: definition.id,
      agentRevisionId: definition.revision.id,
      source: input.source,
      parentSessionId: input.parentSessionId ?? null,
      parentRunId: input.parentRunId ?? null,
      idempotencyKey: input.idempotencyKey,
      task: normalizedTask,
      input: input.input ?? null,
      status: "accepted",
      createdAt: now,
    }).run();

    const runtime = this.runtimeManager.acquire(definition.revision);
    this.runtimeManager.prepareSubmittedResult(
      definition.revision.id,
      invocationId,
      input.input ?? null,
    );
    const promise = this.executeInvocation(invocationId, definition, runtime);
    this.active.set(invocationId, { runtime, promise });
    return { invocationId, completion: promise, joined: false };
  }

  async cancel(invocationId: string): Promise<SubagentInvocation | null> {
    const active = this.active.get(invocationId);
    if (active) await active.runtime.cancel(invocationId);
    return this.getInvocation(invocationId);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.active.entries()].map(async ([invocationId, active]) => {
      await active.runtime.cancel(invocationId).catch(() => undefined);
    }));
    await this.runtimeManager.dispose();
  }

  private validateDispatch(definition: LoadedSubagentDefinition, input: DispatchSubagentInput): void {
    if (!definition.revision.policy.allowedCallers.includes(
      callerPolicyName(input.source) as LoadedSubagentDefinition["revision"]["policy"]["allowedCallers"][number],
    )) {
      throw new Error("subagent_caller_not_allowed");
    }
    if (this.active.size >= this.config.maxConcurrent) throw new Error("subagent_global_concurrency_limit");
    const activeForAgent = [...this.active.keys()].filter((invocationId) => {
      const row = this.db.select({ agentDefinitionId: subagentInvocations.agentDefinitionId })
        .from(subagentInvocations).where(eq(subagentInvocations.id, invocationId)).get();
      return row?.agentDefinitionId === definition.id;
    }).length;
    if (activeForAgent >= definition.revision.policy.maxConcurrency) {
      throw new Error("subagent_concurrency_limit");
    }
    const schema = definition.revision.inputSchema;
    if (schema && !this.validateSchema(schema, input.input ?? null)) {
      throw new Error("subagent_input_schema_invalid");
    }
  }

  private async executeInvocation(
    invocationId: string,
    definition: LoadedSubagentDefinition,
    runtime: AgentRuntime,
  ): Promise<SubagentInvocation> {
    const startedAt = new Date();
    this.db.update(subagentInvocations).set({ status: "running", startedAt })
      .where(eq(subagentInvocations.id, invocationId)).run();
    const row = this.db.select().from(subagentInvocations)
      .where(eq(subagentInvocations.id, invocationId)).get();
    if (!row) throw new Error("subagent_invocation_not_found");
    const prompt = [
      "<everroom-subagent-task>",
      `任务：${row.task}`,
      `结构化输入：${JSON.stringify(row.input)}`,
      ...(definition.revision.outputSchema
        ? ["结果提交：结束前必须调用 subagent_submit_result。只有该工具成功接收的参数会作为正式结果，最终文本不会被解析为结构化结果。"]
        : []),
      "</everroom-subagent-task>",
    ].join("\n");

    let finalText = "";
    let terminal: SubagentInvocationStatus = "failed";
    let terminalError: string | null = null;
    let runtimeRun;
    try {
      runtimeRun = await runtime.start({
        runId: invocationId,
        sessionId: invocationId,
        runtimeSessionRef: null,
        originalPrompt: row.task,
        prompt,
        pageLabel: `Subagent: ${definition.name}`,
        roomId: null,
        captureMemory: false,
        recallMemory: false,
        toolsEnabled: true,
      });
      this.db.update(subagentInvocations).set({ runtimeSessionRef: runtimeRun.runtimeSessionRef })
        .where(eq(subagentInvocations.id, invocationId)).run();
      const consume = this.consumeEvents(invocationId, runtimeRun.events, (event) => {
        if (event.type === "message.completed") {
          const content = (event.payload as { content?: unknown }).content;
          if (typeof content === "string") finalText = content;
        }
        if (event.type === "run.completed") terminal = "completed";
        if (event.type === "run.cancelled") terminal = "cancelled";
        if (event.type === "run.interrupted") terminal = "interrupted";
        if (event.type === "run.failed") {
          terminal = "failed";
          terminalError = String((event.payload as { message?: unknown }).message ?? "Runtime failed");
        }
      });
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          void runtime.cancel(invocationId).catch(() => undefined);
          reject(new InvocationTimeoutError("subagent invocation timed out"));
        }, definition.revision.policy.timeoutMs);
        timeoutHandle.unref();
      });
      try {
        await Promise.race([consume, timeout]);
      } catch (error) {
        if (!(error instanceof InvocationTimeoutError)) throw error;
        await Promise.race([consume.catch(() => undefined), wait(2_000)]);
        terminal = "timed_out";
        terminalError = error.message;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    } catch (error) {
      terminal = "failed";
      terminalError = error instanceof Error ? error.message : String(error);
    }

    let result: SubagentInvocationResult | null = null;
    const submittedResult = this.runtimeManager.takeSubmittedResult(definition.revision.id, invocationId);
    if (isCompletedStatus(terminal)) {
      result = { text: finalText };
      if (Buffer.byteLength(finalText, "utf8") > 512 * 1024) {
        terminal = "failed";
        terminalError = "subagent_output_too_large";
        result = null;
      }
      if (result && definition.revision.outputSchema) {
        if (submittedResult === null) {
          terminal = "failed";
          terminalError = "subagent_result_not_submitted";
          result = null;
        } else {
          result.structuredOutput = submittedResult;
        }
      }
    }
    const completedAt = new Date();
    this.db.update(subagentInvocations).set({
      status: terminal,
      result,
      errorCode: isCompletedStatus(terminal) ? null : terminal === "timed_out" ? "timeout" : "runtime_error",
      errorMessage: terminalError,
      completedAt,
    }).where(eq(subagentInvocations.id, invocationId)).run();
    this.logger.info({
      invocationId,
      agentId: definition.id,
      revisionId: definition.revision.id,
      task: row.task,
      status: terminal,
      errorCode: terminal === "timed_out" ? "timeout" : terminalError,
      // M3 观察期（方案 §5）：T2/T3 判定数据——执行时长与派发→开跑的等待。
      durationMs: completedAt.getTime() - startedAt.getTime(),
      waitedMs: startedAt.getTime() - new Date(row.createdAt).getTime(),
    }, "subagent invocation finished");
    return this.getInvocation(invocationId)!;
  }

  private async consumeEvents(
    invocationId: string,
    events: AsyncIterable<RuntimeEvent>,
    observe: (event: RuntimeEvent) => void,
  ): Promise<void> {
    let seq = 0;
    for await (const event of events) {
      observe(event);
      seq += 1;
      const now = new Date();
      this.db.transaction((tx) => {
        tx.insert(subagentInvocationEvents).values({
          id: randomUUID(),
          invocationId,
          seq,
          type: event.type,
          payload: event.payload,
          createdAt: now,
        }).run();
        tx.update(subagentInvocations).set({ lastEventSeq: seq })
          .where(eq(subagentInvocations.id, invocationId)).run();
      });
    }
  }

  private validateSchema(schema: Record<string, unknown>, value: unknown): boolean {
    let validator = this.schemaValidators.get(schema);
    if (!validator) {
      const compiled = this.ajv.compile(schema);
      this.schemaValidators.set(schema, compiled);
      validator = compiled;
    }
    return validator(value) === true;
  }
}
