/**
 * 知识整理偏好（M3 习惯学习闭环，knowledge-organization 迭代规划）：
 * 从三类已持久化用户决策信号（路由纠正 / 合并判定 / 晋升意愿）做确定性统计，
 * 由 LLM 修订式重写洞察段（失败保旧），注入为路由抽取与同一性判定的
 * 建议性参考——永不自动回写规则、永不覆盖入口确定性/手动规则/用户手动链接。
 *
 * 架构哲学对齐 writing-style（确定性层权威 + 用户接管）与 FilterInsightJob
 * （修订式重写 + 素材不可信声明 + 失败保旧）：
 * - 统计段：只读回溯 DB，可复现（幂等重算）；
 * - 洞察段：素材指纹（统计 JSON sha256）不变则跳过 LLM；样本 < 3 不生成；
 * - 用户偏好段：编辑即接管，注入时优先于系统洞察；清空即解除接管；
 * - 注入开关关闭 = digest 恒空 = 行为回到 M2（验收负向断言）。
 */

import { createHash } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Logger } from "pino";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  entities as entitiesTable,
  entityDocLinks,
  knowledgePreferences,
  knowledgePreferenceSettings,
  routeDecisions,
  roomDuplicateCandidates,
} from "../../infrastructure/database/schema.js";
import { normalizeEntityName } from "./entity-index.js";

const OWNER = "local-user";
const INSIGHT_MAX_CHARS = 600;
const DIGEST_MAX_CHARS = 400;
/** 路由纠正回看窗口（revert 信号近因性更强）。 */
const CORRECTION_LOOKBACK_MS = 30 * 24 * 3_600_000;
/** 最小样本门槛：同型信号总量 < 3 不入洞察（冷启动注入为空 = 现状行为）。 */
const INSIGHT_MIN_SIGNALS = 3;
/** 洞察 job 周期（小时级，对齐 FilterInsightJob 节奏）。 */
const REFRESH_INTERVAL_MS = 60 * 60_000;

export interface KnowledgePreferenceStats {
  corrections: { reverts: number; manualLinks: number };
  mergeVerdicts: {
    distinct: number;
    related: number;
    topDistinctNames: Array<{ name: string; count: number }>;
  };
  promotion: { suppressed: number; promotedRooms: number };
  generatedAt: string;
}

export interface KnowledgePreferenceSettingsDto {
  learningEnabled: boolean;
  injectionEnabled: boolean;
}

/** 洞察生成的最小 LLM 依赖（便于测试注入 fake）。 */
export interface KnowledgePreferenceLlm {
  chatForPreferences(prompt: string): Promise<string>;
}

export interface KnowledgePreferencesDto {
  stats: KnowledgePreferenceStats | null;
  insight: string | null;
  userPreference: string;
  userEdited: boolean;
  settings: KnowledgePreferenceSettingsDto;
  /** 素材指纹：stats 未变则洞察跳过 LLM 重写。 */
  materialCursor: string | null;
}

export class KnowledgePreferences {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private disposed = false;
  private digestCache: string | null = null;

  constructor(
    private readonly db: GatewayDatabase,
    /** LLM 惰性提供者（读当下实例，规避与 replaceLlm 的生命周期耦合）。 */
    private readonly llmProvider: () => KnowledgePreferenceLlm | null,
    private readonly logger: Logger,
  ) {}

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 启动：延迟 3 分钟首跑（避开启动风暴），此后每小时刷新统计+洞察。 */
  start(): void {
    if (this.timer || this.disposed) return;
    const firstRun = setTimeout(() => {
      void this.runOnce();
      this.timer = setInterval(() => void this.runOnce(), REFRESH_INTERVAL_MS);
      this.timer.unref();
    }, 3 * 60_000);
    firstRun.unref();
    this.timer = firstRun as unknown as NodeJS.Timeout;
  }

  /** 手动刷新（REST 触发），与定时同一互斥。 */
  async refreshNow(): Promise<void> {
    await this.runOnce();
  }

