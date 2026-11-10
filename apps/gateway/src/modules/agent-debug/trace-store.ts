import type {
  AgentDebugAgent,
  AgentDebugAgentKind,
  AgentDebugArchiveInfo,
  AgentDebugEvent,
  AgentDebugRun,
  AgentDebugRunStatus,
  AgentEventType,
} from "@nxcore/agent-contract";
import type { RuntimeEvent } from "@nxcore/agent-runtime";
import { DISABLED_ARCHIVE_INFO, type AgentDebugArchive } from "./archive.js";

/** 每个 run 保留的事件条数上限。 */
export const MAX_EVENTS_PER_RUN = 3_000;
/** 每个 run 保留的事件 payload 字节上限（按 run 累计）。 */
export const MAX_RUN_BYTES = 8 * 1024 * 1024;
/** 全部 run 的条数上限（超出优先淘汰最旧终态 run）。 */
export const MAX_RUNS = 150;
/** 单条事件 payload 的序列化字节预算。 */
export const MAX_EVENT_BYTES = 64 * 1024;

/** 只包含 `{ delta }` 的流式增量事件才可安全合并（尺寸可增量核算）。 */
const MERGEABLE_DELTA_TYPES = new Set<AgentEventType>(["reasoning.delta", "message.delta"]);
/** `{"delta":""}` 的字节数：合并事件的固定开销（payload 只允许一个 delta 字段）。 */
const MERGED_DELTA_BASE_BYTES = 12;

const ERROR_RUN_STATUSES = new Set<AgentDebugRunStatus>(["failed", "interrupted", "timed_out"]);

const TERMINAL_STATUS_BY_EVENT: Partial<Record<AgentEventType, AgentDebugRunStatus>> = {
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
  "run.interrupted": "interrupted",
};

export interface AgentDebugRunDescriptor {
  runId: string;
  agentId: string;
  agentName: string;
  agentKind: AgentDebugAgentKind;
  runtimeId: string | null;
  sessionId: string | null;
  pageLabel: string | null;
  task: string;
  /** 逐页任务（slides-layouter 单页布局）的页序，1 起；非逐页 run 不传。 */
  slidePageIndex?: number;
  /** 逐页任务的总页数；未知不传。 */
  slidePageCount?: number;
  /** Agent 描述（调试页 Agent 列表展示用；观测到本机 Agent 时补全）。 */
  agentDescription?: string;
}

export interface AgentDebugEventPage {
  events: AgentDebugEvent[];
  /** 当前缓冲内的最大 seq（下一次 afterSeq）。 */
  latestSeq: number;
}

/** snapshot 的归档范围：混合本次进程与历史 / 仅历史 / 仅本次进程。 */
export type AgentDebugArchivedFilter = "include" | "only" | "exclude";

interface MergedDelta {
  /** 分片保存，避免每来一个 token 就做一次整串拼接（O(n²)）。 */
  chunks: string[];
  /** delta 文本 JSON 转义后的字节数（不含两侧引号）。 */
  escapedBytes: number;
}

interface StoredEvent {
  seq: number;
  type: AgentEventType;
  occurredAt: string;
  /** 非合并事件的 payload；合并事件为 undefined（读取时由 merged 物化）。 */
  payload: unknown;
  sizeBytes: number;
  truncatedBytes?: number;
  merged?: MergedDelta;
}

interface StoredRun {
  runId: string;
  agentId: string;
  agentName: string;
  agentDescription: string;
  agentKind: AgentDebugAgentKind;
  runtimeId: string | null;
  sessionId: string | null;
  pageLabel: string | null;
  task: string;
  slidePageIndex?: number;
  slidePageCount?: number;
  status: AgentDebugRunStatus;
  startedAt: string;
  completedAt: string | null;
  lastEventAt: string | null;
  errorMessage: string | null;
  toolCallCount: number;
  reasoningChars: number;
  /** 已分配的最大 seq。 */
  sequence: number;
  /** 当前保留事件的 payload 字节数。 */
  bytes: number;
  droppedEvents: number;
  events: StoredEvent[];
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** 字符串 JSON 转义后的字节数（不含两侧引号），用于增量核算合并事件尺寸。 */
function escapedStringBytes(value: string): number {
  return byteLength(JSON.stringify(value)) - 2;
}

/** 按 UTF-8 字节数截断，且不切断多字节字符。 */
function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function mergeableDelta(event: RuntimeEvent): string | null {
  if (!MERGEABLE_DELTA_TYPES.has(event.type)) return null;
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "delta") return null;
  return typeof record.delta === "string" ? record.delta : null;
}

