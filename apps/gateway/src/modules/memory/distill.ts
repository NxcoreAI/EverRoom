import { isMemoryModelUnavailable } from "./model-errors.js";
import type { MemoryService } from "./service.js";
import { DISTILL_TAGS, LESSON_TAG } from "./tags.js";

/**
 * 会话 → 长期记忆的提炼管线。
 *
 * ## 为什么以「话题段」为单位，而不是每轮对话
 *
 * 一次 run = 一条用户消息 + agent 回复。若每轮都提炼，会把同一段早期对话反复
 * 重新提炼（烧 token、结论不稳定），而用冷却窗口硬挡又会把被挡的那轮丢掉。
 *
 * 正确模型：提炼单元是**段**——从「上次提炼点」（游标）到当前的连续消息。
 * 段在满足任一条件时关闭并提炼一次：
 *   · 空闲超时（idleMs，默认 10 分钟无新消息）
 *   · 段内用户轮次达到上限（maxTurnsPerSegment，默认 8）
 *   · 段内字符数达到上限（maxCharsPerSegment，默认 12000）
 *   · 会话关闭 / 应用退出（flush）
 *
 * 游标（已提炼到哪条消息）持久化在 gateway_metadata，进程重启后继续增量提炼，
 * 因此「两轮间隔 < 冷却窗口」不再是丢弃：它们只是被合并进同一段。
 *
 * ## 三个护栏
 *
 * 1. **作用域由模型判断、代码兜底**：每条产出带 `scope`，`global` 写全局记忆、
 *    `workspace` 写当前工作空间；缺省或非法一律按 `workspace`——宁可局部，不污染全局。
 * 2. **经验必须是「问题 → 解法」单句**：除了提示词要求，解析层硬校验箭头与单句，
 *    不满足直接丢弃，不靠模型自觉。
 * 3. **删除会话前抢救**：删会话会级联删消息，所以 `captureBeforeDelete` 先把游标之后的
 *    段落落盘（`saveCaptured`），异步提炼成功再清掉；进程崩了下次启动 `resumeCaptured` 重试。
 *
 * 另：按轮数/字符**硬切**段落时往前带 `overlapTurns` 轮上文（只作理解用、不重复提炼），
 * 避免「坑在段尾、解法落进下一段」的上下文断层；空闲切段本身落在话题间隙，不需要上文。
 */

const DEFAULT_MAX_FACTS = 3;
const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MIN_CHARS = 200;
const DEFAULT_OVERLAP_TURNS = 2;
const MAX_CONTENT_LENGTH = 120;
const TRANSCRIPT_CHAR_LIMIT = 12_000;
const GENERATE_TIMEOUT_MS = 60_000;
/** 「问题 → 解法」的箭头写法（模型两种都可能输出）。 */
const LESSON_ARROWS = ["→", "->"] as const;

export interface DistillMessage {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
}

/** 提炼游标：已处理到哪条消息（createdAt + id 组成稳定顺序键）。 */
export interface DistillCursor {
  afterCreatedAt: string | null;
  afterId: string | null;
  attempts: number;
}

export type DistillSkipReason =
  | "disabled"
  | "no-messages"
  | "too-short"
  | "too-few-turns"
  | "empty"
  | "model-error"
  /** 模型档位还没就绪（不代表提炼失败，不消耗重试次数）。 */
  | "model-unavailable"
  | "attempts-exceeded"
  | "inflight"
  | null;

export interface DistillOutcome {
  written: number;
  /** 本次处理的消息条数。 */
  messages: number;
  skipped: DistillSkipReason;
}

/** 作用域提示：由模型判断，代码只认这两个值，其余一律按 workspace。 */
export type MemoryScopeHint = "global" | "workspace";

export interface DistilledFact {
  content: string;
  tags: string[];
  category: "fact" | "lesson";
  /** global=跨空间成立（用户本人的稳定属性），workspace=只属于当前空间。 */
  scope: MemoryScopeHint;
}

/**
 * 一段对话里「出过事」的客观痕迹（来自 agent_events，不需要人参与）：
 * 工具失败次数、失败后重试成功的次数。它们不直接产出经验，
 * 只是告诉提炼模型「这一段确实踩过坑」，让它别把重点放在正确废话上。
 */
export interface DistillSignals {
  toolFailures: number;
  retriedAfterFailure: number;
}