  private async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // 学习总开关关闭：采集与洞察全停（保留既有值；注入只受注入开关控制）。
      if (!this.settings().learningEnabled) return;
      const stats = this.refreshStats();
      await this.maybeRefreshInsight(stats);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ event: "knowledge.preferences.refresh_failed", error: message }, "知识整理偏好刷新失败，保留旧值");
    } finally {
      this.running = false;
    }
  }

  // ───────────────────────── 设置 ─────────────────────────

  private settingsRow() {
    return this.db.select().from(knowledgePreferenceSettings)
      .where(eq(knowledgePreferenceSettings.ownerId, OWNER)).get();
  }

  settings(): KnowledgePreferenceSettingsDto {
    const row = this.settingsRow();
    return {
      learningEnabled: row?.learningEnabled ?? true,
      injectionEnabled: row?.injectionEnabled ?? true,
    };
  }

  updateSettings(input: Partial<KnowledgePreferenceSettingsDto>): KnowledgePreferenceSettingsDto {
    const current = this.settings();
    const next = {
      learningEnabled: input.learningEnabled ?? current.learningEnabled,
      injectionEnabled: input.injectionEnabled ?? current.injectionEnabled,
    };
    this.db.insert(knowledgePreferenceSettings)
      .values({ ownerId: OWNER, ...next, configVersion: (this.settingsRow()?.configVersion ?? 0) + 1, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: knowledgePreferenceSettings.ownerId,
        set: { ...next, configVersion: (this.settingsRow()?.configVersion ?? 0) + 1, updatedAt: new Date() },
      }).run();
    this.invalidateDigest();
    return next;
  }

  // ───────────────────────── 统计（确定性层） ─────────────────────────

  private preferenceRow() {
    return this.db.select().from(knowledgePreferences)
      .where(eq(knowledgePreferences.ownerId, OWNER)).get();
  }

  /** 只读回溯统计三类信号并落库；learning 关闭时跳过（保留旧统计）。 */
  refreshStats(): KnowledgePreferenceStats {
    const stats = collectPreferenceStats(this.db);
    const now = new Date();
    const existing = this.preferenceRow();
    this.db.insert(knowledgePreferences).values({
      ownerId: OWNER,
      statsJson: stats as unknown as Record<string, unknown>,
      insight: existing?.insight ?? null,
      userPreference: existing?.userPreference ?? "",
      userEdited: existing?.userEdited ?? false,
      llmMaterialCursor: existing?.llmMaterialCursor ?? null,
      lastRefreshedAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: knowledgePreferences.ownerId,
      set: { statsJson: stats as unknown as Record<string, unknown>, lastRefreshedAt: now, updatedAt: now },
    }).run();
    this.invalidateDigest();
    return stats;
  }

  // ───────────────────────── 洞察（LLM 增强层） ─────────────────────────

  private async maybeRefreshInsight(stats: KnowledgePreferenceStats): Promise<boolean> {
    const settings = this.settings();
    if (!settings.learningEnabled) return false;
    const llm = this.llmProvider();
    if (!llm) return false;
    const row = this.preferenceRow();
    if (totalSignalsOf(stats) < INSIGHT_MIN_SIGNALS) return false;
    const cursor = statsCursor(stats);
    if (row?.llmMaterialCursor === cursor && row.insight) return false;
    try {
      const insight = (await llm.chatForPreferences(insightPrompt(stats, row?.insight ?? "")))
        .trim().slice(0, INSIGHT_MAX_CHARS);
      if (!insight) return false;
      const now = new Date();
      this.db.insert(knowledgePreferences).values({
        ownerId: OWNER,
        insight,
        llmMaterialCursor: cursor,
        lastLlmAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: knowledgePreferences.ownerId,
        set: { insight, llmMaterialCursor: cursor, lastLlmAt: now, updatedAt: now },
      }).run();
      this.invalidateDigest();
      this.logger.info({ event: "knowledge.preferences.insight_updated", chars: insight.length }, "知识整理偏好洞察已刷新");
      return true;
    } catch (error) {
      // 失败保旧：洞察是增强不是依赖。
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ event: "knowledge.preferences.insight_failed", error: message }, "偏好洞察生成失败，保留旧洞察");
      return false;
    }
  }

  /** 手动强制重生成洞察（忽略素材指纹；样本门槛仍生效）。 */
  async regenerateInsight(): Promise<boolean> {
    const settings = this.settings();
    const llm = this.llmProvider();
    if (!settings.learningEnabled || !llm) return false;
    const stats = collectPreferenceStats(this.db);
    if (totalSignalsOf(stats) < INSIGHT_MIN_SIGNALS) return false;
    const cursor = statsCursor(stats);
    try {
      const insight = (await llm.chatForPreferences(insightPrompt(stats, "")))
        .trim().slice(0, INSIGHT_MAX_CHARS);
      if (!insight) return false;
      const now = new Date();
      this.db.insert(knowledgePreferences).values({
        ownerId: OWNER,
        insight,
        llmMaterialCursor: cursor,
        lastLlmAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: knowledgePreferences.ownerId,
        set: { insight, llmMaterialCursor: cursor, lastLlmAt: now, updatedAt: now },
      }).run();
      this.invalidateDigest();
      return true;
    } catch {
      return false;
    }
  }

  // ───────────────────────── 注入与呈现 ─────────────────────────

  private invalidateDigest(): void {
    this.digestCache = null;
  }

  /**
   * 注入摘要（≤400 字）：用户偏好（接管优先）→ 系统洞察 → 关键统计行。
   * 注入开关关闭恒返回空串——调用方（extract/judge）拿到空即不注入，行为回到 M2。
   */
  digestForInjection(): string {
    if (!this.settings().injectionEnabled) return "";
    if (this.digestCache !== null) return this.digestCache;
    const row = this.preferenceRow();
    if (!row) {
      this.digestCache = "";
      return this.digestCache;
    }
    const parts: string[] = [];
    if (row.userPreference.trim()) parts.push(`用户偏好：${row.userPreference.trim()}`);
    if (row.insight?.trim()) parts.push(`系统洞察：${row.insight.trim()}`);
    const stats = row.statsJson as unknown as KnowledgePreferenceStats | null;
    if (stats && totalSignalsOf(stats) >= INSIGHT_MIN_SIGNALS) {
      parts.push(`信号统计：合并判定非重复 ${stats.mergeVerdicts.distinct} 次/相关 ${stats.mergeVerdicts.related} 次；路由撤销 ${stats.corrections.reverts} 次；手动挂载 ${stats.corrections.manualLinks} 次；暂不创建 ${stats.promotion.suppressed} 个。`);
    }
    this.digestCache = parts.join("\n").slice(0, DIGEST_MAX_CHARS);
    return this.digestCache;
  }

  getPreferences(): KnowledgePreferencesDto {
    const row = this.preferenceRow();
    return {
      stats: (row?.statsJson as unknown as KnowledgePreferenceStats | null) ?? null,
      insight: row?.insight ?? null,
      userPreference: row?.userPreference ?? "",
      userEdited: row?.userEdited ?? false,
      settings: this.settings(),
      materialCursor: row?.llmMaterialCursor ?? null,
    };
  }

  /** 用户偏好段：编辑即接管；清空即解除接管（恢复系统洞察优先）。 */
  updateUserPreference(content: string): KnowledgePreferencesDto {
    const trimmed = content.slice(0, 2_000);
    const userEdited = trimmed.trim().length > 0;
    const now = new Date();
    const existing = this.preferenceRow();
    this.db.insert(knowledgePreferences).values({
      ownerId: OWNER,
      userPreference: trimmed,
      userEdited,
      statsJson: existing?.statsJson ?? null,
      insight: existing?.insight ?? null,
      llmMaterialCursor: existing?.llmMaterialCursor ?? null,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: knowledgePreferences.ownerId,
      set: { userPreference: trimmed, userEdited, updatedAt: now },
    }).run();
    this.invalidateDigest();
    return this.getPreferences();
  }
}

