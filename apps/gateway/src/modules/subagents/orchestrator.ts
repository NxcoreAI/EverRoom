import { abortableDelay } from "./slides-generation-budget.js";
import { randomUUID } from "node:crypto";
import type {
  AgentContextUsage,
  SubagentInvocation,
  SubagentInvocationEvent,
  SubagentInvocationNode,
  SubagentInvocationResult,
  SubagentInvocationSource,
  SubagentInvocationStatus,
} from "@nxcore/agent-contract";
import type { AgentRuntime, RuntimeAttachment, RuntimeEvent } from "@nxcore/agent-runtime";
import { Ajv, type ValidateFunction } from "ajv";
import { asc, and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
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
  /**
   * 图片等富附件（dataUrl）：直透 runtime.start 的 attachments 供多模态模型原生看图。
   * 不落库（base64 体积大）、不拼 prompt 文本——input JSON 里不携带。
   */
  attachments?: RuntimeAttachment[];
  idempotencyKey: string;
  source: SubagentInvocationSource;
  parentSessionId?: string | null;
  parentRunId?: string | null;
  signal?: AbortSignal;
  /**
   * 本次调用的实际耗时上限（毫秒）。只允许比 agent 定义的 policy.timeoutMs 更紧，
   * 用于分批链路（如 arrange 单批 8 页）——单批卡死时不必占满整册预算。
   */
  timeoutMs?: number;
  /** Cumulative model usage, including failed/cancelled runs when provided by the runtime. */
  onUsage?: (invocationId: string, usage: Record<string, unknown>) => void;
  /**
   * invocationId 生成即回调（幂等命中时回传既有 id）：供调用方在子 run 开跑前
   * 以该 id 注册跨模块运行时状态（如 PPT 逐页审阅闸门 arm）。
   */
  onInvocationId?: (invocationId: string) => void;
}

interface ActiveInvocation {
  runtime: AgentRuntime;
  promise: Promise<SubagentInvocation>;
  /** 占用的是哪个 revision 的 runtime（调用结束要归还，供热重载延迟回收）。 */
  revisionId: string;
  cancellationRequested: boolean;
  /** 该 invocation 归属的 agent 定义 id：并发池按它分池（slides-* 走 slides 池）。 */
  agentDefinitionId: string;
}

/**
 * 并发池：
 * - `slides`：逐页布局 / 逐页审阅——批式、直接决定用户等待时长，独占大池；
 * - `background`：影子/旁路作业（如 slides-editor 的 storyboard 阴影压缩）。
 *   它**不参与交付**，却和布局抢同一个窗口——实测 2026-10-21 当天 editor 吃掉
 *   168 分钟 agent 时间（相当于 layouter 的 29%）。给它单独的小池，保证布局永远
 *   不会排在影子作业后面。
 * - `default`：交互链路（context-room / doc-writer 等）。
 */
export type SubagentPool = "slides" | "background" | "default";

const BACKGROUND_AGENT_IDS = new Set(["slides-editor"]);

/** agent 定义 id → 并发池。 */
export function subagentPoolOf(agentDefinitionId: string): SubagentPool {
  if (BACKGROUND_AGENT_IDS.has(agentDefinitionId)) return "background";
  return agentDefinitionId.startsWith("slides-") ? "slides" : "default";
}

const poolOf = subagentPoolOf;

/**
 * 某个池的实际并发上限。
 * 未显式配置（老 config / 测试只给 maxConcurrent）时沿用 `maxConcurrent`，
 * 即退化为「单一全局池」，行为与分池之前完全一致；配置了也不会突破全池总上限。
 */