/** 删除会话前抢救出来的段落（落在 gateway_metadata，成功提炼后删除）。 */
export interface CapturedSegment {
  /** 会话所属工作空间；缺省视为全局。 */
  workspaceId?: string;
  transcript: string;
  /** 抢救时的消息条数与用户轮次（用于日志与用户轮次门槛判断）。 */
  messages: number;
  userTurns: number;
  capturedAt: string;
  /** 抢救时该段的坑信号，保留下来喂给提炼。 */
  signals?: DistillSignals;
}

export interface MemoryDistillerOptions {
  service: MemoryService;
  /** 一次性模型调用；抛错视为失败。 */
  generate: (prompt: string) => Promise<string>;
  /** 读取游标之后的消息（按 createdAt ASC, id ASC）。 */
  loadMessages: (sessionId: string, cursor: DistillCursor) => DistillMessage[];
  /** 读取游标**之前**最近 N 轮用户消息（硬切段落时的上文，可为空）。 */
  loadOverlap?: (sessionId: string, cursor: DistillCursor, userTurns: number) => DistillMessage[];
  readCursor: (sessionId: string) => DistillCursor;
  writeCursor: (sessionId: string, cursor: DistillCursor) => void;
  /** 会话被删除后清掉它的游标行，避免 gateway_metadata 里留孤儿键。 */
  clearCursor?: (sessionId: string) => void;
  /** 抢救段的持久化（真实实现写 gateway_metadata）；缺失时删除前抢救降级为放弃。 */
  saveCaptured?: (sessionId: string, payload: CapturedSegment) => void;
  loadCaptured?: (sessionId: string) => CapturedSegment | null;
  listCaptured?: () => string[];
  clearCaptured?: (sessionId: string) => void;
  logger?: (level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>) => void;
  maxFacts?: number;
  idleMs?: number;
  maxTurnsPerSegment?: number;
  maxCharsPerSegment?: number;
  maxAttempts?: number;
  /** 段最小字符数，低于此值不调用模型（默认 200）。 */
  minChars?: number;
  /** 硬切段落时携带的上文轮数（默认 2；0 = 不带）。 */
  overlapTurns?: number;
}

const DISTILL_PROMPT = `你是长期记忆提炼器。阅读下面这段对话，提炼值得跨会话保留的内容。

两类，分别标注：
- "fact"：脱离这段对话仍然成立的长期事实——用户的稳定偏好（语言、格式、工作方式）、明确确立的约定或决策、长期约束。
- "lesson"：这次遇到并解决的具体坑。必须是一句话，格式固定为「问题/现象 → 解法」，**必须含箭头 →**，例如「飞书导出中文文件名乱码 → 先转 UTF-8 再导出」。只写已经验证有效的解法，没解决的不要写；写成两句话或没有箭头的会被直接丢弃。
  **不要写正确废话**：对话里出现过具体的人名、文件名、版本号、字段名、口径来源，就把它们写进去（「周报排期以李明的邮件附件为准 → 引用时标注以邮件为准」），
  而不是抽象成「注意核对版本号」这种谁都能说、谁也帮不上的话。判断标准：另一个从没参与过这次对话的助手读到它，能不能直接照做。

每条还要标注作用范围 scope：
- "global"：换个工作空间仍然成立，属于用户本人的稳定属性——语言、沟通习惯、通用工作方式、个人偏好。例：用户偏好简体中文；用户要求结论先行。
- "workspace"：只在这个项目的资料与约定里成立——某个空间的数据口径、文档模板、团队流程、业务约束。例：本空间周报固定三段式；本空间财报用合并口径。
- 拿不准就选 "workspace"：宁可局部，不要污染全局。

不要提炼：一次性任务指令、问题本身、工具原始输出、文档正文、助手的长篇解释、临时中间状态。

每条不超过 60 字，用对话的语言；最多 3 条（lesson 优先于 fact）；没有值得记的就输出空数组。
fact 的标签从「身份 / 背景 / 职业 / 沟通方式 / 偏好 / 习惯 / 约束 / 决策 / 生活 / 项目 / 流程」里选一个；lesson 的标签固定用「经验」。

只输出 JSON 数组，不要代码块围栏、不要任何解释：
[{"type":"fact","scope":"global","content":"用户偏好用简体中文撰写正式文档","tags":["偏好"]},{"type":"lesson","scope":"workspace","content":"飞书导出中文文件名乱码 → 先转 UTF-8 再导出","tags":["经验"]}]

对话：
`;

