import { and, asc, eq, ne } from "drizzle-orm";

import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  agentMessages,
  agentRuns,
  agentSessions,
} from "../../infrastructure/database/schema.js";
import type { SessionTitleInput, SessionTitleOutput } from "./session-title.js";

/**
 * 工作会话标题：第一次成功跑完后，用一次 LLM 总结替换「首条 prompt 截断」的占位标题。
 *
 * 产品规则（见 `docs/workspace-session-title.zh-CN.md`）：
 * - 只处理**工作空间内的会话**（`workspaceId` 非空）：空间外的一次性对话不做额外开销；
 * - 每个会话只总结**一次**（第一次 `run.completed`）：之后不再重写，标题应当稳定；
 * - **已有明确标题就不动**：用户改过名、计划指派带入的任务标题、向导建的会话，
 *   都可能与「自动标题 = 首条用户消息前 48 字」不同，视为「有意命名」，一律跳过；
 * - 失败一律静默：标题是增强能力，运行时不可用 / 超时 / 返回空，都保留原占位标题，
 *   绝不影响对话主流程。
 *
 * 与桌面渲染层的既有实现（`useAgentSession.maybeGenerateSessionTitle`）分工：
 * 渲染层是**首选**（有界面语言、有流式正文），但它只在「对话面板正开着并订阅该会话」时触发；
 * 这里延迟 `delayMs` 后再检查一次标题——渲染层已经写好了就自动让路，没人看管的后台会话
 * 由这里补上，避免同一个会话白跑两次 LLM。
 */

const AUTO_TITLE_MAX_CHARS = 48;
/** 默认给渲染层 8 秒窗口：标题通常 1–3 秒就好，超过说明没人在看这个会话。 */
const DEFAULT_DELAY_MS = 8_000;
const USER_TEXT_MAX_CHARS = 2_000;

export interface AutoSessionTitlesOptions {
  db: GatewayDatabase;
  /** 等渲染层先写（它通常 1–3 秒内完成），超时后服务端兜底。`0` = 立即（测试用）。 */
  delayMs?: number;
  /** 通常是 `SessionTitleService.generate`（内部已处理运行时热替换）。 */
  generate: (input: SessionTitleInput) => Promise<SessionTitleOutput>;
  logger?: (level: "debug" | "info" | "warn", event: string, fields?: Record<string, unknown>) => void;
  now?: () => Date;
}

/** 粗略语言判定：CJK 文本按中文出标题，其余按英文（标题服务只支持这两个口径）。 */
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/u;

export class AutoSessionTitles {
  private readonly db: GatewayDatabase;
  private readonly generate: AutoSessionTitlesOptions["generate"];
  private readonly logger: NonNullable<AutoSessionTitlesOptions["logger"]>;
  private readonly now: () => Date;
  private readonly delayMs: number;
  /** 同一会话正在生成时不再并发起第二次（重试/双完成事件兜底）。 */
  private readonly inFlight = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: AutoSessionTitlesOptions) {
    this.db = options.db;
    this.generate = options.generate;
    this.logger = options.logger ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  }

  /**
   * run 完成时调用（fire-and-forget）：自己吞掉所有异常，调用方不需要 await。
   *
   * 注意调用时机在「本次 run 落库为 completed 之前」，所以「是否第一次完成」用
   * `id != runId` 的已完成 run 计数判断，而不是把当前 run 算进去。
   */
  schedule(sessionId: string, runId: string): void {
    if (this.delayMs <= 0) {
      void this.report(sessionId, runId, this.run(sessionId, runId));
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.report(sessionId, runId, this.run(sessionId, runId));
    }, this.delayMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  /** 停止所有待跑的兜底任务（gateway 关闭 / 测试收尾）。 */
  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private async report(sessionId: string, runId: string, work: Promise<void>): Promise<void> {
    try {
      await work;
    } catch (error) {
      this.logger("debug", "session.title.failed", {
        sessionId,
        runId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async run(sessionId: string, runId: string): Promise<void> {
    if (this.inFlight.has(sessionId)) return;
    const session = this.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
    if (!session?.workspaceId) return;

    // 只在第一次成功跑完时总结：之后这个会话的标题就是「已总结」状态。
    const earlier = this.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(
        eq(agentRuns.sessionId, sessionId),
        eq(agentRuns.status, "completed"),
        ne(agentRuns.id, runId),
      ))
      .all();
    if (earlier.length > 0) return;

    const firstUserMessage = this.db
      .select({ content: agentMessages.content })
      .from(agentMessages)
      .where(and(eq(agentMessages.sessionId, sessionId), eq(agentMessages.role, "user")))
      .orderBy(asc(agentMessages.createdAt))
      .limit(1)
      .get();
    if (!firstUserMessage) return;

    // 占位标题 = 首条用户消息前 48 字（`startRun` 写入时就是这个规则）。
    const autoTitle = firstUserMessage.content.slice(0, AUTO_TITLE_MAX_CHARS);
    if (session.title !== null && session.title !== autoTitle) {
      // 用户改过名 / 计划指派带了任务标题：尊重既有命名。
      this.logger("debug", "session.title.skipped.explicit", { sessionId });
      return;
    }

    const runMessages = this.db
      .select({ role: agentMessages.role, content: agentMessages.content })
      .from(agentMessages)
      .where(eq(agentMessages.runId, runId))
      .orderBy(asc(agentMessages.createdAt))
      .all();
    const userText = runMessages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n\n")
      .slice(0, USER_TEXT_MAX_CHARS);
    // 只用最后一条 assistant 正文做「这次工作产出了什么」的信号。
    const assistantText = [...runMessages]
      .reverse()
      .find((message) => message.role === "assistant")
      ?.content ?? "";
    if (!userText.trim() && !assistantText.trim()) return;

    this.inFlight.add(sessionId);
    try {
      const { title } = await this.generate({
        sessionId,
        userText,
        assistantText,
        language: titleLanguageOf(userText || assistantText),
      });
      const normalized = title.trim();
      if (!normalized) return;

      // 生成期间用户可能改名 / 会话可能被删：只在标题仍是「自动标题」时写回。
      const latest = this.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
      if (!latest) return;
      // 标题在生成期间被动过（用户改名 / 别的流程写过）就不覆盖。
      if (latest.title !== session.title) return;

      this.db
        .update(agentSessions)
        .set({ title: normalized.slice(0, 120), updatedAt: this.now() })
        .where(eq(agentSessions.id, sessionId))
        .run();
      this.logger("info", "session.title.generated", { sessionId, runId });
    } finally {
      this.inFlight.delete(sessionId);
    }
  }
}

export function titleLanguageOf(text: string): string {
  return CJK_PATTERN.test(text) ? "zh-CN" : "en";
}