export function resolvePoolLimit(
  config: Pick<
    SubagentFrameworkConfig,
    "maxConcurrent" | "slidesMaxConcurrent" | "defaultMaxConcurrent" | "backgroundMaxConcurrent"
  >,
  pool: SubagentPool,
): number {
  const configured = pool === "slides"
    ? config.slidesMaxConcurrent
    : pool === "background"
      ? config.backgroundMaxConcurrent
      : config.defaultMaxConcurrent;
  return Math.max(1, Math.min(configured ?? config.maxConcurrent, config.maxConcurrent));
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

  /**
   * 一次调用的执行事件（含每次工具调用），afterSeq 增量拉取。该事件流是
   * 渲染子代理工具流的唯一数据源，消费方（对话时间线）按 seq 递进轮询。
   */
  listInvocationEvents(invocationId: string, afterSeq = 0): SubagentInvocationEvent[] {
    return this.db.select().from(subagentInvocationEvents)
      .where(and(
        eq(subagentInvocationEvents.invocationId, invocationId),
        gt(subagentInvocationEvents.seq, afterSeq),
      ))
      .orderBy(asc(subagentInvocationEvents.seq))
      .all()
      .map((row) => ({
        id: row.id,
        invocationId: row.invocationId,
        type: row.type as SubagentInvocationEvent["type"],
        seq: row.seq,
        payload: row.payload,
        occurredAt: row.createdAt.toISOString(),
      }));
  }

  /**
   * 一次 run 的子代理调用树（扁平返回，renderer 据此拼父子链）：
   * 第一层 = parentRunId 命中该 run 的调用，其后逐层取「父为已收录调用」的后代，
   * createdAt 升序。上限 200 条 / 5 层——仅作展示，防脏数据把查询拖成全表回放。
   */
  listInvocationTree(rootRunId: string): SubagentInvocationNode[] {
    const collected = new Map<string, SubagentInvocationNode>();
    let frontier = this.db.select().from(subagentInvocations)
      .where(eq(subagentInvocations.parentRunId, rootRunId))
      .orderBy(asc(subagentInvocations.createdAt))
      .all()
      .map((row) => this.toInvocationNode(row));
    for (const node of frontier) collected.set(node.id, node);
    for (let depth = 1; frontier.length > 0 && collected.size < 200 && depth < 5; depth += 1) {
      frontier = this.db.select().from(subagentInvocations)
        .where(inArray(subagentInvocations.parentRunId, frontier.map((node) => node.id)))
        .orderBy(asc(subagentInvocations.createdAt))
        .all()
        .map((row) => this.toInvocationNode(row))
        .filter((node) => !collected.has(node.id));
      for (const node of frontier) collected.set(node.id, node);
    }
    const nodes = [...collected.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt));
    return this.withContextState(nodes);
  }

  private toInvocationNode(row: typeof subagentInvocations.$inferSelect): SubagentInvocationNode {
    const invocation = toInvocation(row);
    return {
      ...invocation,
      agentName: this.registry.get(invocation.agentDefinitionId)?.name ?? invocation.agentDefinitionId,
    };
  }

  /**
   * 给调用树节点补上「该子代理自己的上下文用量」：每个 invocation 取最近一次
   * context.usage 快照与最新 context.compaction 信号。用量来自子 run 自己的
   * runtime 事件（consumeEvents 已落库），这里只按本次树里的 id 做一次有界查询，
   * 避免渲染层为每个子代理单独轮询事件流。
   */
  private withContextState(nodes: SubagentInvocationNode[]): SubagentInvocationNode[] {
    if (nodes.length === 0) return nodes;
    const rows = this.db.select().from(subagentInvocationEvents)
      .where(and(
        inArray(subagentInvocationEvents.invocationId, nodes.map((node) => node.id)),
        inArray(subagentInvocationEvents.type, ["context.usage", "context.compaction"]),
      ))
      .orderBy(asc(subagentInvocationEvents.invocationId), asc(subagentInvocationEvents.seq))
      .all();
    const states = new Map<string, { usage?: AgentContextUsage; compacting?: boolean }>();
    for (const row of rows) {
      const state = states.get(row.invocationId) ?? {};
      if (row.type === "context.usage") {
        const payload = row.payload as Partial<AgentContextUsage> | null;
        // 与渲染层折叠口径一致：窗口未知的快照不采用（压缩刚结束时 tokens 可为 null）。
        if (payload && typeof payload.contextWindow === "number" && payload.contextWindow > 0) {
          const segments = Array.isArray(payload.segments)
            ? payload.segments.filter(
              (segment): segment is NonNullable<AgentContextUsage["segments"]>[number] =>
                typeof segment?.key === "string" && typeof segment?.tokens === "number",
            )
            : [];
          state.usage = {
            tokens: typeof payload.tokens === "number" ? payload.tokens : null,
            contextWindow: payload.contextWindow,
            percent: typeof payload.percent === "number" ? payload.percent : null,
            ...(segments.length ? { segments } : {}),
          };
        }
      } else if (row.type === "context.compaction") {
        state.compacting = (row.payload as { active?: unknown } | null)?.active === true;
      }
      states.set(row.invocationId, state);
    }
    return nodes.map((node) => {
      const state = states.get(node.id);
      if (!state) return node;
      return {
        ...node,
        ...(state.usage ? { contextUsage: state.usage } : {}),
        ...(state.compacting !== undefined ? { contextCompacting: state.compacting } : {}),
      };
    });
  }

  /**
   * 某个池的并发上限。未显式配置（老 config / 测试）时沿用 `maxConcurrent`，
   * 即退化为「单一全局池」，行为与分池之前完全一致。
   */
  private poolLimit(pool: SubagentPool): number {
    return resolvePoolLimit(this.config, pool);
  }

  /** 该池当前在飞的 invocation 数（内存计数，避免每次 dispatch 都查库）。 */
  private activeInPool(pool: SubagentPool): number {
    let count = 0;
    for (const active of this.active.values()) {
      if (poolOf(active.agentDefinitionId) === pool) count += 1;
    }
    return count;
  }

  /** 该池是否还有空位（全池总上限与池上限同时满足）。 */
  private hasCapacity(pool: SubagentPool): boolean {
    if (this.active.size >= this.config.maxConcurrent) return false;
    return this.activeInPool(pool) < this.poolLimit(pool);
  }

  /**
   * 等某个池出现空位（框架本身无排队，dispatch 满窗即硬拒）。
   * 长链路（逐页布局/审页）在 dispatch 被拒后用它做容量等待，而不是短退避后
   * 立刻降级——2026-10-20 事故：首轮落页失败留下的孤儿 invocation 占满窗口，
   * 重试的 20 页布局全被拒 → 整册兜底版式。返回 false 表示等到超时仍满窗。
   */
  async awaitCapacity(timeoutMs = 60_000, pollMs = 500, agentId?: string, signal?: AbortSignal): Promise<boolean> {
    const pool = poolOf(agentId ?? "");
    const deadline = Date.now() + Math.max(0, timeoutMs);
    signal?.throwIfAborted();
    while (!this.hasCapacity(pool)) {
      if (Date.now() >= deadline) return false;
      await abortableDelay(pollMs, signal);
    }
    return true;
  }

  /** 当前占用中的 invocation 数（诊断/测试用）。 */
  activeCount(): number {
    return this.active.size;
  }

  async dispatch(input: DispatchSubagentInput): Promise<SubagentInvocation> {
    input.signal?.throwIfAborted();
    const { invocationId, completion, joined } = await this.begin(input);
    if (joined) return completion;
    const cancelFromParent = () => {
      void this.cancel(invocationId).catch(() => undefined);
    };
    input.signal?.addEventListener("abort", cancelFromParent, { once: true });
    if (input.signal?.aborted) cancelFromParent();
    try {
      return await completion;
    } finally {
      input.signal?.removeEventListener("abort", cancelFromParent);
      const entry = this.active.get(invocationId);
      this.active.delete(invocationId);
      if (entry) this.runtimeManager.release(entry.revisionId);
    }
  }

  /**
   * 分离式调度：持久化 Invocation 并启动执行后立即返回 invocationId，
   * 不等待终态。调用方通过 GET /v1/subagent-invocations/:id 轮询结果。
   */
  async startDetached(input: DispatchSubagentInput): Promise<string> {
    input.signal?.throwIfAborted();
    const { invocationId, completion, joined } = await this.begin(input);
    if (joined) return invocationId;
    const cancelFromParent = () => {
      void this.cancel(invocationId).catch(() => undefined);
    };
    input.signal?.addEventListener("abort", cancelFromParent, { once: true });
    if (input.signal?.aborted) cancelFromParent();
    void completion.finally(() => {
      input.signal?.removeEventListener("abort", cancelFromParent);
      const entry = this.active.get(invocationId);
      this.active.delete(invocationId);
      // 归还 runtime 占用：runtime config 热重载期间被「延迟回收」的 runtime
      // 在这里才真正 dispose（在跑的调用不受重载影响）。
      if (entry) this.runtimeManager.release(entry.revisionId);
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
      input.onInvocationId?.(existing.id);
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
        // 分池诊断：哪口池满了、各自占几格。压测（NXCORE_SUBAGENT_*）靠这两列定拐点。
        pool: poolOf(input.agentId),
        activeTotal: this.active.size,
        activeSlides: this.activeInPool("slides"),
        activeDefault: this.activeInPool("default"),
      }, "subagent dispatch rejected");
      throw error;
    }
    const invocationId = randomUUID();
    input.onInvocationId?.(invocationId);
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
    const promise = this.executeInvocation(invocationId, definition, runtime, input.attachments, input.timeoutMs, input.onUsage);
    this.active.set(invocationId, {
      runtime,
      promise,
      revisionId: definition.revision.id,
      cancellationRequested: false,
      agentDefinitionId: definition.id,
    });
    return { invocationId, completion: promise, joined: false };
  }

  async cancel(invocationId: string): Promise<SubagentInvocation | null> {
    const active = this.active.get(invocationId);
    if (active) {
      active.cancellationRequested = true;
      await active.runtime.cancel(invocationId);
    }
    return this.getInvocation(invocationId);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.active.entries()].map(async ([invocationId, active]) => {
      active.cancellationRequested = true;
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
    const pool = poolOf(definition.id);
    if (this.activeInPool(pool) >= this.poolLimit(pool)) {
      // 池级拒绝沿用同一个错误码：调用方的退避/容量等待逻辑只认这一个语义。
      // 池名打在日志里（begin() 的 rejected 日志带上 error），便于区分是哪口池满了。
      throw new Error("subagent_global_concurrency_limit");
    }
    let activeForAgent = 0;
    for (const active of this.active.values()) {
      if (active.agentDefinitionId === definition.id) activeForAgent += 1;
    }
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
    attachments?: RuntimeAttachment[],
    timeoutMsOverride?: number,
    onUsage?: DispatchSubagentInput["onUsage"],
  ): Promise<SubagentInvocation> {
    const startedAt = new Date();
    // 调用方只能收紧预算，不能突破 agent 定义的 policy；分批链路用更短的单批上限。
    const timeoutMs = typeof timeoutMsOverride === "number" && Number.isFinite(timeoutMsOverride) && timeoutMsOverride > 0
      ? Math.min(timeoutMsOverride, definition.revision.policy.timeoutMs)
      : definition.revision.policy.timeoutMs;
    this.db.update(subagentInvocations).set({ status: "running", startedAt })
      .where(eq(subagentInvocations.id, invocationId)).run();
    const row = this.db.select().from(subagentInvocations)
      .where(eq(subagentInvocations.id, invocationId)).get();
    if (!row) throw new Error("subagent_invocation_not_found");
    // Phase 2i 后无 Room 维度：子 run 不再从 dispatch input 读取 roomId 绑定
    // 文档工具；子 Agent 的文档读取按工作区级（null scope）直接可用。
    const invocationInput = row.input && typeof row.input === "object" && !Array.isArray(row.input)
      ? (row.input as Record<string, unknown>)
      : null;
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
    let acceptedResult: unknown | null = null;
    let runtimeRun;
    try {
      runtimeRun = await runtime.start({
        runId: invocationId,
        sessionId: invocationId,
        runtimeSessionRef: null,
        originalPrompt: row.task,
        prompt,
        pageLabel: `Subagent: ${definition.name}`,
        toolsEnabled: true,
        // 结构化输入同时以元数据交给工具（不重复进 prompt）：工具可按阶段
        // 收紧取数，例如 planner 的 arrange 阶段不再回文档正文。
        runtimeMetadata: {
          subagentAgentId: definition.id,
          ...(invocationInput ? { subagentInput: invocationInput } : {}),
        },
        // 多模态附件（图片 dataUrl）直透 pi images；不进 prompt 文本、不落库。
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      });
      this.db.update(subagentInvocations).set({ runtimeSessionRef: runtimeRun.runtimeSessionRef })
        .where(eq(subagentInvocations.id, invocationId)).run();
      const consume = this.consumeEvents(invocationId, runtimeRun.events, (event) => {
        if (onUsage && (event.type === "context.usage" || event.type === "message.completed")) {
          const payload = event.payload as { runUsage?: Record<string, unknown>; usage?: Record<string, unknown> };
          const usage = payload.runUsage ?? payload.usage;
          if (usage) onUsage(invocationId, usage);
        }
        if (definition.revision.outputSchema && event.type === "tool.completed"
          && (event.payload as { name?: unknown }).name === "subagent_submit_result"
          && (event.payload as { result?: { details?: { accepted?: boolean } } }).result?.details?.accepted === true
          && !this.active.get(invocationId)?.cancellationRequested) {
          acceptedResult = this.runtimeManager.takeSubmittedResult(definition.revision.id, invocationId);
          if (acceptedResult !== null) return true;
        }
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
        }, timeoutMs);
        timeoutHandle.unref();
      });
      try {
        await Promise.race([consume, timeout]);
        if (acceptedResult !== null) {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          // Stop the acknowledgement request after the formal result has been validated and persisted.
          await Promise.race([runtime.cancel(invocationId).catch(() => undefined), wait(2_000)]);
          terminal = this.active.get(invocationId)?.cancellationRequested ? "cancelled" : "completed";
          terminalError = null;
        }
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
    const submittedResult = acceptedResult ?? this.runtimeManager.takeSubmittedResult(definition.revision.id, invocationId);
    if (this.active.get(invocationId)?.cancellationRequested) {
      terminal = "cancelled";
      terminalError = null;
    }
    // A validated submission is the formal result; a failed closing acknowledgement cannot revoke it.
    if (definition.revision.outputSchema && submittedResult !== null
      && (terminal === "failed" || terminal === "timed_out")) {
      this.logger.warn({ invocationId, terminal, terminalError }, "subagent closing acknowledgement failed after result submission");
      terminal = "completed";
      terminalError = null;
    }
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
    observe: (event: RuntimeEvent) => boolean | void,
  ): Promise<void> {
    let seq = 0;
    for await (const event of events) {
      const stop = observe(event);
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
      if (stop) return;
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