/** 硬切段落时的上文块：明确告诉模型这是已提炼过的内容，避免重复产出。 */
const OVERLAP_HEADER = "【上文（已提炼过，仅供理解上下文，不要重复提炼）】";
const SEGMENT_HEADER = "【本次待提炼】";

export class MemoryDistiller {
  private readonly service: MemoryService;
  private readonly generate: (prompt: string) => Promise<string>;
  private readonly loadMessages: MemoryDistillerOptions["loadMessages"];
  private readonly loadOverlap: MemoryDistillerOptions["loadOverlap"];
  private readonly readCursor: MemoryDistillerOptions["readCursor"];
  private readonly writeCursor: MemoryDistillerOptions["writeCursor"];
  private readonly clearCursor: MemoryDistillerOptions["clearCursor"];
  private readonly saveCaptured: MemoryDistillerOptions["saveCaptured"];
  private readonly loadCaptured: MemoryDistillerOptions["loadCaptured"];
  private readonly listCaptured: MemoryDistillerOptions["listCaptured"];
  private readonly clearCaptured: MemoryDistillerOptions["clearCaptured"];
  private readonly logger: NonNullable<MemoryDistillerOptions["logger"]>;
  private readonly maxFacts: number;
  private readonly idleMs: number;
  private readonly maxTurnsPerSegment: number;
  private readonly maxCharsPerSegment: number;
  private readonly maxAttempts: number;
  private readonly minCharsValue: number;
  private readonly overlapTurns: number;
  /** 每个会话的空闲计时器。 */
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  /** 正在提炼的会话（并发去重）。 */
  private readonly inflight = new Set<string>();
  /** 有未提炼内容的会话 → 该段的工作空间与坑信号（退出前 flush / 提炼时用）。 */
  private readonly pending = new Map<string, { workspaceId?: string; signals: DistillSignals }>();

  constructor(options: MemoryDistillerOptions) {
    this.service = options.service;
    this.generate = options.generate;
    this.loadMessages = options.loadMessages;
    this.loadOverlap = options.loadOverlap;
    this.readCursor = options.readCursor;
    this.writeCursor = options.writeCursor;
    this.clearCursor = options.clearCursor;
    this.saveCaptured = options.saveCaptured;
    this.loadCaptured = options.loadCaptured;
    this.listCaptured = options.listCaptured;
    this.clearCaptured = options.clearCaptured;
    this.logger = options.logger ?? (() => {});
    this.maxFacts = options.maxFacts ?? DEFAULT_MAX_FACTS;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.maxTurnsPerSegment = options.maxTurnsPerSegment ?? DEFAULT_MAX_TURNS;
    this.maxCharsPerSegment = options.maxCharsPerSegment ?? DEFAULT_MAX_CHARS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.minCharsValue = options.minChars ?? DEFAULT_MIN_CHARS;
    this.overlapTurns = Math.max(0, options.overlapTurns ?? DEFAULT_OVERLAP_TURNS);
  }

  /**
   * 一次 run 结束后的入口：**不立刻提炼**，只判断当前段是否已该关闭。
   * 段满（轮次/字符）立即提炼；否则只重置空闲计时器，等空隙或下一个满段。
   */
  noteRun(sessionId: string, workspaceId?: string | null, signals?: Partial<DistillSignals>): void {
    if (!this.service.isEnabled()) return;
    const workspace = normalizeWorkspace(workspaceId);
    const previous = this.pending.get(sessionId);
    // 一段里可能跑过好几次 run：信号累加，工作空间取最近一次。
    this.pending.set(sessionId, {
      ...(workspace !== undefined ? { workspaceId: workspace } : {}),
      signals: mergeSignals(previous?.signals, signals),
    });
    this.clearIdleTimer(sessionId);

    const segment = this.readSegment(sessionId);
    if (segment.length === 0) return;

    if (this.shouldCloseOnSize(segment)) {
      this.logger("info", "memory.distill.segment-full", {
        sessionId,
        messages: segment.length,
        userTurns: countUserTurns(segment),
      });
      // 硬切会把「坑」和解法切到两段，所以带 overlapTurns 轮上文一起送模型。
      void this.distillSegment(sessionId, { overlap: true }).then((outcome) => {
        // 没跑成但**不消耗重试次数**的两种情形要挂回空闲计时器兜底：
        // - inflight：上一轮还在跑，本次内容不能丢；
        // - model-unavailable：档位还没就绪，就绪后（通常几分钟内）自动重试。
        if (outcome.skipped === "inflight" || outcome.skipped === "model-unavailable") {
          this.armIdleTimer(sessionId);
        }
      });
      return;
    }
    this.armIdleTimer(sessionId);
  }