function payloadError(event: RuntimeEvent): string | null {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const message = (payload as Record<string, unknown>).message;
  return typeof message === "string" && message.length > 0 ? message : null;
}

function runTimestamp(run: StoredRun): number {
  return Date.parse(run.completedAt ?? run.startedAt);
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Agent 调试页数据面：只读的内存环形缓冲。
 *
 * - 单条 payload 超过 {@link MAX_EVENT_BYTES} 时截断为字符串预览并记录 `truncatedBytes`；
 * - 同 run 事件数 / 字节数超限从最旧事件淘汰，累计 `droppedEvents`；
 * - run 数超过 {@link MAX_RUNS} 时优先淘汰最旧终态 run，累计 `droppedRuns`；
 * - 相邻同类 `reasoning.delta` / `message.delta` 合并为一条累计事件（seq 不变，
 *   payload 分片保存、读取时物化），避免流式 token 把缓冲冲爆；
 * - `finishRun` 幂等：终态只写一次。
 *
 * 该模块不参与任何业务链路，store 自身异常不应影响 Agent run；`recordEvent`
 * 对未知/已淘汰 run 静默忽略。
 *
 * 可选注入 {@link AgentDebugArchive}：run 到达终态后 fire-and-forget 落盘，
 * 重启后可从归档找回历史 run（`origin:"archive"`）；归档关闭时不传实例。
 */
export class AgentDebugTraceStore {
  private readonly runs = new Map<string, StoredRun>();
  private droppedRunCount = 0;
  private disposed = false;

  constructor(private readonly archive?: AgentDebugArchive) {}

  /** 因 run 数超过缓冲上限被整体淘汰的历史 run 数。 */
  get droppedRuns(): number {
    return this.droppedRunCount;
  }

  beginRun(descriptor: AgentDebugRunDescriptor): void {
    if (this.disposed) return;
    const existing = this.runs.get(descriptor.runId);
    if (existing) {
      // resume 复用同一 runId：保留已累计的事件与计数，只把终态重新拉回 running
      // 并补齐描述信息；否则后续 run.completed 会被终态幂等逻辑忽略，调试页停在
      // 上一次的中断/失败态。
      if (existing.status !== "running") {
        existing.status = "running";
        existing.completedAt = null;
        existing.errorMessage = null;
      }
      if (!existing.agentDescription && descriptor.agentDescription) {
        existing.agentDescription = descriptor.agentDescription;
      }
      // 旧 run（页字段上线前开始）resume 时补齐逐页信息；已有值不覆盖。
      if (existing.slidePageIndex === undefined && descriptor.slidePageIndex !== undefined) {
        existing.slidePageIndex = descriptor.slidePageIndex;
        if (descriptor.slidePageCount !== undefined) existing.slidePageCount = descriptor.slidePageCount;
      }
      return;
    }
    this.runs.set(descriptor.runId, {
      runId: descriptor.runId,
      agentId: descriptor.agentId,
      agentName: descriptor.agentName,
      agentDescription: descriptor.agentDescription ?? "",
      agentKind: descriptor.agentKind,
      runtimeId: descriptor.runtimeId,
      sessionId: descriptor.sessionId,
      pageLabel: descriptor.pageLabel,
      task: descriptor.task,
      ...(descriptor.slidePageIndex === undefined ? {} : { slidePageIndex: descriptor.slidePageIndex }),
      ...(descriptor.slidePageCount === undefined ? {} : { slidePageCount: descriptor.slidePageCount }),
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      lastEventAt: null,
      errorMessage: null,
      toolCallCount: 0,
      reasoningChars: 0,
      sequence: 0,
      bytes: 0,
      droppedEvents: 0,
      events: [],
    });
    this.enforceRunLimit();
  }

  recordEvent(runId: string, event: RuntimeEvent): void {
    if (this.disposed) return;
    const run = this.runs.get(runId);
    if (!run) return;
    const occurredAt = new Date().toISOString();
    run.lastEventAt = occurredAt;
    if (event.type === "tool.started") run.toolCallCount += 1;

    const delta = mergeableDelta(event);
    if (delta !== null) {
      run.reasoningChars += event.type === "reasoning.delta" ? delta.length : 0;
      this.appendDelta(run, event.type, delta, occurredAt);
    } else {
      const encoded = this.encodePayload(event.payload);
      run.sequence += 1;
      const stored: StoredEvent = {
        seq: run.sequence,
        type: event.type,
        occurredAt,
        payload: encoded.payload,
        sizeBytes: encoded.sizeBytes,
        ...(encoded.truncatedBytes === undefined ? {} : { truncatedBytes: encoded.truncatedBytes }),
      };
      this.appendStoredEvent(run, stored);
    }

    const terminal = TERMINAL_STATUS_BY_EVENT[event.type];
    if (terminal) this.finishRun(runId, terminal, payloadError(event));
  }

  /** 幂等收尾：run 已处于终态时忽略，保证终态只写一次；终态后异步落盘归档。 */
  finishRun(runId: string, status: AgentDebugRunStatus, errorMessage?: string | null): void {
    if (this.disposed) return;
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") return;
    run.status = status;
    run.completedAt = new Date().toISOString();
    if (errorMessage) run.errorMessage = errorMessage;
    this.scheduleArchive(run);
  }

  /** 内存没有时回落到磁盘归档；未知 run 返回 null。 */
  getRun(runId: string): AgentDebugRun | null {
    const run = this.runs.get(runId);
    if (run) return this.toDebugRun(run);
    return this.archive?.getRun(runId) ?? null;
  }

  /**
   * 最近 run：运行中的永远在最前，其余按 startedAt 倒序。
   *
   * `archived` 控制是否合并磁盘归档：`include`（默认）混合本次进程与历史 run，
   * `only` 只返回历史，`exclude` 只返回本次进程。live run 补 `origin:"live"`，
   * 归档 run 由归档条目带 `origin:"archive"`；同 runId 以内存为准不重复出现。
   */
  listRuns(limit: number, archived: AgentDebugArchivedFilter = "include"): AgentDebugRun[] {
    const max = Math.max(0, limit);
    if (archived === "only") return this.archive?.listRuns(max) ?? [];
    const liveRuns = [...this.runs.values()]
      .sort((left, right) => {
        const leftRunning = left.status === "running" ? 0 : 1;
        const rightRunning = right.status === "running" ? 0 : 1;
        if (leftRunning !== rightRunning) return leftRunning - rightRunning;
        return Date.parse(right.startedAt) - Date.parse(left.startedAt);
      })
      .slice(0, max)
      .map((run): AgentDebugRun => ({ ...this.toDebugRun(run), origin: "live" }));
    if (archived === "exclude" || !this.archive) return liveRuns;
    const liveRunIds = new Set(liveRuns.map((run) => run.runId));
    const merged = [...liveRuns, ...this.archive.listRuns(max, liveRunIds)];
    merged.sort((left, right) => {
      const leftRunning = left.status === "running" ? 0 : 1;
      const rightRunning = right.status === "running" ? 0 : 1;
      if (leftRunning !== rightRunning) return leftRunning - rightRunning;
      return Date.parse(right.startedAt) - Date.parse(left.startedAt);
    });
    return merged.slice(0, max);
  }

  /**
   * 增量事件：返回 `seq > afterSeq` 的事件；若缓冲尾部仍是可合并的 delta
   * 事件（seq 未变、内容仍在增长），额外附带它，供客户端按 seq upsert。
   * 内存没有时回落到磁盘归档读取（历史 run 终态静态、无尾部重放）。
   */
  listEvents(runId: string, afterSeq = 0, limit = 1_000): AgentDebugEventPage | null {
    const run = this.runs.get(runId);
    if (!run) return this.archive?.readEvents(runId, afterSeq, limit) ?? null;
    const tail = run.events[run.events.length - 1];
    const events: AgentDebugEvent[] = [];
    const max = Math.max(0, limit);
    for (const event of run.events) {
      if (events.length >= max) break;
      if (event.seq > afterSeq) events.push(this.materialize(event));
    }
    if (tail?.merged && tail.seq <= afterSeq) events.push(this.materialize(tail));
    return { events, latestSeq: tail?.seq ?? 0 };
  }

  /** 磁盘归档概况；归档关闭时返回 enabled=false 的占位对象。 */
  archiveInfo(): AgentDebugArchiveInfo {
    return this.archive ? this.archive.info() : { ...DISABLED_ARCHIVE_INFO };
  }

  /** 缓冲里观测到的 Agent（主网关用于合并 status 未覆盖的本机 CLI Agent）。 */
  listObservedAgents(): AgentDebugAgent[] {
    interface ObservedAgent {
      name: string;
      description: string;
      kind: AgentDebugAgentKind;
      activeRunCount: number;
      lastRunAt: string | null;
      lastStartedAt: number;
      lastStatus: AgentDebugRunStatus;
    }
    const agents = new Map<string, ObservedAgent>();
    for (const run of this.runs.values()) {
      const previous = agents.get(run.agentId);
      const startedAt = Date.parse(run.startedAt);
      if (!previous) {
        agents.set(run.agentId, {
          name: run.agentName,
          description: run.agentDescription,
          kind: run.agentKind,
          activeRunCount: run.status === "running" ? 1 : 0,
          lastRunAt: run.completedAt ?? run.startedAt,
          lastStartedAt: startedAt,
          lastStatus: run.status,
        });
        continue;
      }
      if (run.status === "running") previous.activeRunCount += 1;
      if (startedAt >= previous.lastStartedAt) {
        previous.lastRunAt = run.completedAt ?? run.startedAt;
        previous.lastStartedAt = startedAt;
        previous.lastStatus = run.status;
        if (!previous.description && run.agentDescription) previous.description = run.agentDescription;
        if (run.agentName) previous.name = run.agentName;
      }
    }
    return [...agents.entries()]
      .map(([id, agent]): AgentDebugAgent => ({
        id,
        name: agent.name,
        description: agent.description,
        kind: agent.kind,
        state: agent.activeRunCount > 0
          ? "running"
          : ERROR_RUN_STATUSES.has(agent.lastStatus) ? "error" : "idle",
        activeRunCount: agent.activeRunCount,
        lastRunAt: agent.lastRunAt,
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  /**
   * 停用 store：仍是 running 的 run 按 interrupted 收尾（归档为中断态），
   * 等待所有排队写入完成后再清空内存。调用方需 `await`。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    for (const run of [...this.runs.values()]) {
      if (run.status === "running") this.finishRun(run.runId, "interrupted");
    }
    await this.archive?.flush();
    this.runs.clear();
    this.droppedRunCount = 0;
    this.disposed = true;
  }

  /** 终态 run 落盘（fire-and-forget）：不 await、不阻塞事件流、异常吞掉。 */
  private scheduleArchive(run: StoredRun): void {
    const archive = this.archive;
    if (!archive) return;
    try {
      const events = run.events.map((event) => this.materialize(event));
      void archive.archiveRun(this.toDebugRun(run), events).catch(() => {});
    } catch {
      // 归档是旁路：序列化/写盘异常都不应影响 Agent run。
    }
  }

  private appendDelta(run: StoredRun, type: AgentEventType, delta: string, occurredAt: string): void {
    const escaped = escapedStringBytes(delta);
    const tail = run.events[run.events.length - 1];
    if (tail?.merged && tail.type === type && tail.sizeBytes + escaped <= MAX_EVENT_BYTES) {
      // 合并：seq 不变，payload.delta 累计增长。
      tail.merged.chunks.push(delta);
      tail.merged.escapedBytes += escaped;
      tail.sizeBytes = MERGED_DELTA_BASE_BYTES + tail.merged.escapedBytes;
      tail.occurredAt = occurredAt;
      run.bytes += escaped;
      this.enforceEventLimit(run);
      return;
    }
    run.sequence += 1;
    if (MERGED_DELTA_BASE_BYTES + escaped > MAX_EVENT_BYTES) {
      // 单个 delta 就超过单条预算：退化为普通事件（截断预览 + truncatedBytes）。
      const encoded = this.encodePayload({ delta });
      this.appendStoredEvent(run, {
        seq: run.sequence,
        type,
        occurredAt,
        payload: encoded.payload,
        sizeBytes: encoded.sizeBytes,
        ...(encoded.truncatedBytes === undefined ? {} : { truncatedBytes: encoded.truncatedBytes }),
      });
      return;
    }
    this.appendStoredEvent(run, {
      seq: run.sequence,
      type,
      occurredAt,
      payload: undefined,
      sizeBytes: MERGED_DELTA_BASE_BYTES + escaped,
      merged: { chunks: [delta], escapedBytes: escaped },
    });
  }

  private appendStoredEvent(run: StoredRun, event: StoredEvent): void {
    run.events.push(event);
    run.bytes += event.sizeBytes;
    this.enforceEventLimit(run);
  }

  private enforceEventLimit(run: StoredRun): void {
    while (run.events.length > MAX_EVENTS_PER_RUN) {
      if (!this.evictOldestEvent(run)) break;
    }
    // 最少保留最新一条：单条 payload 已被 64KB 上限约束，不会独自撑破 8MB。
    while (run.bytes > MAX_RUN_BYTES && run.events.length > 1) {
      if (!this.evictOldestEvent(run)) break;
    }
  }

  private evictOldestEvent(run: StoredRun): boolean {
    const [evicted] = run.events.splice(0, 1);
    if (!evicted) return false;
    run.bytes = Math.max(0, run.bytes - evicted.sizeBytes);
    run.droppedEvents += 1;
    return true;
  }

  private enforceRunLimit(): void {
    while (this.runs.size > MAX_RUNS) {
      const victim = this.oldestRunForEviction();
      if (!victim) break;
      this.runs.delete(victim.runId);
      this.droppedRunCount += 1;
    }
  }

  private oldestRunForEviction(): StoredRun | null {
    let oldestTerminal: StoredRun | null = null;
    let oldestRunning: StoredRun | null = null;
    for (const run of this.runs.values()) {
      if (run.status === "running") {
        if (!oldestRunning || Date.parse(run.startedAt) < Date.parse(oldestRunning.startedAt)) oldestRunning = run;
      } else if (!oldestTerminal || runTimestamp(run) < runTimestamp(oldestTerminal)) {
        oldestTerminal = run;
      }
    }
    return oldestTerminal ?? oldestRunning;
  }

  /** 序列化核算 payload：超 64KB 时截断为字符串预览并记录原始字节数。 */
  private encodePayload(payload: unknown): {
    payload: unknown;
    sizeBytes: number;
    truncatedBytes?: number;
  } {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      // 不可序列化（循环引用等）的异常 payload 原样保留，不参与字节核算。
      return { payload, sizeBytes: 0 };
    }
    if (serialized === undefined) return { payload, sizeBytes: 0 };
    const sizeBytes = byteLength(serialized);
    if (sizeBytes <= MAX_EVENT_BYTES) return { payload, sizeBytes };
    const preview = truncateUtf8(serialized, MAX_EVENT_BYTES);
    return { payload: preview, sizeBytes: byteLength(preview), truncatedBytes: sizeBytes };
  }

  private materialize(event: StoredEvent): AgentDebugEvent {
    const payload = event.merged ? { delta: event.merged.chunks.join("") } : event.payload;
    return {
      seq: event.seq,
      type: event.type,
      occurredAt: event.occurredAt,
      payload,
      ...(event.truncatedBytes === undefined ? {} : { truncatedBytes: event.truncatedBytes }),
    };
  }

  private toDebugRun(run: StoredRun): AgentDebugRun {
    return {
      runId: run.runId,
      agentId: run.agentId,
      agentName: run.agentName,
      agentKind: run.agentKind,
      runtimeId: run.runtimeId,
      sessionId: run.sessionId,
      pageLabel: run.pageLabel,
      task: run.task,
      ...(run.slidePageIndex === undefined ? {} : { slidePageIndex: run.slidePageIndex }),
      ...(run.slidePageCount === undefined ? {} : { slidePageCount: run.slidePageCount }),
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      eventCount: run.events.length,
      droppedEvents: run.droppedEvents,
      toolCallCount: run.toolCallCount,
      reasoningChars: run.reasoningChars,
      lastEventAt: run.lastEventAt,
      errorMessage: run.errorMessage,
    };
  }
}

export { errorMessageOf as agentDebugErrorMessage };