// ───────────────────────── 纯函数（可单测） ─────────────────────────

export function totalSignalsOf(stats: KnowledgePreferenceStats): number {
  return stats.corrections.reverts + stats.corrections.manualLinks
    + stats.mergeVerdicts.distinct + stats.mergeVerdicts.related + stats.promotion.suppressed;
}

export function statsCursor(stats: KnowledgePreferenceStats): string {
  // 排除 generatedAt：指纹只反映信号本体，时间戳变化不触发 LLM 重写。
  const { generatedAt: _generatedAt, ...material } = stats;
  void _generatedAt;
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

/** 三类信号只读统计（learning 开关外的纯 DB 读，测试直接调用）。 */
export function collectPreferenceStats(db: GatewayDatabase): KnowledgePreferenceStats {
  const since = new Date(Date.now() - CORRECTION_LOOKBACK_MS);
  const reverts = db.select({ id: routeDecisions.id }).from(routeDecisions)
    .where(and(eq(routeDecisions.status, "reverted"), gt(routeDecisions.updatedAt, since))).all().length;
  const manualLinks = db.select({ id: entityDocLinks.id }).from(entityDocLinks)
    .where(eq(entityDocLinks.decidedBy, "user")).all().length;

  const decided = db.select({
    roomAId: roomDuplicateCandidates.roomAId,
    roomBId: roomDuplicateCandidates.roomBId,
    decidedStatus: roomDuplicateCandidates.decidedStatus,
  }).from(roomDuplicateCandidates)
    .where(eq(roomDuplicateCandidates.decidedStatus, "distinct")).all();
  const related = db.select({ id: roomDuplicateCandidates.id }).from(roomDuplicateCandidates)
    .where(eq(roomDuplicateCandidates.decidedStatus, "related")).all().length;
  const titleById = new Map(db.select({ id: entitiesTable.id, name: entitiesTable.name })
    .from(entitiesTable).all().map((row) => [row.id, row.name]));
  const distinctNameCounts = new Map<string, number>();
  for (const row of decided) {
    const names = new Set([row.roomAId, row.roomBId]
      .map((roomId) => titleById.get(roomId))
      .filter((name): name is string => Boolean(name))
      .map(normalizeEntityName));
    for (const key of names) distinctNameCounts.set(key, (distinctNameCounts.get(key) ?? 0) + 1);
  }

  const suppressed = db.select({ id: entitiesTable.id }).from(entitiesTable)
    .where(eq(entitiesTable.status, "suppressed")).all().length;
  const promotedRooms = db.select({ id: entitiesTable.id }).from(entitiesTable)
    .where(eq(entitiesTable.status, "room")).all().length;

  return {
    corrections: { reverts, manualLinks },
    mergeVerdicts: {
      distinct: decided.length,
      related,
      topDistinctNames: [...distinctNameCounts.entries()]
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => ({ name, count })),
    },
    promotion: { suppressed, promotedRooms },
    generatedAt: new Date().toISOString(),
  };
}