  /** 会话关闭（删除/切换）时立即提炼该会话剩余内容。 */
  async flushSession(sessionId: string): Promise<DistillOutcome> {
    this.clearIdleTimer(sessionId);
    return this.distillSegment(sessionId);
  }

  /**
   * 删除会话**之前**调用：把游标之后的段落抢救到持久层，返回是否需要异步提炼。
   *
   * 删除会级联清掉 agent_messages，所以这里只做「读出 + 落盘」（同步、微秒级），
   * 真正的模型提炼交给调用方的 `distillCaptured`，不阻塞删除。
   */
  captureBeforeDelete(sessionId: string): boolean {
    if (!this.service.isEnabled()) return false;
    if (!this.saveCaptured) {
      this.logger("warn", "memory.distill.capture.unavailable", { sessionId });
      return false;
    }
    this.clearIdleTimer(sessionId);
    const state = this.pending.get(sessionId);
    const workspaceId = state?.workspaceId;
    const signals = state?.signals;
    this.pending.delete(sessionId);
    try {
      const segment = this.readSegment(sessionId);
      const transcript = formatTranscript(segment);
      if (segment.length === 0 || transcript.length < this.minCharsValue) return false;
      const userTurns = countUserTurns(segment);
      this.saveCaptured(sessionId, {
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        transcript: transcript.slice(0, TRANSCRIPT_CHAR_LIMIT),
        messages: segment.length,
        userTurns,
        capturedAt: new Date().toISOString(),
        ...(signals !== undefined ? { signals } : {}),
      });
      this.logger("info", "memory.distill.capture.done", {
        sessionId,
        messages: segment.length,
        userTurns,
      });
      return true;
    } catch (error) {
      this.logger("error", "memory.distill.capture.failed", { sessionId, error: describe(error) });
      return false;
    } finally {
      // 会话都没了，游标行留着只会变成孤儿键（抢救段本身已落盘）。
      try {
        this.clearCursor?.(sessionId);
      } catch {
        /* 清游标失败不影响删除 */
      }
    }
  }

  /** 提炼一条抢救段；成功才清掉持久化记录，失败留待下次启动重试。 */
  async distillCaptured(sessionId: string): Promise<DistillOutcome> {
    if (!this.service.isEnabled()) return { written: 0, messages: 0, skipped: "disabled" };
    if (this.inflight.has(sessionId)) return { written: 0, messages: 0, skipped: "inflight" };
    const payload = this.loadCaptured?.(sessionId) ?? null;
    if (!payload) return { written: 0, messages: 0, skipped: "no-messages" };
    if (payload.userTurns < 1) {
      this.clearCaptured?.(sessionId);
      return { written: 0, messages: payload.messages, skipped: "too-few-turns" };
    }

    this.inflight.add(sessionId);
    try {
      const prompt = `${DISTILL_PROMPT}${formatSignals(payload.signals)}${payload.transcript}`;
      const written = await this.writeFacts(prompt, sessionId, payload.workspaceId, payload.signals);
      this.clearCaptured?.(sessionId);
      this.logger("info", "memory.distill.captured.done", {
        sessionId,
        messages: payload.messages,
        written,
      });
      return { written, messages: payload.messages, skipped: written === 0 ? "empty" : null };
    } catch (error) {
      if (isMemoryModelUnavailable(error)) {
        // 档位未就绪：抢救段留在持久层，下次启动 resumeCaptured() 或下轮重试。
        this.logger("warn", "memory.distill.captured.model-unavailable", { sessionId });
        return { written: 0, messages: payload.messages, skipped: "model-unavailable" };
      }
      this.logger("error", "memory.distill.captured.failed", { sessionId, error: describe(error) });
      return { written: 0, messages: payload.messages, skipped: "model-error" };
    } finally {
      this.inflight.delete(sessionId);
    }
  }

  /**
   * 启动时把上次没提炼完的抢救段重新排队（删除会话后进程退出 / 提炼失败留下的）。
   * 返回恢复的会话数，供启动日志使用。
   */
  resumeCaptured(): number {
    if (!this.service.isEnabled()) return 0;
    const sessions = this.listCaptured?.() ?? [];
    if (sessions.length === 0) return 0;
    for (const sessionId of sessions) {
      void this.distillCaptured(sessionId).catch(() => undefined);
    }
    this.logger("info", "memory.distill.captured.resume", { sessions: sessions.length });
    return sessions.length;
  }

  /** 应用退出前：把还有未提炼内容的会话尽力提炼一次（带总超时）。 */
  async flushAll(timeoutMs = 15_000): Promise<void> {
    const sessions = [...this.pending.keys()];
    this.pending.clear();
    for (const sessionId of sessions) this.clearIdleTimer(sessionId);
    if (sessions.length === 0) return;
    await Promise.race([
      Promise.allSettled(sessions.map((sessionId) => this.distillSegment(sessionId))),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  }

  dispose(): void {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
  }

  /** 提炼当前游标之后的整段（并发去重 + 失败计数）。 */
  async distillSegment(sessionId: string, options: { overlap?: boolean } = {}): Promise<DistillOutcome> {
    if (!this.service.isEnabled()) return { written: 0, messages: 0, skipped: "disabled" };
    if (this.inflight.has(sessionId)) return { written: 0, messages: 0, skipped: "inflight" };

    const cursor = this.readCursor(sessionId);
    if (cursor.attempts >= this.maxAttempts) {
      this.logger("warn", "memory.distill.attempts-exceeded", { sessionId, attempts: cursor.attempts });
      return { written: 0, messages: 0, skipped: "attempts-exceeded" };
    }

    const segment = this.readSegment(sessionId, cursor);
    if (segment.length === 0) {
      this.pending.delete(sessionId);
      return { written: 0, messages: 0, skipped: "no-messages" };
    }
    const transcript = formatTranscript(segment);
    const userTurns = countUserTurns(segment);
    if (transcript.length < this.minCharsValue) return { written: 0, messages: segment.length, skipped: "too-short" };
    if (userTurns < 1) return { written: 0, messages: segment.length, skipped: "too-few-turns" };

    // 先快照段尾：LLM 期间新到的消息留给下一段。
    const last = segment[segment.length - 1]!;
    const state = this.pending.get(sessionId);
    const workspaceId = state?.workspaceId;
    const signals = state?.signals;
    const overlap = options.overlap ? this.readOverlap(sessionId, cursor) : [];

    this.inflight.add(sessionId);
    try {
      const written = await this.writeFacts(
        buildPrompt(transcript, overlap, signals),
        sessionId,
        workspaceId,
        signals,
      );
      // 只有成功跑完才推进游标（失败保留，下次重试）。
      this.writeCursor(sessionId, {
        afterCreatedAt: last.createdAt.toISOString(),
        afterId: last.id,
        attempts: 0,
      });
      if (!this.hasMoreMessages(sessionId)) this.pending.delete(sessionId);
      this.logger("info", "memory.distill.done", {
        sessionId,
        messages: segment.length,
        userTurns,
        written,
        overlap: overlap.length,
      });
      return { written, messages: segment.length, skipped: written === 0 ? "empty" : null };
    } catch (error) {
      // 档位未就绪不是「这段提炼失败」：环境没准备好不该消耗重试次数，
      // 否则 3 次机会会在启动窗口期被烧光，整段内容永久不再提炼。
      if (isMemoryModelUnavailable(error)) {
        this.logger("warn", "memory.distill.model-unavailable", {
          sessionId,
          messages: segment.length,
          attempts: cursor.attempts,
        });
        return { written: 0, messages: segment.length, skipped: "model-unavailable" };
      }
      this.writeCursor(sessionId, { ...cursor, attempts: cursor.attempts + 1 });
      this.logger("error", "memory.distill.failed", {
        sessionId,
        attempts: cursor.attempts + 1,
        error: describe(error),
      });
      return { written: 0, messages: segment.length, skipped: "model-error" };
    } finally {
      this.inflight.delete(sessionId);
    }
  }

  /**
   * 调模型 → 解析 → 按每条自带的 scope 落库，返回写入条数。抛错由调用方处理。
   * `workspaceId` 缺省时只能是全局作用域（没有空间可写）。
   */
  private async writeFacts(
    prompt: string,
    sessionId: string,
    workspaceId: string | undefined,
    signals: DistillSignals | undefined,
  ): Promise<number> {
    const raw = await withTimeout(this.generate(prompt), GENERATE_TIMEOUT_MS);
    const facts = parseFacts(raw).slice(0, this.maxFacts);
    let written = 0;
    for (const fact of facts) {
      // 作用域由模型判断：只有明确写了 workspace 且确实有当前空间才落空间，其余落全局。
      const useWorkspace = fact.scope === "workspace" && workspaceId !== undefined;
      if (this.isDuplicate(fact.content, useWorkspace ? workspaceId : undefined)) continue;
      const id = this.service.remember({
        content: fact.content,
        tags: fact.tags,
        category: fact.category,
        sourceSessionId: sessionId,
        // 自动产出不是事实：经验=草稿（inferred，需被复用验证后转正），
        // 事实=机器观察（observed）。都没资格一出生就盖「已核实」的章。
        confidence: fact.category === "lesson" ? "inferred" : "observed",
        ...(useWorkspace ? { workspaceId } : {}),
      });
      if (id) written += 1;
    }
    this.logger("info", "memory.distill.facts", {
      sessionId,
      candidates: facts.length,
      written,
      global: facts.filter((fact) => fact.scope === "global").length,
      lessons: facts.filter((fact) => fact.category === "lesson").length,
      signals,
    });
    return written;
  }

  /** 硬切段落的上文：读不到就当没有，不能影响提炼本身。 */
  private readOverlap(sessionId: string, cursor: DistillCursor): DistillMessage[] {
    if (!this.loadOverlap || this.overlapTurns <= 0) return [];
    try {
      return this.loadOverlap(sessionId, cursor, this.overlapTurns);
    } catch {
      return [];
    }
  }

  private readSegment(sessionId: string, cursor?: DistillCursor): DistillMessage[] {
    try {
      return this.loadMessages(sessionId, cursor ?? this.readCursor(sessionId));
    } catch {
      return [];
    }
  }

  private hasMoreMessages(sessionId: string): boolean {
    return this.readSegment(sessionId).length > 0;
  }

  private shouldCloseOnSize(segment: DistillMessage[]): boolean {
    const chars = segment.reduce((total, message) => total + message.content.length, 0);
    return countUserTurns(segment) >= this.maxTurnsPerSegment || chars >= this.maxCharsPerSegment;
  }

  private armIdleTimer(sessionId: string): void {
    const timer = setTimeout(() => {
      this.idleTimers.delete(sessionId);
      this.logger("info", "memory.distill.idle", { sessionId, idleMs: this.idleMs });
      void this.distillSegment(sessionId);
    }, this.idleMs);
    timer.unref?.();
    this.idleTimers.set(sessionId, timer);
  }

  private clearIdleTimer(sessionId: string): void {
    const timer = this.idleTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(sessionId);
    }
  }

  /**
   * 近似去重：已有记忆包含新事实，或新事实包含已有记忆，都视为重复。
   *
   * 比较范围跟着**写入范围**走：
   * - 写空间：只看「本空间 + 全局」能看见的条目（与检索口径一致）；
   * - 写全局：只看全局条目——否则别的空间里已有的同义句会把「提升为全局」挡掉。
   */
  private isDuplicate(content: string, workspaceId: string | undefined): boolean {
    const normalized = normalize(content);
    if (workspaceId === undefined) {
      return this.service
        .list({ limit: DEDUPE_SCAN_LIMIT })
        .filter((hit) => hit.scope === null)
        .some((hit) => isSameMeaning(hit.content, normalized));
    }
    const hits = this.service.recall({ query: content, limit: 5, workspaceId });
    return hits.some((hit) => isSameMeaning(hit.content, normalized));
  }
}

/** 全局去重的扫描上限（本地库规模有限，一次读取可接受）。 */
const DEDUPE_SCAN_LIMIT = 500;

/** 提示词拼装：坑信号 + （硬切时的）上文块 + 待提炼正文。 */
function buildPrompt(
  transcript: string,
  overlap: DistillMessage[],
  signals: DistillSignals | undefined,
): string {
  const body = transcript.slice(0, TRANSCRIPT_CHAR_LIMIT);
  const signalBlock = formatSignals(signals);
  if (overlap.length === 0) return `${DISTILL_PROMPT}${signalBlock}${body}`;
  return `${DISTILL_PROMPT}${signalBlock}${OVERLAP_HEADER}\n${formatTranscript(overlap)}\n\n${SEGMENT_HEADER}\n${body}`;
}

/**
 * 坑信号的提示词片段：只是事实陈述，不强迫模型产出（没提炼出东西也正常）。
 * 全部来自 agent_events 与对话本身，不需要任何人参与。
 */
function formatSignals(signals: DistillSignals | undefined): string {
  if (!signals) return "";
  const { toolFailures, retriedAfterFailure } = signals;
  if (toolFailures <= 0 && retriedAfterFailure <= 0) return "";
  return `【本段客观信号】工具失败 ${toolFailures} 次，失败后改方案重试成功 ${retriedAfterFailure} 次。
这类地方是真踩过坑：如果对话里已经出现了有效的绕法，优先把它提炼成 lesson，并写清触发点（哪个工具/哪份文件/谁说的）。\n\n`;
}

function mergeSignals(
  previous: DistillSignals | undefined,
  next: Partial<DistillSignals> | undefined,
): DistillSignals {
  return {
    toolFailures: (previous?.toolFailures ?? 0) + Math.max(0, next?.toolFailures ?? 0),
    retriedAfterFailure: (previous?.retriedAfterFailure ?? 0) + Math.max(0, next?.retriedAfterFailure ?? 0),
  };
}

/** 两段文本是否同义（包含关系即视为重复）。 */

/** 两段文本是否同义（包含关系即视为重复）。 */
function isSameMeaning(existing: string, normalizedNew: string): boolean {
  const value = normalize(existing);
  return value === normalizedNew || value.includes(normalizedNew) || normalizedNew.includes(value);
}

/**
 * 经验条目的硬校验：必须是「问题 → 解法」单句。
 *
 * 提示词只是软约束，小模型很容易写成两句话或省略箭头；这类条目入库后既检索不到
 * 也用不上，所以在解析层直接丢弃（宁缺毋滥：lesson 只是 0–3 条里的可选项）。
 */
function isLessonShaped(content: string): boolean {
  const arrow = LESSON_ARROWS.find((candidate) => content.includes(candidate));
  if (!arrow) return false;
  const [problem, ...rest] = content.split(arrow);
  const solution = rest.join(arrow);
  if (!problem || !solution) return false;
  if (problem.trim().length < 2 || solution.trim().length < 2) return false;
  // 解必须是单句：出现句末标点即视为多句（提示词要求的正是「一句话」）。
  return !/[。；;！!？?]/.test(solution);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeWorkspace(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalize(text: string): string {
  return text.replace(/[\s，。、；：！？,.!?;:'"“”‘’()（）]/g, "").toLowerCase();
}

function countUserTurns(messages: DistillMessage[]): number {
  return messages.filter((message) => message.role === "user").length;
}

function formatTranscript(messages: DistillMessage[]): string {
  return messages
    .filter((message) => message.content.trim().length > 0)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
}

/** 容错解析：剥掉代码块围栏，取第一个 JSON 数组。 */
export function parseFacts(raw: string): DistilledFact[] {
  const withoutFence = raw.replace(/```(?:json)?/gi, "").trim();
  const start = withoutFence.indexOf("[");
  const end = withoutFence.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const facts: DistilledFact[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (!content || content.length > MAX_CONTENT_LENGTH) continue;
    const category = record.type === "lesson" ? "lesson" : "fact";
    // 经验必须是「问题 → 解法」单句，否则丢弃（硬约束，不靠模型自觉）。
    if (category === "lesson" && !isLessonShaped(content)) continue;
    const key = normalize(content);
    if (seen.has(key)) continue;
    seen.add(key);
    const tags = Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === "string" && DISTILL_TAGS.has(tag))
      : [];
    facts.push({
      content,
      category,
      // 作用域只认 "global"，其余（含缺失/拼错）一律按 workspace：宁可局部，不污染全局。
      scope: record.scope === "global" ? "global" : "workspace",
      tags: tags.length > 0 ? tags : [category === "lesson" ? LESSON_TAG : "偏好"],
    });
  }
  return facts;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`memory distill timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}