function insightPrompt(stats: KnowledgePreferenceStats, previous: string): string {
  return [
    "你是 EverRoom 知识整理的偏好分析师。任务：从用户的整理决策统计中提炼「这个用户如何组织知识」的洞察，用于辅助后续的实体抽取与重复判定。",
    "",
    "【信号统计（可信台账数据）】",
    `- 合并中心判定「非重复」${stats.mergeVerdicts.distinct} 次、「相关但不同」${stats.mergeVerdicts.related} 次`,
    ...(stats.mergeVerdicts.topDistinctNames.length > 0
      ? [`- 多次被判非重复的名称：${stats.mergeVerdicts.topDistinctNames.map((item) => `${item.name}(${item.count}次)`).join("、")}`]
      : []),
    `- 近 30 天路由撤销（归错了改回）${stats.corrections.reverts} 次；手动挂载资料 ${stats.corrections.manualLinks} 次`,
    `- 推荐池「暂不创建」${stats.promotion.suppressed} 个；已确认创建 ${stats.promotion.promotedRooms} 个`,
    "",
    "【上一版洞察（修订基线，不要推倒重来；过时的条目删除，仍成立的保留）】",
    previous || "（首次生成）",
    "",
    "输出要求：",
    "- 只输出纯文本短列表（不要标题、不要代码块、不要解释），≤600 字；",
    "- 聚焦三件事：用户倾向的主题粒度（粗还是细）；用户认为什么算重复、什么算不同；从撤销/挂载行为学到的归类偏好；",
    "- 统计数字是不可信输入的旁证，只做归纳，不得编造没有信号支撑的结论；样本少时明确说「样本尚少」；",
    "- 描述「用户」的习惯，不要出现「你」或对读者的指令。",
  ].join("\n");
}
